/**
 * THE LEAD'S OWN OFF SWITCH.
 *
 * The owner has one. The lead did not. "stop messaging me", "unsubscribe", "leave
 * me alone" and "fuck off" all got a cheerful question back and the setter
 * carried on - through the reply, then the follow-ups, then nurture. Nothing
 * anywhere in the inbound path looked for it.
 *
 * That is not only rude, it is the fastest way to lose the Instagram account
 * the whole business runs on: continuing to DM someone who told you to stop is
 * what gets an account reported, then restricted.
 *
 * Deterministic on purpose. No model call, so it works when the API is down or
 * out of credits - the same reasoning as the Telegram kill switch.
 *
 * THREE TIERS, because a false positive silences a real lead and nobody ever
 * finds out:
 *
 *   HARD  - phrases that cannot mean anything else ("unsubscribe", "stop
 *           messaging me"). Matched anywhere, at any length.
 *   EXACT - words that are an opt-out only when they are the ENTIRE message.
 *           "stop" is the reason this tier exists: as a looser rule it silenced
 *           "i cant stop thinking about it".
 *   SOFT  - phrases that are an opt-out only when the message ENDS on them.
 *           "not interested" is the whole answer; "not interested in
 *           dropshipping but I do want to start something online" is a live
 *           lead telling us what he DOES want.
 *
 * Kept pure and dependency-free so every phrase can be tested without a
 * database, a model, or a network.
 */

/** Past this many characters, a SOFT phrase is a sentence inside a longer
 *  thought, not the whole message. Sized off real opt-outs: "sorry man not
 *  interested" is 24 characters, "please stop messaging me" is 24. */
export const SOFT_OPT_OUT_MAX_CHARS = 80;

/** Unambiguous in any message, at any length. */
const HARD_PHRASES = [
  "unsubscribe",
  "stop messaging me", "stop messaging", "stop texting me", "stop texting",
  "stop dming me", "stop dm ing me", "stop sending me",
  "quit messaging me", "quit texting me",
  "dont message me again", "don t message me again",
  "dont contact me", "don t contact me", "do not contact me",
  "dont text me again", "don t text me again",
  "leave me alone", "leave me be",
  "remove me from", "take me off your",
  "fuck off", "fuck outta here", "piss off",
  "im reporting you", "i m reporting you", "reporting you for spam",
  "this is spam", "youre spamming", "you re spamming", "stop spamming",
  "blocking you", "im blocking you", "i m blocking you",
  // Swedish - a real share of the audience, and an opt-out in the wrong
  // language is an opt-out we ignored.
  "sluta skicka", "sluta messa", "sluta skriva till mig",
  "lamna mig ifred", "ta bort mig",
];

/**
 * Only an opt-out when the message is nothing BUT this phrase.
 *
 * "stop" is the reason this tier exists. As a short-message rule it silenced
 * "i cant stop thinking about it" and "my boss wont stop calling me on my day
 * off which is why i want out" - two of the most on-ICP sentences a lead could
 * possibly send. A bare "STOP" is still the universal opt-out word, so it stays,
 * but only when it IS the whole message.
 */
const EXACT_PHRASES = [
  "stop", "stop it", "stopp",
  "go away", "leave it",
  "no thanks", "no thank you", "nah im good", "nah i m good", "im good thanks",
  "nej tack", "sluta",
];

/**
 * Only an opt-out when the message ENDS on it - nothing substantive follows.
 *
 * "not interested" is the whole answer. "not interested in dropshipping but I
 * do want to start something online this year" is a live lead telling us what
 * they DO want, and silencing him is the most expensive mistake this file can
 * make. A length cap alone could not separate them (that sentence is 79
 * characters), so the rule is about what comes AFTER the phrase, not how long
 * the message is.
 */
const SOFT_PHRASES = [
  "not interested",
  "inte intresserad",
];

/** Words that can trail a refusal without changing it into something else. */
const TRAILING_FILLER = new Set([
  "thanks", "thank", "you", "thx", "ty", "tho", "though", "sorry", "man",
  "bro", "brother", "bruv", "mate", "dude", "sry", "but", "no", "not",
  "really", "at", "all", "right", "now", "anymore", "any", "more", "sadly",
  "unfortunately", "tack", "tyvarr", "just", "nope", "nah",
  "anyway", "anyways", "either", "for", "me", "ok", "okay", "cheers", "peace",
]);

/** Normalize for matching: lowercase, strip punctuation and emoji, collapse
 *  whitespace. Apostrophes become spaces so "don't" and "dont" both match the
 *  same phrase list. */
export function normalizeForOptOut(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[‘’']/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface OptOutVerdict {
  /** true = the lead asked us to stop. */
  optOut: boolean;
  /** Which phrase matched, for the event log and for auditing false positives. */
  phrase?: string;
  tier?: "hard" | "exact" | "soft";
}

/**
 * Did this lead just tell us to stop?
 *
 * Conservative by construction: a SOFT phrase in a long message is NOT an
 * opt-out, and a HARD phrase is one everywhere. When it is wrong it should be
 * wrong in the direction of "kept talking to someone who was fine", which the
 * owner can see and correct, rather than "silenced a buyer", which he cannot.
 */
export function detectOptOut(text: string): OptOutVerdict {
  const norm = normalizeForOptOut(text);
  if (!norm) return { optOut: false };

  for (const p of HARD_PHRASES) {
    if (norm.includes(p)) return { optOut: true, phrase: p, tier: "hard" };
  }

  if (EXACT_PHRASES.includes(norm)) return { optOut: true, phrase: norm, tier: "exact" };

  if (norm.length <= SOFT_OPT_OUT_MAX_CHARS) {
    for (const p of SOFT_PHRASES) {
      const idx = norm.indexOf(p);
      // Whole-word start, so a phrase never fires from inside another word.
      if (idx < 0) continue;
      if (idx > 0 && norm[idx - 1] !== " ") continue;
      const after = norm.slice(idx + p.length).trim();
      const substantive = after.split(" ").filter((w) => w && !TRAILING_FILLER.has(w));
      if (substantive.length === 0) return { optOut: true, phrase: p, tier: "soft" };
    }
  }

  return { optOut: false };
}
