import { describe, expect, it } from "vitest";
import { exampleSentence, sentences } from "../src/pipeline/example.js";

describe("exampleSentence", () => {
  it("keeps only the sentence with the heard words", () => {
    const text = "We talked about sleep. The tool I use is NSDR, which helps. Anyway, back to work.";
    expect(exampleSentence(text, "NSDR", "NSDR")).toBe("The tool I use is NSDR, which helps.");
  });

  it("matches heard words case- and punctuation-insensitively, falling back to the term", () => {
    expect(exampleSentence("First. We need so-two by March. Done.", "so two", "SOC 2")).toBe("We need so-two by March.");
    expect(exampleSentence("First. We need SOC 2 by March. Done.", "", "SOC 2")).toBe("We need SOC 2 by March.");
  });

  it("takes two sentences when the heard words cross a boundary", () => {
    expect(exampleSentence("It is called non. Sleep deep rest is great. Other.", "non sleep deep rest", "NSDR")).toBe(
      "It is called non. Sleep deep rest is great.",
    );
  });

  it("cuts a long sentence to ~25 words around the heard words, with … where text was left out", () => {
    const before = Array.from({ length: 30 }, (_, i) => `a${i}`).join(" ");
    const after = Array.from({ length: 30 }, (_, i) => `b${i}`).join(" ");
    const out = exampleSentence(`${before} vector database ${after}.`, "vector database", "vector database");
    expect(out.startsWith("… ")).toBe(true);
    expect(out.endsWith(" …")).toBe(true);
    expect(out).toContain("vector database");
    expect(out.replace(/…/g, "").trim().split(/\s+/)).toHaveLength(25);
  });

  it("falls back to the last sentence (cut to 25 words) when the words are not found", () => {
    expect(exampleSentence("One. Two three.", "zzz", "zzz")).toBe("Two three.");
    expect(exampleSentence("", "x", "x")).toBe("");
  });

  it("splits sentences after . ! ? only", () => {
    expect(sentences("A b. C d! E f? g 1.5 h")).toEqual(["A b.", "C d!", "E f?", "g 1.5 h"]);
  });
});
