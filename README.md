# IntelliPad

A compact macOS companion for meetings and lectures, built around the **Logitech MX Keypad** (9 LCD keys) and the
**MX Brio** camera. IntelliPad listens to a Zoom / Teams / Meet call or a recorded lecture, spots jargon as it is
spoken and puts each term on a key. Pressing a key shows a plain-language explanation; the bottom row catches you
up, saves ideas or tells you when a question is for you.

## 🏆 Awards

**2nd place at LauzHack 2026** in three tracks:

- **Logitech track**
- **Nexthink track**
- **IMC Trading track**

## What it does

**Keys 1–6: terms.** New jargon enters at key 1 and moves along (first in, first out), at most 2 new terms every
10 s. Each key shows the term and its category (Tech, Finance, Law…). A press opens a card in the bottom-left corner
of the screen: full name, explanation, and the sentence where it was said. Cards close themselves, or with their ×.

**Bottom row: depends on the mode** (switch above the play bar, ⌘1 / ⌘2).

| Mode | Left | Middle | Right |
|---|---|---|---|
| **Meeting** | **Catch-up**: a 3-line summary | **Save**: keeps the key idea, with an exact quote | **For me?**: pulses when someone asks *you* something; shows the question and a suggested reply |
| **Education** | **Flashcard**: a question / answer card (also exported for Anki) | **Quiz me**: a 3-choice question, press again for the answer | **Explain simply**: the last minutes in plain words, with an example |

- **Catch-up** and **Save** first open a menu on the keypad: how far back (30 s, 1, 2, 5 or 10 min). Pick one, or
  go back with "‹ Back" (or the plugin's Back action on the keypad's left arrow).
- **Saved** (bookmark in the toolbar, ⌘S): the ideas and flashcards saved in this meeting or course, plus earlier
  sessions. Kept between runs.
- **Camera focus** (MX Brio + Logi Gaze Tracker, Live mode): if you look away for more than ~3 s, Catch-up becomes
  `Missed 2m` and summarises exactly what you missed; a question for you while you are away makes every key pulse red.
  No video leaves the Mac.

## How it works

```
system audio ─► Deepgram (speech-to-text) ─► term spotter (LLM) ─► keypad keys ─► explanation card (LLM)
```

- **Live:** audiotee captures the Mac's sound output (any meeting app, no integration). Deepgram nova-3 streams the
  transcript with keyterms (your name, the topic you type, terms seen before). Every ≥ 8 s, and only when something
  new was said, an LLM picks at most 3 terms this listener probably doesn't know; code keeps only confident ones
  (≥ 0.7) whose words really appear in the transcript. Each placed term gets its explanation written at once, based on
  the sentence where it was heard.
- **Mock:** scripted scenarios with a hand-written glossary, for repeatable demos. Two of them play a real video in
  sync. Catch-up, Save, For me?, Quiz, Flashcard and Explain simply call the real model in both modes.
- **Stack:** Electron + TypeScript app (all logic), C# Logi Actions SDK plugin (draws keys, reports presses), local
  WebSocket between them, any OpenAI-compatible LLM (Groq `gpt-oss-120b` today).

## Setting up on a new Mac

1. **Dependencies:** `cd app && npm install`.
2. **audiotee** (system audio capture, once per machine): `cd app && npm run build:audiotee`.
3. **`app/.env`:** `cp app/.env.example app/.env`, then set `LLM_API_KEY` (plus `LLM_BASE_URL` / `LLM_MODEL` if not
   Groq) and `DEEPGRAM_API_KEY`. `LLM_SPOTTER_MODEL` (live term spotting) can be a smaller model on the same server.
   Never commit this file.
4. **System audio permission for Electron:** System Settings → Privacy & Security → Screen & System Audio Recording →
   "System Audio Recording Only" → + → `app/node_modules/electron/dist/Electron.app`. (macOS credits Electron, not
   Terminal: allowing only Terminal gives silence in Live mode.)
5. **Keypad plugin** (needs Logi Options+):
   `mkdir -p ~/Library/Application\ Support/Logi/LogiPluginService/Plugins` (the build fails with `MSB3073` without
   it), then `cd plugin/MeetingKeysPlugin && dotnet build`. Options+ → Settings → **Restart Logi Plugin Service**,
   then put the 9 "Meeting Keys" actions on the matching keypad keys (top left … bottom right). Optional: put the
   **Back** action on the keypad's left arrow.
6. **Camera** (optional): see [Camera focus](#camera-focus-logi-gaze-tracker).
7. **Run:** `cd app && npm run dev`.

## Using it

- **Toolbar:** IntelliPad, status dot (blue playing, red listening), Saved (⌘S), Export meeting notes (⌘E), Settings (⌘,).
- **Mock:** Space plays / pauses (speed 1× / 2×). A quiet **Demo** row at the bottom simulates looking away or a
  question for you (Mock only).
- **Live:** type the topic, names and jargon you expect (better transcription), then **Listen** (Space).
- **Status bar:** Keypad · Model · MX Brio (green: plugged in and tracking; amber: Gaze Tracker not running or not
  calibrated; red: not plugged in; click for details).
- **Settings:** Source (Mock / Live), Scenario, Theme (dark / light), keypad colours (named presets), Camera,
  Diagnostics, Shortcuts. The listener's name lives in `mock/config.json` (currently **Alex**).

### Mock scenarios (`mock/scenarios/index.json`)

| Mode | Scenario | Example terms |
|---|---|---|
| Meeting | **Zoom call: business update (video)** (default; 29 s recorded call, played in sync) | B2B, KYC, ARR, EBITDA, churn, TAM, OKRs |
| Meeting | Product sprint review | RAG, LoRA, SOC 2, runway |
| Meeting | AI platform sync | hallucination, evals, prompt injection, AI agent |
| Meeting | Quarterly business review | ARR, EBITDA, CAC payback, Series B |
| Meeting | New employee onboarding | SSO, MFA, GDPR, OKR |
| Education | **MIT 6.S191: deep learning recap (video)** (default; the clip is local only, not in git) | perceptron, layer, loss function, backpropagation |
| Education | Learning sciences: how the brain learns | hippocampus, spaced repetition |
| Education | Intro to machine learning | gradient descent, overfitting, transformer |
| Education | Climate science 101 | greenhouse effect, albedo, carbon budget |

Video scenarios open the recording in its own window (top-left) that follows Play, Pause, Restart and 2×; the
transcript appears word by word and terms reach the keys when they are spoken. `MOCK_SCENARIO=<id> npm run dev`
forces a meeting scenario at startup; `USAGE=education npm run dev` starts in Education mode.

## Camera focus (Logi Gaze Tracker)

1. Download `Gaze.Tracker-1.0.1-arm64.dmg` from
   https://github.com/Logitech/hackathons/releases/tag/logi-gaze-tracker and drag it to Applications. It is unsigned:
   on first launch click Done, then System Settings → Privacy & Security → Open Anyway. Allow camera access (the first
   run downloads its face model).
2. Menu bar icon → Controls… → Setup: pick the **MX Brio**, 1920×1080, fill in the rig values, Apply rig.
   (IntelliPad's Settings → Camera → **Choose camera…** opens it.)
3. **Calibrate** (Settings → Camera, or the tray icon) and look at the 9 points.
   On a MacBook with a notch, calibration fails with "fullscreen viewport … does not match screen …". Fix (quit the
   tracker first): `plutil -replace NSPrefersDisplaySafeAreaCompatibilityMode -bool YES "/Applications/Gaze Tracker.app/Contents/Info.plist" && codesign --force --deep -s - "/Applications/Gaze Tracker.app"`,
   then reopen it.
4. For reliable detection, aim the MX Brio so your face sits in the middle of the image, with light in front of you.

IntelliPad connects to `ws://127.0.0.1:8964` (`GAZE_WS_URL` to override) and retries every 2 s. Only the tracked
display counts. The camera is used in Live mode only; in Mock, use the Demo row.

## Development

- Tests: `cd app && npm test` (no real model calls). Typecheck: `npm run typecheck`.
- Real-model smoke run (Catch-up + Save on the mock transcript): `npm run smoke`.
- Live smoke run (the mock meeting voiced by `say`, real audiotee + Deepgram): `npm run smoke:live`.
- Offline tuning: `npm run record:live -- --tag podcast --seconds 180` saves raw Deepgram messages to
  `tools/recordings/` (gitignored: third-party speech); `npm run replay:live -- ../tools/recordings/podcast.jsonl`
  replays them through the live pipeline.
