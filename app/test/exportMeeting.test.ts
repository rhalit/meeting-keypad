import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MeetingExporter,
  buildMeetingMarkdown,
  fileStamp,
  formatDuration,
  validateSummary,
  type MeetingSnapshot,
} from "../src/pipeline/exportMeeting.js";
import { LlmError } from "../src/pipeline/llm.js";
import { MeetingRecord } from "../src/pipeline/meetingRecord.js";
import { FakeClock } from "./fakeClock.js";
import { FakeLlmClient, flush } from "./fakeLlm.js";

const START = new Date(2026, 10, 22, 14, 5, 30);

function snapshot(over: Partial<MeetingSnapshot> = {}): MeetingSnapshot {
  return {
    meetingId: 1,
    mode: "mock",
    startedAt: START,
    durationS: 291,
    spokenS: 240,
    listenerName: "Rhali",
    lines: [
      { t: 10, speaker: "Lena", text: "Let's start with the LoRA results." },
      { t: 152, speaker: "Lena", text: "Rhali, can you own the SOC 2 questionnaire?" },
      { t: 291, speaker: "Omar", text: "Thanks everyone." },
    ],
    terms: [
      { term: "LoRA", category: "Tech", t: 10, opened: true, full: "Low-rank adaptation", explanation: "A cheap way to fine-tune." },
      { term: "SOC 2", category: "Law", t: 150, opened: false, full: "SOC 2", explanation: "A security audit standard." },
    ],
    questions: [
      {
        t: 152,
        speaker: "Lena",
        line: "Rhali, can you own the SOC 2 questionnaire?",
        heard: "rhali",
        question: "Can you own the SOC 2 questionnaire?",
        context: "A customer review is coming. Lena needs an owner.",
        suggestedReply: "Yes, I'll own it.",
        opened: true,
      },
    ],
    ideas: [{ title: "Canary rollout first", summary: "Ship to 5 % first.", quote: "five percent of traffic first", t: 108 }],
    catchUps: [{ t: 160, body: "- Said: x\n- Decided: y\n- Now: z" }],
    ...over,
  };
}

const summary = { kind: "ok" as const, title: "Model launch review", bullets: ["One", "Two", "Three", "Four", "Five"] };

describe("buildMeetingMarkdown", () => {
  it("has title, date, duration and every section in order", () => {
    const md = buildMeetingMarkdown(snapshot(), summary);
    expect(md.startsWith("# Model launch review\n")).toBe(true);
    expect(md).toContain("**Date:** 2026-11-22 14:05");
    expect(md).toContain("**Duration:** 4 min 51 s");
    const order = ["## Summary", "## Questions for Rhali", "## Saved ideas", "## Terms", "## Catch-ups", "## Transcript"];
    const at = order.map((h) => md.indexOf(h));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(md).toContain("- One\n- Two\n- Three\n- Four\n- Five");
    expect(md).toContain("**Can you own the SOC 2 questionnaire?**");
    expect(md).toContain("*Suggested reply:* Yes, I'll own it.");
    expect(md).toContain("### 2:32 · Lena · opened");
    expect(md).toContain("### Canary rollout first");
    expect(md).toContain("### 2:40\n\n- Said: x");
    expect(md).toContain("[0:10] Lena: Let's start with the LoRA results.");
    expect(md.trimEnd().endsWith("[4:51] Omar: Thanks everyone.")).toBe(true);
  });

  it("lists terms in order of appearance, opened ones marked", () => {
    const md = buildMeetingMarkdown(snapshot(), summary);
    expect(md).toContain("- **LoRA** (Low-rank adaptation) · Tech · 0:10 · opened ✓  \n  A cheap way to fine-tune.");
    expect(md).toContain("- **SOC 2** · Law · 2:30  \n  A security audit standard.");
    expect(md.indexOf("**LoRA**")).toBeLessThan(md.indexOf("**SOC 2**"));
  });

  it("says when the summary was skipped or failed, and when sections are empty", () => {
    const empty = snapshot({ questions: [], ideas: [], terms: [], catchUps: [] });
    const md = buildMeetingMarkdown(empty, { kind: "skipped" });
    expect(md.startsWith("# Mock meeting\n")).toBe(true);
    expect(md).toContain("Skipped: less than 30 s was said.");
    expect(md.match(/^None\.$/gm)).toHaveLength(4);
    expect(buildMeetingMarkdown(snapshot({ mode: "live" }), { kind: "failed", reason: "rate limit" })).toContain(
      "Summary unavailable (rate limit).",
    );
    const missing = snapshot({ terms: [{ term: "eBPF", category: "Tech", t: 3, opened: false, explanation: "" }] });
    expect(buildMeetingMarkdown(missing, summary)).toContain("*(explanation not ready)*");
  });
});

describe("helpers", () => {
  it("formats the file stamp and durations", () => {
    expect(fileStamp(START)).toBe("2026-11-22 1405");
    expect(formatDuration(38.4)).toBe("38 s");
    expect(formatDuration(291)).toBe("4 min 51 s");
  });

  it("validateSummary keeps 5 clean bullets", () => {
    const v = validateSummary({ title: "Review.", bullets: ["- **A**", "B", "", "C", "D", "E", "F"] });
    expect(v).toEqual({ title: "Review", bullets: ["A", "B", "C", "D", "E"] });
    expect(() => validateSummary({ title: "x", bullets: [] })).toThrow();
  });

  it("MeetingRecord: start time, spoken seconds, terms once in order, opened", () => {
    const r = new MeetingRecord(() => new Date(START.getTime() + 20_000));
    r.addLine({ t: 20, text: "one two three four five" }); // 2 s estimated
    r.addLine({ t: 25, text: "x", end: 31 }); // 6 s from timings
    expect(r.startedAt?.getTime()).toBe(START.getTime());
    expect(r.spokenS).toBeCloseTo(8);
    r.placed("LoRA", "Tech", 20);
    r.placed("lora", "Tech", 30);
    r.placed("RAG", "Tech", 40);
    r.opened("RAG");
    expect(r.terms()).toEqual([
      { term: "LoRA", category: "Tech", t: 20, opened: false },
      { term: "RAG", category: "Tech", t: 40, opened: true },
    ]);
    const id = r.id;
    r.reset();
    expect(r.id).toBe(id + 1);
    expect(r.terms()).toEqual([]);
    expect(r.startedAt).toBeNull();
  });
});

describe("MeetingExporter", () => {
  let dir: string;
  let clock: FakeClock;
  let llm: FakeLlmClient;
  let ex: MeetingExporter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meetings-"));
    clock = new FakeClock();
    llm = new FakeLlmClient();
    ex = new MeetingExporter({ clock, llm, dir, log: () => {} });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("one summary call, the file at output/meetings/<YYYY-MM-DD HHmm>.md", async () => {
    const p = ex.export(snapshot());
    await flush();
    expect(llm.calls).toHaveLength(1);
    expect(llm.last().req.messages[1].content).toContain("[2:32] Lena: Rhali, can you own");
    llm.last().end({ title: "Model launch review", bullets: ["One", "Two", "Three", "Four", "Five"] });
    const r = await p;
    expect(r).toEqual({ status: "written", path: join(dir, "2026-11-22 1405.md"), summary: "model" });
    const md = readFileSync(join(dir, "2026-11-22 1405.md"), "utf8");
    expect(md.startsWith("# Model launch review")).toBe(true);
  });

  it("no call when fewer than 30 s were said", async () => {
    const r = await ex.export(snapshot({ spokenS: 29 }));
    expect(r).toMatchObject({ status: "written", summary: "skipped" });
    expect(llm.calls).toHaveLength(0);
    expect(readFileSync(join(dir, "2026-11-22 1405.md"), "utf8")).toContain("Skipped: less than 30 s was said.");
  });

  it("nothing said: no file, no call", async () => {
    expect(await ex.export(snapshot({ lines: [] }))).toEqual({ status: "empty" });
    expect(readdirSync(dir)).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it("re-export of the same meeting with nothing new reuses the summary and the file; a new line asks again", async () => {
    const a = ex.export(snapshot());
    const b = ex.export(snapshot({ ideas: [] })); // a quick second export waits for the first
    await flush();
    expect(llm.calls).toHaveLength(1);
    llm.last().end({ title: "Review", bullets: ["A"] });
    expect((await a).status).toBe("written");
    expect(await b).toMatchObject({ status: "written", summary: "cached", path: join(dir, "2026-11-22 1405.md") });
    expect(llm.calls).toHaveLength(1);
    expect(readFileSync(join(dir, "2026-11-22 1405.md"), "utf8")).toContain("## Saved ideas\n\nNone.");
    const more = snapshot();
    more.lines = [...more.lines, { t: 300, speaker: "Lena", text: "One more thing." }];
    const c = ex.export(more);
    await flush();
    expect(llm.calls).toHaveLength(2);
    llm.last().end({ title: "Review", bullets: ["A", "B"] });
    expect(await c).toMatchObject({ summary: "model", path: join(dir, "2026-11-22 1405.md") });
    expect(readdirSync(dir)).toEqual(["2026-11-22 1405.md"]);
  });

  it("another meeting in the same minute gets ' 2'; an existing file is not overwritten", async () => {
    writeFileSync(join(dir, "2026-11-22 1405.md"), "older run");
    const r1 = await ex.export(snapshot({ spokenS: 0 }));
    const r2 = await ex.export(snapshot({ meetingId: 2, spokenS: 0 }));
    expect(r1).toMatchObject({ path: join(dir, "2026-11-22 1405 2.md") });
    expect(r2).toMatchObject({ path: join(dir, "2026-11-22 1405 3.md") });
    expect(readFileSync(join(dir, "2026-11-22 1405.md"), "utf8")).toBe("older run");
  });

  it("a failed summary still writes the file", async () => {
    const p = ex.export(snapshot());
    await flush();
    llm.last().fail(new LlmError("rate_limit", "429"));
    expect(await p).toMatchObject({ status: "written", summary: "failed" });
    expect(readFileSync(join(dir, "2026-11-22 1405.md"), "utf8")).toContain("Summary unavailable (rate limit).");
  });
});
