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
- `tools/` – `fake-core.mjs` (stand-in app for testing the plugin), `eval-terms.ts` (later).

## Current phase
Phase 2: the scripted mock meeting (`mock/`) drives the keys end to end
(mock content, `app/` scaffold, pipeline, control panel). Phase 1 (gate G1) is done.
Phase 2b is done: a term key opens the overlay card (`app/src/pipeline/overlay.ts` decides,
`app/src/main/overlayWindow.ts` draws) with explanations from `mock/glossary.json`.
Not in this step: any Claude API calls (they come next).
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
  `AUTOPLAY=1 npm run dev` starts the mock meeting without pressing Play.

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
- Never commit `app/.env`. API keys arrive later: Anthropic in Phase 2, Deepgram in Phase 3.
- The human checks the physical keypad. After every plugin change: build, then say exactly
  what should be visible on which key.
- Models (later phases): `claude-haiku-5-5` for term spotting, explanations and Save;
  `claude-sonnet-5-5` for Catch-up. Use structured outputs for JSON.

## Data schemas (Phase 2+)
- `mock/meeting.json`: array of `{ "t": 42.0, "speaker": "Lena", "text": "...", "terms": ["LoRA"] }`
- `mock/config.json`: `{ "listenerName": "..." }`; meeting lines say `{listener}` where a speaker addresses them.
- `mock/glossary.json`: `{ "<term>": { "label", "full", "explanation", "example", "category" } }`
- Term event (every source, mock or live): `TermCandidate { term, label, category, source: "mock" | "live" }`
  in `app/src/pipeline/terms.ts`.
- Term spotter output: `{ "terms": [ { "term", "label", "category", "confidence", "reason" } ] }`
