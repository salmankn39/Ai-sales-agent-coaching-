/**
 * ============================================================================
 * ANTI-REPEAT (duplicate-reply guard)
 * ============================================================================
 * Pure helpers used by the webhook before sending a generated reply: they
 * decide whether the fresh reply is essentially a REPEAT of something the
 * setter already said (e.g. re-asking a question the lead just answered). The
 * webhook regenerates once with a "don't repeat" directive when this fires, and
 * suppresses the message entirely if it's still a duplicate.
 *
 * Kept dependency-free and pure so it's unit-testable without the DB/model
 * (see scripts/dedup-cases.ts).
 * ============================================================================
 */

/**
 * Normalize a bubble for near-duplicate comparison: lowercase, strip
 * punctuation/emoji, collapse whitespace. Keeps letters (incl. Swedish å/ä/ö
 * and other Unicode letters) and digits so Swedish replies compare correctly.
 */
export function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Distinct word set of a normalized bubble. */
function wordSet(s: string): Set<string> {
  return new Set(normalizeForCompare(s).split(" ").filter(Boolean));
}

/**
 * Overlap coefficient (Szymkiewicz–Simpson): shared words ÷ the SMALLER word
 * set (0..1). Chosen over Jaccard because a re-asked question is often reworded
 * with a different lead-in ("so what would you say is..." vs "what's...") — the
 * differing prefixes drag Jaccard down, but the shared core question still makes
 * the overlap near 1. Genuinely different funnel questions stay well below the
 * threshold, so this separates true repeats from real next-step questions.
 */
export function wordOverlap(a: string, b: string): number {
  const A = wordSet(a);
  const B = wordSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** Minimum word count for a bubble to be eligible for repeat-checking. Short
 *  acks ("nice nice", "okej", "ja hör dig bror") are below this and are never
 *  flagged, so the guard only ever catches substantive repeats (questions). */
export const MIN_WORDS_FOR_REPEAT_CHECK = 4;

/** Overlap at or above this counts as the "same" bubble (reworded repeat). */
export const REPEAT_SIMILARITY_THRESHOLD = 0.8;

// ---------------------------------------------------------------------------
// QUESTION-CORE comparison (added 2026-08-08 after the Asyah/Oliver repeats).
// The word-overlap rule missed the most damaging repeat class: the SAME
// question re-asked with different filler. "where you based bro?" vs
// "tell me a bit about yourself, where you based?" scores 0.75 — under the
// 0.8 threshold — yet reads as an obvious repeat to the lead (it was asked
// FIVE times in one live thread). So questions get their own check: strip the
// texting filler, compare only what the question actually asks.
// ---------------------------------------------------------------------------

/** Texting filler that carries no meaning for "is this the same question". */
const QUESTION_FILLER = new Set([
  "bro", "brother", "brotha", "bror", "brorsan", "man", "dude", "bru",
  "haha", "hahaha", "lol", "hey", "yo", "btw", "tho", "though", "rn",
  "these", "days", "just", "like", "so", "okay", "ok", "anyway",
]);

/** Overlap for question cores: lower than the general threshold because the
 *  filler is already stripped, so what's left IS the question. */
export const QUESTION_CORE_SIMILARITY_THRESHOLD = 0.7;

/** Minimum core size (words) before the question rule may fire — a 1-2 word
 *  core ("you good?") is too generic to call a repeat on. */
const MIN_QUESTION_CORE_WORDS = 3;

/** The de-filled word set of a bubble, if that bubble asks a question. */
function questionCore(s: string): Set<string> | null {
  if (!s.includes("?")) return null;
  const words = normalizeForCompare(s)
    .split(" ")
    .filter((w) => w && !QUESTION_FILLER.has(w));
  return new Set(words);
}

/** Are these two bubbles asking essentially the same question? */
export function isSameQuestion(a: string, b: string): boolean {
  const A = questionCore(a);
  const B = questionCore(b);
  if (!A || !B) return false;
  if (Math.min(A.size, B.size) < MIN_QUESTION_CORE_WORDS) return false;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size) >= QUESTION_CORE_SIMILARITY_THRESHOLD;
}

/**
 * Is the freshly generated reply essentially a repeat of one we already sent?
 * Each substantive new bubble (>= MIN_WORDS_FOR_REPEAT_CHECK words after
 * normalizing) is compared to our recent AI bubbles; a normalized-equal match,
 * or a word-overlap >= REPEAT_SIMILARITY_THRESHOLD against a prior bubble that
 * is ALSO substantive, counts as a repeat. Deliberately conservative: a false
 * positive would suppress a legitimate reply, so both sides must be real
 * sentences (not short fragments) before the overlap rule can fire.
 */
export function isRepeatReply(
  newSegments: string[],
  priorAiBubbles: string[]
): boolean {
  for (const seg of newSegments) {
    // The question-core rule runs BEFORE the general word floor: a bare
    // re-ask like "where you based?" is only 3 normalized words — under
    // MIN_WORDS_FOR_REPEAT_CHECK — yet it is exactly the live repeat this
    // rule exists for. Its own MIN_QUESTION_CORE_WORDS floor still applies.
    for (const prior of priorAiBubbles) {
      if (isSameQuestion(seg, prior)) return true;
    }
    const norm = normalizeForCompare(seg);
    if (norm.split(" ").filter(Boolean).length < MIN_WORDS_FOR_REPEAT_CHECK) {
      continue; // ignore short acks
    }
    for (const prior of priorAiBubbles) {
      const pn = normalizeForCompare(prior);
      if (!pn) continue;
      if (pn === norm) return true;
      const priorWords = pn.split(" ").filter(Boolean).length;
      if (
        priorWords >= MIN_WORDS_FOR_REPEAT_CHECK &&
        wordOverlap(seg, prior) >= REPEAT_SIMILARITY_THRESHOLD
      ) {
        return true;
      }
    }
  }
  return false;
}
