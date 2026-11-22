import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReplayStt, entryLine, headerLine, loadRecording, parseRecording } from "../src/pipeline/replay.js";
import type { SttSegment } from "../src/pipeline/stt.js";
import { KeywordSpotterLlm, newBlock, parseTermList } from "../src/tools/keywordSpotter.js";
import { runReplay } from "../src/tools/replayLive.js";
import { SPOTTER_SPEC } from "../src/pipeline/termSpotter.js";
import { FakeClock } from "./fakeClock.js";

const FIXTURE = join(__dirname, "fixtures", "deepgram-monologue.jsonl");

describe("recording format", () => {
  it("round-trips: the recorder's header + raw tap lines load back", () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-"));
    const path = join(dir, "x.jsonl");
    const msg = JSON.stringify({ type: "Results", is_final: true, start: 0, duration: 1, channel: { alternatives: [{ transcript: "hi" }] } });
    const text = [
      headerLine({ createdAt: "now", model: "nova-3", language: "en", diarize: true, endpointingMs: 300, utteranceEndMs: 1000, keyterms: ["RAG"] }),
      entryLine({ at: 120.4, offset: null, type: "connect" }),
      entryLine({ at: 900, offset: 0, msg }),
    ].join("\n");
    writeFileSync(path, `${text}\n`);
    const rec = loadRecording(path);
    expect(rec.header).toMatchObject({ type: "header", version: 1, model: "nova-3", keyterms: ["RAG"] });
    expect(rec.entries).toEqual([
      { at: 120, offset: null, type: "connect" },
      { at: 900, offset: 0, msg: JSON.parse(msg) },
    ]);
    expect(readFileSync(path, "utf8")).not.toContain('"msg":"{'); // stored parsed, readable
  });

  it("rejects a file without a header or with another version", () => {
    expect(() => parseRecording('{"at":1}')).toThrow(/header/);
    expect(() => parseRecording('{"type":"header","version":9}')).toThrow(/version/);
  });
});

describe("ReplayStt", () => {
  it("plays the recorded messages on the clock through the assembler (long lines cut at 12 words / 6 s)", () => {
    const clock = new FakeClock();
    const stt = new ReplayStt(loadRecording(FIXTURE), { clock });
    const finals: { seg: SttSegment; at: number }[] = [];
    let done = false;
    stt.on("final", (seg: SttSegment) => finals.push({ seg, at: clock.now() }));
    stt.on("done", () => (done = true));
    const t0 = clock.now();
    stt.start();
    clock.advance(5600);
    expect(finals).toHaveLength(0);
    clock.advance(200); // the first piece that reaches 12 words ends at 4.9 s and arrives 0.8 s later
    expect(finals).toHaveLength(1);
    clock.advance(60_000);
    expect(done).toBe(true);
    expect(finals.length).toBeGreaterThanOrEqual(6);
    for (const f of finals.slice(0, -1)) {
      expect(f.seg.reason).toBe("length");
      expect(f.seg.words!.length >= 12 || f.seg.end - f.seg.start >= 6).toBe(true);
    }
    expect(finals.at(-1)!.seg.reason).toBe("speech_final");
    // No line is longer than one piece past the limit (the 49 s line of the podcast cannot happen).
    for (const f of finals) expect(f.seg.end - f.seg.start).toBeLessThan(9);
    expect(finals[0].at - t0).toBeGreaterThan(0);
  });
});

describe("keyword fake spotter", () => {
  it("reads only the NEW block and returns the listed terms found there", async () => {
    const clock = new FakeClock();
    const llm = new KeywordSpotterLlm(parseTermList("NSDR=Health, vector database"), clock);
    const req = {
      messages: [
        { role: "system" as const, content: "x" },
        { role: "user" as const, content: "Already shown: none\n\nEarlier (context only, do not pick from here):\n[0:00] vector database\n\nNEW:\n[0:05] Speaker 1: Try nsdr today." },
      ],
    };
    expect(newBlock(req)).toEqual(["Try nsdr today."]);
    const out = await llm.json(req, SPOTTER_SPEC);
    expect(out.terms.map((t) => [t.term, t.category])).toEqual([["NSDR", "Health"]]);
  });

  it("without a list it returns acronyms", async () => {
    const llm = new KeywordSpotterLlm([], new FakeClock());
    const out = await llm.json({ messages: [{ role: "user", content: "NEW:\n[0:01] I said OK, the EEG and NSDR." }] }, SPOTTER_SPEC);
    expect(out.terms.map((t) => t.term)).toEqual(["EEG", "NSDR"]);
  });
});

describe("runReplay (full live pipeline from a recording, no LLM)", () => {
  it("puts the term on slot 0 within a few seconds of it being spoken, despite the pause-free monologue", async () => {
    const r = await runReplay({ recording: loadRecording(FIXTURE), terms: "NSDR=Health", fakeLatencyMs: 800, intervalMs: 8000 });
    expect(r.layout[0]).toBe("NSDR");
    expect(r.latencies).toHaveLength(1);
    const x = r.latencies[0];
    expect(x.spokenAt).toBeCloseTo(16.25, 1); // word timestamp of "NSDR"
    expect(x.finalAt! - x.spokenAt!).toBeLessThan(4); // the line was cut at a segment boundary, not at the end
    expect(x.total!).toBeLessThan(12);
    expect(r.lines.filter((l) => l.reason === "length").length).toBeGreaterThanOrEqual(5);
  });

  it("does not repeat a variant (NSTR after NSDR) in the same recording", async () => {
    const rec = loadRecording(FIXTURE);
    // Make a later piece say "NSTR".
    const text = JSON.stringify(rec.entries).replace(/"rest and the protocol/g, '"NSTR and the protocol');
    const r = await runReplay({ recording: { header: rec.header, entries: JSON.parse(text) }, terms: "NSDR=Health, NSTR=Health" });
    expect(r.spotted.map((s) => s.term)).toEqual(["NSDR"]);
  });
});
