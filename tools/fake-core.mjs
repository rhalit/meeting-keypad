// fake-core: stand-in for the Meeting Keypad app, for testing the keypad plugin.
// Runs the WebSocket server from protocol/messages.md (v2) and puts random jargon on the keys,
// FIFO like the app: each new term enters on slot 0 and the others move one slot forward.
//
//   cd tools && npm install && npm run fake-core

import { WebSocketServer } from "ws";

const HOST = "127.0.0.1";
const PORT = 8765;
const TICK_MS = 3000; // a new term every 3 s
const NEW_MS = 3000; // "new" -> "shown" after 3 s
const ACTION_RESTORE_MS = 2000; // slots 6-8 go back to "shown" after a press

// Same colours as app/src/pipeline/protocol.ts.
const CATEGORY_COLORS = {
  Tech: "#58A6FF",
  Science: "#BC8CFF",
  Health: "#3FB950",
  Business: "#F0883E",
  Finance: "#E3B341",
  Law: "#FF7B9C",
  Other: "#39C5CF",
};

// Full terms: the plugin breaks and fits them. A mix of short, long-word and 4-word terms.
const TERMS = [
  { term: "Idempotency", sub: "Tech" },
  { term: "Kubernetes", sub: "Tech" },
  { term: "Zero-knowledge proof", sub: "Tech" },
  { term: "LoRA", sub: "Tech" },
  { term: "RAG", sub: "Tech" },
  { term: "Vector database", sub: "Tech" },
  { term: "Quantization", sub: "Tech" },
  { term: "p99 latency", sub: "Tech" },
  { term: "NSDR", sub: "Health" },
  { term: "Non-sleep deep rest", sub: "Health" },
  { term: "Dopamine", sub: "Science" },
  { term: "Adenosine", sub: "Science" },
  { term: "Circadian rhythm", sub: "Science" },
  { term: "EBITDA", sub: "Finance" },
  { term: "Runway", sub: "Finance" },
  { term: "Cap table", sub: "Finance" },
  { term: "Churn rate", sub: "Business" },
  { term: "OKR", sub: "Business" },
  { term: "SOC 2", sub: "Law" },
  { term: "Force majeure", sub: "Law" },
  { term: "Electroencephalography", sub: "Health" },
  { term: "Total addressable market size", sub: "Business" },
  { term: "Long COVID", sub: "Other" },
];

for (const t of TERMS) {
  if (t.term.length > 40 || !CATEGORY_COLORS[t.sub]) throw new Error(`Bad term: ${JSON.stringify(t)}`);
}

const ACTION_KEYS = { 6: "Catch-up", 7: "Save", 8: "For me?" };

// Server-side state of all 9 slots.
const slots = [];
for (let i = 0; i < 9; i++) {
  slots[i] = ACTION_KEYS[i] ? { slot: i, label: ACTION_KEYS[i], state: "shown" } : { slot: i, label: "", state: "empty" };
}

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...args) => console.log(ts(), ...args);

const wss = new WebSocketServer({ host: HOST, port: PORT });
const helloClients = new Set();

function send(ws, keys) {
  ws.send(JSON.stringify({ type: "keys", keys }));
}

function broadcast(slotNumbers) {
  for (const ws of helloClients) send(ws, slotNumbers.map((s) => slots[s]));
}

wss.on("listening", () => log(`fake-core listening on ws://${HOST}:${PORT}`));
wss.on("error", (err) => {
  log(`server error: ${err.message}`);
  process.exit(1);
});

wss.on("connection", (ws, req) => {
  log(`plugin connected from ${req.socket.remoteAddress}:${req.socket.remotePort}`);

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      log(`bad JSON: ${data}`);
      return;
    }

    if (msg.type === "hello") {
      log(`hello from ${msg.plugin} ${msg.version} -> sending all 9 slots`);
      helloClients.add(ws);
      send(ws, slots);
    } else if (msg.type === "press") {
      const s = slots[msg.slot];
      if (!s) {
        log(`PRESS invalid slot ${msg.slot}`);
        return;
      }
      log(`PRESS slot ${msg.slot} (${s.state === "empty" ? "empty" : s.label}) ts=${msg.ts}`);
      if (s.state === "empty") return;
      if (ACTION_KEYS[msg.slot]) {
        slots[msg.slot] = { ...s, state: "busy" };
        broadcast([msg.slot]);
        const mine = slots[msg.slot];
        setTimeout(() => {
          if (slots[msg.slot] !== mine) return;
          slots[msg.slot] = { ...mine, state: "shown" };
          broadcast([msg.slot]);
        }, ACTION_RESTORE_MS);
      } else {
        slots[msg.slot] = { ...s, state: "seen" };
        broadcast([msg.slot]);
      }
    } else {
      log(`unknown message: ${data}`);
    }
  });

  ws.on("close", () => {
    helloClients.delete(ws);
    log("plugin disconnected");
  });
});

let next = 0;
setInterval(() => {
  if (helloClients.size === 0) return;
  const t = TERMS[next++ % TERMS.length];
  // Conveyor: slot 5 leaves, 4 -> 5, ..., 0 -> 1, the new term on 0 (states travel along).
  for (let i = 5; i > 0; i--) slots[i] = { ...slots[i - 1], slot: i };
  const placed = { slot: 0, label: t.term, sub: t.sub, color: CATEGORY_COLORS[t.sub], state: "new" };
  slots[0] = placed;
  log(`slot 0 <- "${t.term}" (${t.sub}) new`);
  broadcast([0, 1, 2, 3, 4, 5]);
  setTimeout(() => {
    const i = slots.findIndex((s) => s.label === placed.label && s.state === "new");
    if (i === -1) return;
    slots[i] = { ...slots[i], state: "shown" };
    broadcast([i]);
  }, NEW_MS);
}, TICK_MS);
