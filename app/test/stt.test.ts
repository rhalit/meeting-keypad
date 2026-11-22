import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { realClock } from "../src/pipeline/clock.js";
import {
  type RawSttEntry,
  BYTES_PER_SECOND,
  DeepgramAssembler,
  DeepgramStt,
  deepgramUrl,
  loadSttConfig,
  parseKeyterms,
  type DeepgramConfig,
  type DgResults,
  type SttSegment,
  type SttStatus,
} from "../src/pipeline/stt.js";

const KEY = "dg-secret-key-123";

function results(text: string, o: Partial<DgResults> & { words?: { start: number; end: number; speaker?: number }[] } = {}): DgResults {
  const words = (o.words ?? []).map((w, i) => ({ word: text.split(" ")[i] ?? "w", ...w }));
  return {
    type: "Results",
    start: o.start ?? 0,
    duration: o.duration ?? 1,
    is_final: o.is_final ?? false,
    speech_final: o.speech_final ?? false,
    channel: { alternatives: [{ transcript: text, words }] },
  };
}

describe("loadSttConfig", () => {
  it("needs DEEPGRAM_API_KEY", () => {
    expect(() => loadSttConfig({})).toThrow(/DEEPGRAM_API_KEY/);
    expect(() => loadSttConfig({ DEEPGRAM_API_KEY: "  " })).toThrow(/DEEPGRAM_API_KEY/);
  });

  it("defaults: en, nova-3, diarize, endpointing 300", () => {
    const c = loadSttConfig({ DEEPGRAM_API_KEY: KEY });
    expect(c).toMatchObject({ language: "en", model: "nova-3", diarize: true, endpointingMs: 300, utteranceEndMs: 1000 });
  });

  it("multi uses endpointing 100 unless set", () => {
    expect(loadSttConfig({ DEEPGRAM_API_KEY: KEY, DEEPGRAM_LANGUAGE: "multi" }).endpointingMs).toBe(100);
    expect(loadSttConfig({ DEEPGRAM_API_KEY: KEY, DEEPGRAM_LANGUAGE: "multi", DEEPGRAM_ENDPOINTING_MS: "250" }).endpointingMs).toBe(250);
    expect(loadSttConfig({ DEEPGRAM_API_KEY: KEY, DEEPGRAM_DIARIZE: "false" }).diarize).toBe(false);
  });
});

describe("deepgramUrl", () => {
  const cfg = loadSttConfig({ DEEPGRAM_API_KEY: KEY });

  it("has the live parameters and never the key", () => {
    const url = new URL(deepgramUrl(cfg, []));
    expect(url.origin + url.pathname).toBe("wss://api.deepgram.com/v1/listen");
    const q = Object.fromEntries(url.searchParams);
    expect(q).toMatchObject({
      model: "nova-3",
      language: "en",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      endpointing: "300",
      utterance_end_ms: "1000",
      diarize: "true",
    });
    expect(url.toString()).not.toContain(KEY);
  });

  it("repeats keyterm once per term, URL-encoded", () => {
    const url = deepgramUrl({ ...cfg, language: "multi" }, ["vector database", "LoRA", "SOC 2"]);
    expect(new URL(url).searchParams.getAll("keyterm")).toEqual(["vector database", "LoRA", "SOC 2"]);
    expect(new URL(url).searchParams.get("language")).toBe("multi");
    expect(url).toContain("keyterm=vector+database");
  });
});

describe("parseKeyterms", () => {
  it("splits on commas, semicolons and newlines, trims and de-duplicates", () => {
    expect(parseKeyterms(" Sprint review, RAG;vector  database\nrag ,, ")).toEqual(["Sprint review", "RAG", "vector database"]);
    expect(parseKeyterms(["LoRA", "p95, SOC 2"])).toEqual(["LoRA", "p95", "SOC 2"]);
    expect(parseKeyterms("")).toEqual([]);
  });

  it("caps at 50 terms", () => {
    expect(parseKeyterms(Array.from({ length: 80 }, (_, i) => `term${i}`))).toHaveLength(50);
  });
});

describe("DeepgramAssembler", () => {
  it("interim results are interim, speech_final ends the utterance", () => {
    const a = new DeepgramAssembler();
    expect(a.results(results("hello"), 0)).toEqual({ interim: expect.objectContaining({ text: "hello" }) });
    expect(a.results(results("hello there", { is_final: true, speech_final: true, start: 0.5, duration: 1.2 }), 10)).toEqual({
      final: { text: "hello there", speaker: undefined, start: 10.5, end: 11.7, words: [], reason: "speech_final" },
    });
    expect(a.flush()).toBeNull();
  });

  it("joins is_final pieces until UtteranceEnd; interim shows them plus the current words", () => {
    const a = new DeepgramAssembler();
    expect(a.results(results("we built it", { is_final: true, start: 1, duration: 1 }), 0).interim?.text).toBe("we built it");
    expect(a.results(results("with RAG"), 0).interim?.text).toBe("we built it with RAG");
    a.results(results("with RAG.", { is_final: true, start: 2, duration: 1 }), 0);
    const seg = a.utteranceEnd();
    expect(seg).toMatchObject({ text: "we built it with RAG.", start: 1, end: 3 });
    expect(a.utteranceEnd()).toBeNull();
  });

  it("uses word times and the majority speaker", () => {
    const a = new DeepgramAssembler();
    const r = a.results(
      results("a b c", {
        is_final: true,
        speech_final: true,
        words: [
          { start: 0.2, end: 0.4, speaker: 1 },
          { start: 0.5, end: 0.7, speaker: 1 },
          { start: 0.8, end: 0.9, speaker: 0 },
        ],
      }),
      5,
    );
    expect(r.final).toEqual({
      text: "a b c",
      speaker: "Speaker 2",
      start: 5.2,
      end: 5.9,
      words: [
        { text: "a", start: 5.2, end: 5.4 },
        { text: "b", start: 5.5, end: 5.7 },
        { text: "c", start: 5.8, end: 5.9 },
      ],
      reason: "speech_final",
    });
  });

  it("ignores empty finals", () => {
    const a = new DeepgramAssembler();
    expect(a.results(results("", { is_final: true, speech_final: true }), 0)).toEqual({});
  });

  describe("long lines (monologue without pauses)", () => {
    /** An is_final piece of `n` words, 0.3 s each, starting at `start`. */
    function piece(n: number, start: number, prefix = "w") {
      const text = Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
      const words = Array.from({ length: n }, (_, i) => ({ start: start + i * 0.3, end: start + i * 0.3 + 0.25 }));
      return results(text, { is_final: true, start, duration: n * 0.3, words });
    }

    it("ends the line at the first is_final boundary once it has >= 12 words", () => {
      const a = new DeepgramAssembler();
      expect(a.results(piece(5, 0, "a"), 0).final).toBeUndefined();
      expect(a.results(piece(5, 1.5, "b"), 0).final).toBeUndefined(); // 10 words, 2.7 s
      const r = a.results(piece(3, 3, "c"), 0); // 13 words
      expect(r.final).toMatchObject({ reason: "length", start: 0 });
      expect(r.final!.words).toHaveLength(13);
      expect(r.final!.text.split(" ")).toHaveLength(13);
      expect(a.flush()).toBeNull();
    });

    it("ends the line once it has >= 6 s of speech, even with few words", () => {
      const a = new DeepgramAssembler();
      const slow = (text: string, start: number, end: number) =>
        results(text, { is_final: true, start, duration: end - start, words: [{ start, end }] });
      expect(a.results(slow("one", 0, 2), 0).final).toBeUndefined();
      expect(a.results(slow("two", 2.5, 5.9), 0).final).toBeUndefined(); // 5.9 s
      expect(a.results(slow("three", 6, 6.5), 0).final).toMatchObject({ text: "one two three", reason: "length", start: 0, end: 6.5 });
    });

    it("never splits inside an is_final piece: a 20-word piece stays one line", () => {
      const a = new DeepgramAssembler();
      const r = a.results(piece(20, 0), 0);
      expect(r.final?.words).toHaveLength(20);
      expect(r.final?.reason).toBe("length");
    });

    it("still ends at speech_final and UtteranceEnd before the limits", () => {
      const a = new DeepgramAssembler();
      const sf = results("short one", { is_final: true, speech_final: true, start: 0, duration: 1 });
      expect(a.results(sf, 0).final).toMatchObject({ text: "short one", reason: "speech_final" });
      a.results(piece(4, 2), 0);
      expect(a.utteranceEnd()).toMatchObject({ reason: "utterance_end" });
      a.results(piece(4, 4), 0);
      expect(a.flush()).toMatchObject({ reason: "flush" });
    });

    it("uses the configured limits", () => {
      const a = new DeepgramAssembler({ maxLineWords: 4, maxLineS: 100 });
      expect(a.results(piece(3, 0), 0).final).toBeUndefined();
      expect(a.results(piece(2, 1), 0).final?.words).toHaveLength(5);
    });

    it("the interim after a cut starts fresh", () => {
      const a = new DeepgramAssembler();
      a.results(piece(12, 0, "x"), 0);
      expect(a.results(results("next words"), 0).interim?.text).toBe("next words");
    });
  });
});

describe("DeepgramStt against a local server", () => {
  let wss: WebSocketServer | null = null;
  let stt: DeepgramStt | null = null;

  afterEach(async () => {
    await stt?.stop();
    await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
    wss = null;
    stt = null;
  });

  async function server(opts: { reject?: number } = {}) {
    const headers: Record<string, string | string[] | undefined>[] = [];
    const urls: string[] = [];
    const sockets: ServerSocket[] = [];
    const binary: Buffer[] = [];
    const text: string[] = [];
    wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient: opts.reject
        ? (_info, cb) => cb(false, opts.reject, "Unauthorized", { "dg-error": "Invalid credentials." })
        : undefined,
    });
    wss.on("connection", (ws, req) => {
      headers.push(req.headers);
      urls.push(req.url ?? "");
      sockets.push(ws);
      ws.on("message", (d, isBinary) => {
        if (isBinary) binary.push(d as Buffer);
        else {
          text.push(String(d));
          if (JSON.parse(String(d)).type === "CloseStream") {
            ws.send(JSON.stringify(results("last words", { is_final: true, start: 0, duration: 0.5 })));
            ws.close(1000);
          }
        }
      });
    });
    await new Promise((r) => wss!.once("listening", r));
    const port = (wss.address() as AddressInfo).port;
    return { port, headers, urls, sockets, binary, text };
  }

  function make(port: number, logs: string[] = []): DeepgramStt {
    const cfg: DeepgramConfig = { ...loadSttConfig({ DEEPGRAM_API_KEY: KEY }), baseUrl: `ws://127.0.0.1:${port}/v1/listen` };
    return new DeepgramStt(cfg, { keyterms: ["RAG"] }, { clock: realClock, log: (m) => logs.push(m), backoffMs: [50] });
  }

  const until = async (cond: () => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("sends the key as a header only, forwards audio, emits finals, flushes on stop", async () => {
    const srv = await server();
    const logs: string[] = [];
    stt = make(srv.port, logs);
    const finals: SttSegment[] = [];
    const states: SttStatus["state"][] = [];
    stt.on("final", (s: SttSegment) => finals.push(s));
    stt.on("status", (s: SttStatus) => states.push(s.state));
    stt.start();
    stt.send(Buffer.alloc(BYTES_PER_SECOND / 10)); // queued while connecting
    await until(() => states.includes("open"));
    stt.send(Buffer.alloc(BYTES_PER_SECOND / 10));
    await until(() => srv.binary.length === 2);
    expect(srv.headers[0].authorization).toBe(`Token ${KEY}`);
    expect(srv.urls[0]).not.toContain(KEY);
    expect(srv.urls[0]).toContain("keyterm=RAG");

    srv.sockets[0].send(JSON.stringify(results("hello", { is_final: true, speech_final: true, start: 0.1, duration: 0.4 })));
    await until(() => finals.length === 1);
    expect(finals[0]).toMatchObject({ text: "hello", start: 0.1 });

    await stt.stop();
    expect(srv.text.map((t) => JSON.parse(t).type)).toContain("CloseStream");
    expect(finals.map((f) => f.text)).toEqual(["hello", "last words"]); // flushed after CloseStream
    expect(states[states.length - 1]).toBe("closed");
    expect(logs.join("\n")).not.toContain(KEY);
    stt = null;
  });

  it("hands every Deepgram text message and the connect to onRaw (the recorder), with the offset", async () => {
    const srv = await server();
    const raw: RawSttEntry[] = [];
    const cfg: DeepgramConfig = { ...loadSttConfig({ DEEPGRAM_API_KEY: KEY }), baseUrl: `ws://127.0.0.1:${srv.port}/v1/listen` };
    stt = new DeepgramStt(cfg, { keyterms: [] }, { clock: realClock, log: () => {}, onRaw: (e) => raw.push(e) });
    stt.start();
    await until(() => stt!.status().state === "open");
    stt.send(Buffer.alloc(BYTES_PER_SECOND / 10));
    await until(() => srv.binary.length === 1);
    const msg = JSON.stringify(results("hello", { is_final: true, speech_final: true }));
    srv.sockets[0].send(msg);
    await until(() => raw.some((e) => e.msg === msg));
    expect(raw[0]).toMatchObject({ type: "connect" });
    expect(raw.find((e) => e.msg === msg)).toMatchObject({ offset: 0 });
    expect(JSON.stringify(raw)).not.toContain(KEY);
  });

  it("keeps the session time base across a reconnect", async () => {
    const srv = await server();
    stt = make(srv.port);
    const finals: SttSegment[] = [];
    stt.on("final", (s: SttSegment) => finals.push(s));
    stt.start();
    await until(() => srv.sockets.length === 1 && stt!.status().state === "open");
    stt.send(Buffer.alloc(BYTES_PER_SECOND * 2)); // 2 s on the first connection
    await until(() => srv.binary.length === 1);
    srv.sockets[0].terminate();
    await until(() => srv.sockets.length === 2 && stt!.status().state === "open");
    stt.send(Buffer.alloc(BYTES_PER_SECOND));
    await until(() => srv.binary.length === 2);
    // Deepgram's clock restarts at 0 on the new connection; the session clock does not.
    srv.sockets[1].send(JSON.stringify(results("again", { is_final: true, speech_final: true, start: 0.25, duration: 0.5 })));
    await until(() => finals.length === 1);
    expect(finals[0].start).toBeCloseTo(2.25, 5);
  });

  it("401 is an auth error with advice, and it does not retry", async () => {
    const srv = await server({ reject: 401 });
    const logs: string[] = [];
    stt = make(srv.port, logs);
    stt.start();
    await until(() => stt!.status().state === "error");
    expect(stt.status().text).toMatch(/auth/);
    expect(stt.status().advice).toMatch(/DEEPGRAM_API_KEY/);
    await new Promise((r) => setTimeout(r, 150));
    expect(srv.headers).toHaveLength(0);
    expect(logs.join("\n")).not.toContain(KEY);
  });
});
