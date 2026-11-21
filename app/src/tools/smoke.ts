// Real calls against the model in app/.env, on the mock transcript (no Electron, no keypad).
//   npm run smoke
// Warm-up, one Catch-up (streamed, time to first token) and Save: first save, an immediate
// second press (must not save again), then one more line and a third press (model asked again,
// duplicate check). Writes to output/smoke-saved-ideas.md, not the real saved-ideas.md.
// The API key is never printed.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { CatchUpController } from "../pipeline/catchUp.js";
import { realClock } from "../pipeline/clock.js";
import { OpenAiCompatClient, errorAdvice, loadLlmConfig, warmUp, type LlmError } from "../pipeline/llm.js";
import { loadConfig, loadMeeting } from "../pipeline/mockData.js";
import { OverlayController, type OverlayCard } from "../pipeline/overlay.js";
import { SlotManager } from "../pipeline/slots.js";
import { SaveController, fileSavedIdeas } from "../pipeline/save.js";
import { TranscriptBuffer } from "../pipeline/transcriptBuffer.js";

const appRoot = join(__dirname, "..", "..");
const repoRoot = join(appRoot, "..");
const AT = 160; // meeting seconds "now"

async function main(): Promise<number> {
  try {
    process.loadEnvFile(join(appRoot, ".env"));
  } catch {
    console.log("no app/.env, using the environment");
  }
  const cfg = loadLlmConfig(process.env);
  const log = (m: string) => console.log(`  ${m}`);
  const llm = new OpenAiCompatClient(cfg, undefined, (m) => log(`[llm] ${m}`));
  console.log(`model: ${llm.describe()}${cfg.reasoningEffort ? ` (reasoning_effort ${cfg.reasoningEffort})` : ""}`);

  const config = loadConfig(join(repoRoot, "mock", "config.json"));
  const meeting = loadMeeting(join(repoRoot, "mock", "meeting.json"), config.listenerName);
  const transcript = new TranscriptBuffer();
  for (const l of meeting) if (l.t <= AT) transcript.add(l);
  let now = AT;

  const clock = realClock;
  const slots = new SlotManager({ clock });
  const overlay = new OverlayController({ clock, lookup: () => undefined });
  const cards: OverlayCard[] = [];
  overlay.on("show", (c: OverlayCard) => cards.push(c));
  slots.on("change", (keys) => {
    for (const k of keys) if (k.slot >= 6) log(`key ${k.slot}: "${k.label.replace("\n", " ")}" ${k.state}${k.bg ? ` ${k.bg}` : ""}`);
  });
  let failures = 0;

  console.log("\n1) warm-up");
  const w = await warmUp(llm, clock);
  if (w.ok) log(`ok in ${w.ms} ms`);
  else {
    log(`FAILED after ${w.ms} ms: ${w.error.kind}: ${w.error.message}`);
    log(errorAdvice(w.error));
    return 1;
  }

  console.log(`\n2) catch-up at ${AT} s (last 120 s)`);
  let printed = "";
  overlay.on("update", (c: OverlayCard) => {
    if (c.kind !== "text") return;
    if (c.body.startsWith(printed)) process.stdout.write(c.body.slice(printed.length));
    printed = c.body;
  });
  const catchUp = new CatchUpController({
    clock,
    llm,
    transcript,
    meetingTime: () => now,
    keys: slots,
    overlay,
    log: (m) => (m.startsWith("catch-up: first token") ? process.stdout.write(`  ${m}\n  `) : log(m)),
    onLlmOutcome: (o) => {
      if (!o.ok) failures++;
    },
    listenerName: config.listenerName,
  });
  catchUp.press();
  await catchUp.whenIdle();
  const cu = overlay.current();
  console.log("\n  final card:");
  if (cu?.kind === "text") console.log(`  [${cu.tone}] ${cu.eyebrow} / ${cu.title}\n${cu.body.replace(/^/gm, "    ")}`);
  overlay.removeAllListeners("update");

  const out = join(repoRoot, "output", "smoke-saved-ideas.md");
  rmSync(out, { force: true });
  const save = new SaveController({
    clock,
    llm,
    transcript,
    meetingTime: () => now,
    keys: slots,
    overlay,
    file: fileSavedIdeas(out),
    log,
    onLlmOutcome: (o) => {
      if (!o.ok) failures++;
    },
  });
  const showCard = () => {
    const c = overlay.current();
    if (c?.kind === "text") log(`card: [${c.tone}] ${c.eyebrow} / ${c.title}${c.body ? ` / ${c.body}` : ""}`);
  };

  console.log(`\n3) save at ${AT} s (last 45 s)`);
  log(`press -> ${save.press()}`);
  await save.whenIdle();
  log(`result: ${save.lastResult}`);
  showCard();

  console.log("\n4) save again right away (no new line)");
  log(`press -> ${save.press()}`);
  showCard();

  const next = meeting.find((l) => l.t > AT)!;
  transcript.add(next);
  now = next.t;
  console.log(`\n5) one more line (${next.t} s: "${next.text}"), save again (model asked, duplicate check)`);
  log(`press -> ${save.press()}`);
  await save.whenIdle();
  log(`result: ${save.lastResult}`);
  showCard();

  await new Promise((r) => setTimeout(r, 1700)); // let the 1.5 s key flash end
  console.log(`\nwritten to ${out}`);
  slots.dispose();
  overlay.dispose();
  return failures > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: LlmError) => {
    console.error(`smoke failed: ${err.message}`);
    process.exit(1);
  },
);
