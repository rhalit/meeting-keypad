// What was saved in each meeting or course, shown in the app's Saved view (no Markdown file).
// One session per mock scenario ("mock:<id>", replays add to it) and per Live listening session
// ("live:<start ms>"). Stored as JSON in Electron's userData folder (sessions.json).

import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SavedIdeaEntry {
  title: string;
  summary: string;
  quote: string;
  /** Meeting second of the quoted line. */
  t: number;
  /** Wall clock ms. */
  savedAt: number;
}

export interface SavedCardEntry {
  front: string;
  back: string;
  t: number;
  savedAt: number;
}

export interface Session {
  id: string;
  title: string;
  kind: "meeting" | "course";
  source: "mock" | "live";
  startedAt: number;
  /** Last time something was saved (sorts the list). */
  updatedAt: number;
  ideas: SavedIdeaEntry[];
  cards: SavedCardEntry[];
}

export interface SessionInit {
  id: string;
  title: string;
  kind: "meeting" | "course";
  source: "mock" | "live";
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Lenient: drops malformed sessions and entries. */
export function parseSessions(raw: unknown): Session[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { sessions?: unknown }).sessions) ? (raw as { sessions: unknown[] }).sessions : [];
  const out: Session[] = [];
  for (const r of list) {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.title !== "string") continue;
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const ideas = (Array.isArray(o.ideas) ? o.ideas : [])
      .map((i) => (i ?? {}) as Record<string, unknown>)
      .filter((i) => typeof i.title === "string" && i.title !== "")
      .map((i) => ({ title: str(i.title), summary: str(i.summary), quote: str(i.quote), t: num(i.t, 0), savedAt: num(i.savedAt, 0) }));
    const cards = (Array.isArray(o.cards) ? o.cards : [])
      .map((c) => (c ?? {}) as Record<string, unknown>)
      .filter((c) => typeof c.front === "string" && c.front !== "")
      .map((c) => ({ front: str(c.front), back: str(c.back), t: num(c.t, 0), savedAt: num(c.savedAt, 0) }));
    out.push({
      id: o.id,
      title: o.title,
      kind: o.kind === "course" ? "course" : "meeting",
      source: o.source === "live" ? "live" : "mock",
      startedAt: num(o.startedAt, 0),
      updatedAt: num(o.updatedAt, num(o.startedAt, 0)),
      ideas,
      cards,
    });
  }
  return out;
}

/**
 * Sessions with their saved ideas (Save key) and flashcards (Flashcard key). `open()` makes a session
 * current (created on first save, so sessions where nothing was saved never show up).
 * Events: `change` after every save.
 */
export class SessionStore extends EventEmitter {
  private sessions: Session[] = [];
  private currentInit: SessionInit | null = null;

  constructor(
    private readonly path: string | null,
    private readonly now: () => number = () => Date.now(),
    private readonly log: (msg: string) => void = () => {},
  ) {
    super();
    if (path) {
      try {
        this.sessions = parseSessions(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        this.sessions = [];
      }
    }
  }

  /** The meeting or course that saves go to from now on. */
  open(init: SessionInit): void {
    this.currentInit = { ...init };
    const s = this.sessions.find((x) => x.id === init.id);
    if (s && s.title !== init.title) s.title = init.title;
    this.emit("change");
  }

  currentId(): string | null {
    return this.currentInit?.id ?? null;
  }

  current(): Session | null {
    const id = this.currentInit?.id;
    return (id && this.sessions.find((x) => x.id === id)) || null;
  }

  /** Every session with something saved, most recently used first. */
  list(): Session[] {
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => ({ ...s, ideas: [...s.ideas], cards: [...s.cards] }));
  }

  /** Adds a saved idea to the current session; a repeat (same title or quote) is ignored. */
  addIdea(idea: { title: string; summary: string; quote: string; t: number }): boolean {
    const s = this.ensureCurrent();
    if (!s) return false;
    if (s.ideas.some((i) => norm(i.title) === norm(idea.title) || (idea.quote && norm(i.quote) === norm(idea.quote)))) return false;
    s.ideas.push({ title: idea.title, summary: idea.summary, quote: idea.quote, t: idea.t, savedAt: this.now() });
    this.touch(s);
    return true;
  }

  addCard(card: { front: string; back: string; t: number }): boolean {
    const s = this.ensureCurrent();
    if (!s) return false;
    if (s.cards.some((c) => norm(c.front) === norm(card.front))) return false;
    s.cards.push({ front: card.front, back: card.back, t: card.t, savedAt: this.now() });
    this.touch(s);
    return true;
  }

  private ensureCurrent(): Session | null {
    const init = this.currentInit;
    if (!init) return null;
    let s = this.sessions.find((x) => x.id === init.id);
    if (!s) {
      const at = this.now();
      s = { ...init, startedAt: at, updatedAt: at, ideas: [], cards: [] };
      this.sessions.push(s);
    }
    return s;
  }

  private touch(s: Session): void {
    s.updatedAt = this.now();
    this.persist();
    this.emit("change");
  }

  private persist(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ sessions: this.sessions }, null, 1)}\n`, "utf8");
      renameSync(tmp, this.path);
    } catch (err) {
      this.log(`WARNING: saved ideas not written: ${(err as Error).message}`);
    }
  }
}
