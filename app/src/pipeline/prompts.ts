// Prompts and schemas for Catch-up and Save.

import type { ChatMessage } from "./llm.js";
import { CATEGORIES } from "./protocol.js";
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

/** "the last two minutes", "the last 30 seconds": how far back a summary looks, in words. */
export function windowWords(sec = 120): string {
  const words: Record<number, string> = { 30: "30 seconds", 60: "minute", 120: "two minutes", 300: "five minutes", 600: "ten minutes" };
  return `the last ${words[sec] ?? (sec < 60 ? `${sec} seconds` : `${Math.round(sec / 60)} minutes`)}`;
}

export function catchUpMessages(lines: TranscriptLine[], listenerName?: string, opts: { away?: boolean; windowS?: number } = {}): ChatMessage[] {
  const span = opts.away ? "the transcript from the moment they looked away until now" : `${windowWords(opts.windowS)} of the transcript`;
  const you = listenerName
    ? ` The reader is ${listenerName}; if someone asked ${listenerName} to do something, put it in the Decided line.`
    : "";
  return [
    {
      role: "system",
      content:
        `You help someone who looked away from a meeting catch up. You get ${span}. Reply with exactly three lines and nothing else:\n` +
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

/** Strict-mode friendly. `heard` = the words as transcribed, so the app can check them and find the sentence. */
export const SPOTTER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    terms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          term: { type: "string", description: "Canonical spelling, 1-4 words" },
          heard: { type: "string", description: "The words exactly as they appear in the NEW lines" },
          full: { type: "string", description: "Full name or expansion, or the term itself" },
          variantOf: { type: "string", description: 'The "Already shown" term this is a variant or mishearing of, or ""' },
          category: { type: "string", enum: [...CATEGORIES] },
          confidence: { type: "number", description: "0 to 1" },
          reason: { type: "string", description: "A few words" },
        },
        required: ["term", "heard", "full", "variantOf", "category", "confidence", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["terms"],
  additionalProperties: false,
};

export const CATEGORY_GUIDE =
  "Tech = software, AI, computing, internet, engineering; Science = physics, chemistry, biology, maths, research; " +
  "Health = medicine, body, mind, fitness, nutrition; Business = companies, management, marketing, sales; " +
  "Finance = money, investing, economics, accounting; Law = legal, regulation, compliance, policy; Other = anything else";

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
        `You spot jargon in a live meeting or talk transcript so it can be explained to one listener: ${opts.listener}.\n` +
        "Pick from the NEW lines every jargon word or technical term specific to a field (tech, science, health, business, " +
        "finance, law...) that this listener would probably not know: established terms of art you would find in a glossary, " +
        "such as acronyms, metrics, named techniques, substances and practices.\n" +
        "Skip: everyday words and phrases most people know (meeting, team, customer, price, email, app, website, report, " +
        "sleep, stress, exercise); ordinary descriptions that are not fixed terms; names of people, companies and products; " +
        "plain numbers; anything only in the Earlier lines; anything in \"Already shown\" and variants of it (\"canary rollout\" " +
        'after "canary release", the spelled-out name of an acronym already shown, or a mishearing of it: "NSTR" after "NSDR").\n' +
        'Spell each term the standard way even when speech-to-text misheard it (e.g. "so two" -> "SOC 2", "rag" -> "RAG", ' +
        '"laura" -> "LoRA"). Use the short form people say ("pen test", not a phrase around it).\n' +
        "For each term: term (canonical spelling, 1-4 words), heard (the words exactly as in the NEW lines), " +
        "full (the full name or expansion, or the term itself), variantOf (the Already shown term it is a variant or " +
        `mishearing of, else ""), category (${CATEGORY_GUIDE}), ` +
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
  },
  required: ["full", "explanation"],
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
        "no other jargon; do not start by repeating the term).",
    },
    {
      role: "user",
      content: `Term: ${opts.term}${said.length ? `\nWhere it came up in the meeting:\n${formatTranscript(said)}` : ""}`,
    },
  ];
}

// --- "For me?" (LLM_MODEL, only when the listener's name was heard) ------------------------------

export interface ForMeJson {
  isForListener: boolean;
  question: string;
  context: string;
  suggestedReply: string;
}

export const FOR_ME_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    isForListener: { type: "boolean", description: "True if the line asks the listener a question or asks them to do something" },
    question: { type: "string", description: "The question or request, one short sentence, addressed to the listener" },
    context: { type: "string", description: "Two short sentences: what the discussion was about and why it is asked" },
    suggestedReply: { type: "string", description: "One or two sentences the listener could say, first person" },
  },
  required: ["isForListener", "question", "context", "suggestedReply"],
  additionalProperties: false,
};

export function forMeMessages(opts: { listener: string; name: string; heard: string; line: TranscriptLine; context: TranscriptLine[] }): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        `You watch a live meeting for one listener: ${opts.listener}. Their name (or a mishearing of it, here "${opts.heard}") ` +
        "was just said in the LINE. Decide whether the LINE asks the listener a question or asks them to do something " +
        "(isForListener true), or only mentions them (thanks, a reference, talking about them: false). Return JSON with: " +
        "isForListener; question (the question or request in one short plain sentence, addressed to the listener as " +
        '"you", e.g. "Can you send Omar the pen test scope by Wednesday?"); context (exactly two short sentences: what ' +
        "was being discussed and why this is asked); suggestedReply (one or two sentences the listener could say right " +
        'now, first person, friendly and concrete; keep every deadline, name and number exactly as in the LINE, and do ' +
        "not promise things the transcript does not support). When " +
        'isForListener is false, the other fields may be "".',
    },
    {
      role: "user",
      content:
        (opts.context.length ? `Last minute (context):\n${formatTranscript(opts.context)}\n\n` : "") +
        `LINE:\n${formatTranscript([opts.line])}`,
    },
  ];
}

// --- meeting export summary (LLM_MODEL, one call per export) -------------------------------------

export interface MeetingSummaryJson {
  title: string;
  bullets: string[];
}

export const SUMMARY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string", description: "Meeting title, at most 8 words, no full stop" },
    bullets: { type: "array", items: { type: "string" }, description: "Exactly 5 bullets, each at most 25 words" },
  },
  required: ["title", "bullets"],
  additionalProperties: false,
};

export function summaryMessages(lines: TranscriptLine[], listenerName?: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You write the notes of a meeting from its transcript. Return JSON with: title (what the meeting was about, " +
        "at most 8 words, no full stop) and bullets (exactly 5 bullets in plain everyday English, at most 25 words each: " +
        "the main points, decisions and agreed tasks with their owners, in the order they came up; use the speakers' names" +
        (listenerName ? `; the reader is ${listenerName}` : "") +
        "). No markdown inside the strings.",
    },
    { role: "user", content: `Transcript:\n${formatTranscript(lines)}` },
  ];
}

// --- Education mode: Explain simply (slot 8), Flashcard (slot 6), Quiz me (slot 7) --------------

/** Streams 3 bullet lines, same shape as Catch-up so the same controller and card can show it. */
export function explainSimplyMessages(lines: TranscriptLine[], listenerName?: string, opts: { away?: boolean; windowS?: number } = {}): ChatMessage[] {
  const span = opts.away ? "the part of the lecture from the moment they looked away until now" : `${windowWords(opts.windowS)} of the lecture`;
  return [
    {
      role: "system",
      content:
        `You help a student${listenerName ? ` (${listenerName})` : ""} who lost the thread of a lecture. You get ${span}. ` +
        "Explain what was just taught so a 15-year-old would understand. Reply with exactly three lines and nothing else:\n" +
        "- Idea: <the main idea being taught, at most 18 words>\n" +
        "- In plain words: <the same idea with no jargon, at most 25 words>\n" +
        "- Example: <one concrete everyday example, at most 25 words>\n" +
        "No intro, no closing, no extra formatting.",
    },
    { role: "user", content: `Lecture transcript:\n${formatTranscript(lines)}` },
  ];
}

export interface FlashcardJson {
  front: string;
  back: string;
}

export const FLASHCARD_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    front: { type: "string", description: "A question or prompt, at most 15 words" },
    back: { type: "string", description: "The answer, at most 30 words, plain English" },
  },
  required: ["front", "back"],
  additionalProperties: false,
};

export function flashcardMessages(lines: TranscriptLine[], avoid: string[]): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You turn the most important idea of a short lecture excerpt into ONE flashcard for spaced repetition. " +
        "Return JSON with: front (a clear question that tests understanding, not a yes/no question, at most 15 words) and " +
        "back (the answer in plain English, at most 30 words, understandable on its own weeks later). " +
        "Use only what the lecture says." +
        (avoid.length ? ` Do not repeat a card the student already has: ${avoid.map((a) => `"${a}"`).join("; ")}.` : ""),
    },
    { role: "user", content: `Lecture excerpt:\n${formatTranscript(lines)}` },
  ];
}

export interface QuizJson {
  question: string;
  choices: string[];
  answerIndex: number;
  explanation: string;
}

export const QUIZ_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    question: { type: "string", description: "One question about the excerpt, at most 20 words" },
    choices: { type: "array", items: { type: "string" }, description: "Exactly 3 short answer options" },
    answerIndex: { type: "number", description: "Index (0, 1 or 2) of the correct choice" },
    explanation: { type: "string", description: "Why that answer is right, at most 30 words" },
  },
  required: ["question", "choices", "answerIndex", "explanation"],
  additionalProperties: false,
};

export function quizMessages(lines: TranscriptLine[], avoid: string[]): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You quiz a student on a lecture excerpt to practise recall. Return JSON with: question (one question that checks " +
        "understanding of something the lecture explained, at most 20 words), choices (exactly 3 short options, only one " +
        "correct, wrong ones plausible), answerIndex (0, 1 or 2), explanation (why the answer is right, at most 30 words, " +
        "plain English). Use only what the lecture says." +
        (avoid.length ? ` Ask about something else than: ${avoid.map((a) => `"${a}"`).join("; ")}.` : ""),
    },
    { role: "user", content: `Lecture excerpt:\n${formatTranscript(lines)}` },
  ];
}
