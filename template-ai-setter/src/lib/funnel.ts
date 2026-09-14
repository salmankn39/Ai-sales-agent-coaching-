import { supabase } from "@/lib/supabase";

/**
 * THE FUNNEL - the TypeScript half of the one business vocabulary.
 *
 * Mirrors intelligence/student_os/funnel.py. Every student names their own
 * board columns; this maps whatever they call it onto the canonical stages so
 * the app, the radar and the Pulse all count the same thing:
 *
 *   offer -> TRAFFIC -> CONVERSATIONS -> APPOINTMENTS -> CLOSE -> CASH
 */

// TWO CALLS ARE TWO CALLS (the owner, 2026-08-04: "intro taken and demo call taken is
// not the same thing or intro booked and demo booked they are not the same thing
// either"). Every live board runs a two-step call funnel, and until now there was
// exactly ONE `booked` bucket and ONE `held` bucket, so both calls landed in the
// same place and were added together. `ask_close` is separate for the same reason:
// an ask happens on a call that was already counted as pitched.
// Mirrors intelligence/student_os/funnel.py, which the parity test enforces.
// AND THREE ASKS ARE THREE ASKS (the owner, 2026-08-04, on the three "pitched" columns
// every Instagram board carries): "onboarding call proposed means u pitched someone
// to jumo on the first call, pitched free tool is something they do in the dms or so
// and pitched demo call is what they do on the onborading/intro call to see if they
// wanna jump on a demo call". Three different asks at three different moments, all
// landing in `pitched` beside the real offer until now.
export const STAGES = ["post", "story", "lead", "outreach", "conversation", "followup", "engage",
  "magnet_pitched", "ask_intro", "intro_booked", "intro_held",
  "ask_demo", "booked", "held", "no_show",
  "pitched", "ask_close", "closed", "revenue", "cash"] as const;
export type Stage = (typeof STAGES)[number];

export const FUNNEL_ORDER: Stage[] = ["outreach", "conversation", "magnet_pitched",
  "ask_intro", "intro_booked", "intro_held",
  "ask_demo", "booked", "held", "pitched", "ask_close", "closed"];

/** Steps not every student runs. Absent from their totals means it is not part of
 *  their funnel; a zero means they ran it and got none. */
export const OPTIONAL_STAGES: ReadonlySet<string> = new Set(["magnet_pitched", "ask_intro",
  "intro_booked", "intro_held", "ask_demo", "ask_close"]);

export const HUMAN: Record<string, string> = {
  post: "posts", story: "stories", lead: "leads", outreach: "outreach",
  conversation: "conversations", followup: "follow-ups", engage: "engagement",
  magnet_pitched: "free tool pitched", ask_intro: "first calls asked for",
  intro_booked: "intro calls booked", intro_held: "intro calls held",
  ask_demo: "demo calls asked for",
  booked: "calls booked", held: "calls held", no_show: "no-shows",
  pitched: "offers made", ask_close: "closes asked for", closed: "clients closed",
  revenue: "revenue sold", cash: "cash collected",
};

// Same fallback patterns as the Python side, so a column invented today still
// lands in the right bucket before anyone maps it.
const FALLBACK: [Stage, string[]][] = [
  ["no_show", ["no show", "noshow", "no-show"]],
  // ORDER IS LOAD-BEARING - see the long note in funnel.py, which this mirrors.
  // "revenue" left the cash needles (a board's Revenue and Cash columns were both
  // landing in `cash`, doubling every sale entered in both), and bare "close" left
  // the closed needles ("ask_for_close" was being reported as a client closed).
  ["cash", ["cash collected", "cash", "collected", "payment", "paid", "mrr"]],
  ["revenue", ["revenue", "contract", "kontrakt", "deal value", "booked value"]],
  ["followup", ["follow", "fu ", "chase", "nurture"]],
  // An ask is not an offer, and the two-step call needles sit ABOVE the generic
  // held/booked ones so the first call never falls into the second call's bucket.
  ["ask_close", ["ask for close", "ask close", "asked for close", "close ask"]],
  // The three asks, above the generic "pitch" needle so none falls into the offer
  // bucket. Mirrors the long note in funnel.py.
  // "Demo Call Proposed" is the ask for the SECOND call and must never fall into
  // ask_intro's generic "call proposed" needle below it (the owner, 2026-08-04, on
  // Thomas's board: the demo is proposed DURING the audit call).
  ["ask_demo", ["demo call proposed", "demo proposed", "proposed demo",
    "pitched demo", "pitch demo", "demo call pitched", "demo pitched",
    "asked for demo", "propose demo"]],
  // An audit call is an intro call wearing the offer's clothes. The owner: "it's
  // usually the intro call. Pitch intro call." So pitching the free audit is
  // asking for the first call, and taking it is holding the first call.
  ["ask_intro", ["free audit", "audit call proposed", "audit proposed", "pitch audit",
    "pitched audit",
    "call proposed", "proposed call", "onboarding call proposed",
    "intro call proposed", "proposed intro", "asked for call",
    "call asked", "pitched call"]],
  ["magnet_pitched", ["free tool", "lead magnet", "magnet pitched", "pitched magnet",
    "free guide", "freebie"]],
  ["pitched", ["pitch", "propos", "offer made", "quote"]],
  ["closed", ["closed", "signed", "won", "new client"]],
  ["intro_held", ["audit call taken", "audit taken", "audit call held", "audit held",
    "audit call done",
    "intro taken", "intros taken", "intro held", "intros held",
    "intro call taken", "intro call held", "intro done",
    "onboarding call held", "onboarding calls held",
    "onboarding call taken", "onboarding calls taken"]],
  ["intro_booked", ["booked intro", "intro booked", "intros booked", "intro call booked",
    "booked onboarding", "onboarding call booked", "onboarding calls booked"]],
  ["held", ["held", "showed", "show up", "call done", "taken", "attended"]],
  ["booked", ["book", "appointment", "scheduled call", "set"]],
  ["conversation", ["convo", "conversation", "reply", "replies", "responded", "inbound"]],
  ["outreach", ["outreach", "dial", "dm", "cold", "message", "contact", "reach"]],
  ["lead", ["lead", "prospect", "scraped"]],
  ["story", ["story", "stories"]],
  ["post", ["post", "reel", "video", "short", "content", "tiktok", "carousel"]],
  ["engage", ["comment", "engage", "question", "like"]],
];

let MAP: Record<string, string> | null = null;

async function stageMap(): Promise<Record<string, string>> {
  if (MAP) return MAP;
  try {
    const { data } = await supabase.from("stage_map").select("alias,stage");
    MAP = Object.fromEntries(((data || []) as { alias: string; stage: string }[])
      .map((r) => [r.alias.toLowerCase(), r.stage]));
  } catch { MAP = {}; }
  return MAP;
}

/**
 * Whatever they call it, mapped to a canonical stage - or null if it is not a
 * funnel action at all.
 *
 * `declared` is the column SAYING what it means (dashboard_columns.stage), and it
 * always wins. Everything below it is guessing, and guessing has cost real money:
 * "revenue" landing in cash double-counted every sale entered twice, "ask for
 * close" manufactured closes on five boards, and Thomas Green's "Intros Taken" and
 * "Demo call taken" both match the needle "taken", so his calls-held counts twice.
 *
 * An empty string is a real declaration - "this counts toward nothing" - so a
 * student can keep a column of their own without it being pattern-matched into
 * somebody's funnel. Mirrors funnel.py's canonical().
 */
export async function canonical(stageKey?: string | null, label?: string | null,
                                declared?: string | null): Promise<Stage | null> {
  if (declared !== undefined && declared !== null) {
    const d = String(declared).trim().toLowerCase();
    if ((STAGES as readonly string[]).includes(d)) return d as Stage;
    if (d === "") return null;
  }
  const m = await stageMap();
  for (const raw of [stageKey, label]) {
    const s = (raw || "").trim().toLowerCase();
    // Validated against STAGES, unlike before: stage_map is a database table, so a
    // row can name a stage this build has never heard of - exactly what happens
    // when the aliases are updated ahead of a deploy. Returning it unchecked moved
    // a column into a bucket nothing reads, so the number just vanished.
    if (s && (STAGES as readonly string[]).includes(m[s])) return m[s] as Stage;
  }
  const blob = `${stageKey || ""} ${label || ""}`.toLowerCase().replace(/_/g, " ");
  for (const [stage, needles] of FALLBACK) {
    if (needles.some((n) => blob.includes(n))) return stage;
  }
  return null;
}

/**
 * The needle half of canonical(), synchronous and database-free: what a label
 * MEANS, judged on wording alone. For callers that only need to know whether two
 * strings describe the same funnel step - the daily-target matcher uses it to stop
 * "50 followups per day" becoming a second column beside FU-Out.
 */
export function guessStage(text: string): Stage | null {
  const blob = String(text || "").toLowerCase().replace(/_/g, " ");
  if (!blob.trim()) return null;
  for (const [stage, needles] of FALLBACK) {
    if (needles.some((n) => blob.includes(n))) return stage;
  }
  return null;
}

/** Teach the map a new alias when a student names a board column. Best-effort. */
export async function learn(stageKey: string, label: string): Promise<void> {
  try {
    const stage = await canonical(stageKey, label);
    if (!stage) return;
    await supabase.from("stage_map").upsert({ alias: stageKey.toLowerCase(), stage }, { onConflict: "alias" });
    if (MAP) MAP[stageKey.toLowerCase()] = stage;
  } catch { /* mapping is a bonus, never a blocker */ }
}

export type Totals = Partial<Record<Stage, number>>;

/**
 * What each board column DECLARES itself to be, keyed by (channel, col_key).
 *
 * Keyed on the pair, never on col_key alone: the whole reason declarations exist
 * is that one key means different things on two boards (`calls_on_calendar_that_day`
 * is "Calls on calendar that day" for three students and "Intros Taken" for
 * Thomas), so a map keyed on the key alone would let one student's declaration
 * rewrite another's numbers.
 *
 * Undeclared columns stay OUT of the map, which is what makes them keep guessing.
 * A read failure returns an empty map for the same reason: degrade to guessing,
 * never to zero. Mirrors funnel.py's _declared_stages().
 */
// Keyed as a JSON pair rather than a joined string: channels are free text
// ("custom", "dash:12", a bare method key), so any single-character separator is
// a collision waiting to happen.
const decKey = (channel: string, colKey: string) => JSON.stringify([channel, colKey]);

async function declaredStages(studentIds: number[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!studentIds.length) return out;
  try {
    const { data: boards } = await supabase.from("student_dashboards")
      .select("id").in("student_id", studentIds);
    const ids = ((boards || []) as { id: number }[]).map((b) => b.id);
    if (!ids.length) return out;
    const { data } = await supabase.from("dashboard_columns")
      .select("dashboard_id,col_key,stage").in("dashboard_id", ids);
    for (const c of (data || []) as { dashboard_id: number; col_key: string; stage: string | null }[]) {
      if (c.stage === null || c.stage === undefined) continue;
      out.set(decKey(`dash:${c.dashboard_id}`, c.col_key), c.stage);
    }
  } catch { /* no declarations available: fall back to guessing */ }
  return out;
}

/**
 * Canonical totals over a window, closes and cash included from student_deals.
 *
 * `channel` is required (PR5b, 2026-07-26, parity with funnel.py): pass a channel string to
 * scope to one named funnel, or `null` explicitly to opt into a cross-funnel total. There is
 * no default - omitting it is a type error, so a new caller can never sum two named funnels
 * together by accident (Law 4). student_deals has no channel column - closes/cash are always
 * whole-business, see funnel.py's own note on this.
 */
export async function totals(studentId: number, sinceISO: string, untilISO: string | undefined, channel: string | null): Promise<Totals> {
  const out: Totals = {};
  const hi = untilISO || new Date().toISOString().slice(0, 10);
  try {
    const dec = await declaredStages([studentId]);
    let q = supabase.from("student_funnel_events")
      .select("stage,count,occurred_on,channel").eq("student_id", studentId)
      .gte("occurred_on", sinceISO).lte("occurred_on", hi);
    if (channel !== null) q = q.eq("channel", channel);
    const { data } = await q;
    for (const r of (data || []) as { stage: string; count: number; channel: string | null }[]) {
      const st = await canonical(r.stage, null, dec.get(decKey(r.channel || "", r.stage || "")));
      if (st) out[st] = (out[st] || 0) + (r.count || 0);
    }
  } catch { /* keep what we have */ }
  try {
    const { data } = await supabase.from("student_deals")
      .select("kind,amount,occurred_on").eq("student_id", studentId)
      .gte("occurred_on", sinceISO).lte("occurred_on", hi);
    for (const d of (data || []) as { kind: string; amount: number | null }[]) {
      if (d.kind === "closed") out.closed = (out.closed || 0) + 1;
      else if (d.kind === "cash") out.cash = (out.cash || 0) + Number(d.amount || 0);
    }
  } catch { /* keep what we have */ }
  return out;
}

/**
 * Canonical totals for MANY students in two queries instead of two per student.
 * The cohort view needs every active student's week at once; looping totals()
 * would be 20+ round trips on every page load.
 *
 * `channel` required, same rule as `totals()` above. The only live caller
 * (app/students/page.tsx) is the owner's HQ cohort view, summing every student's whole
 * business - channel: null there is the deliberate cross-funnel opt-in, not the
 * accidental kind.
 */
export async function cohortTotals(studentIds: number[], sinceISO: string, untilISO: string | undefined, channel: string | null): Promise<Map<number, Totals>> {
  const out = new Map<number, Totals>();
  if (!studentIds.length) return out;
  const hi = untilISO || new Date().toISOString().slice(0, 10);
  const bump = (sid: number, st: Stage, n: number) => {
    const t = out.get(sid) || {};
    t[st] = (t[st] || 0) + n;
    out.set(sid, t);
  };
  try {
    // One declarations query for the whole cohort, not one per student: a
    // dashboard id is globally unique, so (channel, col_key) is already unique
    // across students and the maps cannot bleed into each other.
    const dec = await declaredStages(studentIds);
    let q = supabase.from("student_funnel_events")
      .select("student_id,stage,count,occurred_on,channel").in("student_id", studentIds)
      .gte("occurred_on", sinceISO).lte("occurred_on", hi);
    if (channel !== null) q = q.eq("channel", channel);
    const { data } = await q;
    for (const r of (data || []) as { student_id: number; stage: string; count: number; channel: string | null }[]) {
      const st = await canonical(r.stage, null, dec.get(decKey(r.channel || "", r.stage || "")));
      if (st) bump(r.student_id, st, r.count || 0);
    }
  } catch { /* keep what we have */ }
  try {
    const { data } = await supabase.from("student_deals")
      .select("student_id,kind,amount,occurred_on").in("student_id", studentIds)
      .gte("occurred_on", sinceISO).lte("occurred_on", hi);
    for (const d of (data || []) as { student_id: number; kind: string; amount: number | null }[]) {
      if (d.kind === "closed") bump(d.student_id, "closed", 1);
      else if (d.kind === "cash") bump(d.student_id, "cash", Number(d.amount || 0));
    }
  } catch { /* keep what we have */ }
  return out;
}

/** Sum a set of per-student totals into one cohort-wide picture. */
export function sumTotals(all: Iterable<Totals>): Totals {
  const t: Totals = {};
  for (const one of all) for (const [k, v] of Object.entries(one)) t[k as Stage] = (t[k as Stage] || 0) + (v || 0);
  return t;
}

/** The weakest link in this student's funnel, as [stage, plain-English why]. */
// Each step, with the rate below which reaching it counts as the weak link, and
// the plain-English phrase for the gap into it. Mirrors funnel.py's _CHAIN.
const CHAIN: [Stage, number, string][] = [
  ["outreach", 0, ""],
  ["conversation", 0.15, "conversations from outreach"],
  ["magnet_pitched", 0.20, "conversations where the free tool got pitched"],
  ["ask_intro", 0.20, "conversations where the call got asked for"],
  ["intro_booked", 0.15, "intro calls booked"],
  ["intro_held", 0.60, "intro calls actually held"],
  ["ask_demo", 0.50, "intro calls where the demo got asked for"],
  ["booked", 0.15, "calls booked"],
  ["held", 0.60, "booked calls actually held"],
  ["pitched", 0.60, "held calls where an offer was made"],
  ["ask_close", 0.60, "offers where the close was asked for"],
  ["closed", 0.20, "asks that closed"],
];

// The rate belongs to the TRANSITION, not the stage - see the long note in
// funnel.py. Raising `booked`'s own threshold to suit the two-call funnel told
// every one-call student their booking was broken at a perfectly healthy 25%.
const PAIR_RATE: Record<string, number> = {
  "ask_intro>intro_booked": 0.40,
  "ask_demo>booked": 0.40,
  "magnet_pitched>ask_intro": 0.40,
};

export function bottleneck(t: Totals): [Stage, string] | null {
  const traffic = (t.post || 0) + (t.story || 0) + (t.outreach || 0);
  if (traffic <= 0) return ["outreach", "no traffic at all this week - nothing posted, nobody contacted"];
  // Steps a student does not run are skipped rather than failed: a student who
  // books one call and pitches on it has no intro step, and a fixed chain would
  // have told them "zero intro calls booked" every day forever.
  const steps = CHAIN.filter(([st]) => !OPTIONAL_STAGES.has(st) || t[st] !== undefined);
  for (let i = 0; i + 1 < steps.length; i++) {
    const [top] = steps[i];
    const [bottom, ownRate, what] = steps[i + 1];
    const rate = PAIR_RATE[`${top}>${bottom}`] ?? ownRate;
    const above = t[top] || 0, below = t[bottom] || 0;
    if (above <= 0) continue;
    if (below <= 0) return [bottom, `${Math.round(above)} ${HUMAN[top]} and zero ${HUMAN[bottom]}`];
    if (below / above < rate) {
      return [bottom, `only ${Math.round((below / above) * 100)}% ${what} (${Math.round(below)} from ${Math.round(above)})`];
    }
  }
  return null;
}

export function summaryLine(t: Totals): string {
  const bits: string[] = [];
  for (const s of FUNNEL_ORDER) if (t[s]) bits.push(`${Math.round(t[s]!)} ${HUMAN[s]}`);
  if (t.cash) bits.push(`${Math.round(t.cash)} collected`);
  return bits.length ? bits.join(" · ") : "nothing logged";
}
