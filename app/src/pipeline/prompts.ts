// Prompts and schemas for Catch-up and Save.

import type { ChatMessage } from "./llm.js";
import type { TranscriptLine } from "./transcriptBuffer.js";

/** Meeting seconds as m:ss. */
export function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * `[m:ss] Speaker: text`, one line each (`[m:ss] text` when the speaker is unknown, as in live
 * lines without diarization). With `seconds`, the tag is `[t=123]` instead.
 */
export function formatTranscript(lines: TranscriptLine[], opts: { seconds?: boolean } = {}): string {
  return lines.map((l) => `[${opts.seconds ? `t=${l.t}` : mmss(l.t)}] ${l.speaker ? `${l.speaker}: ` : ""}${l.text}`).join("\n");
}

export function catchUpMessages(lines: TranscriptLine[], listenerName?: string): ChatMessage[] {
  const you = listenerName
    ? ` The reader is ${listenerName}; if someone asked ${listenerName} to do something, put it in the Decided line.`
    : "";
  return [
    {
      role: "system",
      content:
        "You help someone who looked away from a meeting catch up. You get the last two minutes of the " +
        "transcript. Reply with exactly three lines and nothing else:\n" +
        "- Said: <the main thing that was said, at most 18 words>\n" +
        '- Decided: <any decision or agreed task with its owner, or "Nothing decided yet.">\n' +
        "- Now: <what is being discussed right now, at most 18 words>\n" +
        "Plain everyday English, use the speakers' names, no intro, no closing, no extra formatting." +
        you,
    },
    { role: "user", content: `Transcript:\n${formatTranscript(lines)}` },
  ];
}

export interface IdeaJson {
  title: string;
  summary: string;
  quote: string;
  t: number;
}

/** Strict-mode friendly: every property required, no additional properties, no length keywords. */
export const SAVE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short title, at most 8 words" },
    summary: { type: "string", description: "One or two short sentences, at most 2 lines" },
    quote: { type: "string", description: "Words copied exactly from one transcript line, at most 20 words" },
    t: { type: "number", description: "The t= value of the line the quote comes from" },
  },
  required: ["title", "summary", "quote", "t"],
  additionalProperties: false,
};

export function saveMessages(lines: TranscriptLine[]): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You pick the single most important idea from a short meeting excerpt so the listener can save it. " +
        "Return JSON with: title (at most 8 words, no full stop), summary (one or two short plain-English " +
        "sentences, at most 2 lines), quote (copied word for word from ONE transcript line, at most 20 words, " +
        "nothing added or changed), t (the t= number of the line the quote is from).",
    },
    { role: "user", content: `Transcript (t = meeting seconds):\n${formatTranscript(lines, { seconds: true })}` },
  ];
}
