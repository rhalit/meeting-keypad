import { beforeEach, describe, expect, it } from "vitest";
import { LlmError } from "../src/pipeline/llm.js";
import { SPOTTER_SCHEMA } from "../src/pipeline/prompts.js";
import { CATEGORIES } from "../src/pipeline/protocol.js";
import { SlotManager } from "../src/pipeline/slots.js";
import { TermSpotter, editDistance, findLine, heardInNew, heardSpan, variantOf, type SpotInfo } from "../src/pipeline/termSpotter.js";
import type { TermCandidate } from "../src/pipeline/terms.js";
import { FakeClock } from "./fakeClock.js";
import { FakeLlmClient, flush } from "./fakeLlm.js";

const S = 1000;
const listener = { name: "Rhali", knows: "robotics student" };

function raw(term: string, extra: Partial<{ heard: string; full: string; variantOf: string; category: string; confidence: number; reason: string }> = {}) {
  return { term, heard: term, full: term, variantOf: "", category: "Tech", confidence: 0.9, reason: "jargon", ...extra };
}

describe("TermSpotter", () => {
  let clock: FakeClock;
  let llm: FakeLlmClient;
  let spotter: TermSpotter;
  let terms: { c: TermCandidate; info: SpotInfo }[];
  let logs: string[];

  const line = (t: number, text: string) => spotter.addLine({ t, speaker: "Speaker 1", text });
  const userMsg = (i: number) => llm.calls[i].req.messages[llm.calls[i].req.messages.length - 1].content;

  beforeEach(() => {
    clock = new FakeClock();
    llm = new FakeLlmClient();
    logs = [];
    spotter = new TermSpotter({ clock, llm, listener, log: (m) => logs.push(m) });
    terms = [];
    spotter.on("term", (c: TermCandidate, info: SpotInfo) => terms.push({ c, info }));
  });

  describe("throttling", () => {
    it("calls right away for the first line, then at most once per 8 s, one call at a time", async () => {
      line(0, "We built it with RAG.");
      expect(llm.calls).toHaveLength(1);
      clock.advance(1 * S);
      line(1, "It quotes the source now.");
      clock.advance(1 * S);
      line(2, "All documents are in a vector database.");
      expect(llm.calls).toHaveLength(1); // first call still in flight, and < 8 s
      llm.calls[0].end({ terms: [] });
      await flush();
      expect(llm.calls).toHaveLength(1);
      clock.advance(5999); // 7.999 s after the first call started
      expect(llm.calls).toHaveLength(1);
      clock.advance(1);
      expect(llm.calls).toHaveLength(2);
      // The second call carries both new lines, the first one as context only.
      expect(userMsg(1)).toContain("NEW:\n[0:01] Speaker 1: It quotes the source now.\n[0:02] Speaker 1: All documents");
      expect(userMsg(1)).toContain("Earlier (context only");
      expect(userMsg(1)).toContain("We built it with RAG.");
    });

    it("waits for a slow call to finish before the next one", async () => {
      line(0, "one");
      clock.advance(9 * S); // the call is still running after 9 s (timeout is 10 s)
      line(9, "two");
      expect(llm.calls).toHaveLength(1);
      llm.calls[0].end({ terms: [] });
      await flush();
      expect(llm.calls).toHaveLength(2); // already 8 s since the first started
    });

    it("uses the configured interval (LLM_SPOTTER_INTERVAL_MS)", async () => {
      spotter = new TermSpotter({ clock, llm, listener, log: () => {}, minIntervalMs: 5000 });
      spotter.addLine({ t: 0, text: "one" });
      llm.calls[0].end({ terms: [] });
      await flush();
      spotter.addLine({ t: 1, text: "two" });
      clock.advance(4999);
      expect(llm.calls).toHaveLength(1);
      clock.advance(1);
      expect(llm.calls).toHaveLength(2);
    });
  });

  it("makes no calls during silence", async () => {
    line(0, "hello");
    llm.calls[0].end({ terms: [] });
    await flush();
    clock.advance(60 * S);
    await flush();
    expect(llm.calls).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });

  it("ignores blank lines", () => {
    line(0, "   ");
    expect(llm.calls).toHaveLength(0);
  });

  describe("back-off on rate limits", () => {
    it("honours retry-after, doubles on the next 429, keeps only the latest lines, resets after success", async () => {
      line(0, "first line");
      llm.calls[0].fail(new LlmError("rate_limit", "HTTP 429", { status: 429, retryAfterS: 20 }));
      await flush();
      expect(spotter.status().state).toBe("backoff");
      // Lines keep coming in while paused; no call before 20 s.
      for (let i = 1; i <= 9; i++) {
        clock.advance(2 * S);
        line(i * 2, `line ${i}`);
      }
      expect(llm.calls).toHaveLength(1);
      clock.advance(1999); // 19.999 s
      expect(llm.calls).toHaveLength(1);
      clock.advance(1);
      expect(llm.calls).toHaveLength(2);
      // Only the latest 6 lines go out; older ones are skipped, not queued.
      const msg = userMsg(1);
      expect(msg).toContain("line 9");
      expect(msg).toContain("line 4");
      expect(msg).not.toContain("line 3");
      expect(msg).not.toContain("first line");
      expect(spotter.stats.skippedLines).toBe(4);

      // Second 429 in a row without retry-after: 16 s.
      llm.calls[1].fail(new LlmError("rate_limit", "HTTP 429", { status: 429 }));
      await flush();
      line(21, "more");
      clock.advance(15_999);
      expect(llm.calls).toHaveLength(2);
      clock.advance(1);
      expect(llm.calls).toHaveLength(3);

      // Success resets the streak: the next 429 waits 8 s again.
      llm.calls[2].end({ terms: [] });
      await flush();
      clock.advance(8 * S);
      line(40, "again");
      expect(llm.calls).toHaveLength(4);
      llm.calls[3].fail(new LlmError("rate_limit", "HTTP 429", { status: 429 }));
      await flush();
      clock.advance(7999);
      expect(llm.calls).toHaveLength(4);
      clock.advance(1);
      expect(llm.calls).toHaveLength(5);
      expect(spotter.stats.rateLimited).toBe(3);
    });

    it("drops the batch on other errors and carries on", async () => {
      line(0, "one");
      llm.calls[0].fail(new LlmError("server", "HTTP 500"));
      await flush();
      clock.advance(8 * S);
      line(8, "two");
      expect(llm.calls).toHaveLength(2);
      expect(userMsg(1)).not.toContain("NEW:\n[0:00]");
    });

    it("stops on an auth error", async () => {
      line(0, "one");
      llm.calls[0].fail(new LlmError("auth", "HTTP 401"));
      await flush();
      clock.advance(10 * S);
      line(10, "two");
      expect(llm.calls).toHaveLength(1);
      expect(spotter.status().state).toBe("error");
    });

    it("a call that never answers times out after 10 s and the spotter goes on", async () => {
      line(0, "one");
      clock.advance(10 * S);
      await flush();
      line(10, "two");
      expect(llm.calls).toHaveLength(2);
    });
  });

  describe("filtering", () => {
    it("keeps confidence >= 0.7, at most the 2 most confident, emits live candidates", async () => {
      line(0, "We use RAG with a vector database behind a feature flag and a canary release.");
      llm.calls[0].end({
        terms: [
          raw("feature flag", { confidence: 0.75 }),
          raw("RAG", { confidence: 0.95 }),
          raw("canary release", { confidence: 0.69 }),
          raw("vector database", { confidence: 0.9 }),
        ],
      });
      await flush();
      expect(terms.map((t) => t.c)).toEqual([
        { term: "RAG", category: "Tech", source: "live" },
        { term: "vector database", category: "Tech", source: "live" },
      ]);
      expect(logs.some((l) => l.includes('skip "canary release" (confidence 0.69)'))).toBe(true);
      expect(logs.some((l) => l.includes('skip "feature flag" (more than 2'))).toBe(true);
    });

    it("never repeats a term in the same meeting, and lists shown terms in the prompt", async () => {
      line(0, "RAG is great.");
      llm.calls[0].end({ terms: [raw("RAG")] });
      await flush();
      clock.advance(8 * S);
      line(8, "More about rags.");
      expect(userMsg(1)).toContain("Already shown: RAG");
      llm.calls[1].end({ terms: [raw("RAGs", { heard: "rags" }), raw("rag", { heard: "rags" })] });
      await flush();
      expect(terms).toHaveLength(1);
    });

    it("drops long phrases, bad categories, duplicates in one answer, and the listener's name", async () => {
      line(0, "Rhali, the thing about the very long phrase here is SOC 2.");
      llm.calls[0].end({
        terms: [
          raw("the very long phrase here"),
          raw("Rhali"),
          raw("SOC 2", { category: "Crypto" }),
          raw("SOC 2", { category: "Law", confidence: 0.8 }),
          raw("SOC 2", { category: "Law", confidence: 0.8 }),
        ],
      });
      await flush();
      expect(terms.map((t) => t.c.term)).toEqual(["SOC 2"]);
      expect(terms[0].c.category).toBe("Law");
    });

    it("an answer with malformed items keeps the good ones", async () => {
      line(0, "LoRA.");
      llm.calls[0].end({ terms: [{ nope: 1 }, raw("LoRA")] });
      await flush();
      expect(terms.map((t) => t.c.term)).toEqual(["LoRA"]);
    });

    it("finds the line a canonical term was heard in through `heard`", async () => {
      line(0, "Moving on to security.");
      line(0.5, "The bank pilot won't sign until we have so two.");
      clock.advance(8 * S);
      llm.calls[0].end({ terms: [] });
      await flush();
      llm.calls[1].end({ terms: [raw("SOC 2", { heard: "so two", category: "Law" })] });
      await flush();
      expect(terms[0].info.line.text).toBe("The bank pilot won't sign until we have so two.");
      expect(terms[0].info.context.map((l) => l.text)).toEqual(["Moving on to security."]);
    });

    it("accepts a term only if its heard words are in the NEW lines, not only in the context", async () => {
      line(0, "Today we talk about dopamine and NSDR.");
      llm.calls[0].end({ terms: [] });
      await flush();
      clock.advance(8 * S);
      line(8, "It helps you focus.");
      expect(userMsg(1)).toContain("Earlier (context only");
      llm.calls[1].end({ terms: [raw("dopamine", { category: "Science" }), raw("NSDR", { heard: "nsdr", category: "Health" })] });
      await flush();
      expect(terms).toHaveLength(0);
      expect(logs.some((l) => l.includes('skip "dopamine" (not heard in new lines'))).toBe(true);
    });

    it("accepts a term cut by a line boundary (starts in the last context line)", async () => {
      line(0, "Then you store all of it in a vector");
      llm.calls[0].end({ terms: [] });
      await flush();
      clock.advance(8 * S);
      line(6, "database, so search works by meaning.");
      llm.calls[1].end({ terms: [raw("vector database", { heard: "vector database" })] });
      await flush();
      expect(terms.map((t) => t.c.term)).toEqual(["vector database"]);
    });

    it("drops variants and mishearings of terms already shown", async () => {
      line(0, "Try NSDR, non-sleep deep rest.");
      llm.calls[0].end({ terms: [raw("NSDR", { full: "non-sleep deep rest", category: "Health" })] });
      await flush();
      clock.advance(8 * S);
      line(8, "NSTR is great, non sleep deep rest really works, also Yoga Nidra.");
      llm.calls[1].end({
        terms: [
          raw("NSTR", { category: "Health" }),
          raw("non-sleep deep rest", { heard: "non sleep deep rest", category: "Health" }),
          raw("Yoga Nidra", { variantOf: "NSDR", category: "Health" }),
        ],
      });
      await flush();
      expect(terms.map((t) => t.c.term)).toEqual(["NSDR"]);
      expect(logs.filter((l) => l.includes('(variant of "NSDR")'))).toHaveLength(3);
    });

    it("drops a term whose full name matches one already shown", async () => {
      line(0, "We use RAG here.");
      llm.calls[0].end({ terms: [raw("RAG", { full: "Retrieval-augmented generation" })] });
      await flush();
      clock.advance(8 * S);
      line(8, "Retrieval augmented generation again.");
      llm.calls[1].end({ terms: [raw("retrieval augmented generation", { full: "retrieval-augmented generation" })] });
      await flush();
      expect(terms.map((t) => t.c.term)).toEqual(["RAG"]);
    });

    it("reports when the heard words were spoken, from word timestamps", async () => {
      spotter.addLine({
        t: 10,
        text: "We use RAG daily.",
        words: [
          { text: "We", start: 10, end: 10.2 },
          { text: "use", start: 10.3, end: 10.5 },
          { text: "RAG", start: 10.6, end: 11.0 },
          { text: "daily.", start: 11.1, end: 11.5 },
        ],
      });
      llm.calls[0].end({ terms: [raw("RAG")] });
      await flush();
      expect(terms[0].info.spokenAt).toBe(11.0);
      expect(terms[0].info.full).toBe("RAG");
    });
  });

  it("reset() aborts the call in flight and forgets the meeting", async () => {
    line(0, "RAG");
    const call = llm.calls[0];
    spotter.reset();
    await flush();
    expect(call.aborted).toBe(true);
    call.end({ terms: [raw("RAG")] });
    await flush();
    expect(terms).toHaveLength(0);
    line(0, "RAG again");
    expect(llm.calls).toHaveLength(2); // no 8 s wait after a reset
    expect(userMsg(1)).toContain("Already shown: none");
  });

  it("feeds the existing SlotManager", async () => {
    const slots = new SlotManager({ clock });
    spotter.on("term", (c: TermCandidate) => slots.add(c));
    line(0, "RAG");
    llm.calls[0].end({ terms: [raw("RAG")] });
    await flush();
    expect(slots.termAt(0)).toBe("RAG");
    expect(slots.candidateAt(0)?.source).toBe("live");
  });
});

describe("findLine", () => {
  const lines = [
    { t: 0, text: "We applied quantisation to the model." },
    { t: 1, text: "The cold start is eight seconds." },
  ];
  it("prefers the verbatim heard words, then term words, then the last line", () => {
    expect(findLine(lines, "cold start", "cold start").t).toBe(1);
    expect(findLine(lines, "quantisation", "quantization").t).toBe(0);
    expect(findLine(lines, "", "the model").t).toBe(0);
    expect(findLine(lines, "", "zzz").t).toBe(1);
  });
});

describe("heardInNew", () => {
  const ctx = [{ t: 0, text: "Store it in a vector" }];
  it("finds the words in the new lines, ignoring case and punctuation", () => {
    expect(heardInNew("so two", "SOC 2", [{ t: 1, text: "We need So-Two." }], [])).toBe(true);
    expect(heardInNew("", "SOC 2", [{ t: 1, text: "We need SOC 2." }], [])).toBe(true);
    expect(heardInNew("dopamine", "dopamine", [{ t: 1, text: "nothing here" }], [{ t: 0, text: "dopamine" }])).toBe(false);
  });
  it("accepts a run that starts in the last context line and ends in the new text", () => {
    expect(heardInNew("vector database", "vector database", [{ t: 1, text: "database, done." }], ctx)).toBe(true);
    expect(heardInNew("a vector", "x", [{ t: 1, text: "database" }], ctx)).toBe(false); // all in the context
  });
});

describe("heardSpan", () => {
  it("uses the last occurrence and returns its first word start and last word end", () => {
    const lines = [
      { t: 0, text: "cold start", words: [{ text: "cold", start: 1, end: 1.2 }, { text: "start", start: 1.3, end: 1.6 }] },
      { t: 5, text: "a cold start", words: [{ text: "a", start: 5, end: 5.1 }, { text: "cold", start: 5.2, end: 5.4 }, { text: "start.", start: 5.5, end: 5.9 }] },
    ];
    expect(heardSpan(lines, "cold start", "cold start")).toEqual({ start: 5.2, end: 5.9 });
    expect(heardSpan([{ t: 0, text: "no words" }], "x", "x")).toBeUndefined();
  });
});

describe("variantOf", () => {
  const shown = [
    { term: "NSDR", full: "non-sleep deep rest" },
    { term: "vector database", full: "vector database" },
  ];
  it.each([
    [{ term: "NSTR", full: "NSTR", variantOf: "" }, "NSDR"], // edit distance 1
    [{ term: "non-sleep deep rest", full: "", variantOf: "" }, "NSDR"], // same full name
    [{ term: "Non Sleep Deep Rest", full: "", variantOf: "" }, "NSDR"], // same full name / initials
    [{ term: "Yoga Nidra", full: "yoga sleep", variantOf: "NSDR" }, "NSDR"], // the model says so
    [{ term: "VDB", full: "vector database", variantOf: "" }, "vector database"],
    [{ term: "NAD", full: "nicotinamide adenine dinucleotide", variantOf: "" }, null],
    [{ term: "dopamine", full: "dopamine", variantOf: "" }, null],
    [{ term: "CAC", full: "customer acquisition cost", variantOf: "" }, null],
  ])("%j -> %j", (cand, expected) => {
    expect(variantOf(cand, shown)).toBe(expected);
  });
  it("short acronyms one edit apart are variants, different ones are not", () => {
    expect(variantOf({ term: "LTV", full: "", variantOf: "" }, [{ term: "CAC", full: "" }])).toBeNull();
    expect(variantOf({ term: "SOC 3", full: "", variantOf: "" }, [{ term: "SOC 2", full: "" }])).toBeNull(); // has a space: not an acronym
    expect(variantOf({ term: "EGG", full: "", variantOf: "" }, [{ term: "EEG", full: "" }])).toBe("EEG");
  });
  it("edit distance", () => {
    expect(editDistance("nstr", "nsdr")).toBe(1);
    expect(editDistance("rag", "rags")).toBe(1);
    expect(editDistance("abc", "xyz")).toBe(3);
  });
});

describe("spotter schema", () => {
  it("asks for heard, full and variantOf, with the general categories and no label", () => {
    const item = (SPOTTER_SCHEMA as any).properties.terms.items;
    expect(item.required).toEqual(["term", "heard", "full", "variantOf", "category", "confidence", "reason"]);
    expect(item.properties.category.enum).toEqual([...CATEGORIES]);
    expect(item.properties.label).toBeUndefined();
  });
});
