import { beforeEach, describe, expect, it } from "vitest";
import { SlotManager } from "../src/pipeline/slots.js";
import type { KeyState } from "../src/pipeline/protocol.js";
import type { TermCandidate } from "../src/pipeline/terms.js";
import { FakeClock } from "./fakeClock.js";

const S = 1000;

function cand(term: string, category: TermCandidate["category"] = "AI"): TermCandidate {
  return { term, label: term.slice(0, 8), category, source: "mock" };
}

describe("SlotManager", () => {
  let clock: FakeClock;
  let slots: SlotManager;
  let changes: KeyState[][];

  const termAt = (slot: number) => slots.termAt(slot);
  const occupied = () => [0, 1, 2, 3, 4, 5].map(termAt);

  /** Adds 6 terms 10 s apart (respecting the 2-per-10 s limit), filling slots 0..5. */
  function fillAll(prefix = "t") {
    for (let i = 0; i < 6; i++) {
      slots.add(cand(`${prefix}${i}`));
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
    expect(all[6]).toEqual({ slot: 6, label: "Catch\nup", bg: "#30363D", state: "shown" });
    expect(all[7]).toEqual({ slot: 7, label: "Save", bg: "#30363D", state: "shown" });
    expect(all[8]).toEqual({ slot: 8, label: "For me?", bg: "#30363D", state: "shown" });
  });

  it("puts the first term on slot 0 as new and emits only that slot, as a full KeyState", () => {
    slots.add({ term: "LoRA", label: "LoRA", category: "AI", source: "mock" });
    expect(changes).toEqual([[{ slot: 0, label: "LoRA", sub: "AI", bg: "#1F6FEB", state: "new" }]]);
  });

  it("switches new to shown after 3 s", () => {
    slots.add(cand("LoRA"));
    clock.advance(2999);
    expect(slots.getAll()[0].state).toBe("new");
    clock.advance(1);
    expect(slots.getAll()[0].state).toBe("shown");
    expect(changes.at(-1)).toEqual([{ slot: 0, label: "LoRA", sub: "AI", bg: "#1F6FEB", state: "shown" }]);
  });

  it("fills empty slots 0..5 in order", () => {
    fillAll();
    expect(occupied()).toEqual(["t0", "t1", "t2", "t3", "t4", "t5"]);
  });

  it("queues a 7th term until the longest-shown term has had 20 s, then puts it in that slot", () => {
    const m = new SlotManager({ clock, maxNewPerWindow: 100 }); // isolate the 20 s rule
    for (let i = 0; i < 6; i++) {
      m.add(cand(`t${i}`)); // placed at 0, 2, 4, 6, 8, 10 s
      if (i < 5) clock.advance(2 * S);
    }
    m.add(cand("x"));
    expect(m.queued()).toEqual(["x"]);
    clock.advance(10 * S - 1); // t0 has 19.999 s
    expect(m.queued()).toEqual(["x"]);
    clock.advance(1);
    expect(m.queued()).toEqual([]);
    expect(m.termAt(0)).toBe("x");
  });

  it("replaces a seen term right away, even when nothing has had 20 s yet", () => {
    const m = new SlotManager({ clock, maxNewPerWindow: 100 });
    for (let i = 0; i < 6; i++) {
      m.add(cand(`t${i}`)); // placed at 0, 2, 4, 6, 8, 10 s
      if (i < 5) clock.advance(2 * S);
    }
    m.press(5); // t5, 0 s on screen
    m.add(cand("x"));
    expect(m.termAt(5)).toBe("x");
    expect(m.queued()).toEqual([]);
  });

  it("still applies the 2-per-10 s limit when a seen term could be replaced", () => {
    for (let i = 0; i < 6; i++) slots.add(cand(`t${i}`));
    clock.advance(20 * S); // placed at 0,0,10,10,20,20 s; window full until 30 s
    slots.press(3);
    slots.add(cand("v"));
    expect(slots.queued()).toEqual(["v"]);
    clock.advance(10 * S);
    expect(termAt(3)).toBe("v"); // seen first, although t0 is older
  });

  it("replaces the longest-shown unopened term once it has had at least 20 s", () => {
    slots.add(cand("a"));
    clock.advance(10 * S);
    slots.add(cand("b"));
    clock.advance(10 * S);
    slots.add(cand("c"));
    clock.advance(10 * S);
    slots.add(cand("d"));
    clock.advance(10 * S);
    slots.add(cand("e"));
    clock.advance(10 * S);
    slots.add(cand("f"));
    clock.advance(1 * S);
    // a is oldest (51 s): new term goes to slot 0
    slots.add(cand("g"));
    expect(termAt(0)).toBe("g");
    clock.advance(10 * S);
    // b is now oldest (on screen since 10 s) -> slot 1
    slots.add(cand("h"));
    expect(termAt(1)).toBe("h");
    expect(occupied()).toEqual(["g", "h", "c", "d", "e", "f"]);
  });

  it("applies the rate limit to replacements too", () => {
    slots.add(cand("a")); // 0 s
    clock.advance(11 * S);
    slots.add(cand("b")); // 11 s
    slots.add(cand("c"));
    clock.advance(11 * S);
    slots.add(cand("d")); // 22 s
    slots.add(cand("e"));
    clock.advance(11 * S);
    slots.add(cand("f")); // 33 s
    expect(occupied()).toEqual(["a", "b", "c", "d", "e", "f"]);
    slots.add(cand("g")); // 2nd placement in the window: replaces a (33 s on screen)
    expect(termAt(0)).toBe("g");
    slots.add(cand("h")); // 3rd in the window -> queued
    expect(slots.queued()).toEqual(["h"]);
    clock.advance(10 * S); // 43 s: window frees, b (32 s) is the longest-shown
    expect(termAt(1)).toBe("h");
  });

  it("places at most 2 new terms per 10 s; extras queue in order", () => {
    slots.add(cand("a"));
    slots.add(cand("b"));
    slots.add(cand("c"));
    expect(occupied()).toEqual(["a", "b", null, null, null, null]);
    expect(slots.queued()).toEqual(["c"]);
    clock.advance(10 * S - 1);
    expect(termAt(2)).toBeNull();
    clock.advance(1);
    expect(termAt(2)).toBe("c");
    expect(slots.queued()).toEqual([]);
  });

  it("merges duplicates that differ in case or plural", () => {
    slots.add(cand("LoRA"));
    slots.add(cand("lora"));
    slots.add(cand("LoRAs"));
    slots.add(cand("vector database"));
    clock.advance(10 * S);
    slots.add(cand("Vector Databases"));
    slots.add(cand("vector-database"));
    expect(occupied()).toEqual(["LoRA", "vector database", null, null, null, null]);
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

  it("a press on a term slot marks it seen and cancels the pending new -> shown", () => {
    slots.add(cand("LoRA"));
    changes = [];
    const r = slots.press(0);
    expect(r).toEqual({ kind: "term", slot: 0, term: "LoRA" });
    expect(changes).toEqual([[{ slot: 0, label: "LoRA", sub: "AI", bg: "#1F6FEB", state: "seen" }]]);
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

  it("when all slots are full, replaces a seen term first, even one younger than 20 s", () => {
    fillAll(); // t0..t5 placed at 0,10,..,50 s; now 60 s
    slots.press(4); // t4 (placed 40 s, 20 s on screen) opened
    slots.press(5); // t5 (placed 50 s, 10 s on screen) opened
    slots.add(cand("x"));
    // t0 is the longest-shown unopened term (60 s) but seen terms go first: oldest seen = t4
    expect(termAt(4)).toBe("x");
    clock.advance(10 * S);
    slots.add(cand("y"));
    expect(termAt(5)).toBe("y"); // the remaining seen term, only 20 s old
    clock.advance(10 * S);
    slots.add(cand("z"));
    expect(termAt(0)).toBe("z"); // no seen terms left -> longest-shown unopened
  });

  it("never brings back a term that was opened, even after it was replaced", () => {
    slots.add(cand("LoRA"));
    slots.press(0);
    clock.advance(10 * S);
    for (let i = 1; i < 6; i++) {
      slots.add(cand(`t${i}`));
      clock.advance(10 * S);
    }
    slots.add(cand("x")); // replaces the seen LoRA
    expect(occupied()).not.toContain("LoRA");
    clock.advance(30 * S);
    slots.add(cand("loras"));
    clock.advance(60 * S);
    expect(occupied()).not.toContain("LoRA");
    expect(occupied()).not.toContain("loras");
    expect(slots.queued()).toEqual([]);
  });

  it("lets a replaced but never-opened term come back when it is spoken again", () => {
    fillAll(); // t0..t5, now 60 s
    slots.add(cand("x")); // replaces t0
    expect(occupied()).not.toContain("t0");
    clock.advance(10 * S);
    slots.add(cand("t0"));
    expect(occupied()).toContain("t0");
  });

  it("never moves a term to another slot while it is on screen", () => {
    const seenAt = new Map<string, number>();
    for (let i = 0; i < 40; i++) {
      slots.add(cand(`w${i}`));
      if (i % 3 === 0) slots.press(i % 6);
      clock.advance(7 * S);
      for (let s = 0; s < 6; s++) {
        const t = termAt(s);
        if (t === null) continue;
        if (seenAt.has(t)) expect(seenAt.get(t)).toBe(s);
        seenAt.set(t, s);
      }
    }
  });

  it("re-mentioning an on-screen term changes nothing", () => {
    slots.add(cand("LoRA"));
    clock.advance(4 * S);
    changes = [];
    slots.add(cand("LoRA"));
    clock.advance(60 * S);
    expect(changes).toEqual([]);
    expect(slots.getAll()[0].state).toBe("shown");
  });

  it("reset clears terms, queue, opened set and timers, emitting the cleared slots", () => {
    slots.add(cand("a"));
    slots.add(cand("b"));
    slots.add(cand("c"));
    slots.press(1);
    changes = [];
    slots.reset();
    expect(changes).toEqual([[{ slot: 0, label: "", state: "empty" }, { slot: 1, label: "", state: "empty" }]]);
    expect(slots.queued()).toEqual([]);
    clock.advance(60 * S);
    expect(changes).toHaveLength(1);
    slots.add(cand("b")); // opened before reset, allowed again after reset
    expect(termAt(0)).toBe("b");
  });

  it("action overrides change slots 6-8 only, emit the slot and are cleared by reset", () => {
    const changes: KeyState[][] = [];
    slots.on("change", (k: KeyState[]) => changes.push(k));
    slots.setActionOverride(6, { state: "busy" });
    expect(slots.getAll()[6]).toEqual({ slot: 6, label: "Catch\nup", bg: "#30363D", state: "busy" });
    slots.setActionOverride(7, { label: "Saved ✓", bg: "#2DA44E" });
    expect(slots.getAll()[7]).toEqual({ slot: 7, label: "Saved ✓", bg: "#2DA44E", state: "shown" });
    slots.setActionOverride(3, { state: "busy" }); // term slot: ignored
    slots.setActionOverride(8, null); // nothing to clear: no event
    expect(changes.map((c) => c.map((k) => k.slot))).toEqual([[6], [7]]);
    slots.reset();
    expect(slots.getAll()[6].state).toBe("shown");
    expect(slots.getAll()[7].label).toBe("Save");
    expect(changes[changes.length - 1].map((k) => k.slot).sort()).toEqual([6, 7]);
  });
});
