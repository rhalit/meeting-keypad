import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore, parseSessions } from "../src/pipeline/sessions.js";

describe("SessionStore (Saved view)", () => {
  let dir: string;
  let t: number;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const store = (path: string) => new SessionStore(path, () => t);
  const idea = (title: string, quote = `${title} quote`) => ({ title, summary: `${title} summary`, quote, t: 42 });

  it("saves go to the open meeting; a session appears only once something is saved", () => {
    dir = mkdtempSync(join(tmpdir(), "sessions-"));
    t = 1000;
    const s = store(join(dir, "sessions.json"));
    s.open({ id: "mock:sprint", title: "Product sprint review", kind: "meeting", source: "mock" });
    expect(s.current()).toBeNull();
    expect(s.list()).toEqual([]);
    expect(s.addIdea(idea("SOC 2 due Friday"))).toBe(true);
    expect(s.current()).toMatchObject({ id: "mock:sprint", ideas: [{ title: "SOC 2 due Friday", t: 42, savedAt: 1000 }] });
  });

  it("ignores a repeat (same title or quote), keeps sessions apart, newest first, and persists", () => {
    dir = mkdtempSync(join(tmpdir(), "sessions-"));
    const path = join(dir, "sub", "sessions.json");
    t = 1000;
    const s = store(path);
    s.open({ id: "mock:sprint", title: "Sprint", kind: "meeting", source: "mock" });
    s.addIdea(idea("Canary first"));
    expect(s.addIdea(idea("canary FIRST!", "other"))).toBe(false);
    expect(s.addIdea(idea("Other title", "Canary first quote"))).toBe(false);
    t = 2000;
    s.open({ id: "mock:climate", title: "Climate science 101", kind: "course", source: "mock" });
    s.addCard({ front: "What is albedo?", back: "How much light a surface reflects.", t: 66 });
    expect(s.list().map((x) => x.id)).toEqual(["mock:climate", "mock:sprint"]);
    const again = store(path);
    expect(again.list().map((x) => [x.id, x.ideas.length, x.cards.length])).toEqual([
      ["mock:climate", 0, 1],
      ["mock:sprint", 1, 0],
    ]);
    expect(JSON.parse(readFileSync(path, "utf8")).sessions).toHaveLength(2);
  });

  it("a broken file gives an empty list; malformed entries are dropped", () => {
    dir = mkdtempSync(join(tmpdir(), "sessions-"));
    writeFileSync(join(dir, "bad.json"), "{ nope");
    expect(store(join(dir, "bad.json")).list()).toEqual([]);
    expect(parseSessions({ sessions: [{ id: "a", title: "A", ideas: [{ title: "" }, { title: "ok", t: 3 }] }, { title: "no id" }] })).toEqual([
      expect.objectContaining({ id: "a", kind: "meeting", source: "mock", ideas: [expect.objectContaining({ title: "ok", t: 3 })], cards: [] }),
    ]);
  });

  it("nothing is saved without an open session", () => {
    dir = mkdtempSync(join(tmpdir(), "sessions-"));
    const s = store(join(dir, "s.json"));
    expect(s.addIdea(idea("x"))).toBe(false);
  });
});
