import { describe, expect, it } from "vitest";
import {
  LlmError,
  MisconfiguredClient,
  OpenAiCompatClient,
  errorAdvice,
  loadLlmConfig,
  parseSseLine,
  warmUp,
  withTimeout,
  type LlmConfig,
} from "../src/pipeline/llm.js";
import { FakeClock } from "./fakeClock.js";
import { FakeLlmClient, flush } from "./fakeLlm.js";

const KEY = "gsk_test_SECRET_123";
const cfg = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  baseUrl: "https://api.example.com/openai/v1",
  model: "test-model",
  apiKey: KEY,
  jsonMode: "schema",
  host: "api.example.com",
  ...over,
});

interface Captured {
  url: string;
  init: RequestInit;
  body: any;
}

/** fetch stand-in: answers each call with the next responder. */
function fakeFetch(...responders: ((c: Captured) => Response | Promise<Response>)[]) {
  const calls: Captured[] = [];
  const fn = async (url: string, init: RequestInit) => {
    const c = { url, init, body: JSON.parse(String(init.body)) };
    calls.push(c);
    const r = responders[calls.length - 1];
    if (!r) throw new Error("unexpected fetch");
    return r(c);
  };
  return { fn, calls };
}

const sse = (parts: string[]) => {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(ctrl) {
        for (const p of parts) ctrl.enqueue(enc.encode(p));
        ctrl.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};
const chunk = (delta: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const message = (content: string) => Response.json({ choices: [{ message: { role: "assistant", content } }] });
const errorRes = (status: number, msg: string, headers: Record<string, string> = {}) =>
  Response.json({ error: { message: msg, type: "x" } }, { status, headers });

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of it) out.push(d);
  return out;
}

async function caught(p: Promise<unknown>): Promise<LlmError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(LlmError);
    return err as LlmError;
  }
  throw new Error("expected a rejection");
}

describe("loadLlmConfig", () => {
  it("reads the .env values and strips a trailing slash", () => {
    const c = loadLlmConfig({ LLM_BASE_URL: "https://api.groq.com/openai/v1/", LLM_MODEL: "m", LLM_API_KEY: KEY });
    expect(c).toMatchObject({ baseUrl: "https://api.groq.com/openai/v1", model: "m", apiKey: KEY, host: "api.groq.com", jsonMode: "schema" });
    expect(c.reasoningEffort).toBeUndefined();
  });

  it("needs no key for Ollama on localhost", () => {
    const c = loadLlmConfig({ LLM_BASE_URL: "http://localhost:11434/v1", LLM_MODEL: "gpt-oss:20b" });
    expect(c.apiKey).toBeUndefined();
  });

  it("rejects a missing key for a remote host, a missing URL or model, and a bad JSON mode", () => {
    const kind = (env: Record<string, string>) => {
      try {
        loadLlmConfig(env);
      } catch (err) {
        return [(err as LlmError).kind, (err as LlmError).message];
      }
      return null;
    };
    expect(kind({ LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_MODEL: "m" })).toEqual([
      "config",
      "LLM_API_KEY is empty in app/.env. Add it, then restart the app.",
    ]);
    expect(kind({ LLM_MODEL: "m", LLM_API_KEY: "k" })?.[1]).toMatch(/LLM_BASE_URL is empty/);
    expect(kind({ LLM_BASE_URL: "not a url", LLM_MODEL: "m", LLM_API_KEY: "k" })?.[1]).toMatch(/not a valid URL/);
    expect(kind({ LLM_BASE_URL: "https://x.dev/v1", LLM_API_KEY: "k" })?.[1]).toMatch(/LLM_MODEL is empty/);
    expect(kind({ LLM_BASE_URL: "https://x.dev/v1", LLM_MODEL: "m", LLM_API_KEY: "k", LLM_JSON_MODE: "xml" })?.[0]).toBe("config");
  });
});

describe("parseSseLine", () => {
  it("returns content deltas only", () => {
    expect(parseSseLine(chunk({ content: "Hi" }).trim())).toEqual({ text: "Hi" });
    expect(parseSseLine(chunk({ reasoning: "thinking…" }).trim())).toBeNull();
    expect(parseSseLine(chunk({ role: "assistant", content: "" }).trim())).toBeNull();
    expect(parseSseLine(": OPENROUTER PROCESSING")).toBeNull();
    expect(parseSseLine("")).toBeNull();
    expect(parseSseLine("data: [DONE]")).toEqual({ done: true });
    expect(parseSseLine('data: {"error":{"message":"overloaded"}}')).toEqual({ error: "overloaded" });
  });
});

describe("OpenAiCompatClient", () => {
  it("streams content, skipping reasoning, comments and [DONE], across split chunks", async () => {
    const f = fakeFetch(() =>
      sse([
        ": keep-alive\n\n",
        chunk({ role: "assistant", reasoning: "Let me think" }),
        chunk({ content: "- Said: " }).slice(0, 20),
        chunk({ content: "- Said: " }).slice(20) + chunk({ content: "hello" }),
        "data: [DONE]\n\n",
      ]),
    );
    const c = new OpenAiCompatClient(cfg({ reasoningEffort: "low" }), f.fn);
    expect(await collect(c.stream({ messages: [{ role: "user", content: "x" }], maxTokens: 100, temperature: 0.3 }))).toEqual([
      "- Said: ",
      "hello",
    ]);
    const call = f.calls[0];
    expect(call.url).toBe("https://api.example.com/openai/v1/chat/completions");
    expect(call.body).toMatchObject({ model: "test-model", stream: true, max_tokens: 100, temperature: 0.3, reasoning_effort: "low" });
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it("sends no Authorization header without a key and no reasoning_effort unless configured", async () => {
    const f = fakeFetch(() => message("OK"));
    const c = new OpenAiCompatClient(cfg({ apiKey: undefined, baseUrl: "http://localhost:11434/v1", host: "localhost:11434" }), f.fn);
    expect(await c.complete({ messages: [{ role: "user", content: "x" }] })).toBe("OK");
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(f.calls[0].body.reasoning_effort).toBeUndefined();
    expect(f.calls[0].body.stream).toBeUndefined();
  });

  it("an error chunk mid-stream becomes a server error", async () => {
    const f = fakeFetch(() => sse([chunk({ content: "a" }), 'data: {"error":{"message":"overloaded"}}\n\n']));
    const c = new OpenAiCompatClient(cfg(), f.fn);
    const it = c.stream({ messages: [] })[Symbol.asyncIterator]();
    expect((await it.next()).value).toBe("a");
    const e = await caught(it.next());
    expect(e.kind).toBe("server");
  });

  it("asks for strict json_schema and validates the answer", async () => {
    const f = fakeFetch(() => message('{"a": 1}'));
    const c = new OpenAiCompatClient(cfg(), f.fn);
    const schema = { type: "object", properties: { a: { type: "number" } }, required: ["a"], additionalProperties: false };
    const v = await c.json({ messages: [{ role: "user", content: "x" }] }, { name: "thing", schema, validate: (x) => x as { a: number } });
    expect(v).toEqual({ a: 1 });
    expect(f.calls[0].body.response_format).toEqual({ type: "json_schema", json_schema: { name: "thing", strict: true, schema } });
  });

  it("falls back to JSON mode on HTTP 400 and keeps using it", async () => {
    const f = fakeFetch(
      () => errorRes(400, "response_format json_schema is not supported for this model"),
      () => message('```json\n{"a": 2}\n```'),
      () => message('{"a": 3}'),
    );
    const logs: string[] = [];
    const c = new OpenAiCompatClient(cfg(), f.fn, (m) => logs.push(m));
    const spec = { name: "t", schema: { type: "object" }, validate: (x: unknown) => x as { a: number } };
    expect(await c.json({ messages: [{ role: "user", content: "x" }] }, spec)).toEqual({ a: 2 });
    expect(f.calls[1].body.response_format).toEqual({ type: "json_object" });
    expect(f.calls[1].body.messages[0]).toMatchObject({ role: "system" });
    expect(f.calls[1].body.messages[0].content).toContain('{"type":"object"}');
    expect(await c.json({ messages: [] }, spec)).toEqual({ a: 3 });
    expect(f.calls[2].body.response_format).toEqual({ type: "json_object" });
    expect(logs.join()).toMatch(/switching to JSON mode/);
  });

  it("rejects invalid JSON or a failed validation as bad_response", async () => {
    const f = fakeFetch(
      () => message("not json"),
      () => message('{"b": 1}'),
    );
    const c = new OpenAiCompatClient(cfg(), f.fn);
    const spec = {
      name: "t",
      schema: {},
      validate: (x: any) => {
        if (typeof x.a !== "number") throw new Error("a missing");
        return x;
      },
    };
    expect((await caught(c.json({ messages: [] }, spec))).kind).toBe("bad_response");
    const e = await caught(c.json({ messages: [] }, spec));
    expect(e.kind).toBe("bad_response");
    expect(e.message).toMatch(/a missing/);
  });

  it("maps HTTP errors, and never puts the key in a message", async () => {
    const f = fakeFetch(
      () => errorRes(401, `Invalid API Key ${KEY}`),
      () => errorRes(404, "The model `x` does not exist"),
      () => errorRes(429, "Rate limit reached", { "retry-after": "7.2" }),
      () => errorRes(503, "Service Unavailable"),
      () => {
        throw new TypeError("fetch failed");
      },
    );
    const c = new OpenAiCompatClient(cfg(), f.fn);
    const req = { messages: [] };
    const auth = await caught(c.complete(req));
    expect(auth.kind).toBe("auth");
    expect(auth.extra.status).toBe(401);
    expect(auth.message).not.toContain(KEY);
    expect(auth.message).toContain("[key]");
    expect((await caught(c.complete(req))).kind).toBe("not_found");
    const rl = await caught(c.complete(req));
    expect(rl.kind).toBe("rate_limit");
    expect(rl.extra.retryAfterS).toBe(8);
    expect(errorAdvice(rl)).toBe("Too many requests (rate limit). Wait 8 s, then press again.");
    const srv = await caught(c.complete(req));
    expect(srv.kind).toBe("server");
    expect(errorAdvice(srv)).toContain("HTTP 503");
    const net = await caught(c.complete(req));
    expect(net.kind).toBe("network");
    expect(errorAdvice(net)).toBe("Can't reach api.example.com. Check the internet connection (for Ollama: is it running?).");
    for (const e of [auth, rl, srv, net]) expect(errorAdvice(e)).not.toContain(KEY);
  });

  it("an aborted request reports the abort reason (e.g. timeout)", async () => {
    const f = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))),
    );
    const c = new OpenAiCompatClient(cfg(), f.fn);
    const ac = new AbortController();
    const p = c.complete({ messages: [], signal: ac.signal });
    ac.abort(new LlmError("timeout", "No answer within 20 s"));
    expect((await caught(p)).kind).toBe("timeout");
  });

  it("describes itself without the key", () => {
    expect(new OpenAiCompatClient(cfg(), fakeFetch().fn).describe()).toBe("test-model @ api.example.com");
  });
});

describe("withTimeout", () => {
  it("rejects with a timeout after exactly the given time and aborts the signal", async () => {
    const clock = new FakeClock();
    let signal: AbortSignal | undefined;
    const p = withTimeout(clock, 20_000, (s) => {
      signal = s;
      return new Promise(() => {});
    });
    let err: unknown;
    p.catch((e) => (err = e));
    clock.advance(19_999);
    await flush();
    expect(err).toBeUndefined();
    clock.advance(1);
    await flush();
    expect((err as LlmError).kind).toBe("timeout");
    expect(signal!.aborted).toBe(true);
  });

  it("resolves before the timeout and clears its timer", async () => {
    const clock = new FakeClock();
    expect(await withTimeout(clock, 20_000, async () => 42)).toBe(42);
    expect(clock.pending()).toBe(0);
  });

  it("rejects with cancelled when the outer signal aborts", async () => {
    const clock = new FakeClock();
    const ac = new AbortController();
    const p = withTimeout(clock, 20_000, () => new Promise(() => {}), ac.signal);
    ac.abort();
    expect((await caught(p)).kind).toBe("cancelled");
    expect(clock.pending()).toBe(0);
  });
});

describe("warmUp", () => {
  it("reports success with the time taken", async () => {
    const clock = new FakeClock();
    const llm = new FakeLlmClient();
    const p = warmUp(llm, clock);
    clock.advance(412);
    llm.last().end("OK");
    expect(await p).toEqual({ ok: true, ms: 412 });
    expect(llm.last().kind).toBe("complete");
  });

  it("reports a failure with its kind", async () => {
    const clock = new FakeClock();
    const llm = new FakeLlmClient();
    const p = warmUp(llm, clock);
    llm.last().fail(new LlmError("auth", "HTTP 401", { status: 401 }));
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("auth");
  });

  it("times out after 20 s", async () => {
    const clock = new FakeClock();
    const p = warmUp(new FakeLlmClient(), clock);
    clock.advance(20_000);
    const r = await p;
    expect(r).toMatchObject({ ok: false, ms: 20_000 });
    if (!r.ok) expect(r.error.kind).toBe("timeout");
  });

  it("MisconfiguredClient fails every call with the config message", async () => {
    const c = new MisconfiguredClient(new LlmError("config", "LLM_API_KEY is empty in app/.env. Add it, then restart the app."));
    const r = await warmUp(c, new FakeClock());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorAdvice(r.error)).toBe("LLM_API_KEY is empty in app/.env. Add it, then restart the app.");
    expect((await caught(collect(c.stream()))).kind).toBe("config");
  });
});
