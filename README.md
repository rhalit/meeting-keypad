# Meeting Keypad

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

## Recording a fixture (offline tuning)

To tune segmentation and the spotter without spending LLM budget, record a real session once and replay it.

1. Give your **terminal app** the system audio permission (same place as step 4 above; the recorder runs in plain Node).
2. `cd app && npm run record:live -- --tag podcast --seconds 180`, then start playing the audio (a YouTube podcast,
   a call) on this Mac. It prints the transcript as it arrives and writes `tools/recordings/podcast.jsonl`
   (raw Deepgram messages; gitignored, as it holds third-party speech). Ctrl+C stops early.
3. `npm run replay:live -- ../tools/recordings/podcast.jsonl --terms "NSDR=Health, dopamine=Science"` runs it through
   the full live pipeline with a free keyword spotter and prints line lengths and the speech→key delay per term.
   `--spotter real` uses `LLM_SPOTTER_MODEL` instead (real time, costs budget).
