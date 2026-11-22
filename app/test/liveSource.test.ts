import { beforeEach, describe, expect, it } from "vitest";
import { CatchUpController } from "../src/pipeline/catchUp.js";
import { LiveSource, type LiveInterim, type LiveLine, type LiveState } from "../src/pipeline/liveSource.js";
import { OverlayController, type TextCard } from "../src/pipeline/overlay.js";
import { formatTranscript } from "../src/pipeline/prompts.js";
import { SaveController, type SavedIdeasFile } from "../src/pipeline/save.js";
import { SlotManager } from "../src/pipeline/slots.js";
import { TranscriptBuffer } from "../src/pipeline/transcriptBuffer.js";
import { FakeClock } from "./fakeClock.js";
import { FakeLlmClient, flush } from "./fakeLlm.js";
import { FakeAudio, fakeSttFactory } from "./fakeStt.js";

describe("LiveSource", () => {
  let clock: FakeClock;
  let audio: FakeAudio;
  let stt: ReturnType<typeof fakeSttFactory>;
  let live: LiveSource;
  let lines: LiveLine[];
  let interims: (LiveInterim | null)[];
  let events: string[];

  /** Real time passes and audio arrives in 100 ms chunks. */
  function speak(seconds: number): void {
    for (let i = 0; i < Math.round(seconds * 10); i++) {
      clock.advance(100);
      audio.chunk(0.1);
    }
  }

  beforeEach(() => {
    clock = new FakeClock();
    audio = new FakeAudio();
    stt = fakeSttFactory();
    live = new LiveSource({ clock, audio, stt: stt.factory, log: () => {} });
    lines = [];
    interims = [];
    events = [];
    live.on("line", (l: LiveLine) => lines.push(l));
    live.on("interim", (i: LiveInterim | null) => interims.push(i));
    live.on("restart", () => events.push("restart"));
    live.on("end", () => events.push("end"));
  });

  it("meeting time starts at Start; audio goes to STT; keyterms are passed", () => {
    clock.advance(60_000);
    expect(live.position()).toBe(0);
    live.start(["RAG", "LoRA"]);
    expect(events).toEqual(["restart"]);
    expect(audio.running).toBe(true);
    expect(stt.last().opts.keyterms).toEqual(["RAG", "LoRA"]);
    speak(2.5);
    expect(live.position()).toBeCloseTo(2.5);
    expect(stt.last().seconds).toBeCloseTo(2.5);
    expect((live.state() as LiveState).listening).toBe(true);
  });

  it("finals become lines {t, speaker?, text, terms: []}; interims only go to `interim`", () => {
    live.start([]);
    speak(5);
    stt.last().emitInterim({ text: "we built", start: 1.2 });
    expect(lines).toEqual([]);
    expect(interims).toEqual([{ t: 1.2, speaker: undefined, text: "we built" }]);
    stt.last().emitFinal({ text: "We built it with RAG.", speaker: "Speaker 1", start: 1.2, end: 3 });
    expect(lines).toEqual([{ t: 1.2, speaker: "Speaker 1", text: "We built it with RAG.", terms: [], end: 3 }]);
    expect(interims[interims.length - 1]).toBeNull();
    stt.last().emitFinal({ text: "No speaker here.", start: 3.46, end: 4.04 });
    expect(lines[1]).toEqual({ t: 3.5, speaker: undefined, text: "No speaker here.", terms: [], end: 4 });
  });

  it("maps audio time to meeting time across a capture gap (audiotee restart)", () => {
    live.start([]);
    speak(10);
    clock.advance(5000); // 5 s without audio
    speak(4);
    // Audio second 12 is 2 s after the gap, i.e. meeting time 17.
    stt.last().emitFinal({ text: "after the gap", start: 12 });
    expect(lines[0].t).toBeCloseTo(17, 1);
    stt.last().emitFinal({ text: "before the gap", start: 3 });
    expect(lines[1].t).toBeCloseTo(3, 1);
  });

  it("stop freezes the time, keeps late finals, then a new Start begins a new meeting at 0", async () => {
    live.start([]);
    speak(8);
    const first = stt.last();
    const stopping = live.stop();
    expect(live.isListening()).toBe(false);
    first.emitFinal({ text: "last words", start: 7 }); // arrives while STT flushes
    await stopping;
    expect(events).toEqual(["restart", "end"]);
    expect(first.stopped).toBe(true);
    expect(audio.running).toBe(false);
    clock.advance(30_000);
    expect(live.position()).toBeCloseTo(8);
    expect(lines.map((l) => l.text)).toEqual(["last words"]);

    live.start([]);
    expect(events).toEqual(["restart", "end", "restart"]);
    expect(live.position()).toBe(0);
    first.emitFinal({ text: "stale session" });
    expect(lines).toHaveLength(1);
  });

  it("Catch-up and Save work on a transcript filled by LiveSource, unchanged", async () => {
    const transcript = new TranscriptBuffer();
    live.on("line", (l: LiveLine) => transcript.add(l));
    const llm = new FakeLlmClient();
    const slots = new SlotManager({ clock });
    const overlay = new OverlayController({ clock, lookup: () => undefined });
    const meetingTime = () => live.position();
    const catchUp = new CatchUpController({ clock, llm, transcript, meetingTime, keys: slots, overlay, log: () => {} });
    const written: string[] = [];
    const file: SavedIdeasFile = { append: async (s: string) => void written.push(s) };
    const save = new SaveController({ clock, llm, transcript, meetingTime, keys: slots, overlay, file, log: () => {} });

    live.start([]);
    for (let i = 0; i < 6; i++) {
      speak(5);
      stt.last().emitFinal({ text: `Point number ${i}.`, speaker: i % 2 ? "Speaker 2" : undefined, start: i * 5 + 1 });
    }
    expect(catchUp.press()).toBe("started");
    const prompt = llm.last().req.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("[0:01] Point number 0.");
    expect(prompt).toContain("[0:06] Speaker 2: Point number 1.");
    llm.last().push("- one\n- two\n- three").end();
    await catchUp.whenIdle();
    expect((overlay.current() as TextCard).body).toContain("one");

    expect(save.press()).toBe("started");
    await flush();
    expect(llm.calls.length).toBe(2);
    expect(llm.last().req.messages.map((m) => m.content).join("\n")).toContain("Point number 5.");
    slots.dispose();
    overlay.dispose();
  });
});

describe("formatTranscript", () => {
  it("leaves out the speaker when unknown", () => {
    expect(formatTranscript([{ t: 65, text: "hello" }, { t: 70, speaker: "Lena", text: "hi" }])).toBe("[1:05] hello\n[1:10] Lena: hi");
  });
});
