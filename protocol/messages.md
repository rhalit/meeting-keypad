# Protocol: app ↔ keypad plugin

## Transport
- WebSocket. The **app is the server** at `ws://127.0.0.1:8765`; the **plugin is the client**.
- The plugin reconnects every 2 s while the app is unreachable.
- UTF-8 JSON text frames, one message per frame.

## Slots

| slot | key           | role                   |
|------|---------------|------------------------|
| 0    | top left      | term                   |
| 1    | top middle    | term                   |
| 2    | top right     | term                   |
| 3    | middle left   | term                   |
| 4    | middle middle | term                   |
| 5    | middle right  | term                   |
| 6    | bottom left   | Catch-up               |
| 7    | bottom middle | Save                   |
| 8    | bottom right  | "Was that for me?"     |

## Plugin → app

`hello` – sent on every (re)connect.
```json
{ "type": "hello", "plugin": "MeetingKeys", "version": "0.2.0" }
```

`press` – a key was pressed.
```json
{ "type": "press", "slot": 3, "ts": 1795288400000 }
```

## App → plugin

`keys` – key states. Right after `hello`, the app sends all 9 slots; afterwards only the slots that changed.
```json
{
  "type": "keys",
  "keys": [
    { "slot": 0, "label": "Vector database", "sub": "Tech", "color": "#58A6FF", "state": "new" },
    { "slot": 6, "label": "Catch-up", "state": "shown" }
  ]
}
```

### KeyState fields (protocol v2)
| field   | type   | required | notes                                                                         |
|---------|--------|----------|-------------------------------------------------------------------------------|
| `slot`  | int    | yes      | 0–8                                                                           |
| `label` | string | yes      | the **full** term (≤ 40 chars, ≤ 4 words) or action name, `""` = blank. The plugin breaks it into lines and fits it (see below); the app never shortens it. |
| `sub`   | string | no       | category name (term keys only), drawn in small capitals at the top           |
| `color` | string | no       | `#RRGGBB`. Term keys: category colour (category text, "new" border). Keys without `sub`: label colour (default white) |
| `bg`    | string | no       | `#RRGGBB` key background, default black (user setting in the app panel). Ignored in `empty` (always black) and `alert` (`color` is the background). On a light `bg` (luminance > 0.55) the plugin draws the white texts (term, default action label) near-black `#111111` and the "seen" grey darker, so they stay readable |
| `state` | string | yes      | see below                                                                     |

### Drawing (the plugin does the layout)
- Dark (black) background by default, or `bg` when the app sends one; no coloured tile. The image fills the whole key (no device-drawn action name).
- Term keys: `sub` in upper case, small, in `color`, at the top. `label` large, bold, white, centred,
  at most 2 lines broken between words, the largest font size that fits. A word is abbreviated
  (`"Quantiz."`) only if it does not fit on a line at the smallest size; text beyond 2 lines at the
  smallest size ends with "…".
- Keys without `sub` (bottom row): `label` centred in `color` (default white), same fitting.

### States
| state   | drawing                                                                   |
|---------|---------------------------------------------------------------------------|
| `empty` | black key, no text                                                        |
| `new`   | as `shown` plus a thin border in `color` (the app switches to `shown` after 3 s) |
| `shown` | as described above                                                        |
| `seen`  | the label turns grey (term already opened)                                |
| `busy`  | label followed by "…" (the model is working: Catch-up, Save)              |
| `alert` | background in `color` (default red `#E5484D`), white label. The app pulses it by alternating `color` |

### Term order (app side, for reference)
Slots 0–5 are read left to right, top to bottom. A new term always appears on slot 0, every other term
moves one slot forward, the term on slot 5 leaves. A term's state (`new` / `shown` / `seen`) moves with it.
A press within 500 ms after a shift goes to the term that was on that key before the shift.

### Action key feedback (no extra states)
- Catch-up (slot 6) and Save (slot 7) are `busy` while the model works, then `shown` again.
- After a save, slot 7 is sent as `{ "slot": 7, "label": "Saved ✓", "color": "#3FB950", "state": "shown" }`
  for 1.5 s, then back to its normal `Save` label.
- "For me?" (slot 8): when a question or request aimed at the listener is heard, the app sends
  `{ "slot": 8, "label": "For me?", "color": "#E5484D", "state": "alert" }` and then alternates `color` between
  `#E5484D` and `#9E2A2F` every 600 ms (pulse). After a press, or 90 s without one, slot 8 goes back to
  `{ "slot": 8, "label": "For me?", "state": "shown" }`. In `alert`, `color` is the background, never the label colour.
- After you were away (camera focus, see below), slot 6 is sent as
  `{ "slot": 6, "label": "Missed 2m", "color": "#E3B341", "state": "shown" }` (amber label) until it is
  pressed (or 5 min pass); a press summarises only what you missed.
- Mentioned while you are away (a "For me?" question, or your name, while the camera says you look
  away): the app sends **all 9 slots** as `alert` with `"color": "#E5484D"` (labels and `sub` kept),
  then their normal state, alternating every 500 ms. It stops when you look back or press any key;
  that press only stops the pulse and shows the "For me?" card, it does not trigger the key's own action.
  Slot 8 keeps its own pulse underneath and resumes it when the all-keys pulse stops.

## Education mode (app setting)
The app has two layouts. Meeting (default): 6 Catch-up · 7 Save · 8 For me?. Education:
6 `Flashcard` · 7 `Quiz me` · 8 `Explain simply` (slots 0–5 stay term keys). On a switch the app sends
slots 6–8 with the new labels. Feedback, with no new states:
- Flashcard: `busy` while the model writes the card, then `{ "slot": 6, "label": "Added ✓", "color": "#3FB950", "state": "shown" }` for 1.5 s.
- Quiz me: `busy` while the model writes a question, then `{ "slot": 7, "label": "Answer", "color": "#E3B341", "state": "shown" }`
  until the next press shows the answer.
- Explain simply: `busy` while it streams; after an away period it reads `Missed 2m` (amber), like Catch-up in Meeting mode.

## Camera focus (app only)
The app reads the Logi Gaze Tracker (`ws://127.0.0.1:8964`, any Logitech webcam) to know whether you
are looking at the screen. Nothing about it goes to the plugin except the key states above.

## When the app is unreachable
The plugin blanks all keys and shows `No app` on slot 4, so it is obvious on the device.

## Example session
1. Plugin connects → sends `hello`.
2. App sends `keys` with all 9 slots (terms `empty`, slots 6–8 with their labels).
3. App sends `{ "type": "keys", "keys": [ { "slot": 0, "label": "LoRA", "sub": "Tech", "color": "#58A6FF", "state": "new" } ] }`.
4. User presses the top-left key → plugin sends `{ "type": "press", "slot": 0, "ts": ... }`.
5. App opens the overlay card and sends slot 0 again with `"state": "seen"`.
