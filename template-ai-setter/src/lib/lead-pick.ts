/**
 * WHICH ONE HE MEANS.
 *
 * The lead search is an ilike over full_name / ig_username capped at five rows.
 * HQ used to take rows[0] - the most recently active of those five - and act on
 * it: switch the AI off, send a DM, ban them. No word to the owner that there were
 * four other people it could equally have been. That is how a stranger gets
 * switched off and the person he meant keeps getting messaged.
 *
 * This is the decision, split out from the route so it can be tested against
 * the shapes that actually occur: shared first names, a name that is a prefix
 * of another, ManyChat leads with no handle at all.
 *
 * Deliberately the same rule as the Telegram side (_rank_matches in
 * telegram_bot/setter_control.py) so both surfaces pick the same person from
 * the same words.
 */

export interface PickableLead {
  full_name?: string | null;
  ig_username?: string | null;
}

export interface Pick<T> {
  lead: T | null;
  /** true = several people fit and NOBODY should be acted on. */
  ambiguous: boolean;
}

function norm(s: string | null | undefined): string {
  return String(s || "").trim().replace(/^@/, "").toLowerCase();
}

/**
 * @param rows  candidates, best-first (the caller orders by last_message_at)
 * @param query the words the owner used
 */
export function pickLead<T extends PickableLead>(rows: T[], query: string): Pick<T> {
  const list = rows || [];
  if (list.length === 0) return { lead: null, ambiguous: false };
  if (list.length === 1) return { lead: list[0], ambiguous: false };

  // AN EXACT NAME OR HANDLE WINS OUTRIGHT, even against more recent loose
  // matches. "Oscar" must still resolve when an "Oscar Nilsson-Berg" also
  // matches the ilike, or naming someone precisely would get harder the more
  // leads exist.
  const needle = norm(query);
  const exact = list.filter(
    (r) => norm(r.full_name) === needle || norm(r.ig_username) === needle
  );
  if (exact.length === 1) return { lead: exact[0], ambiguous: false };

  // Two people who genuinely answer to the same words, or a partial that fits
  // several. Either way the honest answer is "which one" - never a guess.
  return { lead: null, ambiguous: true };
}
