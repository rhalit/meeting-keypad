// Real calls against LLM_MODEL in app/.env: the "For me?" check on the whole mock meeting, then one export.
//   npm run smoke:forme
// Every line of mock/meeting.json goes through ForMeController (no waiting on meeting time). Only lines that
// name the listener cost a call: expected exactly 2 (2:32 and 4:30), both judged "for the listener".
// Then the meeting is exported once (one summary call) to output/smoke-meetings/<date time>.md. ~3 calls in total.
// The API key is never printed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { realClock } from "../pipeline/clock.js";
import { MeetingExporter, type MeetingSnapshot } from "../pipeline/exportMeeting.js";
import { FOR_ME_SLOT, ForMeController } from "../pipeline/forMe.js";
import { OpenAiCompatClient, loadLlmConfig } from "../pipeline/llm.js";
import { MeetingRecord } from "../pipeline/meetingRecord.js";
import { loadConfig, loadGlossary, loadMeeting } from "../pipeline/mockData.js";
import { OverlayController, type OverlayCard } from "../pipeline/overlay.js";
import { mmss } from "../pipeline/prompts.js";
import { SlotManager } from "../pipeline/slots.js";
import { TranscriptBuffer } from "../pipeline/transcriptBuffer.js";

const appRoot = join(__dirname, "..", "..");
const repoRoot = join(appRoot, "..");
const EXPECTED = [152, 270];

async function main(): Promise<number> {
  try {
    process.loadEnvFile(join(appRoot, ".env"));
  } catch {
    console.log("no app/.env, using the environment");
  }
  const log = (m: string) => console.log(`  ${m}`);
  const llm = new OpenAiCompatClient(loadLlmConfig(process.env), undefined, (m) => log(`[llm] ${m}`));
  console.log(`model: ${llm.describe()}`);

  const config = loadConfig(join(repoRoot, "mock", "config.json"));
  const meeting = loadMeeting(join(repoRoot, "mock", "meeting.json"), config.listenerName);
  const glossary = loadGlossary(join(repoRoot, "mock", "glossary.json"));
  const clock = realClock;
  const transcript = new TranscriptBuffer();
  const slots = new SlotManager({ clock });
  const overlay = new OverlayController({ clock, lookup: () => undefined });
  const record = new MeetingRecord();
  const forMe = new ForMeController({
    clock,
    llm,
    transcript,
    keys: slots,
    overlay,
    log,
    listener: { name: config.listenerName, knows: config.listenerKnows, aliases: config.listenerAliases },
  });
  let failures = 0;

  console.log(`\n1) For me? on ${meeting.length} lines (listener "${config.listenerName}", aliases ${config.listenerAliases.join(", ")})`);
  const alerts: number[] = [];
  for (const l of meeting) {
    transcript.add(l);
    record.addLine(l);
    for (const term of l.terms) {
      const e = glossary[term];
      if (e) record.placed(term, e.category, l.t);
    }
    const before = forMe.questions().length;
    if (forMe.addLine(l)) {
      await forMe.whenIdle();
      const qs = forMe.questions();
      if (qs.length > before) {
        alerts.push(l.t);
        const q = qs[qs.length - 1];
        log(`slot ${FOR_ME_SLOT}: ${slots.getAll()[FOR_ME_SLOT].state} ${slots.getAll()[FOR_ME_SLOT].color ?? ""}`);
        log(`question: ${q.question}`);
        log(`context:  ${q.context}`);
        log(`reply:    ${q.suggestedReply}`);
      } else log(`${mmss(l.t)}: model said not for the listener`);
    }
  }
  const okCalls = forMe.calls === EXPECTED.length;
  const okAlerts = JSON.stringify(alerts) === JSON.stringify(EXPECTED);
  console.log(`  model calls: ${forMe.calls} (expected ${EXPECTED.length}) ${okCalls ? "OK" : "FAIL"}`);
  console.log(`  alerts at: ${alerts.map(mmss).join(", ") || "none"} (expected ${EXPECTED.map(mmss).join(", ")}) ${okAlerts ? "OK" : "FAIL"}`);
  if (!okCalls) failures++;
  if (!okAlerts) failures++;

  const cards: OverlayCard[] = [];
  overlay.on("show", (c: OverlayCard) => cards.push(c));
  console.log("\n2) press slot 8");
  log(`press -> ${forMe.press()}`);
  const c = cards[cards.length - 1];
  if (c?.kind === "text") {
    log(`card eyebrow: ${c.eyebrow}`);
    log(`card title:   ${c.title}`);
    for (const line of c.body.split("\n")) log(`card body:    ${line}`);
  }
  const key = slots.getAll()[FOR_ME_SLOT];
  log(`slot ${FOR_ME_SLOT} after the press: "${key.label}" ${key.state}`);
  if (key.state !== "shown") failures++;

  console.log("\n3) export (one summary call) -> output/smoke-meetings/");
  const exporter = new MeetingExporter({ clock, llm, dir: join(repoRoot, "output", "smoke-meetings"), log });
  const snap: MeetingSnapshot = {
    meetingId: record.id,
    mode: "mock",
    startedAt: record.startedAt ?? new Date(),
    durationS: meeting[meeting.length - 1].t,
    spokenS: record.spokenS,
    listenerName: config.listenerName,
    lines: transcript.all(),
    terms: record.terms().map((t) => ({ ...t, full: glossary[t.term]?.full, explanation: glossary[t.term]?.explanation ?? "" })),
    questions: forMe.questions(),
    ideas: [],
    catchUps: [],
  };
  const r = await exporter.export(snap);
  if (r.status !== "written" || r.summary !== "model") {
    log(`FAIL: export ${JSON.stringify(r)}`);
    failures++;
  }
  const written = r.status === "written" ? readFileSync(r.path, "utf8") : "";
  const head = written.split("## Saved ideas")[0];
  console.log(head.replace(/^/gm, "  | "));
  slots.dispose();
  forMe.reset();
  overlay.dispose();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  return failures ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
