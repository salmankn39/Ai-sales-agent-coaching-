/**
 * CRM NOTES — the paper trail the owner reads inside GoHighLevel.
 *
 * Owner ask, 2026-08-13 (after opening a lead's card and finding "No notes
 * yet"): "We agreed that the AI would be taking notes and typing notes and
 * putting notes all the time as the conversation goes on consistently...
 * there are stages... as you go through each stage, you still need to track
 * it and add these notes in."
 *
 * So every time the setter's own funnel tracker moves a lead to a new stage,
 * a note lands on their GHL contact: where they moved from and to, and the
 * facts learned so far (the same stage_data the reply brain runs on). Key
 * milestones (booking link sent, pre-call video sent) get their own note.
 *
 * Everything here is BEST-EFFORT and NON-THROWING: a note is bookkeeping and
 * can never be allowed to break or delay a reply. A lead with no GHL contact
 * yet is skipped silently — the moment conversation-sync attaches one, the
 * next stage move starts their trail. Every written note also logs a
 * crm_note_written event, so "are the notes actually happening" is a query,
 * not a guess.
 */

import { createContactNote } from "./ghl";
import { logEvent, supabase, getRecentMessages, type Client, type Lead } from "./supabase";

const SIGNATURE = "(AI setter, automatic note)";
const MAX_FACT_LINES = 12;
const MAX_FACT_CHARS = 90;

/** Render accumulated stage facts as plain lines a human skims in the CRM. */
export function factsBlock(stageData: Record<string, unknown> | null | undefined): string {
  if (!stageData) return "";
  const lines: string[] = [];
  for (const [key, value] of Object.entries(stageData)) {
    if (lines.length >= MAX_FACT_LINES) break;
    if (value == null) continue;
    const v =
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value).trim()
        : "";
    if (!v) continue;
    lines.push(`- ${key.replace(/_/g, " ")}: ${v.slice(0, MAX_FACT_CHARS)}`);
  }
  return lines.join("\n");
}

async function writeNote(
  client: Client,
  lead: Lead,
  kind: string,
  body: string
): Promise<void> {
  try {
    const apiKey = client.ghl_api_key;
    // RE-READ THE CONTACT IF THE OBJECT IN HAND HAS NONE (audit 2026-08-14).
    // ensurePipelineCard attaches the contact in a waitUntil task running
    // CONCURRENTLY with this turn, so the lead object here can be a few
    // hundred milliseconds stale - and a stale null meant the note was
    // silently dropped moments after the attach succeeded. One cheap read
    // only in the case that used to fail outright.
    let contactId = lead.ghl_contact_id ?? null;
    if (!contactId && lead.id) {
      const { data: fresh } = await supabase
        .from("leads").select("ghl_contact_id").eq("id", lead.id).maybeSingle();
      contactId = (fresh as { ghl_contact_id?: string | null } | null)?.ghl_contact_id ?? null;
      if (contactId) lead.ghl_contact_id = contactId;
    }
    // A SKIP IS NOW ON THE RECORD (audit 2026-08-14). Until today a note that
    // was never attempted, one GHL rejected, and one that was never called
    // for all left IDENTICAL evidence: nothing at all. That is why "zero
    // notes" could not be diagnosed from data and had to be traced by hand.
    if (!apiKey || !contactId) {
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "crm_note_skipped",
        metadata: { kind, reason: !apiKey ? "no_ghl_key" : "no_contact_yet" },
      }).catch(() => { /* observability only */ });
      return;
    }
    const ok = await createContactNote(apiKey, contactId, `${body}\n${SIGNATURE}`);
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type: ok ? "crm_note_written" : "crm_note_failed",
      metadata: { kind, chars: body.length },
    }).catch(() => { /* observability only */ });
  } catch (e) {
    console.error("[crm-notes] note failed (reply unaffected):", e);
  }
}

/**
 * THE CATCH-UP NOTE — written ONCE per lead, before their first stage note.
 *
 * Owner incident 2026-08-14: he opened Cody's CRM card after a 40-message
 * conversation that had advanced through five funnel stages and saw "No notes
 * yet". Stage notes only fire on a stage CHANGE, so every conversation that
 * happened before this machinery existed (or before the contact was attached)
 * had no way to ever reach the card - its history was simply lost to the CRM.
 *
 * This closes that hole for good: the first time we are about to write ANY
 * note for a lead, their whole story so far goes in first - who they are,
 * where they are in the funnel, every fact captured, and how the conversation
 * has actually gone. Written once, guarded by its own event, so it can never
 * repeat no matter how many paths call it.
 */
export async function ensureCatchUpNote(client: Client, lead: Lead): Promise<void> {
  try {
    if (!client.ghl_api_key) return;
    // Deliberately NOT gated on lead.ghl_contact_id here: writeNote below
    // re-reads it, so a contact attached moments ago (waitUntil race) still
    // gets its catch-up, and a genuinely contactless lead leaves a
    // crm_note_skipped trail instead of vanishing silently.
    const { data: already } = await supabase
      .from("events")
      .select("id")
      .eq("lead_id", lead.id)
      .eq("event_type", "crm_note_written")
      .eq("metadata->>kind", "catch_up")
      .limit(1);
    if (already?.length) return;

    const history = await getRecentMessages(lead.id, 40).catch(() => []);
    const theirs = history.filter((m) => m.role === "lead");
    const ours = history.filter((m) => m.role === "ai" || m.role === "human");
    const who =
      [lead.full_name, lead.ig_username ? `@${String(lead.ig_username).replace(/^@/, "")}` : null]
        .filter(Boolean)
        .join(" ") || "this lead";
    const facts = factsBlock(lead.stage_data as Record<string, unknown> | null);
    const lastFew = history
      .slice(-6)
      .map((m) => `${m.role === "lead" ? "Them" : m.role === "human" ? "You" : "Setter"}: ${(m.content || "").slice(0, 120)}`)
      .join("\n");

    const body = [
      `Catch-up on ${who}.`,
      `Funnel stage: ${lead.funnel_stage || "not set yet"}.`,
      `Conversation so far: ${theirs.length} message(s) from them, ${ours.length} from our side.`,
      facts ? `What we know:\n${facts}` : "No qualifying facts captured yet.",
      lastFew ? `Most recent exchange:\n${lastFew}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    await writeNote(client, lead, "catch_up", body);
  } catch (e) {
    console.error("[crm-notes] catch-up note failed (harmless):", e);
  }
}

/** A funnel-stage move: "opener -> goals", plus everything learned so far. */
export async function noteStageChange(params: {
  client: Client;
  lead: Lead;
  fromStage: string | null;
  toStage: string;
  stageData?: Record<string, unknown> | null;
}): Promise<void> {
  const { client, lead, fromStage, toStage } = params;
  // Their story reaches the card BEFORE this stage line, once, so a card is
  // never just a bare "opener -> goals" with no context behind it.
  await ensureCatchUpNote(client, lead);
  const from = (fromStage || "").trim();
  const facts = factsBlock(params.stageData);
  const head = from
    ? `Stage: ${from} -> ${toStage}`
    : `Conversation started. Stage: ${toStage}`;
  const body = facts ? `${head}\nWhat we know so far:\n${facts}` : head;
  await writeNote(client, lead, "stage_change", body);
}

/** A one-line milestone worth a note of its own (booking link, video, ...). */
export async function noteMilestone(params: {
  client: Client;
  lead: Lead;
  kind: string;
  text: string;
}): Promise<void> {
  await writeNote(params.client, params.lead, params.kind, params.text);
}
