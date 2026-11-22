# IntelliPad (Meeting Keypad)

A macOS app that listens to a meeting, spots jargon as it is spoken and shows each term on a key of the
Logitech MX Keypad. Pressing a term key opens a card with a plain explanation. See `CLAUDE.md` for the
architecture, commands and rules, and `protocol/messages.md` for the plugin ↔ app contract.

## Setting up on a new Mac

1. **Install dependencies:** `cd app && npm install`.
2. **Build audiotee** (system audio capture, once per machine): `cd app && npm run build:audiotee`.
   This writes `tools/audiotee/bin/audiotee`.
3. **Create `app/.env`:** `cp app/.env.example app/.env`, then fill in `LLM_API_KEY` (and `LLM_BASE_URL` /
   `LLM_MODEL` if you don't use Groq) and `DEEPGRAM_API_KEY`. `LLM_SPOTTER_MODEL` (live term spotting) is a
   small fast model on the same server (`openai/gpt-oss-20b` on Groq). Never commit this file.
4. **Allow system audio for Electron:** System Settings → Privacy & Security → Screen & System Audio Recording →
   "System Audio Recording Only" → click + and add `app/node_modules/electron/dist/Electron.app`, then turn it on.
   macOS credits the permission to Electron, not to Terminal, so allowing only Terminal gives silence in Live mode.
   (`npm run smoke:live` runs in plain Node, so for that the terminal app needs the permission.)
5. **Run:** `cd app && npm run dev`, switch the panel to Live and press Start listening.
6. **Keypad plugin** (needs Logi Options+): `mkdir -p ~/Library/Application\ Support/Logi/LogiPluginService/Plugins`
   (the build fails with `MSB3073` if this folder is missing), then `cd plugin/MeetingKeysPlugin && dotnet build`.
   Options+ → Settings → "Restart Logi Plugin Service". Then in Options+, on the MX Keypad, put the 9 "Meeting Keys"
   actions on the matching keys (top left … bottom right). The panel shows "Keypad connected".
7. **Camera focus (optional):** see below.

## Meeting and Education modes

The panel switches between two layouts (keys 0–5 always show terms):
- **Meeting** (default): Catch-up · Save · For me?
- **Education**: **Flashcard** (the model turns the last 90 s into a question/answer card, appended to
  `output/flashcards.csv`, ready for Anki: File → Import) · **Quiz me** (a 3-choice question on the last 3 min;
  press again for the answer) · **Explain simply** (the last 2 min in plain words with an example).

The **Meeting / Education** switch sits above the keypad mirror in the main window (⌘1 / ⌘2). The panel's **Settings**
(⌘,) holds Source (Mock / Live), **Scenario** (mock content for the mode), Theme (Dark / Light) and the keypad colours.
Choices are remembered between runs.

Mock scenarios (`mock/scenarios/index.json`):

| Mode | Scenario | Terms |
|---|---|---|
| Meeting | Product sprint review (default, `mock/meeting.json`) | RAG, LoRA, SOC 2, runway… |
| Meeting | AI platform sync | hallucination, evals, prompt injection, AI agent… |
| Meeting | Quarterly business review | ARR, EBITDA, CAC payback, Series B… |
| Meeting | New employee onboarding | SSO, MFA, GDPR, OKR… |
| Education | Learning sciences: how the brain learns (default) | hippocampus, spaced repetition… |
| Education | Intro to machine learning | gradient descent, overfitting, transformer… |
| Education | Climate science 101 | greenhouse effect, albedo, carbon budget… |

Each one asks the listener two direct questions (For me? / the away pulse). `MOCK_SCENARIO=<id> npm run dev` forces a
meeting scenario at startup; `USAGE=education npm run dev` starts in Education mode.

## Camera focus (Logi Gaze Tracker)

The app uses Logitech's [Gaze Tracker](https://logitech.github.io/hackathons/logi-gaze-tracker/setup/)
(any Logitech webcam, e.g. the MX Brio) to know whether you are looking at the screen:

- Away for more than ~3 s (looking off-screen, or no face) and back again → the Catch-up key reads
  `Missed 2m`, and pressing it summarises from the moment you looked away until now.
- A "For me?" question while you are away → all 9 keys pulse red until you look back or press a key,
  then the "For me?" card opens (question, context, suggested reply).

Setup, once per machine:
1. Download `Gaze.Tracker-1.0.1-arm64.dmg` (Apple Silicon) from
   https://github.com/Logitech/hackathons/releases/tag/logi-gaze-tracker and drag it to Applications.
   It is unsigned: on first launch click Done, then System Settings → Privacy & Security → Open Anyway.
   Allow camera access. The first run needs internet (it downloads its face model).
2. Menu bar icon → Controls… → Setup: pick the MX Brio, 1920×1080, fill in Rig setup, Apply rig.
3. Calibrate: the panel's **Calibrate gaze** button (or tray icon → Start Calibration), look at the 9 points.
   Without calibration the app only detects "left the desk", not "looking away".
   On a MacBook with a notch, calibration fails with "fullscreen viewport 1512×949 does not match screen 1512×982".
   Fix (quit the tracker first): `plutil -replace NSPrefersDisplaySafeAreaCompatibilityMode -bool YES
   "/Applications/Gaze Tracker.app/Contents/Info.plist" && codesign --force --deep -s - "/Applications/Gaze Tracker.app"`,
   then reopen it (Open Anyway again if macOS asks). It then runs below the notch and calibration works.
4. Start Meeting Keypad. The panel's camera line shows `Camera: tracking your gaze`.

The app connects to `ws://127.0.0.1:8964` (override with `GAZE_WS_URL`) and retries every 2 s, so the
order does not matter. Only the tracked display counts: looking at a second monitor counts as away.
**Simulate away** fakes looking away without a camera (demo fallback); **Simulate mention** sends a line
naming you through the real "For me?" check (one model call).
Check before the demo that Meet/Zoom and the Gaze Tracker can use the MX Brio at the same time.

## Recording a fixture (offline tuning)

To tune segmentation and the spotter without spending LLM budget, record a real session once and replay it.

1. Give your **terminal app** the system audio permission (same place as step 4 above; the recorder runs in plain Node).
2. `cd app && npm run record:live -- --tag podcast --seconds 180`, then start playing the audio (a YouTube podcast,
   a call) on this Mac. It prints the transcript as it arrives and writes `tools/recordings/podcast.jsonl`
   (raw Deepgram messages; gitignored, as it holds third-party speech). Ctrl+C stops early.
3. `npm run replay:live -- ../tools/recordings/podcast.jsonl --terms "NSDR=Health, dopamine=Science"` runs it through
   the full live pipeline with a free keyword spotter and prints line lengths and the speech→key delay per term.
   `--spotter real` uses `LLM_SPOTTER_MODEL` instead (real time, costs budget).
