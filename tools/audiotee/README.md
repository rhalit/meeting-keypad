# audiotee (pinned)

System audio capture for the live meeting mode: [makeusabrew/audiotee](https://github.com/makeusabrew/audiotee)
(MIT, Swift, Core Audio process taps, macOS 14.2+). Upstream has no releases or tags, so we pin a
commit: `VERSION` holds the SHA.

Build (release) once per machine:

```sh
cd app && npm run build:audiotee     # = tools/audiotee/build.sh
```

The script fetches exactly that commit into `src/` and puts the binary at `bin/audiotee`
(both gitignored). If `swift build` crashes (some Command Line Tools installs ship a broken
SwiftPM, or an SDK newer than the compiler), it compiles with `swiftc` directly against the
newest SDK the compiler supports. Same sources, same flags (`-O`, whole module).

How the app runs it (`app/src/pipeline/audioCapture.ts`):

```sh
audiotee --sample-rate 16000 --chunk-duration 0.1
```

- stdout: raw PCM, 16 kHz mono Int16 LE (any `--sample-rate` conversion gives Int16), no framing.
- stderr: JSON lines `{timestamp, message_type, data}` (`info`, `error`, `debug`, `metadata`, `stream_start`, `stream_stop`).
- Taps all processes. Playback is not muted, and headphones work too.

Permission: the first time, macOS asks whether the *responsible app* may record system audio.
That is the app that started Meeting Keypad, so Terminal when you use `npm run dev`. Until the
prompt is answered, audiotee waits in "Starting audio device" and sends nothing (the panel shows
"waiting for macOS permission"). To grant or check it later: System Settings → Privacy & Security
→ Screen & System Audio Recording → "System Audio Recording Only" → turn on Terminal.
