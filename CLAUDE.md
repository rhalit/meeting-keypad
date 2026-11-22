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
Save appends to `output/saved-ideas.md` (gitignored). "Was that for me?" (slot 8) is not built yet.
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
- Real model smoke run (Catch-up + Save on the mock transcript): `cd app && npm run smoke`
  (writes `output/smoke-saved-ideas.md`). Tests never call a real model (`test/fakeLlm.ts`).
  `AUTOPLAY=1 npm run dev` starts the mock meeting without pressing Play; `AUTOLISTEN=1 npm run dev` starts Live listening.
- Term eval (voiced mock meeting through the full live pipeline: which glossary terms reach a key, false positives,
  speech→key delay, free-tier interval floor): `cd app && npm run eval:terms` (real audio through the speakers, ~5 min)
  or `npm run eval:terms -- --text` (no audio, script lines as finals). Flags: `--profile "<knows>"` / `--profile config`,
  `--model <id>`, `--interval <ms>`, `--keyterms`, `--lines N`, `--tag <name>` → `output/eval-terms-<name>.json`.
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
- Do not guess SDK members. Fetch the docs page when unsure.
- Do not pass a font size to `BitmapBuilder.DrawText`; the service picks one per device.

## Rules
- The plugin never blocks the Logi Plugin Service: network I/O runs on background tasks,
  reconnect to the app every 2 s.
- Key labels: at most 2 lines of 8 characters. The app shortens them; the full term only appears in the overlay.
- A term placed on a key never moves to another key.
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
- `mock/config.json`: `{ "listenerName": "...", "listenerKnows": "...", "keyterms": [] }`; meeting lines say `{listener}`
  where a speaker addresses them. `listenerKnows` describes the listener for the spotter and explanation prompts. `keyterms` pre-fills the panel's "Meeting topic / keyterms" field (Deepgram keyterms, used at Start listening).
- Live line (LiveSource `line` event): `{ t, speaker?, text, terms: [], end? }`, where `t` = meeting seconds since Start listening
  and `speaker` = "Speaker N" from Deepgram diarization.
- `mock/glossary.json`: `{ "<term>": { "label", "full", "explanation", "example", "category" } }`
- Term event (every source, mock or live): `TermCandidate { term, label, category, source: "mock" | "live" }`
  in `app/src/pipeline/terms.ts`.
- Term spotter output: `{ "terms": [ { "term", "heard", "label", "category", "confidence", "reason" } ] }`
  (`term` = canonical spelling, `heard` = the words as transcribed, used to find the "In this meeting" sentence).
- Live explanation (`Explainer`): `{ "full", "explanation", "category" }`, cached per term for the app session.
