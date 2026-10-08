/**
 * THE BRAIN
 * ---------
 * This file is the single AI call. One agent. One prompt. Minimalist.
 *
 * Why one agent (not router → response → validator)?
 *   - Less to break.
 *   - Cheaper.
 *   - Easier to debug.
 *   - Claude Sonnet 4.6 is smart enough to do it all in one call.
 *
 * Obedience strategy (the 10/10 promise):
 *   - Rules injected at TOP and BOTTOM of system prompt (proven technique)
 *   - Claude sees the rules in 2 places, treats them as absolute
 *   - If needed, we can add a post-generation rule-check pass later (V2)
 */

import { claude } from "./anthropic";
// Named so this shows up as its own line in the spend report. The metering itself
// happens inside the client, so there is nothing to remember at the call below.
const anthropic = claude("setter_reply");
import {
  buildSystemBlocks,
  buildMessageHistory,
  formatDuration,
  type ClientConfig,
  type Message,
  type StageContext,
  type LanguageDirective,
  type LeadContext,
} from "./prompts/master";


// Model used for production replies.
//
// SONNET 5 (owner call, 2026-08-17): "lets do sonnet 5 bro instead and go for
// the 40% cheaper". His reasoning, and it is sound: the setter is not running on
// raw model judgement - it runs on his full script, his rules, his voice samples
// and a stage rail that dictates what this message is allowed to do. When that
// much of the answer is specified, the model is executing instructions rather
// than inventing an approach, which is the regime where the Sonnet tier is
// closest to Opus.
//
// The cost: $3/$15 per million vs Opus 5's $5/$25, so about 40% off the single
// most expensive call in the system, and the biggest line in the bill. (Sonnet 5
// is also on introductory pricing at $2/$10 through 2026-08-31, making the next
// two weeks cheaper still - see PRICING in intelligence/cost.py.)
//
// The previous setting was Opus 5 (owner ask 2026-08-08), on the reasoning that
// the live selling conversation is the most sensitive call in the system and the
// humanizer's hold pacing hides the extra thinking time anyway. That reasoning
// was about latency being free, not about Opus being required - so it does not
// argue against this change, and the latency argument now works in Sonnet's
// favour rather than against it.
//
// HOW TO CHECK THIS WAS RIGHT, rather than assuming: scripts/model-bakeoff.ts
// runs both models through this exact path on the turns that decide bookings,
// and `python scripts/ai_spend_report.py --by model` shows what actually changed
// in the bill. If replies get worse, this one line goes back to "claude-opus-5".
export const PRODUCTION_MODEL = "claude-sonnet-5";

// What we moved away from. Kept as a named constant so the bakeoff can compare
// against it without hardcoding a string that would rot, and so reverting is a
// one-word change rather than an act of memory.
export const PREVIOUS_PRODUCTION_MODEL = "claude-opus-5";

export interface GenerateReplyParams {
  client: ClientConfig;
  history: Message[];   // The full conversation, oldest first
  // Current funnel position. When provided, the reply is railed to this one
  // stage so the model cannot skip ahead. Omitted => legacy full-script mode.
  stage?: StageContext;
  // Language steer for this reply (resolved per lead by lib/language.ts).
  // 'lock_sv' => reply entirely in Swedish; 'ask_sv' => ask "snackar du
  // svenska?" once; omitted => English/default.
  language?: LanguageDirective;
  // One-off directive folded into THIS reply only (anti-repeat guard's retry:
  // "you already said X, don't repeat it / don't re-ask"). Usually undefined.
  extraInstruction?: string;
  // The quick reaction ALREADY DELIVERED to the lead this turn. Injected as
  // the model's OWN assistant turn right before a short bridging user note, so
  // it sees itself having already reacted and continues from there — it cannot
  // re-acknowledge, no matter what other directive (react-first, pain-dig) is
  // pushing it to open with empathy. Instructions alone proved insufficient
  // (live replies re-reacted in fresh wording). NOTE: true assistant PREFILL
  // (trailing assistant turn) is REJECTED by this model with a 400 — verified
  // in production 2026-07-02 ("This model does not support assistant message
  // prefill") — which silently killed every post-ack reply for half a day. The
  // conversation must always end on a user turn.
  ackPrefill?: string;
  // Who the setter is talking to (display name / @handle). Optional so every
  // existing call site keeps compiling; when absent the prompt simply carries
  // no identity block. Thread age is derived from the history below, so the
  // caller never has to supply it.
  lead?: LeadContext;
  // Runtime fact computed by the CALLER from the conversation history (true
  // only when no prior "ai"/"human" turn exists anywhere in it) — NOT
  // something the model is left to infer from a large prompt. Injected as an
  // explicit directive, with matching reinforcement in the final rule-check,
  // so the opening acknowledgment on a genuinely new conversation isn't
  // competing for attention against everything else in the prompt.
  isFirstReply?: boolean;
  // True only for the one dedicated call that drafts a cold outbound
  // re-engagement opener to a dormant lead, triggered by the operator's own
  // note (not a lead message). See isReactivationOpener in master.ts.
  isReactivationOpener?: boolean;
  // Which historical situation this dormant lead is in (decided once,
  // deterministically, by lib/reactivation.ts's classifier). Only meaningful
  // alongside isReactivationOpener.
  reactivationSegment?: "never_attended" | "attended_before";
  // FOR THE MODEL BAKEOFF ONLY (scripts/model-bakeoff.ts, 2026-08-17).
  // The owner: "lets do it and see if there is even any difference bcs i have given
  // it a full script, rules, stages etc so it should be the same either way."
  // Answering that honestly means running the REAL path - same prompt build,
  // same cleaning, same splitting - and changing only the model, so nothing but
  // the model can explain a difference in the output.
  //
  // `spendAction` exists so a bakeoff run does not land in the setter_reply
  // bucket and quietly inflate the number he uses to judge real spend. Both are
  // optional; production passes neither and behaves exactly as before.
  model?: string;
  spendAction?: string;
}

export interface GenerateReplyResult {
  reply: string;                    // The final cleaned reply (with [[SPLIT]] tokens preserved)
  segments: string[];               // Reply split into individual messages
  raw_response: string;             // What Claude returned before cleaning
  system_prompt_used: string;       // The full system prompt sent (for logging)
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
}

/**
 * Generate a reply for the given conversation.
 *
 * This is the ONE function the rest of the app calls to get an AI response.
 */
export async function generateReply(
  params: GenerateReplyParams
): Promise<GenerateReplyResult> {
  const startTime = Date.now();

  // How long this thread has been running, straight off the oldest message we
  // hold. The model got no timestamps at all before 2026-08-08, so it could not
  // tell a months-old relationship from a stranger who just messaged.
  const leadContext: LeadContext = { ...(params.lead ?? {}) };
  if (!leadContext.threadAge) {
    leadContext.threadAge = describeThreadAge(params.history);
  }

  const { stable, volatile } = buildSystemBlocks(
    params.client,
    params.stage,
    params.language,
    params.extraInstruction,
    leadContext,
    params.isFirstReply === true,
    params.isReactivationOpener === true,
    params.reactivationSegment
  );
  const systemPrompt = `${stable}\n\n${volatile}`;
  const messages = buildMessageHistory(params.history, params.client.name);

  // Safety: if there's nothing to reply to, don't call the API
  if (messages.length === 0) {
    throw new Error("Cannot generate reply: conversation history is empty.");
  }

  // The conversation MUST end with a user message for Claude to reply to it
  if (messages[messages.length - 1].role !== "user") {
    throw new Error("Cannot generate reply: last message is not from the lead.");
  }

  // ...and it MUST open on one too. The API hard-400s otherwise ("first message
  // must use the user role"), which is what every thread the operator started
  // himself would have done the moment his hand-typed messages started being
  // recorded. buildMessageHistory already folds a leading our-side run into a
  // context turn; this is the belt-and-braces check so a future change fails
  // loudly here, with a readable reason, instead of as an opaque API error mid
  // conversation.
  if (messages[0].role !== "user") {
    throw new Error(
      "Cannot generate reply: conversation history starts with an assistant turn, which the API rejects. buildMessageHistory must guarantee a user turn first."
    );
  }

  // Already-delivered reaction (see ackPrefill above): append it as the
  // model's own assistant turn, then a short bridging user note so the
  // conversation still ends on a user message (hard API requirement — a
  // trailing assistant turn 400s on this model). Same synthetic-turn pattern
  // the follow-up drafts use in production.
  const prefill = (params.ackPrefill || "").trim();
  if (prefill) {
    messages.push({ role: "assistant", content: prefill });
    messages.push({
      role: "user",
      content:
        "[that reaction above was already delivered as the first bubble of your reply - continue it now: no second reaction in any wording, go straight to your next thought or question]",
    });
  }

  // Default client and model unless a bakeoff explicitly overrode them.
  const client = params.spendAction ? claude(params.spendAction) : anthropic;
  const response = await client.messages.create({
    model: params.model || PRODUCTION_MODEL,
    // Both Sonnet 5 and Opus 5 run adaptive thinking when no `thinking` field is
    // sent, and max_tokens caps thinking + text TOGETHER — 1024 would truncate
    // mid-reply. Effort "medium" bounds the thinking so a DM reply stays a few
    // seconds, not a deliberation. Deliberately left unchanged by the Sonnet 5
    // move: the whole point of the switch is that ONLY the model changes, so if
    // replies get worse there is exactly one variable to blame.
    max_tokens: 6000,
    output_config: { effort: "medium" },
    // Prompt caching: the stable block (engine directives + client rules/voice/
    // context/process) is byte-identical for every lead of this client, so it
    // carries the cache breakpoint. Within the 5-min cache window, repeat
    // replies read it at ~10% of the input price. Volatile content (time,
    // language, stage, slots) comes after the breakpoint, uncached.
    system: [
      { type: "text", text: stable, cache_control: { type: "ephemeral" } },
      { type: "text", text: volatile },
    ],
    messages,
  });

  const cacheWrite = response.usage.cache_creation_input_tokens ?? 0;
  const cacheRead = response.usage.cache_read_input_tokens ?? 0;
  console.log(
    `[brain] tokens — input: ${response.usage.input_tokens}, output: ${response.usage.output_tokens}, ` +
      `cache_write: ${cacheWrite}, cache_read: ${cacheRead}` +
      (cacheRead > 0 ? " (cache HIT)" : cacheWrite > 0 ? " (cache warmed)" : " (no cache — prompt may be under the cacheable minimum)")
  );

  // Extract text content
  const rawResponse = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("");

  // Clean + split the reply
  const cleaned = cleanReply(rawResponse);
  const segments = splitReply(cleaned);

  return {
    reply: cleaned,
    segments,
    raw_response: rawResponse,
    system_prompt_used: systemPrompt,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Age of the thread, from its oldest message to now, e.g. "4 months".
 * Returns undefined for a thread that only started today - "3 hours" is not
 * worth the tokens, and the absence of the line is itself the signal that this
 * is fresh.
 */
function describeThreadAge(history: Message[]): string | undefined {
  const stamps = history
    .map((m) => Date.parse(m.created_at ?? ""))
    .filter((n) => Number.isFinite(n));
  if (stamps.length === 0) return undefined;
  const age = Date.now() - Math.min(...stamps);
  if (age < 24 * 60 * 60 * 1000) return undefined;
  return formatDuration(age);
}

/**
 * Strip common AI tells from the response.
 * Belt-and-suspenders: the system prompt already forbids these, but
 * we clean them post-hoc just in case.
 */
function cleanReply(text: string): string {
  let cleaned = text.trim();

  // Remove wrapping quotes if Claude wrapped the whole thing in quotes
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  // Remove "Response:" or similar prefixes
  cleaned = cleaned.replace(/^(response|reply|message|here'?s? (your |a |my )?(reply|response|message)):\s*/i, "");

  // Replace em-dashes with regular dashes (em-dashes are AI giveaway)
  cleaned = cleaned.replace(/—/g, "-");

  // Replace en-dashes with regular dashes too
  cleaned = cleaned.replace(/–/g, "-");

  // Smart quotes → straight quotes
  cleaned = cleaned.replace(/[\u2018\u2019]/g, "'");
  cleaned = cleaned.replace(/[\u201C\u201D]/g, '"');

  return cleaned;
}

/**
 * Hard cap on how long any single bubble can be. The model is told to keep
 * messages short, but this is the code-level guarantee — no bubble ever ships
 * longer than this, no matter what the model produces.
 */
const MAX_WORDS_PER_BUBBLE = 20;

/**
 * Split the reply into individual bubbles.
 *
 * Splits on BOTH the explicit [[SPLIT]] token AND on line breaks, because the
 * model frequently separates its thoughts with blank lines instead of the
 * token. Either signal produces a new bubble — so the AI can't ship a wall of
 * text even if it ignores the [[SPLIT]] instruction.
 *
 * Then every resulting bubble is run through a 20-word cap (enforceMaxWords) so
 * nothing is ever longer than MAX_WORDS_PER_BUBBLE.
 */
export function splitReply(text: string): string[] {
  // Split on the explicit [[SPLIT]] token first. A message the model marked as a
  // VOICE note (starts with [[VOICE]]) is kept WHOLE — one spoken clip is never
  // word-capped or line-split. Everything else keeps the legacy behaviour:
  // split on line breaks too, then enforce the per-bubble word cap.
  const parts = text
    .split(/\[\[SPLIT\]\]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const segments: string[] = [];
  for (const part of parts) {
    if (/^\s*\[\[VOICE\]\]/i.test(part)) {
      segments.push(part); // marker preserved; sent as a single voice clip downstream
      continue;
    }
    for (const seg of part.split(/\n+/).map((s) => s.trim()).filter(Boolean)) {
      segments.push(...enforceMaxWords(seg, MAX_WORDS_PER_BUBBLE));
    }
  }
  return segments;
}

/** Count words in a string. */
function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Ensure no bubble exceeds maxWords. If a segment is too long, break it at
 * natural clause boundaries (sentence-enders and commas), greedily packing
 * clauses up to the limit so the bubbles still read like a human texting. If a
 * single clause is itself longer than the cap, it's hard-split by word count as
 * a last resort.
 */
function enforceMaxWords(segment: string, maxWords: number): string[] {
  if (wordCount(segment) <= maxWords) return [segment];

  const clauses = (segment.match(/[^.!?,]+[.!?,]*/g) || [segment])
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const bubbles: string[] = [];
  let current: string[] = [];
  let currentWords = 0;

  const flush = () => {
    if (current.length > 0) {
      bubbles.push(current.join(" "));
      current = [];
      currentWords = 0;
    }
  };

  for (const clause of clauses) {
    const cWords = wordCount(clause);

    // Clause alone is over the cap — flush what we have, then hard-split it.
    if (cWords > maxWords) {
      flush();
      const words = clause.split(/\s+/);
      for (let i = 0; i < words.length; i += maxWords) {
        bubbles.push(words.slice(i, i + maxWords).join(" "));
      }
      continue;
    }

    if (currentWords + cWords > maxWords) flush();
    current.push(clause);
    currentWords += cWords;
  }
  flush();

  // Drop trailing commas left over from clause splitting so bubbles look clean.
  return bubbles
    .map((b) => b.replace(/[,\s]+$/, "").trim())
    .filter((b) => b.length > 0);
}

/**
 * Calculate a realistic typing delay for a message.
 * Based on average human typing speed (~40 wpm = ~200 chars/min = ~3 chars/sec).
 * Capped at 8 seconds max so the lead doesn't bounce.
 */
export function calculateTypingDelay(messageText: string): number {
  const chars = messageText.length;
  const baseDelay = 800;                  // 0.8s minimum "reading the message" delay
  const typingDelay = (chars / 3) * 1000; // ~3 chars/sec typing speed
  const total = baseDelay + typingDelay;
  return Math.min(total, 8000);           // cap at 8s
}
