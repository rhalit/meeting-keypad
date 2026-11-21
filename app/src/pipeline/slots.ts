import { EventEmitter } from "node:events";
import type { Clock, TimerHandle } from "./clock.js";
import {
  ACTION_KEYS,
  CATEGORY_COLORS,
  SLOT_COUNT,
  TERM_SLOTS,
  actionKey,
  emptyKey,
  isValidSlot,
  type KeyState,
  type SlotState,
} from "./protocol.js";
import { normalizeTerm, type TermCandidate } from "./terms.js";

export interface SlotManagerOptions {
  clock: Clock;
  /** "new" -> "shown" after this long. */
  newMs?: number;
  /** An unopened term must have been on screen this long before it can be replaced. */
  minOnScreenMs?: number;
  /** At most this many placements per window; extras queue. */
  maxNewPerWindow?: number;
  windowMs?: number;
}

/** Temporary look of an action key (slots 6-8), merged over its static label. */
export interface ActionOverride {
  label?: string;
  bg?: string;
  state?: SlotState;
}

/** What the Catch-up / Save controllers need from SlotManager. */
export interface ActionKeys {
  setActionOverride(slot: number, override: ActionOverride | null): void;
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
 * Decides which term is on which of the 6 term keys (slots 0-5). Slots 6-8 keep their static labels.
 *
 * - A new term fills the lowest empty slot. When all are full it replaces a term already opened ("seen",
 *   the one placed earliest), otherwise the longest-shown unopened term once that has had >= 20 s.
 * - A term never moves to another slot. Duplicates (case, plurals) are merged.
 * - Terms that were opened never come back. At most 2 placements per 10 s; extras queue (FIFO).
 * - Emits `change` with only the slots that changed, as complete protocol KeyStates.
 */
export class SlotManager extends EventEmitter implements ActionKeys {
  private readonly clock: Clock;
  private readonly newMs: number;
  private readonly minOnScreenMs: number;
  private readonly maxNewPerWindow: number;
  private readonly windowMs: number;

  private slots: (Placed | null)[] = new Array(TERM_SLOTS).fill(null);
  private queue: { key: string; candidate: TermCandidate }[] = [];
  private opened = new Set<string>();
  private placements: number[] = [];
  private pumpTimer: TimerHandle | null = null;
  private overrides = new Map<number, ActionOverride>();

  constructor(opts: SlotManagerOptions) {
    super();
    this.clock = opts.clock;
    this.newMs = opts.newMs ?? 3000;
    this.minOnScreenMs = opts.minOnScreenMs ?? 20_000;
    this.maxNewPerWindow = opts.maxNewPerWindow ?? 2;
    this.windowMs = opts.windowMs ?? 10_000;
  }

  /** Offer a spotted term. Ignored if it is on screen, queued, or was opened before. */
  add(candidate: TermCandidate): void {
    const key = normalizeTerm(candidate.term);
    if (!key) return;
    if (this.opened.has(key)) return;
    if (this.slots.some((p) => p?.key === key)) return;
    if (this.queue.some((q) => q.key === key)) return;
    this.queue.push({ key, candidate });
    this.pump();
  }

  press(slot: number): PressResult {
    if (!isValidSlot(slot)) return { kind: "invalid", slot };
    if (slot >= TERM_SLOTS) return { kind: "action", slot, action: ACTION_KEYS[slot].name };
    const p = this.slots[slot];
    if (!p) return { kind: "empty", slot };
    this.opened.add(p.key);
    if (!p.seen) {
      p.seen = true;
      this.cancelNewTimer(p);
      this.emitChange([slot]);
      // A seen term is replaceable right away, so a queued term may now fit.
      this.pump();
    }
    return { kind: "term", slot, term: p.candidate.term };
  }

  /** Change how an action key (6-8) looks, e.g. busy or "Saved ✓"; null restores it. */
  setActionOverride(slot: number, override: ActionOverride | null): void {
    if (!isValidSlot(slot) || slot < TERM_SLOTS) return;
    if (override) this.overrides.set(slot, { ...override });
    else if (!this.overrides.delete(slot)) return;
    this.emitChange([slot]);
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

  /** Back to the initial state (empty term slots, nothing queued or opened, action keys restored). */
  reset(): void {
    const changed: number[] = [...this.overrides.keys()];
    this.overrides.clear();
    this.slots.forEach((p, i) => {
      if (!p) return;
      this.cancelNewTimer(p);
      changed.push(i);
    });
    this.slots = new Array(TERM_SLOTS).fill(null);
    this.queue = [];
    this.opened.clear();
    this.placements = [];
    this.cancelPumpTimer();
    if (changed.length) this.emitChange(changed);
  }

  dispose(): void {
    this.reset();
    this.removeAllListeners();
  }

  // --- internals ---------------------------------------------------------

  private pump(): void {
    this.cancelPumpTimer();
    const changed: number[] = [];
    while (this.queue.length > 0) {
      const now = this.clock.now();
      this.placements = this.placements.filter((t) => t > now - this.windowMs);
      if (this.placements.length >= this.maxNewPerWindow) break;
      const slot = this.pickSlot(now);
      if (slot === null) break;
      const { key, candidate } = this.queue.shift()!;
      this.place(slot, key, candidate, now);
      changed.push(slot);
    }
    if (changed.length) this.emitChange(changed);
    if (this.queue.length > 0) this.scheduleRetry();
  }

  /** Lowest empty slot, else the earliest-placed seen term, else the longest-shown term with >= 20 s. */
  private pickSlot(now: number): number | null {
    const empty = this.slots.findIndex((p) => p === null);
    if (empty !== -1) return empty;
    const oldest = (pred: (p: Placed) => boolean): number | null => {
      let best: number | null = null;
      this.slots.forEach((p, i) => {
        if (p && pred(p) && (best === null || p.placedAt < this.slots[best]!.placedAt)) best = i;
      });
      return best;
    };
    return oldest((p) => p.seen) ?? oldest((p) => !p.seen && now - p.placedAt >= this.minOnScreenMs);
  }

  private place(slot: number, key: string, candidate: TermCandidate, now: number): void {
    const prev = this.slots[slot];
    if (prev) this.cancelNewTimer(prev);
    const placed: Placed = { key, candidate, placedAt: now, seen: false, newTimer: null };
    placed.newTimer = this.clock.setTimeout(() => {
      placed.newTimer = null;
      if (this.slots[slot] === placed && !placed.seen) this.emitChange([slot]);
    }, this.newMs);
    this.slots[slot] = placed;
    this.placements.push(now);
  }

  /** One timer at the earliest moment the rate window or the 20 s rule can unblock the queue. */
  private scheduleRetry(): void {
    const now = this.clock.now();
    const times: number[] = [];
    if (this.placements.length >= this.maxNewPerWindow) {
      const sorted = [...this.placements].sort((a, b) => a - b);
      times.push(sorted[this.placements.length - this.maxNewPerWindow] + this.windowMs);
    }
    if (this.slots.every((p) => p !== null) && !this.slots.some((p) => p!.seen)) {
      times.push(Math.min(...this.slots.map((p) => p!.placedAt)) + this.minOnScreenMs);
    }
    const at = Math.max(now, ...times);
    this.pumpTimer = this.clock.setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, at - now);
  }

  private keyState(slot: number): KeyState {
    if (slot >= TERM_SLOTS) return { ...actionKey(slot), ...this.overrides.get(slot) };
    const p = this.slots[slot];
    if (!p) return emptyKey(slot);
    const { label, category } = p.candidate;
    return {
      slot,
      label,
      sub: category,
      bg: CATEGORY_COLORS[category],
      state: p.seen ? "seen" : p.newTimer !== null ? "new" : "shown",
    };
  }

  private emitChange(slots: number[]): void {
    this.emit(
      "change",
      [...new Set(slots)].map((s) => this.keyState(s)),
    );
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
