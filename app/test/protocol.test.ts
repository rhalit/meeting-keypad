import { describe, expect, it } from "vitest";
import { CATEGORIES, CATEGORY_COLORS, actionKey, displayTerm, isCategory } from "../src/pipeline/protocol.js";

describe("categories", () => {
  it("are the general set, each with its own #RRGGBB colour", () => {
    expect([...CATEGORIES]).toEqual(["Tech", "Science", "Health", "Business", "Finance", "Law", "Other"]);
    const colors = CATEGORIES.map((c) => CATEGORY_COLORS[c]);
    for (const c of colors) expect(c).toMatch(/^#[0-9A-F]{6}$/);
    expect(new Set(colors).size).toBe(colors.length);
    expect(isCategory("AI")).toBe(false);
    expect(isCategory("Health")).toBe(true);
  });
});

describe("displayTerm (the full term the key shows)", () => {
  it.each([
    ["feature flag", "Feature flag"],
    ["vector database", "Vector database"],
    ["p95 latency", "p95 latency"],
    ["eBPF", "eBPF"],
    ["iOS", "iOS"],
    ["SOC 2", "SOC 2"],
    ["  non-sleep   deep rest ", "Non-sleep deep rest"],
    ["a", "a"],
  ])("%j -> %j", (term, shown) => {
    expect(displayTerm(term)).toBe(shown);
  });
});

describe("action keys", () => {
  it("have plain labels and no colour (the plugin draws them white, centred)", () => {
    expect([6, 7, 8].map(actionKey)).toEqual([
      { slot: 6, label: "Catch-up", state: "shown" },
      { slot: 7, label: "Save", state: "shown" },
      { slot: 8, label: "For me?", state: "shown" },
    ]);
  });
});
