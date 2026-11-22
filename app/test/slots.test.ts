import { beforeEach, describe, expect, it } from "vitest";
import { SlotManager } from "../src/pipeline/slots.js";
import type { KeyState } from "../src/pipeline/protocol.js";
import type { TermCandidate } from "../src/pipeline/terms.js";
import { FakeClock } from "./fakeClock.js";

const S = 1000;
const TECH = "#58A6FF";

function cand(term: string, category: TermCandidate["category"] = "Tech"): TermCandidate {
  return { term, category, source: "mock" };
}

describe("SlotManager (FIFO conveyor)", () => {
  let clock: FakeClock;
  let slots: SlotManager;
  let changes: KeyState[][];

  const termAt = (slot: number) => slots.termAt(slot);
  const occupied = () => [0, 1, 2, 3, 4, 5].map(termAt);
  const states = () => slots.getAll().slice(0, 6).map((k) => k.state);

  /** Adds terms 10 s apart (respecting the 2-per-10 s limit). */
  function addSpaced(terms: string[]) {
    for (const t of terms) {
      slots.add(cand(t));
      clock.advance(10 * S);
    }
  }

  beforeEach(() => {
    clock = new FakeClock();
    slots = new SlotManager({ clock });
    changes = [];
    slots.on("change", (keys: KeyState[]) => changes.push(keys));
  });

  it("starts with 6 empty term slots and the 3 static action keys", () => {
    const all = slots.getAll();
    expect(all).toHaveLength(9);
    for (let i = 0; i < 6; i++) expect(all[i]).toEqual({ slot: i, label: "", state: "empty" });
    expect(all[6]).toEqual({ slot: 6, label: "Catch-up", state: "shown" });
    expect(all[7]).toEqual({ slot: 7, label: "Save", state: "shown" });
    expect(all[8]).toEqual({ slot: 8, label: "For me?", state: "shown" });
  });

  it("puts the first term on slot 0 as new, with the full term, category and colour", () => {
    slots.add({ term: "vector database", category: "Tech", source: "mock" });
    expect(changes).toEqual([[{ slot: 0, label: "Vector database", sub: "Tech", color: TECH, state: "new" }]]);
  });

  it("switches new to shown after 3 s", () => {
    slots.add(cand("LoRA"));
    clock.advance(2999);
    expect(slots.getAll()[0].state).toBe("new");
    clock.advance(1);
    expect(slots.getAll()[0].state).toBe("shown");
    expect(changes.at(-1)).toEqual([{ slot: 0, label: "LoRA", sub: "Tech", color: TECH, state: "shown" }]);
  });

  it("a new term always appears on slot 0 and every other term moves one slot forward", () => {
    addSpaced(["a", "b", "c"]);
    expect(occupied()).toEqual(["c", "b", "a", null, null, null]);
    addSpaced(["d", "e", "f"]);
    expect(occupied()).toEqual(["f", "e", "d", "c", "b", "a"]);
  });

  it("the term on slot 5 leaves when a 7th arrives", () => {
    addSpaced(["a", "b", "c", "d", "e", "f", "g"]);
    expect(occupied()).toEqual(["g", "f", "e", "d", "c", "b"]);
  });

  it("emits every slot whose content changed on a shift, and only those", () => {
    addSpaced(["a", "b"]);
    changes = [];
    slots.add(cand("c"));
    expect(changes).toHaveLength(1);
    expect(changes[0].map((k) => [k.slot, k.label, k.state])).toEqual([
      [0, "c", "new"],
      [1, "b", "shown"],
      [2, "a", "shown"],
    ]);
  });

  it("opened terms are not removed early: they move along and leave from slot 5 like the others", () => {
    addSpaced(["a", "b", "c", "d", "e", "f"]);
    slots.press(0); // f opened
    addSpaced(["g", "h", "i", "j", "k"]);
    expect(occupied()).toEqual(["k", "j", "i", "h", "g", "f"]);
    expect(slots.getAll()[5].state).toBe("seen");
    addSpaced(["l"]);
    expect(occupied()).not.toContain("f");
  });

  it("a term's state travels with it (seen stays seen, new stays new)", () => {
    addSpaced(["a"]);
    slots.press(0); // a seen
    slots.add(cand("b"));
    expect(states().slice(0, 2)).toEqual(["new", "seen"]);
    clock.advance(1 * S);
    clock.advance(10 * S); // b shown, then c placed later below
    slots.add(cand("c"));
    expect(states().slice(0, 3)).toEqual(["new", "shown", "seen"]);
  });

  it("the 3 s new timer follows the term and emits the slot it is on now", () => {
    const m = new SlotManager({ clock, maxNewPerWindow: 100 });
    const ch: KeyState[][] = [];
    m.on("change", (k: KeyState[]) => ch.push(k));
    m.add(cand("a")); // 0 s
    clock.advance(2 * S);
    m.add(cand("b")); // a moves to slot 1, still new
    expect(m.getAll()[1]).toMatchObject({ label: "a", state: "new" });
    ch.length = 0;
    clock.advance(1 * S); // a's 3 s are up
    expect(ch).toEqual([[{ slot: 1, label: "a", sub: "Tech", color: TECH, state: "shown" }]]);
    expect(m.getAll()[0].state).toBe("new"); // b keeps its own timer
  });

  it("places at most 2 new terms per 10 s; extras queue in order", () => {
    slots.add(cand("a"));
    slots.add(cand("b"));
    slots.add(cand("c"));
    expect(occupied()).toEqual(["b", "a", null, null, null, null]);
    expect(slots.queued()).toEqual(["c"]);
    clock.advance(10 * S - 1);
    expect(termAt(0)).toBe("b");
    clock.advance(1);
    expect(occupied()).toEqual(["c", "b", "a", null, null, null]);
    expect(slots.queued()).toEqual([]);
  });

  it("a full keypad does not block: a queued term only waits for the rate window", () => {
    addSpaced(["a", "b", "c", "d", "e", "f"]);
    slots.add(cand("x"));
    expect(termAt(0)).toBe("x"); // no 20 s rule, no seen term needed
  });

  it("merges duplicates that differ in case or plural", () => {
    slots.add(cand("LoRA"));
    slots.add(cand("lora"));
    slots.add(cand("LoRAs"));
    slots.add(cand("vector database"));
    clock.advance(10 * S);
    slots.add(cand("Vector Databases"));
    slots.add(cand("vector-database"));
    expect(occupied()).toEqual(["vector database", "LoRA", null, null, null, null]);
    expect(slots.queued()).toEqual([]);
  });

  it("does not queue a duplicate of a queued term twice", () => {
    slots.add(cand("a"));
    slots.add(cand("b"));
    slots.add(cand("feature flag"));
    slots.add(cand("Feature Flag"));
    slots.add(cand("feature flags"));
    expect(slots.queued()).toEqual(["feature flag"]);
  });

  it("re-mentioning a term that is on screen or already left changes nothing", () => {
    addSpaced(["a", "b", "c", "d", "e", "f", "g"]); // a has left
    changes = [];
    slots.add(cand("a"));
    slots.add(cand("c"));
    clock.advance(60 * S);
    expect(changes.filter((c) => c.some((k) => k.state === "new"))).toEqual([]);
    expect(occupied()).toEqual(["g", "f", "e", "d", "c", "b"]);
  });

  it("a press on a term slot marks it seen and cancels the pending new -> shown", () => {
    slots.add(cand("LoRA"));
    clock.advance(600); // outside the press grace
    changes = [];
    const r = slots.press(0);
    expect(r).toEqual({ kind: "term", slot: 0, term: "LoRA" });
    expect(changes).toEqual([[{ slot: 0, label: "LoRA", sub: "Tech", color: TECH, state: "seen" }]]);
    clock.advance(5 * S);
    expect(slots.getAll()[0].state).toBe("seen");
    expect(changes).toHaveLength(1);
  });

  it("a press on an empty or action slot changes nothing", () => {
    expect(slots.press(3)).toEqual({ kind: "empty", slot: 3 });
    expect(slots.press(6)).toEqual({ kind: "action", slot: 6, action: "catch-up" });
    expect(slots.press(8)).toEqual({ kind: "action", slot: 8, action: "for-me" });
    expect(slots.press(42)).toEqual({ kind: "invalid", slot: 42 });
    expect(changes).toEqual([]);
  });

  describe("press within 500 ms after a shift", () => {
    beforeEach(() => {
      addSpaced(["a", "b", "c"]); // c, b, a
    });

    it("goes to the term that was on that key before the shift, and marks it seen where it is now", () => {
      slots.add(cand("d")); // d, c, b, a
      clock.advance(499);
      expect(slots.press(0)).toEqual({ kind: "term", slot: 0, term: "c" });
      expect(slots.getAll()[1]).toMatchObject({ label: "c", state: "seen" });
      expect(slots.getAll()[0].state).toBe("new"); // d untouched
    });

    it("goes to the term on the key after 500 ms", () => {
      slots.add(cand("d"));
      clock.advance(500);
      expect(slots.press(0)).toEqual({ kind: "term", slot: 0, term: "d" });
    });

    it("a key that was empty before the shift goes to the term on it now", () => {
      slots.add(cand("d")); // slot 3 was empty, now holds a
      clock.advance(100);
      expect(slots.press(3)).toEqual({ kind: "term", slot: 3, term: "a" });
      expect(slots.getAll()[3].state).toBe("seen");
    });

    it("still opens a term that just left from slot 5", () => {
      addSpaced(["d", "e", "f"]); // f e d c b a
      slots.add(cand("g")); // a leaves
      clock.advance(200);
      expect(slots.press(5)).toEqual({ kind: "term", slot: 5, term: "a" });
      expect(occupied()).toEqual(["g", "f", "e", "d", "c", "b"]);
    });
  });

  it("reset clears terms, queue, shown set and timers, emitting the cleared slots", () => {
    slots.add(cand("a"));
    slots.add(cand("b"));
    slots.add(cand("c"));
    clock.advance(600);
    slots.press(1);
    changes = [];
    slots.reset();
    expect(changes).toEqual([[{ slot: 0, label: "", state: "empty" }, { slot: 1, label: "", state: "empty" }]]);
    expect(slots.queued()).toEqual([]);
    clock.advance(60 * S);
    expect(changes).toHaveLength(1);
    slots.add(cand("b")); // shown before reset, allowed again after reset
    expect(termAt(0)).toBe("b");
  });

  it("action overrides change slots 6-8 only, emit the slot and are cleared by reset", () => {
    slots.setActionOverride(6, { state: "busy" });
    expect(slots.getAll()[6]).toEqual({ slot: 6, label: "Catch-up", state: "busy" });
    slots.setActionOverride(7, { label: "Saved ✓", color: "#3FB950" });
    expect(slots.getAll()[7]).toEqual({ slot: 7, label: "Saved ✓", color: "#3FB950", state: "shown" });
    slots.setActionOverride(3, { state: "busy" }); // term slot: ignored
    slots.setActionOverride(8, null); // nothing to clear: no event
    expect(changes.map((c) => c.map((k) => k.slot))).toEqual([[6], [7]]);
    slots.reset();
    expect(slots.getAll()[6].state).toBe("shown");
    expect(slots.getAll()[7].label).toBe("Save");
    expect(changes[changes.length - 1].map((k) => k.slot).sort()).toEqual([6, 7]);
  });

  it("random use never shows a term twice and keeps the reading order newest first", () => {
    const m = new SlotManager({ clock, maxNewPerWindow: 100 });
    let n = 0;
    for (let i = 0; i < 40; i++) {
      m.add(cand(`w${n++}`));
      if (i % 3 === 0) m.press(i % 6);
      clock.advance(7 * S);
      const on = [0, 1, 2, 3, 4, 5].map((s) => m.termAt(s)).filter((t): t is string => t !== null);
      expect(new Set(on).size).toBe(on.length);
      const idx = on.map((t) => Number(t.slice(1)));
      expect(idx).toEqual([...idx].sort((a, b) => b - a));
    }
  });
});

describe("SlotManager placed event", () => {
  it("fires once per term that lands on a key, after its change, not for queued terms", () => {
    const clock = new FakeClock();
    const slots = new SlotManager({ clock });
    const events: string[] = [];
    slots.on("change", (keys: KeyState[]) => events.push(`change ${keys.map((k) => k.slot).join(",")}`));
    slots.on("placed", ({ slot, candidate }: { slot: number; candidate: TermCandidate }) => events.push(`placed ${slot} ${candidate.term}`));
    slots.add(cand("a"));
    slots.add(cand("b"));
    slots.add(cand("c")); // third within 10 s: queued
    expect(events).toEqual(["change 0", "placed 0 a", "change 0,1", "placed 0 b"]);
    clock.advance(10 * S); // includes the "new" -> "shown" changes of a (slot 1) and b (slot 0) after 3 s
    expect(events.slice(4)).toEqual(["change 1", "change 0", "change 0,1,2", "placed 0 c"]);
  });
});
