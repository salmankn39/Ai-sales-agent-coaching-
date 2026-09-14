/**
 * ADDING A PERSON, FROM SOMETHING THE STUDENT SAID.
 *
 * The reason there were zero people in anybody's CRM: Jarvis could update a lead
 * and move a lead, but there was no way to CREATE one. A student saying "spoke to
 * Dan today, he wants a call Thursday" got sympathy and nothing else, because the
 * only route in was typing the person into a form on the CRM tab, and nobody does
 * that. Seven students, 341 messages, zero leads.
 *
 * So the agent can add people now. The two things that decide whether that is a
 * feature or a mess:
 *
 * 1. IT MUST NOT MAKE A SECOND DAN. Students say a first name and say it often.
 *    Three "Dan"s in a CRM is worse than no Dan at all, because now the follow-up
 *    is on the wrong card and the student stops trusting the board. `findExisting`
 *    below is what stops that, and it errs towards "this is the same person" only
 *    when the match is unambiguous.
 *
 * 2. IT MUST NOT INVENT A PERSON. A name is required and comes from what they
 *    actually said. "spoke to a guy about the offer" creates nobody: the agent asks
 *    who, which costs one question and is the difference between a CRM and a pile
 *    of ghosts.
 *
 * Pure, so both rules can be tested rather than trusted by eye.
 */

export type ExistingLead = { id: number; name: string; handle?: string | null };

/** Lowercase, strip punctuation and @, collapse spaces. "Dan W." -> "dan w" */
export function normalizeName(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/[@._]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type MatchResult =
  /** Unambiguously the same person. Update them, do not create a second card. */
  | { kind: "same"; lead: ExistingLead }
  /** Could be one of several. Ask which, never pick (Law 2). */
  | { kind: "ambiguous"; leads: ExistingLead[] }
  /** Nobody like this yet. Safe to create. */
  | { kind: "new" };

/**
 * Is this somebody the student already has?
 *
 * Exact normalized name, or a handle match, is the same person. A FIRST NAME that
 * matches exactly one existing person is also the same person, because "Dan" said
 * out loud almost always means the Dan already on the board. A first name matching
 * two people is the one case that must ask: guessing there puts a real
 * conversation on the wrong person's card, and nobody would ever notice.
 */
export function findExisting(name: string, handle: string | null | undefined, existing: ExistingLead[]): MatchResult {
  const n = normalizeName(name);
  if (!n) return { kind: "new" };

  const h = normalizeName(handle || "");
  if (h) {
    const byHandle = existing.filter((l) => normalizeName(l.handle || "") === h);
    if (byHandle.length === 1) return { kind: "same", lead: byHandle[0] };
    if (byHandle.length > 1) return { kind: "ambiguous", leads: byHandle };
  }

  const exact = existing.filter((l) => normalizeName(l.name) === n);
  if (exact.length === 1) return { kind: "same", lead: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", leads: exact };

  // One word said out loud: match it against the first word of each existing name.
  // Only when the spoken name is a single word - "Dan Whelan" not matching "Dan
  // Murphy" is correct, and treating it as the same person would be a real error.
  if (!n.includes(" ")) {
    const byFirst = existing.filter((l) => normalizeName(l.name).split(" ")[0] === n);
    if (byFirst.length === 1) return { kind: "same", lead: byFirst[0] };
    if (byFirst.length > 1) return { kind: "ambiguous", leads: byFirst };
  }

  return { kind: "new" };
}

/**
 * Names pulled out of a pasted list, one per line or comma separated.
 *
 * Deliberately does no cleverness beyond splitting and trimming: a list is a list,
 * and a parser that tries to understand it will one day decide a line is a note
 * rather than a person. Blank lines, duplicates within the paste, and anything
 * longer than a name are dropped, with the count returned so the student is told
 * what was ignored rather than silently losing four of their twenty.
 */
export function parseNameList(raw: string, max = 200): { names: string[]; skipped: number } {
  const parts = String(raw || "")
    .split(/[\n,;]+/)
    .map((p) => p.replace(/^\s*[-*\d.)\]]+\s*/, "").trim())   // strip bullets and "1." numbering
    .filter(Boolean);
  const seen = new Set<string>();
  const names: string[] = [];
  let skipped = 0;
  for (const p of parts) {
    // A "name" over 120 chars is a sentence somebody pasted by accident.
    if (p.length > 120) { skipped++; continue; }
    const key = normalizeName(p);
    if (!key) { skipped++; continue; }
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    names.push(p);
    if (names.length >= max) break;
  }
  return { names, skipped };
}
