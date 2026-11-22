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

// --- live term spotter (LLM_SPOTTER_MODEL) ------------------------------------------------------

/** Strict-mode friendly. `heard` = the words as transcribed, so the app can find the sentence. */
export const SPOTTER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    terms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          term: { type: "string", description: "Canonical spelling, 1-4 words" },
          heard: { type: "string", description: "The words exactly as they appear in the transcript" },
          label: { type: "string", description: "Key label: at most 2 lines of at most 8 characters, separated by \\n" },
          category: { type: "string", enum: ["AI", "Infra", "Eng", "Biz", "Security"] },
          confidence: { type: "number", description: "0 to 1" },
          reason: { type: "string", description: "A few words" },
        },
        required: ["term", "heard", "label", "category", "confidence", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["terms"],
  additionalProperties: false,
};

export function spotterMessages(opts: {
  listener: string;
  alreadyShown: string[];
  context: TranscriptLine[];
  lines: TranscriptLine[];
}): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        `You spot jargon in a live meeting transcript so it can be explained to one listener: ${opts.listener}.\n` +
        "Pick from the NEW lines every jargon word or technical term specific to a domain (AI, software, infrastructure, " +
        "security, business, finance, legal...) that this listener would probably not know: established terms of art you " +
        "would find in a glossary, such as acronyms, metrics, named techniques and practices.\n" +
        "Skip: everyday words and phrases most people know (meeting, team, customer, price, revenue, email, app, website, " +
        "report, bug, test, spike, accounts); ordinary descriptions that are not fixed terms (\"Monday morning spike\", " +
        "\"cost per revenue\"); names of people, companies and products; plain numbers; anything in \"Already shown\" and " +
        "variants of it (\"canary rollout\" after \"canary release\").\n" +
        'Spell each term the standard way even when speech-to-text misheard it (e.g. "so two" -> "SOC 2", "rag" -> "RAG", ' +
        '"laura" -> "LoRA"). Use the short form people say ("pen test", not a phrase around it).\n' +
        "For each term: term (canonical spelling, 1-4 words), heard (the words exactly as in the transcript), label (for a small " +
        'key: the term itself, shortened if needed, never another word; at most 2 lines of at most 8 characters, lines separated ' +
        'by \\n, e.g. "Vector\\nDB", "p95\\nlatency", "SOC 2"), ' +
        "category (AI; Infra = servers, cloud, deployment; Eng = software practice; Biz = business, finance, sales; Security), " +
        "confidence (0 to 1: 0.9 for a clear term of art this listener would not know, 0.5 or less for borderline or " +
        "common words), reason (a few words).\n" +
        'Return at most 3 terms, best first. Most lines contain none: then return {"terms": []}.',
    },
    {
      role: "user",
      content:
        `Already shown: ${opts.alreadyShown.length ? opts.alreadyShown.join(", ") : "none"}\n\n` +
        (opts.context.length ? `Earlier (context only, do not pick from here):\n${formatTranscript(opts.context)}\n\n` : "") +
        `NEW:\n${formatTranscript(opts.lines)}`,
    },
  ];
}

// --- live term explanation (LLM_MODEL) -----------------------------------------------------------

export const EXPLAIN_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    full: { type: "string", description: "Full name or expansion of the term, or the term itself" },
    explanation: { type: "string", description: "40-60 words, plain English" },
    category: { type: "string", enum: ["AI", "Infra", "Eng", "Biz", "Security"] },
  },
  required: ["full", "explanation", "category"],
  additionalProperties: false,
};

export function explainMessages(opts: { term: string; listener: string; heard?: TranscriptLine; context: TranscriptLine[] }): ChatMessage[] {
  const said = [...opts.context, ...(opts.heard ? [opts.heard] : [])];
  return [
    {
      role: "system",
      content:
        `You explain a jargon term that just came up in a meeting to ${opts.listener}. Return JSON with: ` +
        'full (the full name or expansion, e.g. "Retrieval-augmented generation" for RAG; the term itself if it has none), ' +
        "explanation (40 to 60 words of plain everyday English for this listener: what it is and what it means here; " +
        "no other jargon; do not start by repeating the term), category (AI, Infra, Eng, Biz or Security).",
    },
    {
      role: "user",
      content: `Term: ${opts.term}${said.length ? `\nWhere it came up in the meeting:\n${formatTranscript(said)}` : ""}`,
    },
  ];
}
