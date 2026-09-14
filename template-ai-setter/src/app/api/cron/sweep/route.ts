/**
 * UNANSWERED-LEADS SWEEP — the safety net so no lead is EVER left silently
 * without a reply. The webhook path is best-effort at every step (a killed
 * serverless invocation, ManyChat AND GHL both failing on the same message, a
 * generateReply() giving up after 3 attempts) — this catches whatever slips
 * through. Runs the SAME reply engine as the live webhook
 * (generateAndSendReply), so a swept reply is indistinguishable from a live
 * one.
 *
 * READS THE THREAD BEFORE IT SPEAKS (incident 2026-08-08). "Unanswered" used
 * to mean nothing in OUR messages table answered the lead, which was false for
 * every conversation the owner was holding by hand in the Instagram app, and
 * false for every message deliberately tracked-only while the setter was off.
 * Three deterministic stand-downs now sit in front of the rescue: a human
 * takeover, an owner-chosen tracked-only skip, and an exchange still in
 * flight. Each one either sends or leaves a queryable reason behind
 * (sweep_human_handled, or the tracked-only event that already explains it),
 * and the outcome-ledger monitor still escalates anything that goes quiet for
 * no recorded reason. The judgment lives HERE and is deterministic on purpose:
 * nothing inside the reply engine may ever decide a lead deserves silence.
 *
 * Driven by Supabase pg_cron (every ~5 min) plus a daily Vercel cron backstop
 * (vercel.json).
 *
 * GET /api/cron/sweep   (optional CRON_SECRET bearer auth)
 */
import { NextRequest, NextResponse } from "next/server";
import {
  supabase,
  getRecentMessages,
  logEvent,
  recentEventExists,
  type Client,
  type Lead,
} from "@/lib/supabase";
import { runLeadPipeline } from "@/lib/lead-pipeline";
import { INSTANT_ACK_TAG } from "@/lib/instant-ack";
import { resendUndeliveredTail } from "@/lib/resend-undelivered";
import { reconcileInboxTruth } from "@/lib/delivery-verify";
import { findActiveBan } from "@/lib/bans";
import { draftReplyForLead } from "@/lib/draft";
import { sendTelegramPing, sendTelegramCopyBlock, ghlContactLink, leadLabel } from "@/lib/telegram";

export const dynamic = "force-dynamic";
// 300 for headroom: the sweep budgets itself internally (40s/45s guards),
// but its RESCUE volleys pace bubbles like a live reply and must never be
// guillotined mid-transport either (that is how a resent bubble would dup).
export const maxDuration = 300;

const MIN_AGE_MS = 3 * 60_000;
const MAX_AGE_MS = 20 * 3600_000;
const MAX_PER_RUN = 3;
const LOCK_TTL_MS = 80_000;
const ATTEMPT_BACKOFF_MS = 30 * 60_000;

// Don't talk over a live exchange (incident 2026-08-08). lib/nurture.ts has
// carried this guard for months and the sweep had no equivalent: a bubble that
// landed seconds ago means something is still in flight (the webhook's own
// debounce, a paced send, the owner typing), and a rescue on top of it is how
// the setter ends up speaking twice in the same beat. Purely a deferral — the
// next tick is 5 minutes away and the outcome ledger still escalates anything
// that stays unanswered, so nothing can go silent behind this.
const IN_FLIGHT_MS = 90_000;

// Silence the OWNER chose, attached to the message that caused it. These
// events are written by the inbound route at save time, so an event newer than
// (message - 2 min) explains that message. THE BACKLOG BOMB (2026-08-08):
// while the kill switch is off every DM is still recorded, with a
// setter_off_tracked event standing in for the reply. The candidate query
// cannot see events, so the instant the switch went back on the sweep read the
// whole backlog as "unanswered leads" and started cold-opening people three at
// a time, every five minutes. A tracked-only skip is a decision, not a drop:
// it must never be rescued.
// continuation_absorbed (2026-08-21, Scott Hall): a lead bubble that arrived
// while our own volley was MID-SEND and added nothing the delivered volley's
// closing question doesn't handle. Unlike the deleted follow-on gate this can
// only fire when a full reply WAS just delivered - on Instagram the thread
// ends with our question landing after their bubble, so skipping the rescue
// here never leaves anyone on read. See lib/continuation.ts.
const TRACKED_ONLY_SKIP_EVENTS = [
  "setter_off_tracked", "skip_emoji_first_contact", "continuation_absorbed",
];

// How close a tracked-only event must sit to the message it explains. These
// events are written by the inbound route in the same beat as the message
// (save, then log), so a real one lands within seconds of it. A generous
// upper bound absorbs a slow write; the text match below is what actually
// separates one bubble of a burst from the next.
const TRACKED_ONLY_MATCH_BEFORE_MS = 10_000;
const TRACKED_ONLY_MATCH_AFTER_MS = 90_000;

// The inbound route records `text.slice(0, 120)` on these events, so a logged
// text of EXACTLY this length is the only one that can legitimately be a
// prefix of the message it explains. Any shorter one that merely prefixes the
// message is a DIFFERENT, earlier bubble - see the match below.
const TRACKED_ONLY_TEXT_LIMIT = 120;

/**
 * Is a human holding this thread RIGHT NOW?
 *
 * "Has a human EVER spoken here" is the wrong question (review 2026-08-09).
 * role='human' rows come from three writers now — the GHL backfill, HQ chat and
 * Jarvis's sendDm — so one DM the owner fired off from HQ months ago would freeze
 * a lead the setter is legitimately working: no rescue, no resend, no expiry
 * ping, and sweep_human_handled closing the ledger row as deliberate silence
 * so the monitor stayed quiet too. Silent and permanent, which is the exact
 * failure shape this whole sweep exists to make impossible.
 *
 * The signal that matters is whose message is the LAST one from our side. A
 * friend thread (all human, no ai) still stands down. A lead the setter has
 * since replied to does not. A trailing instant ack is not the setter taking
 * the thread back — it is filler, the same as everywhere else in this file.
 *
 * Returns false on any read error: a stand-down freezes a lead, and a database
 * blip must never be able to freeze every lead at once.
 */
async function humanIsHandlingThread(leadId: string): Promise<boolean> {
  try {
    const { data: humanRows, error: humanErr } = await supabase
      .from("messages")
      .select("created_at")
      .eq("lead_id", leadId)
      .eq("role", "human")
      .order("created_at", { ascending: false })
      .limit(1);
    if (humanErr) {
      console.error("[sweep] human-takeover check failed:", humanErr.message);
      return false;
    }
    const newestHumanAt = humanRows?.[0]?.created_at;
    if (!newestHumanAt) return false;

    // Acks are excluded IN THE QUERY, not afterwards (review 2026-08-09). The
    // old form took an unordered page of 10 rows and asked whether any was a
    // real reply: with more than 10 acks trailing the human message, Postgres
    // could hand back 10 acks and nothing else, and the sweep would freeze a
    // lead the setter is actively working, closing its ledger row as
    // deliberate silence. Now one matching row is proof and none is proof of
    // the opposite, whatever order the planner chooses.
    //
    // The null arm is load-bearing: a real setter message may carry no
    // model_used, and SQL's `model_used <> 'instant_ack'` drops NULL rows.
    const { data: aiAfter, error: aiErr } = await supabase
      .from("messages")
      .select("id")
      .eq("lead_id", leadId)
      .eq("role", "ai")
      .gt("created_at", newestHumanAt)
      .or(`model_used.is.null,model_used.neq.${INSTANT_ACK_TAG}`)
      .limit(1);
    if (aiErr) {
      console.error("[sweep] human-takeover ai-since check failed:", aiErr.message);
      return false;
    }
    const setterSpokeSince = (aiAfter?.length ?? 0) > 0;
    return !setterSpokeSince;
  } catch (e) {
    console.error("[sweep] human-takeover check threw:", e);
    return false;
  }
}

// ── Cold-lead follow-up drafts (second section, below) ──────────────────────
// Instagram's 24h automation window is Meta's rule — no tool can automate a DM
// past it. MANUAL sends from the IG app have no window. So when a lead ghosts,
// the setter's real brain drafts the exact follow-up it would send, and the owner
// gets it on Telegram in a tap-to-copy block to paste from the IG app. Two
// touches per stall: ~3 days and ~7 days after OUR last message. NEVER sends
// to the lead. The in-window follow-up engine (lib/followups.ts) is untouched.
const COLD_MARKS = [
  { key: "7d", ms: 7 * 86400_000, days: 7 },
  { key: "3d", ms: 3 * 86400_000, days: 3 },
]; // checked in this order → a lead fires only the HIGHEST unfired mark per pass
const MAX_COLD_DRAFTS_PER_RUN = 3;

/** The hour (0-23) right now on the client's own clock. UTC on any failure. */
function clientLocalHour(timezone: string | null | undefined): number {
  try {
    return parseInt(
      new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: timezone || "UTC" }).format(new Date()),
      10
    );
  } catch {
    return new Date().getUTCHours();
  }
}

/** Has this exact (mark, anchor) cold draft already been sent for this lead?
 *  Anchored on OUR last message's timestamp: if the lead replies and ghosts
 *  again later, the anchor changes and both marks naturally re-arm. */
async function coldDraftAlreadySent(leadId: string, mark: string, anchorIso: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("events")
    .select("id")
    .eq("lead_id", leadId)
    .eq("event_type", "cold_draft_sent")
    .eq("metadata->>mark", mark)
    .eq("metadata->>anchor", anchorIso)
    .limit(1);
  if (error) {
    console.error("[sweep] cold draft dedupe check failed:", error.message);
    return true; // fail CLOSED — a missed draft beats a duplicate ping
  }
  return (data?.length ?? 0) > 0;
}

type SweepLead = Lead & { reply_lock_at: string | null };

// ── OUTCOME-LEDGER MONITOR ──────────────────────────────────────────────────
// Every inbound lead message opens an inbound_outcomes row (saveMessage). Any
// delivered non-ack ai/human message closes the lead's open rows as 'replied'
// (also saveMessage). This monitor is the third state: it reconciles rows the
// hooks missed, closes rows as 'silent' when a DELIBERATE-skip event explains
// the silence, and ESCALATES anything still open past the grace window — an
// alarm to the owner that fires no matter which code path failed, which is the
// whole point: silence can no longer be achieved by accident.
const LEDGER_GRACE_MS = 10 * 60_000; // two sweep cycles must have had their shot
const DELIBERATE_SILENCE_EVENTS = [
  "followon_absorbed", "continuation_absorbed", "setter_off_skip", "ai_paused_skip", "skip_stop_tag",
  "rate_limit_lead_hold", "screen_skip_their_funnel", "screen_skip_owner",
  "screen_skip_friend", "screen_hold", "screen_not_lead", "screen_purge_pitch",
  "sweep_expired_ping",
  // Deliberate stand-downs that pause the lead and already notify the owner
  // (review 2026-07-24, P1): without these, every biz-owner handoff and
  // disqualify paged a false "engine dropped it" 10 minutes after the REAL
  // notification — false alarms are what kill an alarm's value.
  "handoff_biz_owner", "lead_disqualified",
  // Tracked-only inbound (2026-08-08): the setter is off system-wide, or the
  // first contact was an emoji-only story reaction. The message was recorded
  // (tracking always works) and the silence is the owner's own choice.
  "setter_off_tracked", "skip_emoji_first_contact", "personal_claim_handoff",
  // The owner is answering this thread by hand from the Instagram app
  // (2026-08-08). His reply is a real answer, it simply did not come from us,
  // so the row must close as deliberate silence instead of paging him about a
  // conversation he is personally holding.
  "sweep_human_handled",
];

async function runLedgerMonitor(): Promise<{ reconciled: number; silent: number; escalated: number }> {
  const out = { reconciled: 0, silent: 0, escalated: 0 };
  const { data: openRows, error } = await supabase
    .from("inbound_outcomes")
    .select("*")
    .eq("status", "open")
    .lt("created_at", new Date(Date.now() - LEDGER_GRACE_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) {
    console.error("[sweep] ledger monitor query failed:", error.message);
    return out;
  }
  // One page per LEAD per run — a 3-bubble burst that dies opens 3 rows and
  // must not fire 3 near-identical alarms (review 2026-07-24).
  const pagedLeads = new Set<string>();
  for (const row of (openRows ?? []) as { id: string; client_id: string; lead_id: string; message_id: string; created_at: string }[]) {
    try {
      // (a) Reconcile: a non-ack ai/human message after this row = replied
      // (covers a saveMessage whose ledger hook failed, or ordering races).
      const { data: replies } = await supabase
        .from("messages")
        .select("id, role, model_used")
        .eq("lead_id", row.lead_id)
        .gt("created_at", row.created_at)
        .in("role", ["ai", "human"])
        .limit(10);
      // Same exclusions as the saveMessage close hook: acks are filler and
      // time-triggered drips/touches are not answers to THIS message.
      const NON_ANSWER_TAGS = new Set([INSTANT_ACK_TAG, "nurture_engine", "followup_engine", "followup_engine_voice"]);
      const realReply = (replies ?? []).some((m) => m.role === "human" || !NON_ANSWER_TAGS.has(m.model_used ?? ""));
      if (realReply) {
        await supabase.from("inbound_outcomes")
          .update({ status: "replied", closed_at: new Date().toISOString() }).eq("id", row.id);
        out.reconciled++;
        continue;
      }
      // (b) Deliberate silence: a logged skip decision since just before the
      // message explains and closes it — the events ARE the closure mechanism,
      // so no gate anywhere has to remember to also write to the ledger.
      const { data: skips } = await supabase
        .from("events")
        .select("event_type")
        .eq("lead_id", row.lead_id)
        .in("event_type", DELIBERATE_SILENCE_EVENTS)
        .gte("created_at", new Date(new Date(row.created_at).getTime() - 2 * 60_000).toISOString())
        .limit(1);
      const skip = (skips ?? [])[0];
      if (skip) {
        await supabase.from("inbound_outcomes")
          .update({ status: "silent", reason: skip.event_type, closed_at: new Date().toISOString() }).eq("id", row.id);
        out.silent++;
        continue;
      }
      // (c) Nothing replied, nothing explains it → the engine died somewhere.
      // Alarm the owner and mark escalated (a later reply flips it to replied
      // via the saveMessage hook, so "escalated and still unreplied" stays
      // queryable). The unanswered-leads sweep keeps retrying regardless.
      const { data: leadRow } = await supabase
        .from("leads").select("full_name, ig_username, ghl_contact_id, client_id, ai_paused").eq("id", row.lead_id).maybeSingle();
      if (!leadRow) {
        // Lead purged after the message landed — close, don't page forever.
        await supabase.from("inbound_outcomes")
          .update({ status: "silent", reason: "lead_purged", closed_at: new Date().toISOString() }).eq("id", row.id);
        continue;
      }
      if (leadRow.ai_paused) {
        // A human owns this lead (manual pause, handoff, disqualify) — the
        // silence is deliberate even when the pause left no event behind
        // (e.g. HQ's manual pause). Never page over a human takeover.
        await supabase.from("inbound_outcomes")
          .update({ status: "silent", reason: "ai_paused", closed_at: new Date().toISOString() }).eq("id", row.id);
        out.silent++;
        continue;
      }
      if (pagedLeads.has(row.lead_id)) {
        // Same lead already paged this run — close the sibling row against
        // that one alarm instead of stacking near-identical pings.
        await supabase.from("inbound_outcomes")
          .update({ status: "escalated", reason: "escalated with sibling row", closed_at: new Date().toISOString() }).eq("id", row.id);
        out.escalated++;
        continue;
      }
      const ageMin = Math.round((Date.now() - new Date(row.created_at).getTime()) / 60_000);
      const name = leadLabel({ ...leadRow, id: row.lead_id }, "A lead");
      // NEVER ASSERT A NEGATIVE WE DID NOT CHECK (incident 2026-08-16). This
      // said "no logged reason. The engine dropped it somewhere" as unconditional
      // text, having only ever queried DELIBERATE_SILENCE_EVENTS. On the day the
      // Anthropic account ran out of credit, ai_generate_failed had been written
      // for this exact lead fifteen minutes earlier with the full reason in its
      // metadata, and this message sent the owner hunting for a phantom.
      // ai_generate_failed deliberately stays OUT of the deliberate-silence list
      // (a dead brain is not deliberate silence, the row must still escalate) —
      // the fix is to look it up and NAME it, not to close the row.
      const { data: failures } = await supabase
        .from("events")
        .select("event_type, metadata, created_at")
        .eq("lead_id", row.lead_id)
        .in("event_type", ["ai_generate_failed", "llm_account_down", "ai_reply_failed"])
        .gte("created_at", new Date(new Date(row.created_at).getTime() - 2 * 60_000).toISOString())
        .order("created_at", { ascending: false })
        .limit(1);
      const failure = (failures ?? [])[0] as
        { event_type: string; metadata: { error?: string; message?: string; kind?: string } | null } | undefined;
      const why = failure
        ? `The reason is on record: ${String(failure.metadata?.message || failure.metadata?.error || failure.event_type).slice(0, 300)}`
        : "Nothing anywhere explains it, so the engine dropped it somewhere.";
      const ping = await sendTelegramPing(
        `${name} messaged ${ageMin} min ago and never got a reply. ${why}`,
        true,
        { leadId: row.lead_id, clientId: leadRow.client_id, kind: "ledger_escalation" }
      );
      // Only consume the escalation when the alarm actually reached Telegram —
      // otherwise leave the row open so the next sweep tick retries the page.
      if (!ping.success) continue;
      pagedLeads.add(row.lead_id);
      await supabase.from("inbound_outcomes")
        .update({ status: "escalated", reason: "no outcome after grace window", closed_at: new Date().toISOString() }).eq("id", row.id);
      out.escalated++;
    } catch (err) {
      console.error("[sweep] ledger monitor row failed:", row.id, err);
    }
  }
  return out;
}

async function activeClients(): Promise<Client[]> {
  const { data, error } = await supabase.from("clients").select("*").eq("is_active", true);
  if (error) {
    console.error("[sweep] activeClients failed:", error);
    return [];
  }
  return (data ?? []) as Client[];
}

/** Once-per-24h Telegram nudge for a lead whose 24h IG reply window is closing
 *  unanswered — this is past what an AI reply can help with; needs the owner. */
async function pingExpired(client: Client, lead: Lead, hoursAgo: number): Promise<void> {
  const alreadyPinged = await recentEventExists({
    client_id: client.id,
    lead_id: lead.id,
    event_type: "sweep_expired_ping",
    since_iso: new Date(Date.now() - 24 * 3600_000).toISOString(),
  });
  if (alreadyPinged) return;
  // Log only when actually pinging — the event row IS the 24h dedup marker, so
  // logging on every 5-min tick would grow events unbounded for a stuck lead.
  await logEvent({
    client_id: client.id,
    lead_id: lead.id,
    event_type: "sweep_expired_ping",
    metadata: { hours_ago: hoursAgo },
  });
  const link = ghlContactLink(client.ghl_location_id ?? "", lead.ghl_contact_id ?? "");
  await sendTelegramPing(
    `⏰ ${leadLabel(lead, "A lead")} messaged ${hoursAgo}h ago and never got a reply — the 24h Instagram window is closing. Needs a manual touch.${link ? `\n${link}` : ""}`,
    true,
    { leadId: lead.id, clientId: client.id, kind: "window_expiring" }
  );
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  let scanned = 0;
  let attempted = 0;
  let sent = 0;
  let expiredPinged = 0;
  let coldDrafts = 0;

  let ledger = { reconciled: 0, silent: 0, escalated: 0 };

  try {
    const clients = await activeClients();

    // ── ZEROTH: the outcome-ledger monitor — cheap (a handful of queries), so
    // it runs FIRST and always gets budget. This is the hard guarantee: any
    // inbound with no reply and no logged reason pages the owner within
    // ~10-15 min no matter which code path failed.
    try {
      ledger = await runLedgerMonitor();
    } catch (err) {
      console.error("[sweep] ledger monitor failed:", err);
    }


    for (const client of clients) {
      const now = Date.now();
      const oldestIso = new Date(now - MAX_AGE_MS - 4 * 3600_000).toISOString();
      const newestIso = new Date(now - MIN_AGE_MS).toISOString();

      // NO screened=true filter (audit 2026-07-24): a first-contact lead whose
      // one live invocation died mid-screener stayed screened=false forever,
      // and this filter made the sweep structurally blind to exactly them —
      // the hottest leads in the system. runLeadPipeline (called below) runs
      // the screener itself, so rescuing an unscreened lead is safe: spam
      // still gets screened out, ICP leads finally get their reply.
      // limit 75 not 25: the query can't express "thread ends on a lead
      // message", so on a busy day the 25 oldest ANSWERED threads hogged the
      // whole page every tick and starved real unanswered leads out of scan
      // range entirely.
      const { data: candidateRows, error } = await supabase
        .from("leads")
        .select("*")
        .eq("client_id", client.id)
        .eq("ai_paused", false)
        .gte("last_message_at", oldestIso)
        .lte("last_message_at", newestIso)
        .order("last_message_at", { ascending: true })
        .limit(75);
      if (error) {
        console.error("[sweep] candidate query failed:", client.slug, error);
        continue;
      }
      const candidates = (candidateRows ?? []) as SweepLead[];
      scanned += candidates.length;

      const attempts: Promise<void>[] = [];
      let eligibleCount = 0;
      let resendCount = 0;
      let reconcileCount = 0;
      for (const lead of candidates) {
        if (eligibleCount >= MAX_PER_RUN) break;
        try {
          // Read the thread BEFORE doing anything to this lead. Both
          // stand-downs below have to gate the dropped-bubble resend as well
          // as the rescue, because a resend is just as much a message arriving
          // in the lead's inbox from us.
          const recent5 = await getRecentMessages(lead.id, 5);

          // Something in flight right now, from ANY side (ack, paced bubble,
          // The owner mid-sentence). Hands off this tick — see IN_FLIGHT_MS.
          const newestAny = recent5[recent5.length - 1];
          if (newestAny && now - new Date(newestAny.created_at).getTime() < IN_FLIGHT_MS) continue;

          // THE OWNER IS HANDLING THIS THREAD HIMSELF (incident 2026-08-08).
          // Until conversation-sync existed, a message he typed in the
          // Instagram app was recorded nowhere: role='human' had zero rows
          // ever, so a conversation he was personally holding read here as a
          // lead who sent one message and was never answered. That is how his
          // friends got cold-opened mid-conversation. When his hand-typed
          // message is the LAST thing our side said, a human owns the thread
          // and the sweep stands down completely — no resend, no rescue, and
          // no expiry ping either, because "never got a reply" is false when he
          // answered it himself. Scoped to NOW, not ever: see
          // humanIsHandlingThread.
          if (await humanIsHandlingThread(lead.id)) {
            const alreadyLogged = await recentEventExists({
              client_id: client.id,
              lead_id: lead.id,
              event_type: "sweep_human_handled",
              since_iso: new Date(now - 24 * 3600_000).toISOString(),
            });
            // Once per lead per day: the row is both the ledger's closure
            // reason and its own dedupe marker, so logging on every 5-min tick
            // would grow events without end for a thread he simply owns.
            if (!alreadyLogged) {
              await logEvent({
                client_id: client.id,
                lead_id: lead.id,
                event_type: "sweep_human_handled",
                metadata: { last_message_at: newestAny?.created_at ?? null },
              });
            }
            continue;
          }

          // INBOX AUDIT (lib/delivery-verify.ts): read the real conversation
          // back and settle every recent bubble ManyChat claimed it sent —
          // stamp the ones visibly in the inbox, and flip a proven-vanished
          // one back to undelivered so the resend directly below delivers its
          // exact words THIS tick. Runs before the resend on purpose.
          // Capped on MIRROR READS, not results: every audit that finds
          // unverified rows costs two GHL calls, and a tick where many
          // mirrors are merely lagging must not spend the whole 60s budget
          // fetching threads before a single rescue runs. A lead with nothing
          // unverified costs one cheap DB read and does not touch the cap.
          // Ten mirror reads per tick; the next tick is 5 minutes away and
          // the audit is idempotent.
          if (reconcileCount < 10) {
            const audited = await reconcileInboxTruth({ client, lead }).catch((e) => {
              console.error("[sweep] inbox reconcile failed:", lead.id, e);
              return { verified: 0, vanished: 0, fetched: false };
            });
            if (audited.fetched) reconcileCount++;
          }

          // DROPPED-BUBBLE RECOVERY (runs before the unanswered-lead logic): if
          // the thread's TAIL is AI bubbles written but never delivered — a
          // paced send the 60s limit killed mid-sequence — resend just those.
          // The lead is sitting on a question that never arrived; nothing else
          // in this sweep would catch it, because the thread "ends with an AI
          // message" and looks answered. Capped per run to protect the budget.
          if (resendCount < 5) {
            const resent = await resendUndeliveredTail({ client, lead }).catch((e) => {
              console.error("[sweep] undelivered-tail resend failed:", lead.id, e);
              return 0;
            });
            if (resent > 0) resendCount++;
          }
          // The newest REAL message must be the LEAD's — if we already replied,
          // this isn't an unanswered lead. CRITICAL: a trailing instant ack is
          // NOT a reply. Skipping only on role would make an "ack sent, then
          // the brain died" thread look answered forever (happened live: a 400
          // killed the considered reply right after the ack and the sweep
          // never rescued it). Walk past trailing acks to the newest non-ack.
          let latest = undefined as (typeof recent5)[number] | undefined;
          for (let i = recent5.length - 1; i >= 0; i--) {
            const m = recent5[i];
            if (m.role === "ai" && m.model_used === INSTANT_ACK_TAG) continue;
            latest = m;
            break;
          }
          if (!latest || latest.role !== "lead") continue;

          // NOTE: the follow-on absorb skip was removed with the gate itself
          // (2026-07-25): nothing may decide a lead message deserves TOTAL
          // silence, so a thread ending on a lead message is rescuable here.
          // The one narrow exception (2026-08-21) is continuation_absorbed in
          // TRACKED_ONLY_SKIP_EVENTS below: the bubble arrived while our own
          // volley was mid-send and the delivered volley's closing question
          // already answers it - on Instagram the thread ends with US, so
          // that is not silence and must not be "rescued" into a double turn.

          const ageMs = now - new Date(latest.created_at).getTime();
          if (ageMs < MIN_AGE_MS) continue;

          // The owner's own tracked-only skip already explains this silence —
          // see TRACKED_ONLY_SKIP_EVENTS. Checked before the expiry ping as
          // well: a backlog that piled up while the setter was off must not
          // page him about every message in it either.
          //
          // The event has to explain THIS message, not merely sit near it
          // (review 2026-08-09). The old check accepted any such event newer
          // than (this message - 2 min), so in a burst the FIRST bubble's skip
          // suppressed the rescue of a LATER bubble that nothing had answered —
          // the lead's real question, dropped with a reason that belonged to a
          // different message. Anchor on the message: a tight window around its
          // own timestamp, plus the text the inbound route recorded in the
          // event, which is what actually tells two bubbles of one burst apart.
          const latestMs = new Date(latest.created_at).getTime();
          const { data: trackedOnlyEvents, error: trackedOnlyErr } = await supabase
            .from("events")
            .select("event_type, metadata")
            .eq("client_id", client.id)
            .eq("lead_id", lead.id)
            .in("event_type", TRACKED_ONLY_SKIP_EVENTS)
            .gte("created_at", new Date(latestMs - TRACKED_ONLY_MATCH_BEFORE_MS).toISOString())
            .lte("created_at", new Date(latestMs + TRACKED_ONLY_MATCH_AFTER_MS).toISOString())
            .limit(10);
          if (trackedOnlyErr) {
            // Fail CLOSED. Rescuing on a failed read is how the backlog bomb
            // starts cold-opening people again; a skipped tick costs 5 minutes
            // and the ledger monitor still escalates a silence nothing explains.
            console.error("[sweep] tracked-only skip lookup failed:", lead.id, trackedOnlyErr.message);
            continue;
          }
          const explainedByOwner = (trackedOnlyEvents ?? []).some((e) => {
            const loggedText = (e.metadata as { text?: string } | null)?.text;
            // Legacy rows carry no text — the timestamp window is all they have.
            if (!loggedText) return true;
            if (latest.content === loggedText) return true;
            // Prefix matching exists ONLY to undo the 120-char truncation, and
            // it has to stay that narrow (review 2026-08-09): in a burst "hey"
            // is a prefix of "hey you there? whats the price", so a loose
            // prefix let the first bubble's skip event suppress the rescue of
            // the later bubble carrying the lead's actual question.
            return (
              loggedText.length === TRACKED_ONLY_TEXT_LIMIT &&
              latest.content.startsWith(loggedText)
            );
          });
          if (explainedByOwner) continue;

          if (ageMs > MAX_AGE_MS) {
            await pingExpired(client, lead, Math.round(ageMs / 3600_000));
            expiredPinged++;
            continue;
          }

          // In-flight guard: the live webhook path may already be generating a
          // reply for this lead right now. Harmless pre-filter only — the reply
          // engine's own lock is the atomic guarantee against a double reply.
          if (lead.reply_lock_at) {
            const lockAgeMs = now - new Date(lead.reply_lock_at).getTime();
            if (lockAgeMs < LOCK_TTL_MS) continue;
          }

          const ban = await findActiveBan(client.id, {
            ghl_contact_id: lead.ghl_contact_id,
            ig_username: lead.ig_username,
          });
          if (ban) continue;

          const rateLimited = await recentEventExists({
            client_id: client.id,
            lead_id: lead.id,
            event_type: "rate_limit_lead_hold",
            since_iso: new Date(now - 3600_000).toISOString(),
          });
          if (rateLimited) continue;

          // The live webhook path reads the stop tag straight off its GHL
          // payload; this sweep has no such payload, so it checks whether we
          // already SAW one recently instead (a fresh tag the owner just added
          // slips past this the same way it slips past every other best-effort
          // gate in the system — the next real inbound catches it).
          const stopTagged = await recentEventExists({
            client_id: client.id,
            lead_id: lead.id,
            event_type: "skip_stop_tag",
            since_iso: new Date(new Date(latest.created_at).getTime() - 2 * 60_000).toISOString(),
          });
          if (stopTagged) continue;

          const recentlyAttempted = await recentEventExists({
            client_id: client.id,
            lead_id: lead.id,
            event_type: "sweep_reply_attempt",
            since_iso: new Date(now - ATTEMPT_BACKOFF_MS).toISOString(),
          });
          if (recentlyAttempted) continue;

          // Never START an attempt we can't finish: earlier passes can eat time out of
          // the 60s budget, and an attempt killed mid-flight still burns the
          // 30-min backoff (its attempt event is logged before the pipeline
          // runs) — a slow tick used to cost a lead half an hour of silence.
          if (Date.now() - startedAt > 40_000) break;

          eligibleCount++;
          attempted++;
          attempts.push(
            (async () => {
              await logEvent({
                client_id: client.id,
                lead_id: lead.id,
                event_type: "sweep_reply_attempt",
                metadata: { lead_message_age_ms: ageMs },
              });
              // Run the FULL pipeline, not the bare reply engine: the lead-magnet
              // gate (e.g. "reply BDP") must fire on a swept message exactly like
              // a live one. Live case: a keyword reply the live path mishandled
              // was later swept — and got the generic brain opener instead of the
              // book flow, because this call used to go straight to the brain.
              // debounceMs ~1s: the message is minutes old, there is no burst
              // left to coalesce, and the configured reply delay was pushing
              // rescues into the 60s kill zone.
              await runLeadPipeline({
                client,
                lead,
                inboundMessageId: latest.id,
                messageText: latest.content,
                debounceMs: 1_000,
              });
              const after = (await getRecentMessages(lead.id, 1))[0];
              if (after?.role === "ai") {
                sent++;
                await logEvent({ client_id: client.id, lead_id: lead.id, event_type: "sweep_reply_sent" });
              }
            })()
          );

        } catch (err) {
          // One bad candidate (a transient query error, a throwing gate) must
          // only cost THAT lead this tick — never the rest of the batch.
          console.error("[sweep] candidate check failed — skipping lead:", lead.id, err);
        }
      }

      await Promise.allSettled(attempts);
    }

    // ── SECOND SECTION: cold-lead follow-up drafts to Telegram (3d + 7d) ──
    // These leads are OUTSIDE Instagram's 24h automation window, so nothing is
    // ever sent to the lead from here — the owner gets the setter-brain draft in a
    // tap-to-copy block and sends it himself from the IG app.
    for (const client of clients) {
      try {
        const hour = clientLocalHour(client.timezone);
        if (hour < 8 || hour >= 22) continue; // only during the client's waking hours

        const now = Date.now();
        const { data: coldRows, error: coldErr } = await supabase
          .from("leads")
          .select("*")
          .eq("client_id", client.id)
          .eq("screened", true)
          .eq("ai_paused", false)
          .not("followup_paused", "is", true)
          .in("status", ["new", "engaged"])
          .gte("last_message_at", new Date(now - 8 * 86400_000).toISOString())
          .lte("last_message_at", new Date(now - 3 * 86400_000).toISOString())
          .order("last_message_at", { ascending: true })
          .limit(50);
        if (coldErr) {
          console.error("[sweep] cold candidate query failed:", client.slug, coldErr);
          continue;
        }

        let draftedThisRun = 0;
        for (const lead of (coldRows ?? []) as Lead[]) {
          if (draftedThisRun >= MAX_COLD_DRAFTS_PER_RUN) break;
          // Time budget: the unanswered-leads section above can eat most of the
          // 60s function limit. Never start a draft we might not finish — a
          // kill mid-send is what re-pings; the next 5-min tick picks it up.
          if (Date.now() - startedAt > 45_000) break;
          try {
            // WE must have spoken last — a lead-last thread belongs to the
            // unanswered sweep above, not here. Our message is the ANCHOR.
            // Instant acks don't count as us speaking: an "ack sent, brain
            // died" thread is OUR unanswered failure, and drafting a "you went
            // quiet" follow-up for it blames the lead for our silence.
            const tail = await getRecentMessages(lead.id, 5);
            let latest = undefined as (typeof tail)[number] | undefined;
            for (let i = tail.length - 1; i >= 0; i--) {
              const m = tail[i];
              if (m.role === "ai" && m.model_used === INSTANT_ACK_TAG) continue;
              latest = m;
              break;
            }
            if (!latest || (latest.role !== "ai" && latest.role !== "human")) continue;
            const anchorIso = latest.created_at;
            const quietMs = now - new Date(anchorIso).getTime();

            const mark = COLD_MARKS.find((m) => quietMs >= m.ms);
            if (!mark) continue;
            if (await coldDraftAlreadySent(lead.id, mark.key, anchorIso)) continue;

            const ban = await findActiveBan(client.id, {
              ghl_contact_id: lead.ghl_contact_id,
              ig_username: lead.ig_username,
            });
            if (ban) continue;

            // The setter's real brain composes the exact follow-up it would
            // send. Any drafting failure just skips this lead this tick.
            const draft = await draftReplyForLead({
              client: client as unknown as Record<string, unknown> & { id: string },
              lead,
              followUp: { daysQuiet: mark.days },
            });
            if (!draft.text.trim()) continue;

            // Claim the mark BEFORE sending (kill-safe: a timeout between the
            // two Telegram sends must not re-ping every subsequent tick). If
            // BOTH sends then fail, release the claim so it re-arms.
            const { data: claimRow, error: claimErr } = await supabase
              .from("events")
              .insert({
                client_id: client.id,
                lead_id: lead.id,
                event_type: "cold_draft_sent",
                metadata: { mark: mark.key, anchor: anchorIso, chars: draft.text.length },
              })
              .select("id")
              .single();
            if (claimErr || !claimRow) continue; // couldn't claim → next tick retries

            const name = leadLabel(lead, "A lead");
            const days = Math.floor(quietMs / 86400_000);
            const link = ghlContactLink(client.ghl_location_id ?? "", lead.ghl_contact_id ?? "");
            const ping = await sendTelegramPing(
              `🧊 ${name} went quiet ${days} days ago (stage: ${draft.stage || lead.funnel_stage || "unknown"}). Copy the follow-up below and send it from the IG app:${link ? `\n${link}` : ""}`,
              true,
              { leadId: lead.id, clientId: client.id, kind: "cold_draft" }
            );
            // The header was an EMPTY STRING, so this block carried no name, no
            // reference, no link and no recorded subject - and it is the LAST of
            // the two messages sent per cold lead, which makes it the one he
            // actually taps reply on.
            const block = await sendTelegramCopyBlock(
              leadLabel(lead, "this lead"),
              draft.text,
              { leadId: lead.id, clientId: client.id, kind: "cold_draft" }
            );
            if (!ping.success && !block.success) {
              await supabase.from("events").delete().eq("id", claimRow.id)
                .then(undefined, (e) => console.error("[sweep] cold claim release failed:", e));
              continue;
            }
            draftedThisRun++;
            coldDrafts++;
          } catch (err) {
            console.error("[sweep] cold draft failed — skipping lead:", lead.id, err);
          }
        }
      } catch (err) {
        console.error("[sweep] cold-draft section failed for client:", client.slug, err);
      }
    }

    // A SWEEP THAT SENDS NOTHING SHOULD SAY WHY (incident 2026-08-16). During
    // the credit outage this line went out unchanged every 35 minutes -
    // "Sweep caught 1 unanswered lead(s), 0 got a reply" - four times, with no
    // hint that the account was dead, while the ledger alarm that WOULD have
    // said so had already closed its row and gone quiet after one message. A
    // sweep that attempted work and sent nothing is either a silent outage or
    // nothing at all, and those must not look identical.
    if (attempted > 0) {
      let why = "";
      if (sent === 0) {
        const { data: recent } = await supabase
          .from("events")
          .select("metadata")
          .eq("event_type", "llm_account_down")
          .gte("created_at", new Date(Date.now() - 60 * 60_000).toISOString())
          .order("created_at", { ascending: false })
          .limit(1);
        const msg = (recent ?? [])[0] as { metadata: { message?: string } | null } | undefined;
        if (msg) {
          why = ` Nothing can reply: ${String(msg.metadata?.message || "the AI account is refusing requests").slice(0, 220)}`;
        }
      }
      await sendTelegramPing(`Sweep caught ${attempted} unanswered lead(s), ${sent} got a reply.${why}`);
    }

    return NextResponse.json({ ok: true, attempted, sent, expired_pinged: expiredPinged, cold_drafts: coldDrafts, scanned, ledger });
  } catch (err) {
    console.error("[sweep] failed:", err);
    return NextResponse.json({ ok: false, attempted, sent, expired_pinged: expiredPinged, cold_drafts: coldDrafts, scanned, ledger });
  }
}
