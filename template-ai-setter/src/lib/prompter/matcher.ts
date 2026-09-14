/**
 * PROMPTER — voice-follow matcher (pure logic, no browser APIs)
 *
 * The prompter listens to speech recognition output and needs to answer one
 * question continuously: "which word of the script did the speaker just say?"
 *
 * Design rules (all enforced here, unit-tested in scripts/prompter-matcher-check.ts):
 *   - NEVER move backward: re-reading an earlier line must not yank the view up.
 *   - BOUNDED jumps: the pointer can only advance within a small look-ahead
 *     window, so a phrase that also appears much later in the script can't
 *     teleport the view.
 *   - AD-LIB tolerant: off-script speech scores low and leaves the pointer
 *     parked; the moment on-script words return, the pointer snaps to them.
 *   - RECOGNITION-ERROR tolerant: a partially garbled transcript still
 *     advances as long as most words line up (LCS-based scoring).
 */

export interface ScriptModule {
  label: string;
  text: string;
  est_seconds?: number;
}

export interface ScriptToken {
  /** normalized word used for matching */
  word: string;
  /** raw word as displayed (original casing/punctuation) */
  display: string;
  /** which module this token belongs to */
  moduleIndex: number;
  /**
   * Line breaks in the source text immediately before this word, within its
   * module:
   *   0  → continues the current line
   *   1  → starts a new line
   *   2+ → starts a new paragraph (a blank line in the source)
   * Lets the prompter mirror the writer's paragraph structure instead of
   * flattening everything into one run-on block. Always 0 for a module's
   * first word.
   */
  breakBefore: number;
}

/** Lowercase, strip everything except letters/digits. "Don't!" -> "dont" */
export function normalizeWord(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9åäö]/g, "");
}

/** Split free text into normalized, non-empty spoken words. */
export function normalizeWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeWord)
    .filter((w) => w.length > 0);
}

/**
 * Turn the script modules into a flat token stream for matching + rendering.
 * Tokens keep their display form so the UI can render the original text.
 */
export function tokenizeScript(modules: ScriptModule[]): ScriptToken[] {
  const tokens: ScriptToken[] = [];
  modules.forEach((mod, moduleIndex) => {
    // Walk line by line so the writer's line/paragraph breaks survive into the
    // rendered prompter. Within a line we split on spaces/tabs only — newlines
    // are structure to keep, not word separators.
    const lines = mod.text.split(/\r?\n/);
    let pendingBreaks = 0; // newlines seen since the last emitted word
    let firstOfModule = true;
    lines.forEach((line, li) => {
      if (li > 0) pendingBreaks += 1;
      for (const raw of line.split(/[ \t]+/)) {
        const word = normalizeWord(raw);
        if (word.length === 0) continue;
        tokens.push({
          word,
          display: raw,
          moduleIndex,
          breakBefore: firstOfModule ? 0 : pendingBreaks,
        });
        pendingBreaks = 0;
        firstOfModule = false;
      }
    });
  });
  return tokens;
}

/** Length of the longest common subsequence of two short word arrays. */
function lcsLength(a: string[], b: string[]): number {
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

export interface AdvanceOptions {
  /** how many script words ahead of the pointer we are willing to look */
  maxAhead?: number;
  /** how many trailing spoken words to align against */
  tailSize?: number;
  /** hardest cap on how far the pointer may move in a single update */
  maxStep?: number;
  /** score penalty per word of distance from the current pointer */
  proximityPenalty?: number;
}

/**
 * Given the script's normalized words, the current pointer (index of the NEXT
 * word to be spoken) and the recently spoken words, return the new pointer.
 *
 * Tuned to advance smoothly, roughly one word at a time:
 *   - small look-ahead window (a common word repeated later can't pull the
 *     view far forward)
 *   - a distance penalty so the NEAREST matching position wins, not the
 *     furthest one with the same overlap
 *   - a hard per-update step cap so even a strong far match can only nudge;
 *     subsequent updates keep it in sync
 *
 * Returns the same pointer when nothing convincing matched.
 */
export function advancePointer(
  scriptWords: string[],
  pointer: number,
  spokenWords: string[],
  opts: AdvanceOptions = {}
): number {
  const maxAhead = opts.maxAhead ?? 10;
  const tailSize = opts.tailSize ?? 6;
  const maxStep = opts.maxStep ?? 6;
  const proximityPenalty = opts.proximityPenalty ?? 0.2;

  if (pointer >= scriptWords.length || spokenWords.length === 0) return pointer;

  const tail = spokenWords.slice(-tailSize);
  const lastWord = tail[tail.length - 1];
  const windowEnd = Math.min(scriptWords.length, pointer + maxAhead);

  let bestPointer = pointer;
  let bestScore = 0;

  // Anchor on the NEWEST spoken word: only positions where the script word
  // equals the word just spoken are candidates. This is what makes ad-libs
  // (and a misheard final word) hold position instead of drifting — the
  // trailing context alone can no longer push the pointer forward.
  for (let c = pointer; c < windowEnd; c++) {
    if (scriptWords[c] !== lastWord) continue;
    const sliceStart = Math.max(0, c + 1 - tail.length);
    const slice = scriptWords.slice(sliceStart, c + 1);
    // LCS includes the lastWord match (≥1) plus any surrounding context.
    let score = lcsLength(tail, slice);
    // prefer the closest qualifying position — stops the pointer from leaping
    // rows when a common word recurs further ahead
    score -= (c - pointer) * proximityPenalty;
    // strict > keeps the EARLIEST best candidate on ties
    if (score > bestScore) {
      bestScore = score;
      bestPointer = c + 1;
    }
  }

  // With a short tail (session start) one matched word is enough; once we have
  // context, require the lastWord match PLUS at least one corroborating word so
  // a lone stray common word can't nudge the pointer.
  const needed = tail.length >= 2 ? 2 : 1;
  if (bestScore < needed) return pointer;

  // Never jump more than maxStep words in one update — keeps motion smooth
  // and word-by-word even if a far position scored well.
  bestPointer = Math.min(bestPointer, pointer + maxStep);
  return Math.max(pointer, bestPointer);
}

/** ~150 spoken words per minute. */
export function estimateSeconds(wordCount: number): number {
  return Math.max(5, Math.round(wordCount / 2.5));
}
