import { EventEmitter } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { SLOT_COUNT, emptyKey, isValidSlot, type KeyState } from "./protocol.js";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8765;

export class PortInUseError extends Error {
  constructor(
    readonly host: string,
    readonly port: number,
  ) {
    super(`Port ${port} on ${host} is already in use`);
    this.name = "PortInUseError";
  }
}

export interface KeypadBridgeOptions {
  host?: string;
  /** 0 picks a free port (tests). */
  port?: number;
  /** Initial state of all 9 slots, e.g. SlotManager.getAll(). */
  initial?: KeyState[];
  log?: (msg: string) => void;
}

export interface PressEvent {
  slot: number;
  ts: number;
}

/**
 * WebSocket server for the keypad plugin (protocol/messages.md), same behaviour as tools/fake-core.mjs:
 * all 9 slots right after `hello`, afterwards only changed slots. Events: `press` (PressEvent),
 * `connected` / `disconnected` (number of plugins that said hello), `listening` (port).
 */
export class KeypadBridge extends EventEmitter {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly log: (msg: string) => void;
  private readonly slots: KeyState[];
  private wss: WebSocketServer | null = null;
  private readonly helloClients = new Set<WebSocket>();

  constructor(opts: KeypadBridgeOptions = {}) {
    super();
    this.host = opts.host ?? DEFAULT_HOST;
    this.requestedPort = opts.port ?? DEFAULT_PORT;
    this.log = opts.log ?? ((m) => console.log(`[keypad] ${m}`));
    this.slots = [];
    for (let i = 0; i < SLOT_COUNT; i++) this.slots[i] = opts.initial?.[i] ?? emptyKey(i);
  }

  /** Resolves with the bound port; rejects with PortInUseError if the port is taken. */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: this.host, port: this.requestedPort });
      const onStartupError = (err: NodeJS.ErrnoException) => {
        wss.close();
        reject(err.code === "EADDRINUSE" ? new PortInUseError(this.host, this.requestedPort) : err);
      };
      wss.once("error", onStartupError);
      wss.once("listening", () => {
        wss.off("error", onStartupError);
        wss.on("error", (err) => this.log(`server error: ${err.message}`));
        this.wss = wss;
        const port = this.port();
        this.log(`listening on ws://${this.host}:${port}`);
        this.emit("listening", port);
        resolve(port);
      });
      wss.on("connection", (ws, req) => this.onConnection(ws, `${req.socket.remoteAddress}:${req.socket.remotePort}`));
    });
  }

  port(): number {
    const addr = this.wss?.address();
    return addr && typeof addr === "object" ? addr.port : this.requestedPort;
  }

  connectedCount(): number {
    return this.helloClients.size;
  }

  /** Store these slots and send them (only these) to every plugin that said hello. */
  apply(keys: KeyState[]): void {
    const valid = keys.filter((k) => isValidSlot(k.slot));
    if (valid.length === 0) return;
    for (const k of valid) this.slots[k.slot] = { ...k };
    this.broadcast(valid);
  }

  /** Current copy of all 9 slots. */
  snapshot(): KeyState[] {
    return this.slots.map((k) => ({ ...k }));
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    this.wss = null;
    if (!wss) return;
    for (const ws of wss.clients) ws.terminate();
    this.helloClients.clear();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  private onConnection(ws: WebSocket, from: string): void {
    this.log(`plugin connected from ${from}`);
    ws.on("message", (data) => this.onMessage(ws, data.toString()));
    ws.on("close", () => {
      const had = this.helloClients.delete(ws);
      this.log("plugin disconnected");
      if (had) this.emit("disconnected", this.helloClients.size);
    });
    ws.on("error", (err) => this.log(`socket error: ${err.message}`));
  }

  private onMessage(ws: WebSocket, text: string): void {
    let msg: { type?: unknown; slot?: unknown; ts?: unknown; plugin?: unknown; version?: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      this.log(`bad JSON: ${text}`);
      return;
    }
    if (msg.type === "hello") {
      this.log(`hello from ${String(msg.plugin)} ${String(msg.version)} -> sending all 9 slots`);
      const isNew = !this.helloClients.has(ws);
      this.helloClients.add(ws);
      this.send(ws, this.slots);
      if (isNew) this.emit("connected", this.helloClients.size);
    } else if (msg.type === "press") {
      if (!isValidSlot(msg.slot)) {
        this.log(`press with invalid slot: ${text}`);
        return;
      }
      const ts = typeof msg.ts === "number" ? msg.ts : Date.now();
      this.emit("press", { slot: msg.slot, ts } satisfies PressEvent);
    } else {
      this.log(`unknown message: ${text}`);
    }
  }

  private broadcast(keys: KeyState[]): void {
    for (const ws of this.helloClients) this.send(ws, keys);
  }

  private send(ws: WebSocket, keys: KeyState[]): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "keys", keys }));
  }
}
