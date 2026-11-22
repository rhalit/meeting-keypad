import type { Clock, TimerHandle } from "./clock.js";
import type { KeyState } from "./protocol.js";

// Key menus (protocol/messages.md, "Key menus"): Catch-up and Save first ask how far back to look.

export type MenuId = "catch-up" | "save";

/** Seconds offered on slots 0-4. */
export const MENU_DURATIONS = [30, 60, 120, 300, 600] as const;
export const MENU_BACK_SLOT = 6;
export const MENU_COLOR = "#58A6FF";
export const BACK_COLOR = "#8B949E";

const TITLES: Record<MenuId, string> = { "catch-up": "Catch-up", save: "Save" };

/** "30 s", "1 min", "10 min". */
export function durationLabel(sec: number): string {
  return sec < 60 ? `${sec} s` : `${Math.round(sec / 60)} min`;
}

/** The menu's 9 keys (missing slots are empty). */
export function menuKeys(menu: MenuId): KeyState[] {
  return [
    ...MENU_DURATIONS.map((sec, slot): KeyState => ({ slot, label: durationLabel(sec), sub: TITLES[menu], color: MENU_COLOR, state: "shown" })),
    { slot: MENU_BACK_SLOT, label: "‹ Back", color: BACK_COLOR, state: "shown" },
  ];
}

export interface MenuKeysTarget {
  setMenu(keys: KeyState[] | null): void;
}

export interface KeypadMenuOptions {
  clock: Clock;
  keys: MenuKeysTarget;
  log: (msg: string) => void;
  /** A duration was picked; the menu is already closed. */
  onPick: (menu: MenuId, seconds: number) => void;
  /** No press for this long closes the menu. */
  timeoutMs?: number;
}

export type MenuPress = "picked" | "back" | "ignored";

/**
 * One menu at a time. While open, every key press goes to press() (not to the normal keys): slots 0-4
 * pick a duration, slot 6 or back() (the Back action / left arrow) leaves, other keys are ignored.
 */
export class KeypadMenu {
  private readonly timeoutMs: number;
  private current: MenuId | null = null;
  private timer: TimerHandle | null = null;

  constructor(private readonly o: KeypadMenuOptions) {
    this.timeoutMs = o.timeoutMs ?? 15_000;
  }

  open(menu: MenuId): void {
    this.current = menu;
    this.o.keys.setMenu(menuKeys(menu));
    this.o.log(`menu: ${menu} (pick how far back, or Back)`);
    this.arm();
  }

  openMenu(): MenuId | null {
    return this.current;
  }

  isOpen(): boolean {
    return this.current !== null;
  }

  press(slot: number): MenuPress {
    const menu = this.current;
    if (!menu) return "ignored";
    if (slot >= 0 && slot < MENU_DURATIONS.length) {
      const seconds = MENU_DURATIONS[slot];
      this.close();
      this.o.log(`menu: ${menu} -> last ${durationLabel(seconds)}`);
      this.o.onPick(menu, seconds);
      return "picked";
    }
    if (slot === MENU_BACK_SLOT) {
      this.back();
      return "back";
    }
    this.arm(); // a stray press keeps the menu open a little longer
    return "ignored";
  }

  /** Leave without picking (Back key, Back action / left arrow). False if no menu was open. */
  back(): boolean {
    if (!this.current) return false;
    this.o.log(`menu: ${this.current} closed (back)`);
    this.close();
    return true;
  }

  close(): void {
    if (this.timer !== null) this.o.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.current === null) return;
    this.current = null;
    this.o.keys.setMenu(null);
  }

  private arm(): void {
    if (this.timer !== null) this.o.clock.clearTimeout(this.timer);
    this.timer = this.o.clock.setTimeout(() => {
      this.timer = null;
      if (!this.current) return;
      this.o.log(`menu: ${this.current} closed (no press for ${this.timeoutMs / 1000} s)`);
      this.close();
    }, this.timeoutMs);
  }
}
