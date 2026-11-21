// fake-core: stand-in for the Meeting Keypad app, for testing the keypad plugin.
// Runs the WebSocket server from protocol/messages.md and puts random jargon on the keys.
//
//   cd tools && npm install && npm run fake-core

import { WebSocketServer } from "ws";

const HOST = "127.0.0.1";
const PORT = 8765;
const TICK_MS = 3000; // a new term every 3 s
const NEW_MS = 3000; // "new" -> "shown" after 3 s
const ACTION_RESTORE_MS = 2000; // slots 6-8 go back to "shown" after a press

const CATEGORY_BG = {
  AI: "#1F6FEB",
  Infra: "#0E7C7B",
  Eng: "#8250DF",
  Biz: "#B7791F",
  Crypto: "#BF3989",
};

// label: max 2 lines x 8 chars (the full term only ever appears in the overlay).
const TERMS = [
  { term: "idempotency", label: "Idem-\npotency", sub: "Eng" },
  { term: "Kubernetes", label: "K8s", sub: "Infra" },
  { term: "zero-knowledge proof", label: "ZK\nproof", sub: "Crypto" },
  { term: "LoRA", label: "LoRA", sub: "AI" },
  { term: "retrieval-augmented generation", label: "RAG", sub: "AI" },
  { term: "vector database", label: "Vector\nDB", sub: "AI" },
  { term: "quantization", label: "Quanti-\nzation", sub: "AI" },
  { term: "fine-tuning", label: "Fine-\ntuning", sub: "AI" },
  { term: "embedding", label: "Embed-\nding", sub: "AI" },
  { term: "backpressure", label: "Back-\npressure", sub: "Eng" },
  { term: "sharding", label: "Sharding", sub: "Infra" },
  { term: "CI/CD", label: "CI/CD", sub: "Infra" },
  { term: "p99 latency", label: "p99", sub: "Infra" },
  { term: "latency budget", label: "Latency\nbudget", sub: "Infra" },
  { term: "tech debt", label: "Tech\ndebt", sub: "Eng" },
  { term: "feature flag", label: "Feature\nflag", sub: "Eng" },
  { term: "EBITDA", label: "EBITDA", sub: "Biz" },
  { term: "runway", label: "Runway", sub: "Biz" },
  { term: "cap table", label: "Cap\ntable", sub: "Biz" },
  { term: "churn rate", label: "Churn\nrate", sub: "Biz" },
  { term: "OKR", label: "OKR", sub: "Biz" },
];

for (const t of TERMS) {
  const lines = t.label.split("\n");
  if (lines.length > 2 || lines.some((l) => l.length > 8) || t.sub.length > 8) {
    throw new Error(`Label too long for a key: ${JSON.stringify(t)}`);
  }
}

const ACTION_KEYS = {
  6: { label: "Catch\nup", bg: "#30363D" },
  7: { label: "Save", bg: "#30363D" },
  8: { label: "For me?", bg: "#30363D" },
};

// Server-side state of all 9 slots; gen[] guards the delayed "new" -> "shown" switch.
const slots = [];
const gen = new Array(9).fill(0);
for (let i = 0; i < 9; i++) {
  slots[i] = ACTION_KEYS[i]
    ? { slot: i, label: ACTION_KEYS[i].label, bg: ACTION_KEYS[i].bg, state: "shown" }
    : { slot: i, label: "", state: "empty" };
}

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...args) => console.log(ts(), ...args);
const oneLine = (label) => label.replace(/\n/g, " ");

const wss = new WebSocketServer({ host: HOST, port: PORT });
const helloClients = new Set();

function send(ws, keys) {
  ws.send(JSON.stringify({ type: "keys", keys }));
}

function update(slot, patch) {
  slots[slot] = { ...slots[slot], ...patch };
  for (const ws of helloClients) send(ws, [slots[slot]]);
  return ++gen[slot];
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
      log(`PRESS slot ${msg.slot} (${s.state === "empty" ? "empty" : oneLine(s.label)}) ts=${msg.ts}`);
      if (s.state === "empty") return;
      const g = update(msg.slot, { state: "seen" });
      if (ACTION_KEYS[msg.slot]) {
        setTimeout(() => {
          if (gen[msg.slot] === g) update(msg.slot, { state: "shown" });
        }, ACTION_RESTORE_MS);
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

setInterval(() => {
  if (helloClients.size === 0) return;
  const t = TERMS[Math.floor(Math.random() * TERMS.length)];
  const slot = Math.floor(Math.random() * 6);
  log(`slot ${slot} <- "${t.term}" (${oneLine(t.label)}) new`);
  const g = update(slot, { label: t.label, sub: t.sub, bg: CATEGORY_BG[t.sub], state: "new" });
  setTimeout(() => {
    if (gen[slot] === g) update(slot, { state: "shown" });
  }, NEW_MS);
}, TICK_MS);
