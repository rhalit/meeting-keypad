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
{ "type": "hello", "plugin": "MeetingKeys", "version": "0.1.0" }
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
    { "slot": 0, "label": "LoRA", "sub": "AI", "bg": "#1F6FEB", "state": "new" },
    { "slot": 6, "label": "Catch\nup", "bg": "#30363D", "state": "shown" }
  ]
}
```

### KeyState fields
| field   | type   | required | notes                                                        |
|---------|--------|----------|--------------------------------------------------------------|
| `slot`  | int    | yes      | 0–8                                                          |
| `label` | string | yes      | max 2 lines × 8 chars, `\n` breaks the line, `""` = blank    |
| `sub`   | string | no       | small second text, max 8 chars (e.g. category)               |
| `bg`    | string | no       | `#RRGGBB`, default `#000000`                                 |
| `state` | string | yes      | see below                                                    |

### States and how the plugin draws them
| state   | drawing                                                                 |
|---------|-------------------------------------------------------------------------|
| `empty` | black key, no text                                                      |
| `new`   | `bg` colour, label, bright white border (app switches to `shown` after 3 s) |
| `shown` | `bg` colour, label                                                      |
| `seen`  | `bg` dimmed to ~40 %, grey label (term already opened)                  |
| `busy`  | label followed by "…" (the model is working: Catch-up, Save)            |
| `alert` | red `#E5484D` background, white label (app may toggle to make it pulse) |

### Action key feedback (no extra states)
- Catch-up (slot 6) and Save (slot 7) are `busy` while the model works, then `shown` again.
- After a save, slot 7 is sent as `{ "slot": 7, "label": "Saved ✓", "bg": "#2DA44E", "state": "shown" }`
  for 1.5 s, then back to its normal `Save` label.

## When the app is unreachable
The plugin blanks all keys and shows `No app` on slot 4, so it is obvious on the device.

## Example session
1. Plugin connects → sends `hello`.
2. App sends `keys` with all 9 slots (terms `empty`, slots 6–8 with their labels).
3. App sends `{ "type": "keys", "keys": [ { "slot": 0, "label": "LoRA", "sub": "AI", "bg": "#1F6FEB", "state": "new" } ] }`.
4. User presses the top-left key → plugin sends `{ "type": "press", "slot": 0, "ts": ... }`.
5. App opens the overlay card and sends slot 0 again with `"state": "seen"`.
