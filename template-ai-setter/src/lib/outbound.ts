/**
 * OUTBOUND SAFETY NET — the one scrub that runs before ANYTHING reaches a lead.
 *
 * Used at every lead-facing chokepoint: text (lib/send.ts) AND voice
 * (synthesizeVoice). Strips every internal control token a human must never see
 * or hear — [[SPLIT]], [[VOICE]], any [[...]] marker, {{...}} template vars, and
 * {ALLCAPS} placeholders ({TRACKED_LINK}…) — then tidies the leftover whitespace
 * so the line still reads/speaks naturally.
 *
 * This is the guarantee that the "[[SPLIT]] leaked into a real DM" class of bug
 * can never happen again, no matter which flow (reply, follow-up, nurture, voice,
 * or anything added later) produced the text. Pure + unit-tested.
 */
export function scrubOutboundText(text: string): string {
  if (!text) return text;
  let t = text
    // 1) Internal control tokens — must NEVER reach a human.
    .replace(/<\/?(?:thinking|antml:thinking)>/gi, " ") // leaked reasoning tags (model internals)
    .replace(/\[\[[^\]]*\]\]/g, " ")            // any [[...]] internal marker ([[SPLIT]], [[VOICE]]…)
    .replace(/\{\{[^}]*\}\}/g, " ")              // any {{...}} unfilled template var
    .replace(/\{[A-Z][A-Z0-9_]{2,}\}/g, " ")     // {TRACKED_LINK}/{FIRST_NAME}-style placeholders
    // 2) Leftover single-bracket template placeholders (high-confidence only, so
    //    real prose like "[laughs]" is left alone).
    .replace(/\[(?:insert|your)\b[^\]]*\]/gi, " ")  // [insert link], [your name]
    .replace(/\[[^\]]*\bhere\]/gi, " ")              // [name here], [link here]
    .replace(/\[[A-Z][A-Z0-9_ ]{1,}\]/g, " ")        // [LINK], [FIRST NAME]
    // 3) Markdown formatting that never belongs in a casual DM (strip the markup,
    //    keep the words). Single * / _ are left alone — too easily legit emphasis.
    .replace(/```[\s\S]*?```/g, " ")             // code fences
    .replace(/`([^`]+)`/g, "$1")                  // inline code
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")         // markdown headers
    .replace(/\*\*([^*]+)\*\*/g, "$1")            // **bold**
    .replace(/__([^_]+)__/g, "$1")               // __bold__
    // 4) Pictographic emoji (owner rule, 2026-08-12: "never ever should you
    //    send emojis"). The owner texts in words; every live complaint about tone
    //    involved an emoji the model added on its own - the worst being a
    //    literal dog emoji trailing the side-eye meme. Symbols people type as
    //    punctuation (arrows, dashes) are untouched; this strips the picture
    //    set: emoji presentation, pictographs, transport, flags, skin tones.
    .replace(/[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F900}-\u{1F9FF}\u{2764}\u{2705}\u{274C}\u{2B50}]/gu, " ")
    // 5) AI-tell punctuation (humanizer, owner-approved 2026-08-13). The
    //    mechanical tells are enforced HERE, not just asked for in the prompt:
    //    a numeric range keeps a plain hyphen ("5-10k"), any other em/en dash
    //    or double-hyphen aside becomes a comma beat (the humanizer's own
    //    preference for a tight aside), and curly quotes become the straight
    //    ones a phone keyboard types. Hyphens inside words ("9-5", "co-op")
    //    are untouched.
    .replace(/(\d)\s*[—–]\s*(?=\d)/g, "$1-")
    .replace(/\s*[—–]+\s*/g, ", ")
    .replace(/\s+--+\s+/g, ", ")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"');
  // Tidy the whitespace/punctuation the removals leave behind.
  t = t
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.!?;:])/g, "$1")
    // A dash swap can leave a comma bumping into other punctuation or the
    // edges of the message ("bro, ." / a leading ", hey" / a trailing "bro,").
    .replace(/,\s*([,.!?;:])/g, "$1")
    .replace(/^[,;]\s*/, "")
    .replace(/[,;]+\s*$/, "")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t;
}

/**
 * INTERNAL-MESSAGE TRIPWIRE (owner incident 2026-07-30): text that reads like
 * an internal notification, a model refusal, or an AI self-reference must
 * NEVER be sent to a lead. Live case: the ack model refused ("I need to pause
 * here. This message (...) appears to be inappropriate or a test of my
 * boundaries.") and that refusal was DELIVERED to the lead's Instagram. The
 * owner's rule is absolute: what the system says to HIM (Telegram pings,
 * status notes, deliberation) can never reach a lead.
 *
 * Deliberately conservative: every pattern here is something the setter has
 * no legitimate reason to say in a DM, so a false positive is near-impossible
 * while a true positive is a disaster averted. Pure + unit-testable.
 */
const INTERNAL_META_PATTERNS: RegExp[] = [
  // Emoji markers used exclusively by owner-facing Telegram pings. NOTE: only
  // single-code-point emoji may sit in this class — a composed emoji like ⚠️
  // (U+26A0 + U+FE0F) would add the variation selector U+FE0F as a STANDALONE
  // member and every ❤️/☝️-style emoji in a normal reply would match. The
  // warning sign is therefore its bare code point.
  /[🆘🚨🛑🐳📣📊📡⚠]/u,
  // The internal ping format ("Them: "..." / Setter: "..." / I said: "...").
  /\b(?:Them|Setter|I said|Setter tried):\s*["“]/,
  // CRM/system surfaces a lead must never hear about. (NOT bare "Telegram" /
  // "ManyChat" words — a lead can legitimately bring those up in conversation
  // and the reply may need to echo them; the ping-format patterns above are
  // what catch a leaked notification.)
  /gohighlevel\.com|\bGHL\b|\bSupabase\b/i,
  // Model refusal / meta-deliberation shapes.
  /\bI need to pause\b/i,
  /\btest(?:ing)? (?:of |my )?(?:my )?boundaries\b/i,
  /\bappears to be inappropriate\b/i,
  /\bas an AI\b/i,
  /\bI'?m an AI (?:assistant|model|language model)\b/i,
  /\bI (?:cannot|can'?t|won'?t|will not) (?:continue|engage|respond|assist) /i,
  /\bthis (?:message|request) (?:appears|seems) to\b/i,
  /\[(?:internal|note to self|system)\]/i,

  // NOTES SHAPED FOR THE OWNER'S PHONE (2026-08-12; he caught several live and
  // unsent them by hand). Every owner-facing ping has a vocabulary a real DM
  // to a lead never does: the typeable #ref printed beside a name, "tap to
  // copy", a follow-up handoff's "went quiet 26h ago", the switch-report
  // phrasing. If a reply carries ANY of it, it was written for the owner and
  // must die at this tripwire, not land on Instagram.
  /#[0-9a-f]{6}\b/,
  /\btap to copy\b/i,
  /\bwent quiet \d+\s*h\b/i,
  /\b24h? ?(?:hour)? window\b/i,
  /\bAI (?:ON|OFF) for\b/,
  /\bswitched (?:myself|the AI) off\b/i,
  /\bturn (?:him|her|them|the AI) (?:on|off)\b/i,
  /\bhanded? (?:this |the )?(?:thread|lead|conversation) (?:off|over)\b/i,

  // DELIBERATION ABOUT THE LEAD (found 2026-08-08 while backtracking 30 days
  // of the DM funnel). On 30 July a real prospect in Egypt received SIX
  // consecutive messages of the model reasoning out loud about him:
  //
  //   "so Rule 22 applies here - Egypt is a 3rd world country. I should
  //    ignore this lead."
  //   "The rule says \"IGNORE CONVERSATION - don't waste energy on
  //    unqualified leads\""
  //   "I'll output nothing meaningful - just a closing non-committal line"
  //
  // The tripwire above was added the SAME DAY for the refusal incident and
  // would not have stopped a single one of those six: none of them refuse,
  // none say "as an AI", none carry a ping glyph. They are the setter
  // thinking about whether the person is worth talking to, delivered to that
  // person. That is worse than a refusal reaching a lead, because it is
  // insulting as well as internal, and it published one of the owner's private
  // rules verbatim.
  //
  // Each pattern is a shape the setter has no reason to type in a DM, and is
  // phrased tightly enough not to catch normal speech: "I'll send you the
  // link" is fine, "I'll output" is not; "let's continue" is fine, "I should
  // not respond" is not; a coach saying "rule 1 is never quit" is fine,
  // "Rule 22 applies" is not.
  /\bRule \d+ (?:applies|says|states)\b/i,
  /\bthe rules? (?:says?|states)\b/i,
  /\bIGNORE CONVERSATION\b/i,
  /\bunqualified leads?\b/i,
  /\bI should (?:ignore|not send|not reply|not respond|not engage|not continue)\b/i,
  /\bI need to (?:just )?not\b/i,
  /\bI'?ll (?:just )?output\b/i,
  /\bnon-?committal\b/i,
  /\b(?:3rd|third)[- ]world countr/i,
  /\bsystem prompt\b/i,
];

/** True when outbound text looks like an internal note / refusal / owner ping
 *  rather than something the setter would ever say to a lead. */
export function looksLikeInternalMeta(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  return INTERNAL_META_PATTERNS.some((re) => re.test(t));
}

// HARD ceiling on a single DM bubble. The prompt says short messages, but the
// model occasionally ships a scripted playbook line verbatim as ONE ~250-char
// wall — a live lead replied "That was copied and pasted bro way to quick".
// Any bubble over the ceiling is split at sentence boundaries into real
// texting-sized bubbles before sending (see splitLongBubble). Pure + tested.
export const MAX_BUBBLE_CHARS = 160;

/** Split one over-long bubble at sentence boundaries (then spaces as a last
 *  resort) into chunks of at most MAX_BUBBLE_CHARS. Never splits mid-token,
 *  so links always survive intact. */
export function splitLongBubble(text: string): string[] {
  const t = text.trim();
  if (t.length <= MAX_BUBBLE_CHARS) return [t];
  // Sentence-ish pieces: keep each ender with its sentence. Newlines split too.
  const pieces = t.split(/(?<=[.!?])\s+|\n+/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (let piece of pieces) {
    // A single sentence longer than the cap: break it at the last space/comma
    // before the limit (never inside a word or URL).
    while (piece.length > MAX_BUBBLE_CHARS) {
      const cut = Math.max(
        piece.lastIndexOf(", ", MAX_BUBBLE_CHARS),
        piece.lastIndexOf(" ", MAX_BUBBLE_CHARS)
      );
      if (cut <= 0) break; // unbreakable token (e.g. one huge URL) — send as-is
      flush();
      out.push(piece.slice(0, cut + 1).trim());
      piece = piece.slice(cut + 1).trim();
    }
    if ((cur ? cur.length + 1 : 0) + piece.length > MAX_BUBBLE_CHARS) flush();
    cur = cur ? `${cur} ${piece}` : piece;
  }
  flush();
  return out.length ? out : [t];
}
