import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AudioCapture, rmsDbfs, type AudioStatus } from "../src/pipeline/audioCapture.js";
import { realClock } from "../src/pipeline/clock.js";

const FAKE = join(__dirname, "fixtures", "fake-audiotee.mjs");

function capture(mode: string, extra: Partial<ConstructorParameters<typeof AudioCapture>[0]> = {}) {
  const spawned: string[][] = [];
  const logs: string[] = [];
  const cap = new AudioCapture({
    binPath: FAKE,
    clock: realClock,
    log: (m) => logs.push(m),
    spawn: (cmd, args) => {
      spawned.push(args);
      return spawn(process.execPath, [cmd, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FAKE_AUDIOTEE_MODE: mode },
      });
    },
    backoffMs: [100, 200],
    permissionWaitMs: 300,
    silentMs: 400,
    killWaitMs: 300,
    ...extra,
  });
  const states: AudioStatus[] = [];
  cap.on("status", (s: AudioStatus) => states.push(s));
  return { cap, spawned, logs, states };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("rmsDbfs", () => {
  it("is -Infinity for silence and ~-20 dB for a 0.1 square wave", () => {
    expect(rmsDbfs(Buffer.alloc(320))).toBe(-Infinity);
    const b = Buffer.alloc(320);
    for (let i = 0; i < 160; i++) b.writeInt16LE(i % 2 ? 3277 : -3277, i * 2);
    expect(rmsDbfs(b)).toBeCloseTo(-20, 0);
  });
});

describe("AudioCapture", () => {
  let cap: AudioCapture | null = null;
  afterEach(async () => {
    await cap?.stop();
    cap = null;
  });

  it("missing binary: status 'missing' with build advice, nothing spawned", () => {
    const c = capture("ok", { exists: () => false });
    cap = c.cap;
    cap.start();
    expect(cap.status()).toMatchObject({ state: "missing" });
    expect(cap.status().advice).toMatch(/build:audiotee/);
    expect(c.spawned).toHaveLength(0);
  });

  it("streams aligned PCM at 16 kHz and reports levels", async () => {
    const c = capture("ok");
    cap = c.cap;
    const chunks: Buffer[] = [];
    const levels: number[] = [];
    cap.on("pcm", (b: Buffer) => chunks.push(b));
    cap.on("level", (d: number) => levels.push(d));
    cap.start();
    expect(c.spawned[0]).toEqual(["--sample-rate", "16000", "--chunk-duration", "0.1"]);
    await until(() => chunks.reduce((n, b) => n + b.length, 0) >= 3200 * 3);
    expect(chunks.every((b) => b.length % 2 === 0)).toBe(true);
    const all = Buffer.concat(chunks);
    expect(all.readInt16LE(0)).toBe(-3000);
    expect(all.readInt16LE(2)).toBe(3000);
    expect(cap.status().state).toBe("running");
    expect(levels.length).toBeGreaterThan(0);
    expect(levels[0]).toBeGreaterThan(-25);
    await cap.stop();
    expect(cap.status().state).toBe("stopped");
    expect(c.logs.some((l) => l.includes("stream started"))).toBe(true);
  });

  it("all-zero audio becomes 'silent' with permission advice", async () => {
    const c = capture("silent");
    cap = c.cap;
    cap.start();
    await until(() => cap!.status().state === "silent");
    expect(cap.status().advice).toMatch(/System Audio Recording Only/);
  });

  it("no audio after stream_start: 'waiting-permission'; stop kills it even if it ignores SIGTERM", async () => {
    const c = capture("hang");
    cap = c.cap;
    cap.start();
    await until(() => cap!.status().state === "waiting-permission");
    expect(cap.status().advice).toMatch(/Privacy & Security/);
    const t0 = Date.now();
    await cap.stop();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(cap.status().state).toBe("stopped");
  });

  it("restarts with backoff after an exit, keeping the error", async () => {
    const c = capture("fail");
    cap = c.cap;
    cap.start();
    await until(() => c.spawned.length >= 3);
    const restarting = c.states.filter((s) => s.state === "restarting");
    expect(restarting.length).toBeGreaterThanOrEqual(2);
    expect(restarting[0].advice).toMatch(/Failed to setup audio tap/);
    expect(c.logs.some((l) => /restart 1 in 100 ms/.test(l))).toBe(true);
    expect(c.logs.some((l) => /restart 2 in 200 ms/.test(l))).toBe(true);
    await cap.stop();
    const n = c.spawned.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(c.spawned.length).toBe(n); // no restart after stop
  });
});
