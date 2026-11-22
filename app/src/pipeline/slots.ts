import { EventEmitter } from "node:events";
import type { Clock, TimerHandle } from "./clock.js";
import {
  ACTION_KEYS,
  type ActionKeyMap,
  CATEGORY_COLORS,
  SLOT_COUNT,
  TERM_SLOTS,
  actionKeyIn,
  displayTerm,
  emptyKey,
  isValidSlot,
  type KeyState,
  type SlotState,
} from "./protocol.js";
import type { KeyBackgrounds } from "./settings.js";
import { normalizeTerm, type TermCandidate } from "./terms.js";

export interface SlotManagerOptions {
  clock: Clock;
  /** "new" -> "shown" after this long. */
  newMs?: number;
  /** At most this many placements per window; extras queue. */
  maxNewPerWindow?: number;
  windowMs?: number;
  /** A press this soon after a shift goes to the term that was on that key before the shift. */
  pressGraceMs?: number;
}

/** Temporary look of an action key (slots 6-8), merged over its static label. */
export interface ActionOverride {
  label?: string;
  color?: string;
  state?: SlotState;
}

/** What the Catch-up / Save controllers need from SlotManager. */
export interface ActionKeys {
  setActionOverride(slot: number, override: ActionOverride | null): void;
}

/** Background of every key during the away-mention pulse. */
export const FLASH_RED = "#E5484D";

/** What the mention alert needs: pulse all 9 keys red. */
export interface FlashKeys {
  /** true = all keys `alert`, false = all keys normal (pulse off phase), null = no flash. */
  setFlash(phase: boolean | null): void;
}

export type PressResult =
  | { kind: "term"; slot: number; term: string }
  | { kind: "empty"; slot: number }
  | { kind: "action"; slot: number; action: string }
  | { kind: "invalid"; slot: number };

interface Placed {
  key: string;
  candidate: TermCandidate;
  placedAt: number;
  seen: boolean;
  newTimer: TimerHandle | null;
}

/**
 * Decides which term is on which of the 6 term keys (slots 0-5, read left to right, top to bottom).
 * Slots 6-8 keep their static labels.
 *
 * FIFO conveyor:
 * - A new term always appears on slot 0; every other term moves one slot forward; the term on
 *   slot 5 leaves. Opened ("seen") terms are not removed early. A term's state (new / shown / seen)
 *   and its 3 s "new" timer travel with it.
 * - At most 2 placements per 10 s; extras queue (FIFO). Duplicates (case, plurals) are merged, and a
 *   term that was already shown in this meeting is not shown again.
 * - A press within 500 ms after a shift goes to the term that was on that key before the shift
 *   (the user aimed at what they saw); if that key was empty, the press goes to the term on it now.
 * - Emits `change` with only the slots whose KeyState changed, as complete protocol KeyStates, and
 *   `placed` ({ slot, candidate }) for every term that lands on a key (after its `change`; slot 0,
 *   or 1 for the first of two terms placed at the same moment).
 * - setFlash(true) shows every key as red `alert` (labels kept) on top of all this, for the away-mention pulse.
 */
export class SlotManager extends EventEmitter implements ActionKeys, FlashKeys {
  private readonly clock: Clock;
  private readonly newMs: number;
  private readonly maxNewPerWindow: number;
  private readonly windowMs: number;
  private readonly pressGraceMs: number;

  private slots: (Placed | null)[] = new Array(TERM_SLOTS).fill(null);
  private queue: { key: string; candidate: TermCandidate }[] = [];
  /** Every term that reached a key in this meeting (on screen or gone). */
  private shown = new Set<string>();
  private placements: number[] = [];
  private pumpTimer: TimerHandle | null = null;
  private overrides = new Map<number, ActionOverride>();
  private flash: boolean | null = null;
  private actionKeys: ActionKeyMap = ACTION_KEYS;
  private backgrounds: KeyBackgrounds = {};
  /** Layout just before the last shift, and when it happened. */
  private beforeShift: (Placed | null)[] | null = null;
  private shiftAt = -Infinity;

  constructor(opts: SlotManagerOptions) {
    super();
    this.clock = opts.clock;
    this.newMs = opts.newMs ?? 3000;
    this.maxNewPerWindow = opts.maxNewPerWindow ?? 2;
    this.windowMs = opts.windowMs ?? 10_000;
    this.pressGraceMs = opts.pressGraceMs ?? 500;
  }

  /** Offer a spotted term. Ignored if it is queued or was already shown in this meeting. */
  add(candidate: TermCandidate): void {
    const key = normalizeTerm(candidate.term);
    if (!key) return;
    if (this.shown.has(key)) return;
    if (this.queue.some((q) => q.key === key)) return;
    this.queue.push({ key, candidate });
    this.pump();
  }

  press(slot: number): PressResult {
    if (!isValidSlot(slot)) return { kind: "invalid", slot };
    if (slot >= TERM_SLOTS) return { kind: "action", slot, action: this.actionKeys[slot].name };
    const inGrace = this.beforeShift !== null && this.clock.now() - this.shiftAt < this.pressGraceMs;
    // In the grace period the user aimed at what was there before the shift; an empty key had nothing to aim at.
    const p = (inGrace ? this.beforeShift![slot] : null) ?? this.slots[slot];
    if (!p) return { kind: "empty", slot };
    if (!p.seen) {
      const before = this.states();
      p.seen = true;
      this.cancelNewTimer(p);
      this.emitDiff(before);
    }
    return { kind: "term", slot, term: p.candidate.term };
  }

  /** Change how an action key (6-8) looks, e.g. busy or "Saved ✓"; null restores it. */
  setActionOverride(slot: number, override: ActionOverride | null): void {
    if (!isValidSlot(slot) || slot < TERM_SLOTS) return;
    if (override) this.overrides.set(slot, { ...override });
    else if (!this.overrides.delete(slot)) return;
    this.emit("change", [this.keyState(slot)]);
  }

  /** User key backgrounds (panel Settings): `terms` for keys 0-5, "6" / "7" / "8" for the bottom row. Sends all 9. */
  setBackgrounds(bg: KeyBackgrounds): void {
    this.backgrounds = { ...bg };
    this.emit("change", this.getAll());
  }

  /** Switch the bottom row (Meeting / Education mode). Clears action overrides; sends slots 6-8. */
  setActionKeys(keys: ActionKeyMap): void {
    if (keys === this.actionKeys) return;
    this.actionKeys = keys;
    this.overrides.clear();
    this.emit("change", [6, 7, 8].map((s) => this.keyState(s)));
  }

  setFlash(phase: boolean | null): void {
    if (this.flash === phase) return;
    const wasRed = this.flash === true;
    this.flash = phase;
    if (wasRed || phase === true) this.emit("change", this.getAll());
  }

  /** All 9 slots in protocol format. */
  getAll(): KeyState[] {
    const out: KeyState[] = [];
    for (let i = 0; i < SLOT_COUNT; i++) out.push(this.keyState(i));
    return out;
  }

  /** The term on a term slot, or null. */
  termAt(slot: number): string | null {
    return this.slots[slot]?.candidate.term ?? null;
  }

  /** The full candidate on a term slot (for the overlay / panel), or null. */
  candidateAt(slot: number): TermCandidate | null {
    return this.slots[slot]?.candidate ?? null;
  }

  queued(): string[] {
    return this.queue.map((q) => q.candidate.term);
  }

  /** Back to the initial state (empty term slots, nothing queued or shown, action keys restored). */
  reset(): void {
    const changed: number[] = [...this.overrides.keys()];
    if (this.flash === true) changed.push(...Array(SLOT_COUNT).keys());
    this.flash = null;
    this.overrides.clear();
    this.slots.forEach((p, i) => {
      if (!p) return;
      this.cancelNewTimer(p);
      changed.push(i);
    });
    this.slots = new Array(TERM_SLOTS).fill(null);
    this.queue = [];
    this.shown.clear();
    this.placements = [];
    this.beforeShift = null;
    this.shiftAt = -Infinity;
    this.cancelPumpTimer();
    if (changed.length) this.emit("change", [...new Set(changed)].sort((a, b) => a - b).map((s) => this.keyState(s)));
  }

  dispose(): void {
    this.reset();
    this.removeAllListeners();
  }

  // --- internals ---------------------------------------------------------

  private pump(): void {
    this.cancelPumpTimer();
    const before = this.states();
    const layout = [...this.slots];
    const placed: Placed[] = [];
    while (this.queue.length > 0) {
      const now = this.clock.now();
      this.placements = this.placements.filter((t) => t > now - this.windowMs);
      if (this.placements.length >= this.maxNewPerWindow) break;
      const { key, candidate } = this.queue.shift()!;
      placed.push(this.insert(key, candidate, now));
    }
    if (placed.length) {
      this.beforeShift = layout;
      this.shiftAt = this.clock.now();
      this.emitDiff(before);
    }
    // Two terms placed together: the first one is already on slot 1.
    for (const p of placed) this.emit("placed", { slot: this.slots.indexOf(p), candidate: p.candidate });
    if (this.queue.length > 0) this.scheduleRetry();
  }

  /** New term on slot 0; the others move one slot forward; slot 5's term leaves. */
  private insert(key: string, candidate: TermCandidate, now: number): Placed {
    const leaving = this.slots[TERM_SLOTS - 1];
    if (leaving) this.cancelNewTimer(leaving);
    const placed: Placed = { key, candidate, placedAt: now, seen: false, newTimer: null };
    placed.newTimer = this.clock.setTimeout(() => {
      placed.newTimer = null;
      const slot = this.slots.indexOf(placed);
      if (slot !== -1 && !placed.seen) this.emit("change", [this.keyState(slot)]);
    }, this.newMs);
    this.slots = [placed, ...this.slots.slice(0, TERM_SLOTS - 1)];
    this.shown.add(key);
    this.placements.push(now);
    return placed;
  }

  /** One timer at the moment the rate window lets the next queued term in. */
  private scheduleRetry(): void {
    const now = this.clock.now();
    const sorted = [...this.placements].sort((a, b) => a - b);
    const at = sorted.length >= this.maxNewPerWindow ? sorted[sorted.length - this.maxNewPerWindow] + this.windowMs : now;
    this.pumpTimer = this.clock.setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, Math.max(0, at - now));
  }

  private keyState(slot: number): KeyState {
    const base = this.baseKeyState(slot);
    // In `alert`, color is the background (protocol v2), so a term key's category colour must not leak in.
    if (this.flash === true) return { ...base, color: FLASH_RED, state: "alert" };
    if (base.state === "empty" || base.state === "alert") return base;
    const bg = slot < TERM_SLOTS ? this.backgrounds.terms : this.backgrounds[String(slot) as "6" | "7" | "8"];
    return bg && bg !== "#000000" ? { ...base, bg } : base;
  }

  private baseKeyState(slot: number): KeyState {
    if (slot >= TERM_SLOTS) return { ...actionKeyIn(this.actionKeys, slot), ...this.overrides.get(slot) };
    const p = this.slots[slot];
    if (!p) return emptyKey(slot);
    const { term, category } = p.candidate;
    return {
      slot,
      label: displayTerm(term),
      sub: category,
      color: CATEGORY_COLORS[category],
      state: p.seen ? "seen" : p.newTimer !== null ? "new" : "shown",
    };
  }

  /** The 6 term-key states, for diffing. */
  private states(): KeyState[] {
    return this.slots.map((_, i) => this.keyState(i));
  }

  private emitDiff(before: KeyState[]): void {
    const after = this.states();
    const changed = after.filter((k, i) => JSON.stringify(k) !== JSON.stringify(before[i]));
    if (changed.length) this.emit("change", changed);
  }

  private cancelNewTimer(p: Placed): void {
    if (p.newTimer !== null) {
      this.clock.clearTimeout(p.newTimer);
      p.newTimer = null;
    }
  }

  private cancelPumpTimer(): void {
    if (this.pumpTimer !== null) {
      this.clock.clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
  }
}
