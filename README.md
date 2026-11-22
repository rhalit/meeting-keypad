# Meeting Keypad

A macOS app that listens to a meeting, spots jargon as it is spoken and shows each term on a key of the
Logitech MX Keypad. Pressing a term key opens a card with a plain explanation. See `CLAUDE.md` for the
architecture, commands and rules, and `protocol/messages.md` for the plugin ↔ app contract.

## Setting up on a new Mac

1. **Install dependencies:** `cd app && npm install`.
2. **Build audiotee** (system audio capture, once per machine): `cd app && npm run build:audiotee`.
   This writes `tools/audiotee/bin/audiotee`.
3. **Create `app/.env`:** `cp app/.env.example app/.env`, then fill in `LLM_API_KEY` (and `LLM_BASE_URL` /
   `LLM_MODEL` if you don't use Groq) and `DEEPGRAM_API_KEY`. Never commit this file.
4. **Allow system audio for Electron:** System Settings → Privacy & Security → Screen & System Audio Recording →
   "System Audio Recording Only" → click + and add `app/node_modules/electron/dist/Electron.app`, then turn it on.
   macOS credits the permission to Electron, not to Terminal, so allowing only Terminal gives silence in Live mode.
   (`npm run smoke:live` runs in plain Node, so for that the terminal app needs the permission.)
5. **Run:** `cd app && npm run dev`, switch the panel to Live and press Start listening.
