import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { realClock } from "../src/pipeline/clock.js";
import type { FocusSample } from "../src/pipeline/focus.js";
import { GazeClient, parseSnapshot, type GazeStatus } from "../src/pipeline/gazeSource.js";

const SCREEN = { width_px: 1728, height_px: 1117 };
const FACE = { bounding_box_norm: { x: 0.3, y: 0.2, width: 0.3, height: 0.4 } };
const CALIBRATED = { tracking_enabled: true, model_calibrated: true, geometric_calibrated: true };

function snap(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "snapshot", timestamp_ms: 1, screen: SCREEN, gaze: { x_px: 842, y_px: 391, source: "geometric" }, face: FACE, state: CALIBRATED, ...over };
}

describe("parseSnapshot", () => {
  it("gaze on the screen -> present, on screen", () => {
    expect(parseSnapshot(snap())).toMatchObject({ sample: { present: true, onScreen: true }, hasGaze: true, calibrated: true });
  });

  it("gaze slightly outside (within 10 %) still counts as on screen; far below is off screen", () => {
    expect(parseSnapshot(snap({ gaze: { x_px: -100, y_px: 1180 } }))!.sample.onScreen).toBe(true);
    expect(parseSnapshot(snap({ gaze: { x_px: 800, y_px: 1500 } }))!.sample.onScreen).toBe(false);
    expect(parseSnapshot(snap({ gaze: { x_px: 2200, y_px: 400 } }))!.sample.onScreen).toBe(false);
  });

  it("an implausible gaze point (more than half a screen outside) is 'unknown', not 'looking away'", () => {
    expect(parseSnapshot(snap({ gaze: { x_px: -2040, y_px: -7714 } }))!.sample).toEqual({ present: true, onScreen: null });
    expect(parseSnapshot(snap({ gaze: { x_px: 800, y_px: 1800 } }))!.sample.onScreen).toBeNull();
  });

  it("no face, no gaze -> not present", () => {
    expect(parseSnapshot(snap({ gaze: null, face: null }))!.sample).toEqual({ present: false, onScreen: null });
    expect(parseSnapshot(snap({ gaze: null, face: { bounding_box_norm: null } }))!.sample.present).toBe(false);
  });

  it("uncalibrated: face but no gaze -> present, unknown direction", () => {
    const p = parseSnapshot(snap({ gaze: null, state: { tracking_enabled: true, model_calibrated: false } }))!;
    expect(p).toMatchObject({ sample: { present: true, onScreen: null }, hasGaze: false, calibrated: false });
  });

  it("ignores other messages", () => {
    expect(parseSnapshot({ type: "ack", status: "streaming" })).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot("x")).toBeNull();
  });
});

describe("GazeClient (against a local fake tracker)", () => {
  let server: WebSocketServer | null = null;
  let client: GazeClient | null = null;

  afterEach(async () => {
    client?.stop();
    client = null;
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });

  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  async function startServer(port = 0): Promise<{ url: string; received: unknown[]; sockets: WebSocket[] }> {
    const received: unknown[] = [];
    const sockets: WebSocket[] = [];
    server = new WebSocketServer({ host: "127.0.0.1", port });
    await new Promise<void>((r) => server!.once("listening", () => r()));
    server.on("connection", (ws) => {
      sockets.push(ws);
      ws.on("message", (d) => received.push(JSON.parse(d.toString())));
    });
    return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, received, sockets };
  }

  function makeClient(url: string, extra: Partial<ConstructorParameters<typeof GazeClient>[0]> = {}) {
    const samples: FocusSample[] = [];
    const states: GazeStatus["state"][] = [];
    const live: boolean[] = [];
    const logs: string[] = [];
    client = new GazeClient({ url, clock: realClock, log: (m) => logs.push(m), retryMs: 50, staleMs: 300, ...extra });
    client.on("sample", (s: FocusSample) => samples.push(s));
    client.on("status", (s: GazeStatus) => states.push(s.state));
    client.on("live", (l: boolean) => live.push(l));
    return { client, samples, states, live, logs };
  }

  it("asks for a stream, emits samples, dedupes re-sent frames", async () => {
    const srv = await startServer();
    const c = makeClient(srv.url);
    c.client.start();
    await until(() => srv.received.length > 0);
    expect(srv.received[0]).toEqual({ type: "start_stream", interval_ms: 200 });
    const ws = srv.sockets[0];
    ws.send(JSON.stringify(snap({ timestamp_ms: 10 })));
    ws.send(JSON.stringify(snap({ timestamp_ms: 10 }))); // same frame again
    ws.send(JSON.stringify(snap({ timestamp_ms: 11, gaze: { x_px: 800, y_px: 1400 } })));
    await until(() => c.samples.length >= 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(c.samples).toEqual([
      { present: true, onScreen: true },
      { present: true, onScreen: false },
    ]);
    expect(c.client.status().state).toBe("tracking");
    expect(c.live).toEqual([true]);
  });

  it("uncalibrated tracker -> status 'uncalibrated' with calibration advice", async () => {
    const srv = await startServer();
    const c = makeClient(srv.url);
    c.client.start();
    await until(() => srv.sockets.length > 0);
    srv.sockets[0].send(JSON.stringify(snap({ gaze: null, state: { model_calibrated: false } })));
    await until(() => c.samples.length === 1);
    expect(c.client.status()).toMatchObject({ state: "uncalibrated" });
    expect(c.client.status().advice).toMatch(/Calibrate/);
  });

  it("no frames for staleMs -> 'no-data' and live false", async () => {
    const srv = await startServer();
    const c = makeClient(srv.url);
    c.client.start();
    await until(() => srv.sockets.length > 0);
    srv.sockets[0].send(JSON.stringify(snap({ timestamp_ms: 5 })));
    await until(() => c.live.length === 1);
    await until(() => c.live.length === 2, 1500);
    expect(c.live).toEqual([true, false]);
    expect(c.client.status().state).toBe("no-data");
  });

  it("tracker not running -> 'no-tracker', logs once, connects when it starts", async () => {
    const probe = await startServer();
    const port = Number(new URL(probe.url).port);
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    const c = makeClient(`ws://127.0.0.1:${port}`);
    c.client.start();
    await until(() => c.client.status().state === "no-tracker");
    await new Promise((r) => setTimeout(r, 200)); // a few retries
    expect(c.logs.filter((l) => l.includes("not reachable"))).toHaveLength(1);
    const srv = await startServer(port);
    await until(() => srv.received.length > 0);
    expect(srv.received[0]).toMatchObject({ type: "start_stream" });
  });

  it("calibrate() sends start_calibration when connected, false otherwise", async () => {
    const srv = await startServer();
    const c = makeClient(srv.url);
    expect(c.client.calibrate()).toBe(false);
    c.client.start();
    await until(() => srv.received.length > 0);
    expect(c.client.calibrate()).toBe(true);
    await until(() => srv.received.length > 1);
    expect(srv.received[1]).toEqual({ type: "start_calibration", pose: "center", append: false });
  });
});
