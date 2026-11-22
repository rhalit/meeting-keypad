import { describe, expect, it } from "vitest";
import { mentionsListener, osaDistance } from "../src/pipeline/nameMatch.js";

const names = { name: "Rhali", aliases: ["Rally", "Rali"] };

describe("mentionsListener", () => {
  it("finds the name, any case, with punctuation and a possessive", () => {
    expect(mentionsListener("Rhali, can you own the SOC 2 questionnaire?", names)).toBe("rhali");
    expect(mentionsListener("what do you think, RHALI?", names)).toBe("rhali");
    expect(mentionsListener("Is that Rhali's draft?", names)).toBe("rhali");
  });

  it("finds the aliases exactly (the mishearing Deepgram wrote)", () => {
    expect(mentionsListener("Rally, can you send me the scope?", names)).toBe("rally");
    expect(mentionsListener("rali can you check", names)).toBe("rali");
    expect(mentionsListener("Thanks Ana Maria", { name: "Sam", aliases: ["Ana Maria"] })).toBe("ana maria");
  });

  it("fuzzy-matches close spellings of the name (one edit or a swap)", () => {
    expect(mentionsListener("Rhaly, quick question", names)).toBe("rhaly");
    expect(mentionsListener("Rahli, quick question", names)).toBe("rahli");
    expect(mentionsListener("Khali, quick question", names)).toBe("khali");
    expect(mentionsListener("Rhalli, quick question", names)).toBe("rhalli");
  });

  it("does not fuzzy-match the aliases, so ordinary words stay quiet", () => {
    expect(mentionsListener("That is really important for the rollout.", names)).toBeNull();
    expect(mentionsListener("Ralph will take the pen test.", names)).toBeNull();
    expect(mentionsListener("We need a real plan and a rail of servers.", names)).toBeNull();
    expect(mentionsListener("Let's look at the latency numbers.", names)).toBeNull();
    expect(mentionsListener("", names)).toBeNull();
  });

  it("does not fuzzy-match short names (too many collisions)", () => {
    expect(mentionsListener("Can you hand me the pen?", { name: "Ben", aliases: [] })).toBeNull();
    expect(mentionsListener("Ben, can you?", { name: "Ben", aliases: [] })).toBe("ben");
  });
});

describe("osaDistance", () => {
  it("counts a swap of neighbours as one edit", () => {
    expect(osaDistance("rhali", "rahli")).toBe(1);
    expect(osaDistance("rhali", "rally")).toBe(3); // why "Rally" needs to be an alias
    expect(osaDistance("rally", "really")).toBe(1);
    expect(osaDistance("", "abc")).toBe(3);
  });

  it("a short name (Alex) matches exactly or by alias, never by one edit (flex, apex, Alexa)", () => {
    const alex = { name: "Alex", aliases: ["Alec", "Alix"] };
    expect(mentionsListener("Alex, can you take the eval set?", alex)).toBe("alex");
    expect(mentionsListener("Is that Alex's draft?", alex)).toBe("alex");
    expect(mentionsListener("Alec, could you send the scope?", alex)).toBe("alec");
    expect(mentionsListener("We keep a flex budget for the apex project.", alex)).toBeNull();
    expect(mentionsListener("Alexa, turn the lights off.", alex)).toBeNull();
  });
});
