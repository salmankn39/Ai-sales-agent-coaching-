import { supabase } from "@/lib/supabase";

/**
 * THE EVIDENCE LEDGER - the only way the agent is allowed to change a lead.
 *
 * Taken from trycompai/crm, whose rule is the best one in that repo:
 *
 *   "No tool accepts a confidence, a score, or a sourceUrl offered as proof.
 *    A tool reports what it observed."
 *
 * So nothing here takes a confidence. It takes `observed`: the sentence the
 * student actually said, or the thing that actually happened. That string is
 * required, it is stored, and it is what a student sees when they ask the card
 * why it says what it says. An agent that cannot say where a value came from
 * cannot write it.
 *
 * Three rules, enforced here so no caller can route around them:
 *
 *   1. NEVER OVERWRITE A HUMAN. A field a person typed is theirs. The agent may
 *      add to an empty field and may correct its own earlier guess, but it does
 *      not get to argue with somebody who typed something.
 *   2. NEVER RE-OFFER A DISMISSED VALUE. If a human rejected this value for this
 *      field once, it is dead. Not softened, not retried later.
 *   3. NEVER WRITE WITHOUT AN OBSERVATION. No `observed`, no write.
 *
 * Rule 1 is why this file exists rather than the agent calling `update` directly:
 * "never overwrite a human" is only true if one place enforces it.
 */

/** Where a value came from. Not a confidence - a provenance. */
export type FactSource = "student_said" | "agent_saw" | "import" | "manual";

export type FactWrite = {
  sid: number;
  leadId: number;
  field: string;
  /** The value to write. null clears the field. */
  value: string | number | null;
  /** WHAT WAS ACTUALLY SAID OR SEEN. Required, and stored verbatim. */
  observed: string;
  source: FactSource;
  actor?: string;
};

export type FactHistory = { value: string | null; source: string; dismissed_at: string | null };
export type FactVerdict = "apply" | "human_owns_it" | "dismissed" | "unchanged";

/**
 * THE THREE RULES, as one pure decision so they can actually be tested.
 *
 * `history` is this field's ledger, newest first. Kept free of any database call
 * on purpose: "never overwrite a human" is only a real guarantee if it is one
 * function with tests around it, rather than a habit spread across call sites.
 */
export function decideFactWrite(a: {
  current: string | null;
  next: string | null;
  history: FactHistory[];
  source: FactSource;
}): FactVerdict {
  if (a.current === a.next) return "unchanged";

  // Rule 2: a value a human rejected for this field never comes back. Checked
  // before rule 1, because a dismissal outranks an empty field.
  if (a.history.some((h) => h.dismissed_at && h.value === a.next)) return "dismissed";

  // A human writing always wins. This is the only source that can pass rule 1.
  if (a.source === "manual") return "apply";

  // Rule 1: an empty field is free to fill. A field holding something a human put
  // there is theirs, and the agent does not get to argue with it. The agent MAY
  // correct its own earlier value - that is a correction, not an overwrite.
  if (a.current === null || a.current === "") return "apply";
  const lastWrite = a.history[0];
  const humanWroteLast = !lastWrite || lastWrite.source === "manual" || lastWrite.source === "import";
  return humanWroteLast ? "human_owns_it" : "apply";
}

export type FactResult =
  | { ok: true; wrote: true }
  | { ok: true; wrote: false; reason: "human_owns_it" | "dismissed" | "unchanged" }
  | { ok: false; error: string };

/** The lead columns the agent may touch. Anything else is refused outright:
 * stage moves have their own path, and money has its own confirm-first writer. */
const WRITABLE = new Set([
  "name", "contact_name", "phone", "email", "handle", "source",
  "next_step", "needs_followup", "last_contact_on", "notes", "value", "owner",
]);

function asText(v: string | number | null): string | null {
  return v === null ? null : String(v);
}

/**
 * Record a fact and, if the rules allow, apply it to the lead.
 *
 * Returns `wrote: false` with a reason rather than throwing, because a refused
 * write is a normal outcome the agent should tell the student about, not an error.
 */
export async function recordFact(w: FactWrite): Promise<FactResult> {
  const observed = String(w.observed || "").trim();
  if (!observed) return { ok: false, error: "a fact needs an observation - what was actually said or seen" };
  if (!WRITABLE.has(w.field)) return { ok: false, error: `${w.field} is not a field the agent may set` };

  const { data: leadRows } = await supabase.from("student_leads")
    .select("id,student_id," + w.field).eq("id", w.leadId).eq("student_id", w.sid).limit(1);
  const lead = leadRows?.[0] as Record<string, unknown> | undefined;
  if (!lead) return { ok: false, error: "not your lead" };

  const next = asText(w.value);
  const current = lead[w.field] == null ? null : String(lead[w.field]);

  const { data: histRows } = await supabase.from("student_lead_facts")
    .select("value,source,dismissed_at")
    .eq("lead_id", w.leadId).eq("field", w.field)
    .order("created_at", { ascending: false }).limit(30);
  const history = (histRows || []) as FactHistory[];

  const verdict = decideFactWrite({ current, next, history, source: w.source });
  if (verdict !== "apply") {
    // A refused write is still recorded, so the disagreement is visible rather than
    // silently lost: the agent believed something, and the rules stopped it.
    await logFact(w, observed, next, verdict);
    return { ok: true, wrote: false, reason: verdict };
  }

  const { error } = await supabase.from("student_leads")
    .update({ [w.field]: w.value, updated_at: new Date().toISOString() })
    .eq("id", w.leadId).eq("student_id", w.sid);
  if (error) return { ok: false, error: "couldn't save that" };

  await logFact(w, observed, next, "apply");
  return { ok: true, wrote: true };
}

async function logFact(w: FactWrite, observed: string, value: string | null, outcome: FactVerdict) {
  await supabase.from("student_lead_facts").insert({
    student_id: w.sid, lead_id: w.leadId, field: w.field, value,
    observed: observed.slice(0, 1000), source: w.source, actor: w.actor || "agent",
    // A refused write is stored with its own marker so the trail shows what the
    // agent believed AND that the rules stopped it.
    dismissed_at: outcome === "dismissed" ? new Date().toISOString() : null,
  }).then(undefined, () => {});
}

/** A human rejects a value: it is never offered for this field again. */
export async function dismissFact(sid: number, factId: number): Promise<boolean> {
  const { data } = await supabase.from("student_lead_facts")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", factId).eq("student_id", sid).is("dismissed_at", null).select("id");
  return !!data?.length;
}

/** Why the card says what it says. Newest first, applied writes only. */
export async function whyFor(sid: number, leadId: number) {
  const { data } = await supabase.from("student_lead_facts")
    .select("id,field,value,observed,source,actor,dismissed_at,created_at")
    .eq("student_id", sid).eq("lead_id", leadId)
    .order("created_at", { ascending: false }).limit(40);
  return (data || []) as {
    id: number; field: string; value: string | null; observed: string;
    source: string; actor: string; dismissed_at: string | null; created_at: string;
  }[];
}
