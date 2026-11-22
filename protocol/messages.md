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
| `state` | string | yes      | see below                                                                     |

### Drawing (the plugin does the layout)
- Dark (black) background, no coloured tile. The image fills the whole key (no device-drawn action name).
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
| `alert` | red `#E5484D` background, white label (app may toggle to make it pulse)   |

### Term order (app side, for reference)
Slots 0–5 are read left to right, top to bottom. A new term always appears on slot 0, every other term
moves one slot forward, the term on slot 5 leaves. A term's state (`new` / `shown` / `seen`) moves with it.
A press within 500 ms after a shift goes to the term that was on that key before the shift.

### Action key feedback (no extra states)
- Catch-up (slot 6) and Save (slot 7) are `busy` while the model works, then `shown` again.
- After a save, slot 7 is sent as `{ "slot": 7, "label": "Saved ✓", "color": "#3FB950", "state": "shown" }`
  for 1.5 s, then back to its normal `Save` label.

## When the app is unreachable
The plugin blanks all keys and shows `No app` on slot 4, so it is obvious on the device.

## Example session
1. Plugin connects → sends `hello`.
2. App sends `keys` with all 9 slots (terms `empty`, slots 6–8 with their labels).
3. App sends `{ "type": "keys", "keys": [ { "slot": 0, "label": "LoRA", "sub": "Tech", "color": "#58A6FF", "state": "new" } ] }`.
4. User presses the top-left key → plugin sends `{ "type": "press", "slot": 0, "ts": ... }`.
5. App opens the overlay card and sends slot 0 again with `"state": "seen"`.
