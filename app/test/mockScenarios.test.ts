import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { LISTENER_PLACEHOLDER, loadConfig, loadGlossary, loadMeeting, loadScenarioIndex } from "../src/pipeline/mockData.js";
import { mentionsListener } from "../src/pipeline/nameMatch.js";
import { CATEGORIES, MAX_TERM_CHARS } from "../src/pipeline/protocol.js";

// Extra mock content (mock/scenarios/<name>/meeting.json + glossary.json): Education mode plays "lecture",
// MOCK_SCENARIO=onboarding replaces the default meeting. Same rules as mock/meeting.json, looser sizes.

const MOCK = join(__dirname, "..", "..", "mock");
const SCENARIOS = join(MOCK, "scenarios");
const names = readdirSync(SCENARIOS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, term: string) => new RegExp(`(^|[^\\w])${escape(term)}(s|es)?($|[^\\w])`, "i").test(text);

describe("mock/scenarios", () => {
  it("index.json lists every scenario folder (plus the default meeting), with files present", () => {
    const index = loadScenarioIndex(join(SCENARIOS, "index.json"));
    expect(index.filter((x) => x.path !== ".").map((x) => x.path.replace("scenarios/", "")).sort()).toEqual([...names].sort());
    expect(index.find((x) => x.path === ".")).toMatchObject({ id: "sprint", usage: "meeting" });
    for (const x of index) {
      expect(existsSync(join(MOCK, x.path, "meeting.json")), x.id).toBe(true);
      expect(existsSync(join(MOCK, x.path, "glossary.json")), x.id).toBe(true);
    }
    expect(index.filter((x) => x.usage === "meeting").length).toBeGreaterThanOrEqual(3);
    expect(index.filter((x) => x.usage === "education").length).toBeGreaterThanOrEqual(3);
    // The app's defaults exist and are of the right kind.
    expect(index.find((x) => x.id === "lecture")?.usage).toBe("education");
  });

  for (const name of names) {
    describe(name, () => {
      const dir = join(SCENARIOS, name);
      const raw = JSON.parse(readFileSync(join(dir, "meeting.json"), "utf8")) as { t: number; speaker: string; text: string; terms: string[] }[];
      const glossary = JSON.parse(readFileSync(join(dir, "glossary.json"), "utf8")) as Record<string, any>;
      const termLines = raw.flatMap((l) => l.terms.map((term) => ({ term, t: l.t })));

      it("loads, is sorted, 3 speakers, 2-6 minutes, 10+ terms", () => {
        const { listenerName } = loadConfig(join(MOCK, "config.json"));
        expect(() => loadMeeting(join(dir, "meeting.json"), listenerName)).not.toThrow();
        expect(() => loadGlossary(join(dir, "glossary.json"))).not.toThrow();
        const ts = raw.map((l) => l.t);
        expect(ts).toEqual([...ts].sort((a, b) => a - b));
        expect(new Set(raw.map((l) => l.speaker)).size).toBe(3);
        expect(Math.max(...ts)).toBeGreaterThanOrEqual(120);
        expect(Math.max(...ts)).toBeLessThanOrEqual(360);
        expect(termLines.length).toBeGreaterThanOrEqual(10);
      });

      it("each term once, on the line where it is first spoken; at most 2 per 10 s; glossary matches", () => {
        expect(new Set(termLines.map((x) => x.term)).size).toBe(termLines.length);
        expect(Object.keys(glossary).sort()).toEqual(termLines.map((x) => x.term).sort());
        raw.forEach((line, i) => {
          for (const term of line.terms) {
            expect(mentions(line.text, term), `"${term}" not in its line`).toBe(true);
            for (const earlier of raw.slice(0, i)) expect(mentions(earlier.text, term), `"${term}" spoken earlier`).toBe(false);
          }
        });
        const ts = termLines.map((x) => x.t);
        for (const t of ts) expect(ts.filter((u) => u >= t && u < t + 10).length).toBeLessThanOrEqual(2);
      });

      it("asks the listener 2 direct questions, and only those lines name the listener", () => {
        const { listenerName, listenerAliases } = loadConfig(join(MOCK, "config.json"));
        const addressed = raw.filter((l) => l.text.includes(LISTENER_PLACEHOLDER));
        expect(addressed).toHaveLength(2);
        for (const l of addressed) {
          expect(l.text.startsWith(`${LISTENER_PLACEHOLDER},`)).toBe(true);
          expect(l.text.trim().endsWith("?")).toBe(true);
        }
        const lines = loadMeeting(join(dir, "meeting.json"), listenerName);
        const named = lines.filter((l) => mentionsListener(l.text, { name: listenerName, aliases: listenerAliases }));
        expect(named.map((l) => l.t)).toEqual(addressed.map((l) => l.t));
      });

      for (const [term, e] of Object.entries(glossary)) {
        it(`glossary "${term}" is valid`, () => {
          expect(Object.keys(e).sort()).toEqual(["category", "example", "explanation", "full"]);
          expect(term.length).toBeLessThanOrEqual(MAX_TERM_CHARS);
          const words = e.explanation.trim().split(/\s+/).length;
          expect(words).toBeGreaterThanOrEqual(40);
          expect(words).toBeLessThanOrEqual(60);
          expect(raw.some((l) => l.text.includes(e.example)), "example is from the meeting").toBe(true);
          expect(CATEGORIES).toContain(e.category);
        });
      }
    });
  }
});
