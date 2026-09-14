import { supabase } from "@/lib/supabase";
import { canonical, FUNNEL_ORDER, HUMAN } from "@/lib/funnel";

/**
 * EVERY STUDENT GETS A BOARD, NOBODY BUILDS ONE.
 *
 * The owner, 2026-08-04: "And I feel like you should create a default pipeline for
 * everyone just automatically right now".
 *
 * He is right and it was worse than he knew. Two students had a pipeline row and
 * BOTH had zero stages, so every CRM in the system rendered "No stages yet. Open
 * Pipelines and add the steps someone walks through." The tab shipped asking a
 * student to design a CRM before it would show them one, which is the same as not
 * shipping it. Nobody built one, so the CRM held nobody, so the funnel numbers had
 * no people behind them.
 *
 * WHERE THE STAGES COME FROM. Their own metrics board, which is already exactly
 * this list - the owner again: "they are all oin the right order in the dashboard, the
 * columns are in the same order a sale would happen!!!!!" So the default pipeline
 * is their board, in their words, in their order, with two differences:
 *
 *   1. Only the columns a PERSON can sit in. A metrics column counts an action; a
 *      pipeline stage holds a human being. "FU-Pitch" is a thing you do at every
 *      stage, not a place anyone is, and a Follow-ups column as a stage would mean
 *      dragging the same person back and forth forever. Same for reels, stories
 *      and cash - those are counts, not people.
 *   2. Two stages that count nothing get added at the end: the won one (already
 *      there on most boards, as "Closed") and somewhere for the ones that said no,
 *      because a board with no exit fills up with dead names inside a month.
 *
 * A student who has no board yet gets the plain six, which they can rename to
 * anything - the CRM has never hardcoded a stage list and still does not. This is
 * a starting point, not a schema.
 */

export type SeedStage = { name: string; canonical: string | null; is_won: boolean; is_lost: boolean };
export type ResolvedCol = { label: string; resolved: string | null };

/** Stages that are somewhere a person can BE. `lead` is on the front because a name
 *  on a list is a real place to sit; the follow-up, content and money stages are
 *  not, which is the whole filter. */
export const PERSON_STAGES: readonly string[] = ["lead", ...FUNNEL_ORDER];

/** For a student with no metrics board at all. Plain words, no jargon, and every
 *  one of them renameable the moment they open Pipelines. */
export const FALLBACK_STAGES: SeedStage[] = [
  { name: "New", canonical: "lead", is_won: false, is_lost: false },
  { name: "Reached out", canonical: "outreach", is_won: false, is_lost: false },
  { name: "Talking", canonical: "conversation", is_won: false, is_lost: false },
  { name: "Call booked", canonical: "booked", is_won: false, is_lost: false },
  { name: "Call held", canonical: "held", is_won: false, is_lost: false },
  { name: "Offer made", canonical: "pitched", is_won: false, is_lost: false },
  { name: "Closed", canonical: "closed", is_won: true, is_lost: false },
  { name: "Not now", canonical: null, is_won: false, is_lost: true },
];

const LOST_STAGE: SeedStage = { name: "Not now", canonical: null, is_won: false, is_lost: true };

/**
 * The pipeline a board describes. Pure, so the rule is testable against real
 * boards rather than only observable after it has written to somebody's CRM.
 *
 * Columns arrive in board order with their canonical stage already resolved.
 * Deduped by stage, keeping the FIRST label - two columns resolving to the same
 * stage is one place a person sits, named twice.
 */
export function stagesFromBoard(cols: ResolvedCol[]): SeedStage[] {
  const allowed = new Set(PERSON_STAGES);
  const seen = new Set<string>();
  const out: SeedStage[] = [];
  for (const c of cols) {
    const st = c.resolved || "";
    if (!allowed.has(st) || seen.has(st)) continue;
    seen.add(st);
    out.push({ name: c.label.trim() || HUMAN[st] || st, canonical: st, is_won: st === "closed", is_lost: false });
  }
  // A board that never reaches the sale is not a pipeline, it is a couple of
  // counters. Fall back rather than hand somebody a two-column CRM.
  if (out.length < 3) return FALLBACK_STAGES;
  if (!out.some((s) => s.is_won)) {
    out.push({ name: "Closed", canonical: "closed", is_won: true, is_lost: false });
  }
  out.push(LOST_STAGE);
  return out;
}

/** Their first board's columns, in position order, each resolved to a canonical
 *  stage the same way every other number in the OS resolves them. */
async function boardColumns(sid: number): Promise<{ name: string; cols: ResolvedCol[] } | null> {
  const { data: boards } = await supabase.from("student_dashboards")
    .select("id,name").eq("student_id", sid).order("position", { ascending: true }).limit(1);
  const board = boards?.[0] as { id: number; name: string } | undefined;
  if (!board) return null;
  const { data: rows } = await supabase.from("dashboard_columns")
    .select("label,col_key,stage").eq("dashboard_id", board.id).order("position", { ascending: true });
  const cols: ResolvedCol[] = [];
  for (const r of ((rows || []) as { label: string; col_key: string; stage: string | null }[])) {
    cols.push({ label: r.label, resolved: await canonical(r.col_key, r.label, r.stage) });
  }
  return { name: board.name, cols };
}

async function writeStages(pipelineId: number, seeds: SeedStage[]) {
  await supabase.from("student_pipeline_stages").insert(
    seeds.map((s, i) => ({
      pipeline_id: pipelineId, name: s.name, sort_order: i,
      canonical: s.canonical, is_won: s.is_won, is_lost: s.is_lost,
    })),
  );
}

/**
 * People they have already won, as cards in the won stage.
 *
 * The owner, 2026-08-04: "for example, for Oscar, he already has three clients... create
 * a, like, deal closed, uh, stage and create three cards for him".
 *
 * A brand new board with nothing on it teaches a student that the CRM is another
 * empty thing to fill in. Their own clients on it teaches them what a card is in
 * one look. Linked by client_id so the card and the client are one person, not two
 * records that will disagree by Friday.
 */
async function seedWonFromClients(sid: number, pipelineId: number, wonStageId: number) {
  const { data: clients } = await supabase.from("student_clients")
    .select("id,name,amount,currency,service,status").eq("student_id", sid);
  const rows = (clients || []) as { id: string; name: string; amount: number | null;
    currency: string | null; service: string | null; status: string | null }[];
  if (!rows.length) return;

  // Never a second card for somebody already on the board, however they got there.
  const { data: existing } = await supabase.from("student_leads")
    .select("client_id,name").eq("student_id", sid);
  const haveClient = new Set(((existing || []) as { client_id: string | null }[]).map((l) => l.client_id).filter(Boolean));
  const haveName = new Set(((existing || []) as { name: string }[]).map((l) => (l.name || "").trim().toLowerCase()));

  const fresh = rows.filter((c) => !haveClient.has(c.id) && !haveName.has((c.name || "").trim().toLowerCase()));
  if (!fresh.length) return;
  await supabase.from("student_leads").insert(fresh.map((c, i) => ({
    student_id: sid, pipeline_id: pipelineId, stage_id: wonStageId,
    name: c.name, status: "won", value: c.amount, currency: c.currency,
    source: "client", client_id: c.id, position: i,
    notes: c.service ? `Client: ${c.service}` : null,
  })));
}

/**
 * Make sure this student has a pipeline with stages in it. Called on every CRM
 * read, cheap when there is nothing to do, and it never touches a pipeline that
 * already has stages - a student's own board is theirs, including the day they
 * delete every stage but one.
 */
export async function ensurePipeline(sid: number): Promise<void> {
  const { data: pipes } = await supabase.from("student_pipelines")
    .select("id").eq("student_id", sid).eq("archived", false)
    .order("sort_order", { ascending: true });
  const existing = (pipes || []) as { id: number }[];

  // Any pipeline anywhere with a stage in it means this student is set up. Only a
  // student with NO stages at all is one this has anything to say about.
  if (existing.length) {
    const { count } = await supabase.from("student_pipeline_stages")
      .select("id", { count: "exact", head: true }).in("pipeline_id", existing.map((p) => p.id));
    if ((count || 0) > 0) return;
  }

  const board = await boardColumns(sid);
  const seeds = board ? stagesFromBoard(board.cols) : FALLBACK_STAGES;

  let pipelineId = existing[0]?.id;
  if (!pipelineId) {
    const { data, error } = await supabase.from("student_pipelines")
      .insert({ student_id: sid, name: board?.name || "My pipeline", sort_order: 0 })
      .select("id").single();
    if (error || !data) return;
    pipelineId = (data as { id: number }).id;
  }
  await writeStages(pipelineId, seeds);

  const { data: wonRows } = await supabase.from("student_pipeline_stages")
    .select("id").eq("pipeline_id", pipelineId).eq("is_won", true).limit(1);
  const wonId = (wonRows?.[0] as { id: number } | undefined)?.id;
  if (wonId) await seedWonFromClients(sid, pipelineId, wonId);
}
