# Meeting Keypad (hackathon project)

## What we're building
A macOS app that listens to a meeting (Zoom, Meet, Teams), spots jargon as it is spoken,
and shows each term on a key of the Logitech MX Keypad (9 full-colour LCD keys).
Pressing a term key opens a small overlay card with a plain explanation.

Key layout (slot numbers are used everywhere, see protocol/messages.md):

| Row    | Left            | Middle       | Right                    |
|--------|-----------------|--------------|--------------------------|
| Top    | 0 term          | 1 term       | 2 term                   |
| Middle | 3 term          | 4 term       | 5 term                   |
| Bottom | 6 Catch-up      | 7 Save       | 8 "Was that for me?"     |

## Architecture
- `plugin/` – C# Logi Actions SDK plugin (.NET 10, pinned by `global.json`).
  It is deliberately DUMB: it draws what the app sends and reports key presses. No business logic.
- `app/` – Electron + TypeScript, the only place with logic.
  - Main process: WebSocket server on `ws://127.0.0.1:8765` (see `protocol/messages.md`),
    pipeline: source (mock or live) → TranscriptBuffer → TermSpotter → SlotManager,
    explanation cache, catch-up / save / alert.
  - Renderer: overlay card (always on top, never steals focus) and a small control panel.
- `protocol/messages.md` – the contract between plugin and app. Change it FIRST, then both sides.
- `mock/` – scripted meeting (`meeting.json`), `glossary.json`, optional `meeting.mp3` ("Demo mode").
- `tools/` – `fake-core.mjs` (stand-in app for testing the plugin). The term eval lives in
  `app/src/tools/evalTerms.ts` (compiled with the app).

## Current phase
Phase 2: the scripted mock meeting (`mock/`) drives the keys end to end
(mock content, `app/` scaffold, pipeline, control panel). Phase 1 (gate G1) is done.
Phase 2b is done: a term key opens the overlay card (`app/src/pipeline/overlay.ts` decides,
`app/src/main/overlayWindow.ts` draws) with explanations from `mock/glossary.json`.
Phase 2c: Catch-up (slot 6) and Save (slot 7) work on the mock meeting through an
OpenAI-compatible LLM (`app/src/pipeline/llm.ts`, controllers `catchUp.ts` / `save.ts`).
Save appends to `output/saved-ideas.md` (gitignored).
Phase 3a: live transcript. The panel has a Mock / Live switch. In Live mode, `LiveSource`
(`app/src/pipeline/liveSource.ts`) runs audiotee (`audioCapture.ts`, system audio, 16 kHz PCM)
into Deepgram nova-3 (`stt.ts`). Final utterances become TranscriptBuffer lines `{t, speaker?, text}`,
and interim text only goes to the panel. Catch-up and Save work on the live transcript.
Phase 3b: live term spotting. `TermSpotter` (`app/src/pipeline/termSpotter.ts`) sends new final lines
(at most every `LLM_SPOTTER_INTERVAL_MS`, never during silence, backs off on 429) to `LLM_SPOTTER_MODEL`
and emits `TermCandidate { source: "live" }` into the SlotManager. When a live term is placed, `Explainer`
(`explainer.ts`, `LLM_MODEL`) writes its card at once; a press before it is ready shows "Explaining…" and fills in.
Spotted terms are added to Deepgram keyterms at the next Start listening. The listener profile for the prompts is
`mock/config.json` `listenerKnows` (currently a general audience).
Phase 3c: faster spotting, new key design. The Deepgram assembler (`stt.ts`) also ends a line at the next
is_final boundary once it has >= 12 words or >= 6 s of speech (never inside a segment), so a pause-free
monologue does not hold terms back. Lines carry word timestamps; `latency.ts` logs speech→key per placed live term.
The spotter accepts a term only if its `heard` words are in the NEW lines (checked in code) and drops variants /
mishearings of terms already shown (`variantOf()`). General categories (Tech, Science, Health, Business, Finance,
Law, Other). The app sends the full term; the plugin fits it (`plugin/.../Core/TextFit.cs`). Term keys are a FIFO
conveyor. Offline tuning: `record:live` saves raw Deepgram messages, `replay:live` runs the pipeline from them.
Phase 4: "For me?" (slot 8) and meeting export, Mock and Live. `ForMeController` (`forMe.ts`) checks every final line
with `mentionsListener()` (`nameMatch.ts`: name + `listenerAliases` exactly, one edit from the NAME only, so "really" never
matches the alias "Rally"); only then one `LLM_MODEL` call (`FOR_ME_SCHEMA`, last 60 s as context). For the listener →
slot 8 `alert`, pulsing `#E5484D`/`#9E2A2F` every 600 ms, stops after 90 s (card kept); a press shows question / context /
suggested reply ("N questions" when more wait) and restores the key. The name and aliases are always Deepgram keyterms.
`MeetingExporter` (`exportMeeting.ts`) writes `output/meetings/<YYYY-MM-DD HHmm>.md` (title, date, duration, 5-bullet
summary (one call, skipped < 30 s said, reused when nothing new), questions, saved ideas, terms with explanations in order
(opened marked), catch-ups, transcript). Runs on the panel button, Stop listening and the end of the mock meeting (each
reveals the file in Finder) and silently on a Mock/Live switch. `MeetingRecord` (`meetingRecord.ts`) keeps start time,
spoken seconds and the terms that reached a key.
Do not build features from later phases unless asked.

## Commands
- Plugin build: `cd plugin/MeetingKeysPlugin && dotnet build`
- Plugin hot reload: `cd plugin/MeetingKeysPlugin/src && dotnet watch build`
- A successful build writes `~/Library/Application Support/Logi/LogiPluginService/Plugins/MeetingKeysPlugin.link`.
- If a plugin change doesn't show up: Options+ → Settings → "Restart Logi Plugin Service".
- Plugin log: `~/Library/Application Support/Logi/LogiPluginService/Logs/plugin_logs/MeetingKeys.log`
  (connects, disconnects, every message, and a `Draw slot n` line each time the service redraws a key).
- Fake core (stand-in app for testing the plugin): `cd tools && npm install && npm run fake-core`.
  Stop it before running the real app; both use port 8765.
- App: `cd app && npm install && npm run dev` (control panel + WebSocket server), `npm test`.
- Real model For-me + export check: `cd app && npm run smoke:forme` (mock meeting through ForMeController, expects exactly
  2 calls and alerts at 2:32 and 4:30, then one export to `output/smoke-meetings/`; ~3 calls).
- Real model smoke run (Catch-up + Save on the mock transcript): `cd app && npm run smoke`
  (writes `output/smoke-saved-ideas.md`). Tests never call a real model (`test/fakeLlm.ts`).
  `AUTOPLAY=1 npm run dev` starts the mock meeting without pressing Play; `AUTOLISTEN=1 npm run dev` starts Live listening.
- Term eval (voiced mock meeting through the full live pipeline: which glossary terms reach a key, false positives,
  speech→key delay, free-tier interval floor): `cd app && npm run eval:terms` (real audio through the speakers, ~5 min)
  or `npm run eval:terms -- --text` (no audio, script lines as finals). Flags: `--profile "<knows>"` / `--profile config`,
  `--model <id>`, `--interval <ms>`, `--keyterms`, `--lines N`, `--tag <name>` → `output/eval-terms-<name>.json`.
- Record a live session for offline tuning (system audio → Deepgram only, no spotter, no LLM):
  `cd app && npm run record:live -- --tag podcast --seconds 180` → `tools/recordings/podcast.jsonl` (gitignored).
  Needs the system audio permission for the terminal (plain Node, like `smoke:live`).
- Replay it through the full live pipeline: `npm run replay:live -- ../tools/recordings/podcast.jsonl --terms "NSDR=Health, dopamine=Science"`
  (keyword fake spotter on virtual time, free; no `--terms` = acronyms). `--fake-latency <ms>`, `--interval <ms>`,
  `--max-words N`, `--max-s S`, `--spotter real` (LLM_SPOTTER_MODEL in real time, costs budget), `--tag <name>` →
  `output/replay-<name>.json`. Reports line lengths and speech→key per term (final + spot + queue).
- Plugin text-fitting checks: `cd plugin/MeetingKeysPlugin && dotnet run --project tests/TextFitCheck` (not in the `.slnx`).
- audiotee (once per machine): `cd app && npm run build:audiotee` → `tools/audiotee/bin/audiotee`
  (pinned commit in `tools/audiotee/VERSION`, see `tools/audiotee/README.md`).
- Live smoke run (plays the mock meeting voiced by `say` through the speakers, real audiotee + Deepgram):
  `cd app && npm run smoke:live` (add `-- --keyterms` for glossary keyterms, `-- --lines 8` for a short run).
  Audio is cached in `tools/mock-audio/` (gitignored). Needs the system audio permission for the terminal.
- System audio permission: System Settings → Privacy & Security → Screen & System Audio Recording →
  "System Audio Recording Only". For `npm run dev` this must be **Electron**
  (add `app/node_modules/electron/dist/Electron.app` with +): macOS credits the permission to Electron,
  so Terminal alone gives silence. `npm run smoke:live` runs in plain Node, so it needs the terminal app.
  New Mac setup steps are in `README.md` ("Setting up on a new Mac").

## Logi Actions SDK docs
- Index for AI tools: https://logitech.github.io/actions-sdk-docs/llms.txt
  (append `.md` to any docs page URL to get Markdown).
- Most relevant pages:
  - csharp/tutorial/add-a-command-with-a-parameter.md
  - csharp/tutorial/change-a-button-image.md
  - csharp/plugin-features/logging.md
  - csharp/plugin-features/implementing-dynamic-folders.md (fallback approach)
- The Node.js SDK is discontinued: C# only.
- Do not guess SDK members. Fetch the docs page when unsure; the docs are incomplete, so also check the real API
  by reflection on `~/.nuget/packages/logipluginapi/<version>/lib/net10.0/PluginApi.dll` (e.g. `IsWidget`,
  `DrawText(text, x, y, w, h, color, fontSize, lineHeight, spaceHeight, fontName)` are only found there).
- `KeySlotCommand` is a widget (`IsWidget = true`) so the image fills the key without the device-drawn action name.
- The plugin passes explicit font sizes to `DrawText` (text fitting needs them) with the service's own font
  "Brown Logitech Pan Bold"; `TextFit` estimates widths from that font's advance widths (no public measuring API).

## Rules
- The plugin never blocks the Logi Plugin Service: network I/O runs on background tasks,
  reconnect to the app every 2 s.
- Key labels: the app sends the full term (at most 4 words / 40 characters) or action name, never shortened.
  The plugin fits it in at most 2 lines broken between words at the largest size that fits, and abbreviates a word
  only if it cannot fit on a line at the smallest size (text beyond 2 lines ends with "…").
- Term keys are a FIFO conveyor: slots 0-5 read left to right, top to bottom; a new term always appears on slot 0,
  every other term moves one slot forward, the term on slot 5 leaves (opened terms are not removed early). A term's
  state (new / shown / seen) moves with it. At most 2 new terms per 10 s (extras queue). A press within 500 ms after
  a shift goes to the term that was on that key before the shift. A term shown once is not shown again in that meeting.
- Press guards (a bumped keypad must not burn model calls): the app drops a press of the same slot within 300 ms
  of that slot's previous press (`pressGuard.ts`). Catch-up re-shows its last summary when no new final line arrived
  since it, and calls the model at most once per 10 s (a press in between re-shows the last card). Save keeps its
  dedupe and has a 3 s cooldown between model calls. Every ignored press is logged with the reason.
  "For me?" never calls the model on a press; its check runs only when the name is heard, one call at a time
  (a mention during a call waits, latest only). An export makes at most one summary call.
- Never commit `app/.env`, never print or log the key. LLM settings live there:
  `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, optional `LLM_REASONING_EFFORT`, `LLM_JSON_MODE`
  (see `app/.env.example` for Groq / Ollama / OpenRouter). Term spotter: `LLM_SPOTTER_MODEL` (currently
  `openai/gpt-oss-20b`), optional `LLM_SPOTTER_REASONING_EFFORT`, `LLM_SPOTTER_JSON_MODE`, `LLM_SPOTTER_INTERVAL_MS` (default 8000). Speech-to-text: `DEEPGRAM_API_KEY`
  (never logged, sent only as a header), optional `DEEPGRAM_LANGUAGE` (`en` default, `multi` for English/French),
  `DEEPGRAM_DIARIZE`, `DEEPGRAM_ENDPOINTING_MS`, `AUDIOTEE_PATH`.
- The human checks the physical keypad. After every plugin change: build, then say exactly
  what should be visible on which key.
- LLM: any OpenAI-compatible chat API from `app/.env` (currently Groq `openai/gpt-oss-120b` for explanations,
  Catch-up and Save; `openai/gpt-oss-20b` for the spotter).
  Use structured outputs (json_schema, strict) for JSON; the client falls back to JSON mode + validation.

## Data schemas (Phase 2+)
- `mock/meeting.json`: array of `{ "t": 42.0, "speaker": "Lena", "text": "...", "terms": ["LoRA"] }`
- `mock/config.json`: `{ "listenerName": "...", "listenerAliases": ["Rally"], "listenerKnows": "...", "keyterms": [] }`;
  `listenerAliases` = mishearings of the name (matched exactly, added to Deepgram keyterms); meeting lines say `{listener}`
  where a speaker addresses them. `listenerKnows` describes the listener for the spotter and explanation prompts. `keyterms` pre-fills the panel's "Meeting topic / keyterms" field (Deepgram keyterms, used at Start listening).
- Live line (LiveSource `line` event): `{ t, speaker?, text, terms: [], end?, words?: [{ text, start, end }], reason? }`,
  where `t` = meeting seconds since Start listening, `speaker` = "Speaker N" from Deepgram diarization, `words` = word
  timings in meeting seconds, `reason` = why the line ended (`length` | `speech_final` | `utterance_end` | `flush`).
- `mock/glossary.json`: `{ "<term>": { "full", "explanation", "example", "category" } }`
- Categories: `Tech`, `Science`, `Health`, `Business`, `Finance`, `Law`, `Other`, each with a colour in
  `CATEGORY_COLORS` (`app/src/pipeline/protocol.ts`, same in `tools/fake-core.mjs`).
- Term event (every source, mock or live): `TermCandidate { term, category, source: "mock" | "live" }`
  in `app/src/pipeline/terms.ts`. The key shows `displayTerm(term)`.
- Key state (protocol v2): `{ slot, label, sub?, color?, state }` (`label` = full term, `sub` = category, `color` = category colour).
- Term spotter output: `{ "terms": [ { "term", "heard", "full", "variantOf", "category", "confidence", "reason" } ] }`
  (`term` = canonical spelling, `heard` = the words as transcribed (must be in the NEW lines; also used to find the
  "In this meeting" sentence), `full` = expansion, `variantOf` = an already-shown term this is a variant/mishearing of, or "").
- Live explanation (`Explainer`): `{ "full", "explanation" }`, cached per term for the app session. The card's category is
  always the key's. "In this meeting" = only the sentence(s) with the heard words, max ~25 words (`example.ts`).
- For-me check (`FOR_ME_SCHEMA`): `{ isForListener, question, context (2 sentences), suggestedReply (1-2 sentences) }`.
- Export summary (`SUMMARY_SCHEMA`): `{ title, bullets: string[] }` (5 kept).
- Recording (`record:live`, `app/src/pipeline/replay.ts`): JSONL, line 1 `{ type: "header", version: 1, model, language, ... }`,
  then `{ at: <ms since start>, offset, msg: <Deepgram message> }` or `{ at, offset, type: "connect" }`.
