import { LlmError, type JsonSpec, type LlmClient, type LlmRequest } from "../src/pipeline/llm.js";

/** A call the test controls: push chunks, then end / fail / resolve. Honours the abort signal. */
export class FakeCall {
  private queue: string[] = [];
  private ended = false;
  private error: unknown = null;
  private wake: (() => void) | null = null;
  private value: unknown;
  private settle: { resolve: (v: unknown) => void; reject: (e: unknown) => void } | null = null;
  aborted = false;

  constructor(
    readonly kind: "stream" | "json" | "complete",
    readonly req: LlmRequest,
  ) {
    req.signal?.addEventListener("abort", () => {
      this.aborted = true;
      this.fail(req.signal!.reason ?? new LlmError("cancelled", "aborted"));
    });
  }

  /** Stream calls: next text delta. */
  push(...chunks: string[]): this {
    this.queue.push(...chunks);
    this.poke();
    return this;
  }

  /** Stream: no more chunks. json/complete: resolve with `value`. */
  end(value?: unknown): this {
    this.ended = true;
    this.value = value;
    this.settle?.resolve(value);
    this.poke();
    return this;
  }

  fail(err: unknown): this {
    if (this.error === null && !this.ended) this.error = err;
    this.settle?.reject(err);
    this.poke();
    return this;
  }

  async *iterate(): AsyncIterable<string> {
    for (;;) {
      if (this.queue.length) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.error !== null) throw this.error;
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
    }
  }

  promise(): Promise<unknown> {
    if (this.error !== null) return Promise.reject(this.error);
    if (this.ended) return Promise.resolve(this.value);
    return new Promise((resolve, reject) => (this.settle = { resolve, reject }));
  }

  private poke(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }
}

/** LlmClient for tests: every call is recorded and stays pending until the test drives it. */
export class FakeLlmClient implements LlmClient {
  readonly calls: FakeCall[] = [];

  describe(): string {
    return "fake-model @ fake";
  }

  stream(req: LlmRequest): AsyncIterable<string> {
    const c = new FakeCall("stream", req);
    this.calls.push(c);
    return c.iterate();
  }

  async json<T>(req: LlmRequest, spec: JsonSpec<T>): Promise<T> {
    const c = new FakeCall("json", req);
    this.calls.push(c);
    const v = await c.promise();
    try {
      return spec.validate(v);
    } catch (err) {
      throw new LlmError("bad_response", (err as Error).message);
    }
  }

  async complete(req: LlmRequest): Promise<string> {
    const c = new FakeCall("complete", req);
    this.calls.push(c);
    return String(await c.promise());
  }

  last(): FakeCall {
    const c = this.calls[this.calls.length - 1];
    if (!c) throw new Error("no LLM call was made");
    return c;
  }
}

/** Let pending promise callbacks run. */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}
