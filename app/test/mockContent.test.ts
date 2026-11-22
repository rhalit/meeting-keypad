import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATEGORIES, MAX_TERM_CHARS } from "../src/pipeline/protocol.js";
import { LISTENER_PLACEHOLDER, loadConfig, loadGlossary, loadMeeting } from "../src/pipeline/mockData.js";
import { mentionsListener } from "../src/pipeline/nameMatch.js";

const MOCK = join(__dirname, "..", "..", "mock");
const rawMeeting = JSON.parse(readFileSync(join(MOCK, "meeting.json"), "utf8"));
const glossary = JSON.parse(readFileSync(join(MOCK, "glossary.json"), "utf8"));

const termLines = (rawMeeting as { t: number; terms: string[] }[]).flatMap((l) => l.terms.map((term) => ({ term, t: l.t })));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-word, case-insensitive, optional plural. */
const mentions = (text: string, term: string) => new RegExp(`(^|[^\\w])${escape(term)}(s|es)?($|[^\\w])`, "i").test(text);

describe("mock/meeting.json", () => {
  it("is an array of {t, speaker, text, terms} with the right types", () => {
    expect(Array.isArray(rawMeeting)).toBe(true);
    for (const l of rawMeeting) {
      expect(Object.keys(l).sort()).toEqual(["speaker", "t", "terms", "text"]);
      expect(typeof l.t).toBe("number");
      expect(typeof l.speaker).toBe("string");
      expect(typeof l.text).toBe("string");
      expect(l.text.length).toBeGreaterThan(0);
      expect(Array.isArray(l.terms)).toBe(true);
      for (const term of l.terms) expect(typeof term).toBe("string");
    }
  });

  it("is a ~5 minute meeting of about 60 lines from 3 speakers, sorted by t", () => {
    expect(rawMeeting.length).toBeGreaterThanOrEqual(50);
    expect(rawMeeting.length).toBeLessThanOrEqual(70);
    expect(new Set(rawMeeting.map((l: { speaker: string }) => l.speaker)).size).toBe(3);
    const ts = rawMeeting.map((l: { t: number }) => l.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(Math.min(...ts)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ts)).toBeLessThanOrEqual(300);
    expect(Math.max(...ts)).toBeGreaterThanOrEqual(270);
  });

  it("has 15 terms, each listed once, on the line where it is first spoken", () => {
    const terms = termLines.map((x) => x.term);
    expect(terms).toHaveLength(15);
    expect(new Set(terms).size).toBe(15);
    rawMeeting.forEach((line: { text: string; terms: string[] }, i: number) => {
      for (const term of line.terms) {
        expect(mentions(line.text, term), `"${term}" not in its line`).toBe(true);
        for (const earlier of rawMeeting.slice(0, i)) {
          expect(mentions(earlier.text, term), `"${term}" spoken earlier: ${earlier.text}`).toBe(false);
        }
      }
    });
  });

  it("starts terms after about 10 s and never has more than 2 terms in any 10 s window", () => {
    const ts = termLines.map((x) => x.t);
    expect(Math.min(...ts)).toBeGreaterThanOrEqual(8);
    for (const t of ts) {
      const inWindow = ts.filter((u) => u >= t && u < t + 10).length;
      expect(inWindow, `window starting at ${t}s`).toBeLessThanOrEqual(2);
    }
  });

  it("addresses the listener by name with a direct question around 150 s and 270 s", () => {
    const addressed = rawMeeting.filter((l: { text: string }) => l.text.includes(LISTENER_PLACEHOLDER));
    expect(addressed.map((l: { t: number }) => l.t)).toHaveLength(2);
    expect(Math.abs(addressed[0].t - 150)).toBeLessThanOrEqual(10);
    expect(Math.abs(addressed[1].t - 270)).toBeLessThanOrEqual(10);
    for (const l of addressed) {
      expect(l.text.startsWith(`${LISTENER_PLACEHOLDER},`)).toBe(true);
      expect(l.text.trim().endsWith("?")).toBe(true);
    }
  });

  it("fills in the listener name from mock/config.json when loaded", () => {
    const { listenerName } = loadConfig(join(MOCK, "config.json"));
    expect(listenerName.length).toBeGreaterThan(0);
    const lines = loadMeeting(join(MOCK, "meeting.json"), listenerName);
    expect(lines.some((l) => l.text.includes(LISTENER_PLACEHOLDER))).toBe(false);
    expect(lines.filter((l) => l.text.startsWith(`${listenerName},`))).toHaveLength(2);
    expect(loadMeeting(join(MOCK, "meeting.json"), "Sam").filter((l) => l.text.startsWith("Sam,"))).toHaveLength(2);
  });

  it("only the two listener lines (2:32, 4:30) name the listener, so For-me makes exactly 2 model calls", () => {
    const { listenerName, listenerAliases } = loadConfig(join(MOCK, "config.json"));
    expect(listenerAliases).toContain("Alec");
    const lines = loadMeeting(join(MOCK, "meeting.json"), listenerName);
    const named = lines.filter((l) => mentionsListener(l.text, { name: listenerName, aliases: listenerAliases }));
    expect(named.map((l) => l.t)).toEqual([152, 270]);
  });
});

describe("mock/glossary.json", () => {
  it("has exactly one entry per meeting term", () => {
    expect(Object.keys(glossary).sort()).toEqual(termLines.map((x) => x.term).sort());
    expect(() => loadGlossary(join(MOCK, "glossary.json"))).not.toThrow();
  });

  for (const [term, e] of Object.entries<any>(glossary)) {
    it(`entry "${term}" is valid`, () => {
      expect(Object.keys(e).sort()).toEqual(["category", "example", "explanation", "full"]);
      expect(term.length, "the key shows the full term").toBeLessThanOrEqual(MAX_TERM_CHARS);
      expect(typeof e.full).toBe("string");
      expect(e.full.trim().length).toBeGreaterThan(0);
      const words = e.explanation.trim().split(/\s+/).length;
      expect(words, "explanation word count").toBeGreaterThanOrEqual(40);
      expect(words, "explanation word count").toBeLessThanOrEqual(60);
      expect(e.example.length).toBeGreaterThan(0);
      expect(rawMeeting.some((l: { text: string }) => l.text.includes(e.example)), "example is from the meeting").toBe(true);
      expect(CATEGORIES).toContain(e.category);
    });
  }
});
