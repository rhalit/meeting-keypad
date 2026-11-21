import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LlmError } from "../src/pipeline/llm.js";
import { OverlayController, type TextCard } from "../src/pipeline/overlay.js";
import type { KeyState } from "../src/pipeline/protocol.js";
import {
  SAVED_GREEN,
  SAVE_SLOT,
  SaveController,
  fileSavedIdeas,
  findDuplicate,
  formatEntry,
  normalizeIdea,
  validateIdea,
} from "../src/pipeline/save.js";
import { SlotManager } from "../src/pipeline/slots.js";
import { TranscriptBuffer, type TranscriptLine } from "../src/pipeline/transcriptBuffer.js";
import { FakeClock } from "./fakeClock.js";
import { FakeLlmClient, flush } from "./fakeLlm.js";

const LINES: TranscriptLine[] = [
  { t: 99, speaker: "Omar", text: "Agreed. Then we widen it slowly." },
  { t: 103, speaker: "Lena", text: "What does slowly mean in practice?" },
  {
    t: 108,
    speaker: "Omar",
    text: "A canary release: five percent of traffic first, and if error rates stay flat, we go to everyone a week later.",
  },
  { t: 113, speaker: "Priya", text: "What happens if the five percent breaks?" },
  { t: 117, speaker: "Omar", text: "We roll back in under a minute. It's one switch." },
  { t: 124, speaker: "Omar", text: "Autoscaling handles it. The cluster adds servers when traffic climbs." },
  { t: 139, speaker: "Omar", text: "The cold start is about eight seconds while the model loads into memory." },
];

const canary = {
  title: "Canary rollout to 5 % first",
  summary: "Ship to five percent of traffic first.\nWiden to everyone a week later if errors stay flat.",
  quote: "A canary release: five percent of traffic first",
  t: 108,
};
const coldStart = {
  title: "Cold starts take eight seconds",
  summary: "A fresh server needs about eight seconds to load the model.",
  quote: "The cold start is about eight seconds",
  t: 139,
};

describe("SaveController", () => {
  let clock: FakeClock;
  let llm: FakeLlmClient;
  let transcript: TranscriptBuffer;
  let slots: SlotManager;
  let overlay: OverlayController;
  let save: SaveController;
  let written: string[];
  let slot7: KeyState[];
  let now: number;
  let failWrite: boolean;

  const card = () => overlay.current() as TextCard;
  const addUpTo = (t: number) => {
    for (const l of LINES) if (l.t <= t && !transcript.all().some((x) => x.t === l.t)) transcript.add(l);
    now = t;
  };

  beforeEach(() => {
    clock = new FakeClock();
    llm = new FakeLlmClient();
    transcript = new TranscriptBuffer();
    slots = new SlotManager({ clock });
    overlay = new OverlayController({ clock, lookup: () => undefined });
    written = [];
    slot7 = [];
    failWrite = false;
    slots.on("change", (keys: KeyState[]) => slot7.push(...keys.filter((k) => k.slot === SAVE_SLOT)));
    save = new SaveController({
      clock,
      llm,
      transcript,
      meetingTime: () => now,
      keys: slots,
      overlay,
      file: {
        append: async (md) => {
          if (failWrite) throw new Error("EACCES");
          written.push(md);
        },
      },
      log: () => {},
      now: () => new Date(2026, 10, 21, 14, 5),
    });
    addUpTo(124);
  });

  it("asks for the last 45 s as structured output and appends the idea with its meeting time", async () => {
    expect(save.press()).toBe("started");
    expect(slots.getAll()[SAVE_SLOT].state).toBe("busy");
    const call = llm.last();
    expect(call.kind).toBe("json");
    const user = call.req.messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("[t=99] Omar: Agreed.");
    expect(user).toContain("[t=124]");
    call.end(canary);
    await save.whenIdle();
    expect(save.lastResult).toBe("saved");
    expect(written).toEqual([
      "## Canary rollout to 5 % first\n*Meeting 1:48 · saved 2026-11-21 14:05*\n\n" +
        "Ship to five percent of traffic first.\nWiden to everyone a week later if errors stay flat.\n\n" +
        '> "A canary release: five percent of traffic first"\n\n',
    ]);
  });

  it('shows "Saved ✓" in green for 1.5 s and the title card for 3 s', async () => {
    save.press();
    llm.last().end(canary);
    await save.whenIdle();
    expect(slots.getAll()[SAVE_SLOT]).toMatchObject({ label: "Saved ✓", bg: SAVED_GREEN, state: "shown" });
    expect(card()).toMatchObject({ eyebrow: "Saved ✓", title: canary.title, tone: "success", durationMs: 3000 });
    clock.advance(1499);
    expect(slots.getAll()[SAVE_SLOT].label).toBe("Saved ✓");
    clock.advance(1);
    expect(slots.getAll()[SAVE_SLOT]).toMatchObject({ label: "Save", state: "shown" });
    clock.advance(1499);
    expect(overlay.current()).not.toBeNull();
    clock.advance(1);
    expect(overlay.current()).toBeNull();
    expect(slot7.map((k) => `${k.label}:${k.state}`)).toEqual(["Save:busy", "Saved ✓:shown", "Save:shown"]);
  });

  it("a second press while saving is ignored (one call, one entry)", async () => {
    save.press();
    expect(save.press()).toBe("ignored");
    expect(llm.calls).toHaveLength(1);
    llm.last().end(canary);
    await save.whenIdle();
    expect(written).toHaveLength(1);
  });

  it("pressing again with nothing new said does not ask the model or write again", async () => {
    save.press();
    llm.last().end(canary);
    await save.whenIdle();
    clock.advance(5000);
    expect(save.press()).toBe("duplicate");
    expect(llm.calls).toHaveLength(1);
    expect(written).toHaveLength(1);
    expect(card()).toMatchObject({ eyebrow: "Already saved", title: canary.title });
    expect(slots.getAll()[SAVE_SLOT].label).toBe("Saved ✓");
  });

  it("the same idea after new lines is recognised and not written twice", async () => {
    save.press();
    llm.last().end(canary);
    await save.whenIdle();
    addUpTo(139);
    expect(save.press()).toBe("started");
    llm.last().end({ ...canary, title: "Canary rollout plan", quote: "five percent of traffic first" });
    await save.whenIdle();
    expect(save.lastResult).toBe("duplicate");
    expect(written).toHaveLength(1);
    expect(card().eyebrow).toBe("Already saved");
  });

  it("a different idea is appended", async () => {
    save.press();
    llm.last().end(canary);
    await save.whenIdle();
    addUpTo(139);
    save.press();
    llm.last().end(coldStart);
    await save.whenIdle();
    expect(save.lastResult).toBe("saved");
    expect(written).toHaveLength(2);
    expect(written[1]).toContain("*Meeting 2:19 ·");
  });

  it("reset() (new meeting) forgets what was saved", async () => {
    save.press();
    llm.last().end(canary);
    await save.whenIdle();
    save.reset();
    expect(slots.getAll()[SAVE_SLOT].label).toBe("Save");
    expect(save.press()).toBe("started");
    llm.last().end(canary);
    await save.whenIdle();
    expect(written).toHaveLength(2);
  });

  it("nothing said yet -> a short card, no call", () => {
    transcript.clear();
    expect(save.press()).toBe("empty");
    expect(llm.calls).toHaveLength(0);
    expect(card().title).toBe("Nothing to save yet.");
  });

  it("an invalid answer -> error card, key back to Save", async () => {
    save.press();
    llm.last().end({ title: "x" });
    await save.whenIdle();
    expect(save.lastResult).toBe("failed");
    expect(card()).toMatchObject({ eyebrow: "Save failed", tone: "error", body: "The model's answer could not be used. Press again." });
    expect(slots.getAll()[SAVE_SLOT]).toMatchObject({ label: "Save", state: "shown" });
    expect(written).toHaveLength(0);
  });

  it("bad key / timeout -> error card with what to do, key back", async () => {
    save.press();
    llm.last().fail(new LlmError("auth", "HTTP 401", { status: 401 }));
    await save.whenIdle();
    expect(card().body).toBe("The API key was rejected (HTTP 401). Check LLM_API_KEY in app/.env, then restart the app.");
    expect(slots.getAll()[SAVE_SLOT].state).toBe("shown");

    save.press();
    clock.advance(20_000);
    await save.whenIdle();
    expect(card().body).toBe("No answer within 20 s. Press again in a moment.");
    expect(slots.getAll()[SAVE_SLOT].state).toBe("shown");
    expect(written).toHaveLength(0);
  });

  it("a file write error -> error card, not remembered as saved", async () => {
    failWrite = true;
    save.press();
    llm.last().end(canary);
    await save.whenIdle();
    expect(card()).toMatchObject({ eyebrow: "Save failed", title: "Couldn't write the file" });
    failWrite = false;
    expect(save.press()).toBe("started"); // not "duplicate": nothing was written
  });

  it("reset() during a save cancels it without an error card", async () => {
    save.press();
    const call = llm.last();
    save.reset();
    await flush();
    await save.whenIdle();
    expect(call.aborted).toBe(true);
    expect(save.lastResult).toBe("cancelled");
    expect(overlay.current()).toBeNull();
    expect(written).toHaveLength(0);
  });
});

describe("normalizeIdea / validateIdea / findDuplicate", () => {
  it("validates the shape", () => {
    expect(validateIdea({ ...canary, t: "108" })).toEqual(canary);
    expect(() => validateIdea({ ...canary, quote: "" })).toThrow(/quote/);
    expect(() => validateIdea({ ...canary, t: "soon" })).toThrow(/"t"/);
    expect(() => validateIdea(null)).toThrow();
  });

  it("caps the quote at 20 words and the summary at 2 lines, takes t from the quoted line", () => {
    const long = LINES[2].text; // 22 words
    const n = normalizeIdea({ title: "Canary.", summary: "a\n\nb\nc", quote: `“${long}”`, t: 50 }, LINES);
    expect(n.title).toBe("Canary");
    expect(n.summary).toBe("a\nb");
    expect(n.quote.split(" ")).toHaveLength(20);
    expect(n.quote.endsWith("…")).toBe(true);
    expect(n.t).toBe(108);
  });

  it("replaces a quote that is not in the transcript with the line nearest t", () => {
    const n = normalizeIdea({ ...canary, quote: "We will definitely ship on Friday", t: 116 }, LINES);
    expect(n.quote).toBe("We roll back in under a minute. It's one switch.");
    expect(n.t).toBe(117);
  });

  it("matches a quote despite case and punctuation differences", () => {
    const n = normalizeIdea({ ...canary, quote: "we roll back in under a minute, it's one switch", t: 0 }, LINES);
    expect(n.t).toBe(117);
    expect(n.quote).toBe("we roll back in under a minute, it's one switch");
  });

  it("finds duplicates by line, quote overlap or title", () => {
    const a = normalizeIdea(canary, LINES);
    expect(findDuplicate({ ...a, title: "Other", quote: "x" }, [a])).toBe(a); // same t
    expect(findDuplicate({ ...a, title: "Other", t: 1, quote: "five percent of traffic" }, [a])).toBe(a);
    expect(findDuplicate({ ...a, t: 1, quote: "zzz", title: "Canary rollout to 5 % first!" }, [a])).toBe(a);
    expect(findDuplicate(normalizeIdea(coldStart, LINES), [a])).toBeNull();
  });

  it("formats an entry", () => {
    expect(formatEntry({ title: "T", summary: "S", quote: "Q", t: 65.4 }, new Date(2026, 0, 2, 3, 4))).toBe(
      '## T\n*Meeting 1:05 · saved 2026-01-02 03:04*\n\nS\n\n> "Q"\n\n',
    );
  });
});

describe("fileSavedIdeas", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "saved-ideas-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates the folder and file with a heading, then appends", async () => {
    const path = join(dir, "output", "saved-ideas.md");
    const f = fileSavedIdeas(path);
    await f.append("## A\n\n");
    await f.append("## B\n\n");
    expect(readFileSync(path, "utf8")).toBe("# Saved ideas\n\n## A\n\n## B\n\n");
  });
});
