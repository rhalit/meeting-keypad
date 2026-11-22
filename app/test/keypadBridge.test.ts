import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { KeypadBridge, PortInUseError, type PressEvent } from "../src/pipeline/keypadBridge.js";
import { SlotManager } from "../src/pipeline/slots.js";
import { realClock } from "../src/pipeline/clock.js";

interface Client {
  ws: WebSocket;
  messages: unknown[];
  next(): Promise<any>;
}

function connect(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages: unknown[] = [];
    const waiters: ((m: unknown) => void)[] = [];
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      const w = waiters.shift();
      if (w) w(m);
      else messages.push(m);
    });
    const next = () =>
      new Promise<any>((res) => {
        if (messages.length) res(messages.shift());
        else waiters.push(res);
      });
    ws.once("open", () => resolve({ ws, messages, next }));
    ws.once("error", reject);
  });
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe("KeypadBridge", () => {
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  async function startBridge() {
    const initial = new SlotManager({ clock: realClock }).getAll();
    const bridge = new KeypadBridge({ port: 0, initial, log: () => {} });
    const port = await bridge.start();
    cleanup.push(() => bridge.stop());
    return { bridge, port };
  }

  async function client(port: number) {
    const c = await connect(port);
    cleanup.push(() => c.ws.terminate());
    return c;
  }

  it("sends all 9 slots right after hello", async () => {
    const { port } = await startBridge();
    const c = await client(port);
    c.ws.send(JSON.stringify({ type: "hello", plugin: "MeetingKeys", version: "0.1.0" }));
    const msg = await c.next();
    expect(msg.type).toBe("keys");
    expect(msg.keys).toHaveLength(9);
    expect(msg.keys[0]).toEqual({ slot: 0, label: "", state: "empty" });
    expect(msg.keys[6]).toEqual({ slot: 6, label: "Catch-up", state: "shown" });
  });

  it("afterwards sends only the changed slots, and the new state on a later hello", async () => {
    const { bridge, port } = await startBridge();
    const c = await client(port);
    c.ws.send(JSON.stringify({ type: "hello" }));
    await c.next();
    const lora = { slot: 2, label: "LoRA", sub: "Tech", color: "#58A6FF", state: "new" as const };
    bridge.apply([lora]);
    expect(await c.next()).toEqual({ type: "keys", keys: [lora] });
    c.ws.send(JSON.stringify({ type: "hello" }));
    const full = await c.next();
    expect(full.keys[2]).toEqual(lora);
  });

  it("sends nothing to a client before its hello", async () => {
    const { bridge, port } = await startBridge();
    const c = await client(port);
    bridge.apply([{ slot: 0, label: "X", state: "shown" }]);
    await tick();
    expect(c.messages).toEqual([]);
  });

  it("emits press events and ignores invalid ones", async () => {
    const { bridge, port } = await startBridge();
    const presses: PressEvent[] = [];
    bridge.on("press", (p: PressEvent) => presses.push(p));
    const c = await client(port);
    c.ws.send(JSON.stringify({ type: "hello" }));
    await c.next();
    c.ws.send(JSON.stringify({ type: "press", slot: 3, ts: 123 }));
    c.ws.send(JSON.stringify({ type: "press", slot: 9, ts: 1 }));
    c.ws.send(JSON.stringify({ type: "press", slot: "2", ts: 1 }));
    c.ws.send("not json");
    await tick();
    expect(presses).toEqual([{ slot: 3, ts: 123 }]);
  });

  it("emits connected and disconnected", async () => {
    const { bridge, port } = await startBridge();
    const events: string[] = [];
    bridge.on("connected", (n: number) => events.push(`connected ${n}`));
    bridge.on("disconnected", (n: number) => events.push(`disconnected ${n}`));
    const c = await client(port);
    c.ws.send(JSON.stringify({ type: "hello" }));
    await c.next();
    c.ws.close();
    await tick();
    expect(events).toEqual(["connected 1", "disconnected 0"]);
  });

  it("rejects with PortInUseError when the port is taken", async () => {
    const { port } = await startBridge();
    const second = new KeypadBridge({ port, log: () => {} });
    await expect(second.start()).rejects.toBeInstanceOf(PortInUseError);
  });
});
