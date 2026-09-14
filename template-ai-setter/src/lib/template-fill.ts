/**
 * FILLING IN THE OWNER'S WORDS. Not writing new ones.
 *
 * The owner, 2026-08-04, on what the OS should do with a conversation:
 *
 *     "it doesn't need to be connected, so it sends messages. But what it can do
 *      is draft messages, give them to the client and say, okay. This guy just
 *      replied this. Like, go message him... Here is a drafted message you can
 *      send to him based on the conversation I just read."
 *
 * The whole difficulty is that a drafted DM is a script, and Law 1 forbids the
 * agent from producing scripts. Both are right, and the way through is this: the
 * WORDS are the owner's, written once as a template. The only thing generated is
 * whose name goes in the gap.
 *
 * So this is deliberately dumb. No model, no paraphrase, no "improving" the
 * wording, no inventing a value that was not given. It is string substitution and
 * nothing else, and it stays that way: the moment it starts composing, the drafts
 * become the agent's opinion wearing the owner's name.
 *
 * A placeholder with no value is REFUSED, not guessed and not left as {{name}}.
 * A student who copies "hey {{first_name}}, saw your post" into a real DM has been
 * embarrassed by their own tooling, and a draft that silently drops a gap says
 * something the owner never wrote. Refusing costs one question; both alternatives cost
 * trust.
 */

/** `{{ first_name }}` - whitespace tolerated, since the owner types these by hand. */
const TOKEN = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

export type FillResult =
  | { ok: true; text: string; used: string[] }
  | { ok: false; missing: string[] };

/** Every placeholder a template asks for, in order, without duplicates. */
export function placeholdersIn(body: string): string[] {
  const out: string[] = [];
  for (const m of String(body || "").matchAll(TOKEN)) {
    const k = m[1].toLowerCase();
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * Fill a template from known values, or say which ones are missing.
 *
 * A value counts as known only if it is a non-empty string after trimming. null,
 * undefined, "" and "   " are all "we do not know this", because a template filled
 * with an empty string reads as finished while saying something else entirely.
 */
export function fillTemplate(body: string, values: Record<string, unknown>): FillResult {
  const known = new Map<string, string>();
  for (const [k, v] of Object.entries(values || {})) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) known.set(k.toLowerCase(), s);
  }
  const missing = placeholdersIn(body).filter((k) => !known.has(k));
  if (missing.length) return { ok: false, missing };
  const used: string[] = [];
  const text = String(body || "").replace(TOKEN, (_m, raw: string) => {
    const k = raw.toLowerCase();
    if (!used.includes(k)) used.push(k);
    return known.get(k)!;
  });
  return { ok: true, text, used };
}

/**
 * The values a draft may be built from, taken from what is already WRITTEN DOWN
 * about a lead. Nothing here is inferred: `first_name` is the first word of the
 * name they typed, not a guess at what someone likes to be called, and a lead
 * with no name simply has no first_name.
 *
 * Kept small on purpose. Every key added here is a new way for a template to say
 * something about a person that nobody checked.
 */
export type LeadLike = {
  name?: string | null; contact_name?: string | null; handle?: string | null;
  notes?: string | null; next_step?: string | null;
};

export function valuesFromLead(lead: LeadLike, extra?: Record<string, unknown>): Record<string, unknown> {
  const person = (lead.contact_name || lead.name || "").trim();
  return {
    name: lead.name || "",
    // The person's own name, where the lead row carries both a business and a
    // contact. Writing "hey Acme Roofing" into a DM is the tell that a human is
    // not on the other end.
    contact_name: person,
    first_name: person.split(/\s+/)[0] || "",
    handle: lead.handle || "",
    next_step: lead.next_step || "",
    ...(extra || {}),
  };
}

/**
 * WHICH TEMPLATE, given where this person is.
 *
 * Law 2 says never guess when two things could fit, and that applies here more
 * than anywhere: the wrong template is a message sent to a real person. So this
 * returns EVERY template at the best matching tier, not a winner. One result means
 * the agent can draft; several mean it asks which; none means it says so.
 *
 * Tiers, most specific first. A template that names both the stage and the channel
 * beats one that names only the stage, which beats one that names nothing - and a
 * template that names a DIFFERENT stage or channel is not a candidate at all,
 * however few others there are.
 */
export type TemplateLike = {
  slug: string; title: string; body: string;
  channel?: string | null; stage?: string | null;
};

export function pickTemplates(
  templates: TemplateLike[],
  want: { stage?: string | null; channel?: string | null },
): TemplateLike[] {
  const stage = (want.stage || "").trim().toLowerCase();
  const channel = (want.channel || "").trim().toLowerCase();
  const fits = (t: TemplateLike) => {
    const ts = (t.stage || "").trim().toLowerCase();
    const tc = (t.channel || "").trim().toLowerCase();
    // A template pinned to a stage is out if we know a different stage. If we do
    // NOT know the stage, a pinned template is still a candidate: the student can
    // be asked, which is better than silently hiding the only right answer.
    if (ts && stage && ts !== stage) return false;
    if (tc && channel && tc !== channel) return false;
    return true;
  };
  const score = (t: TemplateLike) =>
    (t.stage && stage && t.stage.toLowerCase() === stage ? 2 : 0) +
    (t.channel && channel && t.channel.toLowerCase() === channel ? 1 : 0);

  const usable = templates.filter(fits);
  if (!usable.length) return [];
  const best = Math.max(...usable.map(score));
  return usable.filter((t) => score(t) === best);
}
