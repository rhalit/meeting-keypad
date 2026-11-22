// LLM access through the OpenAI-compatible chat API (Groq, Ollama, OpenRouter, ...).
// Configured by app/.env: LLM_BASE_URL, LLM_MODEL, LLM_API_KEY, optional LLM_REASONING_EFFORT
// and LLM_JSON_MODE. No Electron here, so the smoke script and tests can use it directly.
// The API key is never logged and never part of an error message.

import type { Clock } from "./clock.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface JsonSpec<T> {
  /** Schema name sent with json_schema (letters, digits, _ and -). */
  name: string;
  /** JSON schema. For strict mode: every property required, additionalProperties false. */
  schema: Record<string, unknown>;
  /** Checks the parsed value; throw to reject it. */
  validate: (value: unknown) => T;
}

/** Token counts of one call, when the server reports them. */
export interface LlmUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt tokens served from the provider's prompt cache (Groq does not count them against limits). */
  cachedTokens: number;
}

export interface LlmClient {
  /** "model @ host", for logs and the panel. Never contains the key. */
  describe(): string;
  /** Streams the answer text (reasoning tokens are skipped). */
  stream(req: LlmRequest): AsyncIterable<string>;
  /** Structured output: one JSON object, parsed and validated. */
  json<T>(req: LlmRequest, spec: JsonSpec<T>): Promise<T>;
  /** Plain, non-streaming answer text. */
  complete(req: LlmRequest): Promise<string>;
}

export type LlmErrorKind =
  | "config"
  | "auth"
  | "not_found"
  | "bad_request"
  | "rate_limit"
  | "timeout"
  | "network"
  | "server"
  | "bad_response"
  | "cancelled";

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly extra: { status?: number; retryAfterS?: number; host?: string; model?: string } = {},
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** Any thrown value as an LlmError (unknown errors count as a bad response). */
export function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  return new LlmError("bad_response", err instanceof Error ? err.message : String(err));
}

// --- config ----------------------------------------------------------------------------------

export type JsonMode = "schema" | "object";

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  reasoningEffort?: string;
  jsonMode: JsonMode;
  /** Host of baseUrl, for messages. */
  host: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Config for the term spotter: same server and key as LLM_*, but LLM_SPOTTER_MODEL (falls back to
 * LLM_MODEL), LLM_SPOTTER_REASONING_EFFORT (falls back to LLM_REASONING_EFFORT only when the model is
 * the same) and LLM_SPOTTER_JSON_MODE (falls back to LLM_JSON_MODE).
 */
export function loadSpotterLlmConfig(env: Record<string, string | undefined>): LlmConfig {
  const model = (env.LLM_SPOTTER_MODEL ?? "").trim();
  const sameModel = !model || model === (env.LLM_MODEL ?? "").trim();
  const effort = (env.LLM_SPOTTER_REASONING_EFFORT ?? "").trim();
  const jsonMode = (env.LLM_SPOTTER_JSON_MODE ?? "").trim();
  return loadLlmConfig({
    ...env,
    LLM_MODEL: model || env.LLM_MODEL,
    LLM_REASONING_EFFORT: effort || (sameModel ? env.LLM_REASONING_EFFORT : ""),
    LLM_JSON_MODE: jsonMode || env.LLM_JSON_MODE,
  });
}

/** LLM_SPOTTER_INTERVAL_MS: minimum time between two spotter calls (default 8000, at least 1000). */
export function spotterIntervalMs(env: Record<string, string | undefined>): number {
  const raw = (env.LLM_SPOTTER_INTERVAL_MS ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n >= 1000 ? Math.round(n) : 8000;
}

/** Reads the LLM_* variables. Throws LlmError("config") with a fix-it message. */
export function loadLlmConfig(env: Record<string, string | undefined>): LlmConfig {
  const baseUrl = (env.LLM_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const model = (env.LLM_MODEL ?? "").trim();
  const apiKey = (env.LLM_API_KEY ?? "").trim() || undefined;
  const reasoningEffort = (env.LLM_REASONING_EFFORT ?? "").trim() || undefined;
  const jsonModeRaw = (env.LLM_JSON_MODE ?? "").trim().toLowerCase();

  if (!baseUrl) throw new LlmError("config", "LLM_BASE_URL is empty in app/.env. Set it, then restart the app.");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new LlmError("config", "LLM_BASE_URL in app/.env is not a valid URL. Fix it, then restart the app.");
  }
  if (!model) throw new LlmError("config", "LLM_MODEL is empty in app/.env. Set it, then restart the app.");
  if (!apiKey && !LOCAL_HOSTS.has(url.hostname)) {
    throw new LlmError("config", "LLM_API_KEY is empty in app/.env. Add it, then restart the app.", { host: url.host });
  }
  if (jsonModeRaw && jsonModeRaw !== "schema" && jsonModeRaw !== "object") {
    throw new LlmError("config", 'LLM_JSON_MODE in app/.env must be "schema" or "object".');
  }
  return { baseUrl, model, apiKey, reasoningEffort, jsonMode: (jsonModeRaw || "schema") as JsonMode, host: url.host };
}

// --- SSE -------------------------------------------------------------------------------------

export type SseEvent = { text: string } | { done: true } | { error: string } | null;

/** One line of an OpenAI-style SSE stream. Only `delta.content` counts as text. */
export function parseSseLine(line: string): SseEvent {
  if (!line.startsWith("data:")) return null; // blank lines, ": comments", event:/id: lines
  const data = line.slice(5).trim();
  if (data === "") return null;
  if (data === "[DONE]") return { done: true };
  let obj: any;
  try {
    obj = JSON.parse(data);
  } catch {
    return null;
  }
  if (obj?.error) return { error: String(obj.error.message ?? obj.error) };
  const content = obj?.choices?.[0]?.delta?.content;
  return typeof content === "string" && content !== "" ? { text: content } : null;
}

// --- the real client -------------------------------------------------------------------------

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class OpenAiCompatClient implements LlmClient {
  private jsonMode: JsonMode;

  constructor(
    private readonly cfg: LlmConfig,
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
    private readonly log: (msg: string) => void = () => {},
    /** Called with the token counts of every non-streaming call that reports them. */
    private readonly onUsage?: (u: LlmUsage) => void,
  ) {
    this.jsonMode = cfg.jsonMode;
  }

  describe(): string {
    return `${this.cfg.model} @ ${this.cfg.host}`;
  }

  async *stream(req: LlmRequest): AsyncIterable<string> {
    const res = await this.post(this.body(req, { stream: true }), req.signal);
    if (!res.body) throw this.err("bad_response", "The response had no body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let finished = false;
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          throw this.abortOr(req.signal, () => this.err("network", `Connection to ${this.cfg.host} was lost`));
        }
        if (chunk.done) {
          buf += decoder.decode();
          buf += "\n";
        } else {
          buf += decoder.decode(chunk.value, { stream: true });
        }
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          const ev = parseSseLine(line);
          if (!ev) continue;
          if ("done" in ev) {
            finished = true;
            return;
          }
          if ("error" in ev) throw this.err("server", `The model service reported: ${this.redact(ev.error)}`);
          yield ev.text;
        }
        if (chunk.done) {
          finished = true;
          return;
        }
      }
    } finally {
      if (!finished) void reader.cancel().catch(() => {});
      else reader.releaseLock();
    }
  }

  async complete(req: LlmRequest): Promise<string> {
    return this.completeWith(req, {});
  }

  async json<T>(req: LlmRequest, spec: JsonSpec<T>): Promise<T> {
    if (this.jsonMode === "schema") {
      try {
        const text = await this.completeWith(req, {
          response_format: { type: "json_schema", json_schema: { name: spec.name, strict: true, schema: spec.schema } },
        });
        return parseAndValidate(text, spec);
      } catch (err) {
        if (!(err instanceof LlmError && err.kind === "bad_request")) throw err;
        this.log(`json_schema rejected (${err.message}); switching to JSON mode for this session`);
        this.jsonMode = "object";
      }
    }
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `Reply with one JSON object and nothing else. It must match this JSON schema:\n${JSON.stringify(spec.schema)}`,
      },
      ...req.messages,
    ];
    const text = await this.completeWith({ ...req, messages }, { response_format: { type: "json_object" } });
    return parseAndValidate(text, spec);
  }

  // --- internals -------------------------------------------------------------------------------

  private async completeWith(req: LlmRequest, extra: Record<string, unknown>): Promise<string> {
    const res = await this.post(this.body(req, extra), req.signal);
    let obj: any;
    try {
      obj = await res.json();
    } catch {
      throw this.abortOr(req.signal, () => this.err("bad_response", "The response was not JSON"));
    }
    const u = obj?.usage;
    if (this.onUsage && u && typeof u.total_tokens === "number") {
      this.onUsage({
        model: this.cfg.model,
        promptTokens: Number(u.prompt_tokens) || 0,
        completionTokens: Number(u.completion_tokens) || 0,
        totalTokens: u.total_tokens,
        cachedTokens: Number(u.prompt_tokens_details?.cached_tokens) || 0,
      });
    }
    const content = obj?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw this.err("bad_response", "The response had no message content");
    return content;
  }

  private body(req: LlmRequest, extra: Record<string, unknown>): Record<string, unknown> {
    const body: Record<string, unknown> = { model: this.cfg.model, messages: req.messages };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (this.cfg.reasoningEffort) body.reasoning_effort = this.cfg.reasoningEffort;
    return { ...body, ...extra };
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      throw this.abortOr(signal, () => this.err("network", `Can't reach ${this.cfg.host}`));
    }
    if (!res.ok) throw await this.httpError(res);
    return res;
  }

  private async httpError(res: Response): Promise<LlmError> {
    let detail = "";
    try {
      const text = await res.text();
      try {
        const obj = JSON.parse(text);
        detail = String(obj?.error?.message ?? obj?.message ?? obj?.error ?? "");
      } catch {
        detail = text;
      }
    } catch {
      // body unreadable: status alone is enough
    }
    detail = this.redact(detail).replace(/\s+/g, " ").trim().slice(0, 300);
    const status = res.status;
    const msg = `HTTP ${status}${detail ? `: ${detail}` : ""}`;
    if (status === 401 || status === 403) return this.err("auth", msg, { status });
    if (status === 404) return this.err("not_found", msg, { status });
    if (status === 429) {
      const ra = Number.parseFloat(res.headers.get("retry-after") ?? "");
      return this.err("rate_limit", msg, { status, retryAfterS: Number.isFinite(ra) ? Math.ceil(ra) : undefined });
    }
    if (status === 400 || status === 422) return this.err("bad_request", msg, { status });
    return this.err("server", msg, { status });
  }

  private abortOr(signal: AbortSignal | undefined, otherwise: () => LlmError): LlmError {
    if (signal?.aborted) {
      return signal.reason instanceof LlmError ? signal.reason : this.err("cancelled", "Request cancelled");
    }
    return otherwise();
  }

  private err(kind: LlmErrorKind, message: string, extra: { status?: number; retryAfterS?: number } = {}): LlmError {
    return new LlmError(kind, message, { ...extra, host: this.cfg.host, model: this.cfg.model });
  }

  private redact(s: string): string {
    const key = this.cfg.apiKey;
    return key ? s.split(key).join("[key]") : s;
  }
}

function parseAndValidate<T>(text: string, spec: JsonSpec<T>): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch {
    throw new LlmError("bad_response", "The model's answer was not valid JSON");
  }
  try {
    return spec.validate(value);
  } catch (err) {
    throw new LlmError("bad_response", `The model's answer did not match the schema: ${(err as Error).message}`);
  }
}

/** Stands in when app/.env is incomplete: every call fails with the config error. */
export class MisconfiguredClient implements LlmClient {
  constructor(private readonly error: LlmError) {}
  describe(): string {
    return "not configured";
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<string> {
    throw this.error;
  }
  async json<T>(): Promise<T> {
    throw this.error;
  }
  async complete(): Promise<string> {
    throw this.error;
  }
}

// --- timeouts, warm-up, advice ----------------------------------------------------------------

/**
 * Runs fn with an AbortSignal that fires after `ms` (on `clock`) or when `cancel` aborts.
 * Rejects with LlmError("timeout") / LlmError("cancelled") right away, even if fn ignores the signal.
 */
export function withTimeout<T>(
  clock: Clock,
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
  cancel?: AbortSignal,
): Promise<T> {
  const ac = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (f: () => void) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      cancel?.removeEventListener("abort", onCancel);
      f();
    };
    const fail = (e: LlmError) => {
      ac.abort(e);
      finish(() => reject(e));
    };
    const timer = clock.setTimeout(() => fail(new LlmError("timeout", `No answer within ${Math.round(ms / 1000)} s`)), ms);
    const onCancel = () => fail(new LlmError("cancelled", "Cancelled"));
    if (cancel?.aborted) {
      onCancel();
      return;
    }
    cancel?.addEventListener("abort", onCancel);
    let p: Promise<T>;
    try {
      p = fn(ac.signal);
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}

export const DEFAULT_TIMEOUT_MS = 20_000;

export type WarmUpResult = { ok: true; ms: number } | { ok: false; ms: number; error: LlmError };

/** One tiny request to check the key and the connection. */
export async function warmUp(client: LlmClient, clock: Clock, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<WarmUpResult> {
  const start = clock.now();
  try {
    await withTimeout(clock, timeoutMs, (signal) =>
      client.complete({ messages: [{ role: "user", content: "Reply with the word OK." }], maxTokens: 64, signal }),
    );
    return { ok: true, ms: clock.now() - start };
  } catch (err) {
    return { ok: false, ms: clock.now() - start, error: toLlmError(err) };
  }
}

/** One or two sentences that tell the user what to do. */
export function errorAdvice(err: LlmError): string {
  const host = err.extra.host ?? "the model service";
  switch (err.kind) {
    case "config":
      return err.message;
    case "auth":
      return `The API key was rejected (HTTP ${err.extra.status ?? 401}). Check LLM_API_KEY in app/.env, then restart the app.`;
    case "not_found":
      return `Model "${err.extra.model ?? "?"}" was not found at ${host}. Check LLM_MODEL and LLM_BASE_URL in app/.env.`;
    case "rate_limit":
      return err.extra.retryAfterS
        ? `Too many requests (rate limit). Wait ${err.extra.retryAfterS} s, then press again.`
        : "Too many requests (rate limit). Wait a moment, then press again.";
    case "timeout":
      return "No answer within 20 s. Press again in a moment.";
    case "network":
      return `Can't reach ${host}. Check the internet connection (for Ollama: is it running?).`;
    case "bad_request":
      return `${host} rejected the request (HTTP ${err.extra.status ?? 400}). Press again; if it keeps failing, try another LLM_MODEL.`;
    case "server":
      return `${host} had a problem${err.extra.status ? ` (HTTP ${err.extra.status})` : ""}. Press again in a moment.`;
    case "bad_response":
      return "The model's answer could not be used. Press again.";
    case "cancelled":
      return "Cancelled.";
  }
}
