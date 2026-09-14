/**
 * ============================================================================
 * INBOX READ-BACK — "did it SHOW UP in the inbox where the conversation is
 * held, yes or no. THEN it means it was sent. That is it."  (the owner, 2026-08-12)
 * ============================================================================
 *
 * Everything before this module INFERS delivery from the sender's answer:
 * ManyChat's HTTP status plus its body verdict. That is the transmitter's
 * receipt, not the inbox. This module closes the loop from the OTHER side: it
 * reads the real Instagram conversation back and confirms our words are
 * actually sitting in it.
 *
 * THE READABLE MIRROR. ManyChat has no message-history read API, but
 * GoHighLevel is connected to the same Instagram account and its conversations
 * API surfaces the same DM thread — every message, both directions, whoever
 * sent it. That thread IS "the inbox field where the conversation is held",
 * fetched through the one API we can read. (GHL never sends anything; it is
 * the CRM and, here, the witness.)
 *
 * PHYSICS, MEASURED NOT ASSUMED (see conversation-sync.ts): the GHL mirror
 * lags 10-105s behind ManyChat and has been observed to drop individual
 * bubbles outright. Two consequences are load-bearing:
 *
 *   1. PRESENCE is proof of delivery. ABSENCE, alone, is not proof of failure.
 *      A bubble missing from the mirror seconds after a send is usually just
 *      the lag; a bubble missing forever might still have reached Instagram
 *      (mirror drop). Auto-resending on bare absence would double-text real
 *      people, which is its own broken promise.
 *   2. So absence only counts once the mirror PROVABLY MOVED PAST the send:
 *      it contains some OTHER message stamped comfortably after ours went
 *      out, and ours still is not there. That is the strongest "it never
 *      showed up" evidence this side of Instagram's own servers, and only
 *      THAT flips a bubble back to undelivered — at which point the existing
 *      exact-words resend delivers it, automatically.
 *
 * Three hooks, one truth:
 *   - verifyReplyInInbox   — INLINE, right after a reply's volley: re-reads
 *                            the thread (with short waits for the mirror) and
 *                            stamps inbox_verified_at on every bubble it can
 *                            see. Most sends are proven delivered before the
 *                            invocation ends.
 *   - stampVerifiedFromThread — FREE verification on every conversation-sync:
 *                            the thread was already fetched for the turn, so
 *                            unverified bubbles get checked at zero API cost.
 *   - reconcileInboxTruth  — the auditor, run from the sweep: stamps late
 *                            arrivals, and applies the proven-absent rule
 *                            above so a genuinely vanished bubble becomes the
 *                            resend's work order within minutes.
 *
 * Everything here is BEST-EFFORT and NON-THROWING. Verification can only ever
 * add certainty; a GHL blip must never break a reply that already went out.
 * Nothing in this file sends anything.
 * ============================================================================
 */

import { supabase, echoKey, logEvent, type Client, type Lead } from "./supabase";
import { fetchContactThread, type ThreadMessage } from "./ghl";
import { INSTANT_ACK_TAG } from "./instant-ack";

/** GHL stamps messages with its own clock; allow it to disagree with ours. */
const MIRROR_SKEW_MS = 5 * 60_000;
/** Absence proof: the mirror must hold some OTHER message at least this far
 *  after our send, and still not ours, before "vanished" can be concluded. */
const PROOF_MARGIN_MS = 2 * 60_000;
/** Never conclude "vanished" on a bubble younger than this — the mirror's own
 *  observed worst-case lag (105s) plus headroom. */
const PROVEN_ABSENT_MIN_AGE_MS = 10 * 60_000;
/** Verification only looks at recent history; ancient rows are settled. */
const VERIFY_LOOKBACK_MS = 24 * 3600_000;
/** Inline wait plan between mirror reads. Short on purpose: whatever the
 *  invocation can't confirm, conversation-sync and the sweep confirm later. */
const INLINE_WAITS_MS = [7_000, 12_000];

/** Rows that, even when proven vanished, must never be flipped back to
 *  undelivered: the exact-words resend excludes them (a late duplicate of a
 *  time-triggered touch is pure noise), so flipping them buys nothing and
 *  corrupts their engines' own bookkeeping. Mirror of resend-undelivered.ts. */
const NEVER_FLIP_TAGS = new Set<string>([
  INSTANT_ACK_TAG,
  "followup_engine",
  "followup_engine_voice",
  "nurture_engine",
  "lead_magnet",
  "manychat_handoff",
]);

export type VerifiableRow = {
  id: string;
  content: string;
  created_at: string;
  delivered_at: string | null;
  delivery?: string | null; // 'voice' when the bubble went out as a voice note
  model_used?: string | null;
};

function sentAtMs(row: VerifiableRow): number {
  const ms = new Date(row.delivered_at ?? row.created_at).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function threadMs(m: ThreadMessage): number {
  const ms = new Date(m.created_at).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Match our sent bubbles against the mirror thread.
 *
 * A mirror message can vouch for at most ONE row (a volley that says "yo"
 * twice needs two mirror hits, not one counted twice). Text bubbles match on
 * normalised words; a voice bubble has no words in the mirror, so it matches
 * an outbound media message instead. Every match is time-fenced: only mirror
 * messages stamped at-or-after the send (minus clock skew) count, so last
 * week's identical "yo bro" can never confirm today's.
 */
export function matchRowsAgainstThread(
  rows: VerifiableRow[],
  thread: ThreadMessage[]
): { confirmed: VerifiableRow[]; missing: VerifiableRow[] } {
  const confirmed: VerifiableRow[] = [];
  const missing: VerifiableRow[] = [];
  const used = new Set<number>();
  const outbound = thread
    .map((m, idx) => ({ m, idx }))
    .filter(({ m }) => m.direction === "outbound");

  const ordered = [...rows].sort((a, b) => sentAtMs(a) - sentAtMs(b));
  for (const row of ordered) {
    const floor = sentAtMs(row) - MIRROR_SKEW_MS;
    const wantVoice = row.delivery === "voice";
    const key = echoKey(row.content);
    const hit = outbound.find(({ m, idx }) => {
      if (used.has(idx)) return false;
      if (threadMs(m) < floor) return false;
      if (wantVoice) {
        // The mirror shows our voice note as a bodyless media message.
        // A voice bubble that FELL BACK to text still matches by words below.
        if (m.is_media) return true;
        return !m.is_media && key !== "" && echoKey(m.content) === key;
      }
      return !m.is_media && key !== "" && echoKey(m.content) === key;
    });
    if (hit) {
      used.add(hit.idx);
      confirmed.push(row);
    } else {
      missing.push(row);
    }
  }
  return { confirmed, missing };
}

/** Stamp rows as seen-in-the-inbox. First stamp wins; never overwrites. */
async function stampInboxVerified(rowIds: string[]): Promise<void> {
  if (!rowIds.length) return;
  await supabase
    .from("messages")
    .update({ inbox_verified_at: new Date().toISOString() })
    .in("id", rowIds)
    .is("inbox_verified_at", null)
    .then(undefined, (e) => console.error("[inbox-verify] stamp failed:", e));
}

/** Read the mirror thread, or null when it cannot be read (no creds, no
 *  contact, API failure). null is "unreadable", NOT "empty" — the distinction
 *  is load-bearing everywhere below AND in the resend backstop (which must
 *  never blindly re-send an attempted bubble it cannot check). */
export async function readMirror(client: Client, lead: Lead): Promise<ThreadMessage[] | null> {
  const apiKey = client.ghl_api_key;
  const locationId = client.ghl_location_id;
  const contactId = lead.ghl_contact_id;
  if (!apiKey || !locationId || !contactId) return null;
  try {
    return await fetchContactThread(apiKey, locationId, contactId);
  } catch (e) {
    console.error("[inbox-verify] mirror read failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

export type InlineVerifyResult = {
  verdict: "confirmed" | "partial" | "unconfirmed" | "unreadable";
  verified: number;
  of: number;
};

/**
 * INLINE READ-BACK, called by the reply engine the moment its volley finishes.
 *
 * Checks immediately, then re-checks after short waits so the mirror's normal
 * lag has a chance to surface the bubbles. Whatever is confirmed gets stamped
 * inbox_verified_at on the spot. Whatever is not confirmed here is NOT acted
 * on — see the module header: bare absence proves nothing this soon. The
 * later hooks finish the job.
 *
 * Never throws; safe to be killed mid-wait (stamps land per check).
 */
export async function verifyReplyInInbox(params: {
  client: Client;
  lead: Lead;
  rows: VerifiableRow[];
  /** Spend no waits past this moment (the serverless budget's edge). */
  deadlineMs?: number;
}): Promise<InlineVerifyResult> {
  const { client, lead } = params;
  let remaining = params.rows.filter((r) => r.id && (r.content?.trim() || r.delivery === "voice"));
  const of = remaining.length;
  if (!of) return { verdict: "confirmed", verified: 0, of: 0 };

  let sawMirror = false;
  let verified = 0;

  try {
    for (let attempt = 0; attempt <= INLINE_WAITS_MS.length; attempt++) {
      if (attempt > 0) {
        const wait = INLINE_WAITS_MS[attempt - 1];
        if (params.deadlineMs && Date.now() + wait > params.deadlineMs) break;
        await new Promise((r) => setTimeout(r, wait));
      }
      const thread = await readMirror(client, lead);
      if (thread === null) continue; // unreadable this attempt; try again after a wait
      sawMirror = true;
      const { confirmed, missing } = matchRowsAgainstThread(remaining, thread);
      if (confirmed.length) {
        await stampInboxVerified(confirmed.map((r) => r.id));
        verified += confirmed.length;
      }
      remaining = missing;
      if (!remaining.length) break;
    }

    const verdict: InlineVerifyResult["verdict"] = !sawMirror
      ? "unreadable"
      : remaining.length === 0
        ? "confirmed"
        : verified > 0
          ? "partial"
          : "unconfirmed";

    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "reply_inbox_check",
      metadata: { verdict, verified, of },
    }).catch(() => { /* observability only */ });

    return { verdict, verified, of };
  } catch (e) {
    console.error("[inbox-verify] inline verify failed:", e);
    return { verdict: "unreadable", verified, of };
  }
}

/** The delivered-but-unverified recent AI bubbles for a lead. */
async function unverifiedRows(leadId: string): Promise<VerifiableRow[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, content, created_at, delivered_at, delivery, model_used")
    .eq("lead_id", leadId)
    .eq("role", "ai")
    .not("delivered_at", "is", null)
    .is("inbox_verified_at", null)
    .gte("created_at", new Date(Date.now() - VERIFY_LOOKBACK_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) {
    console.error("[inbox-verify] unverified read failed:", error.message);
    return [];
  }
  return (data ?? []) as VerifiableRow[];
}

/**
 * FREE VERIFICATION on an already-fetched thread (conversation-sync calls
 * this with the thread it just pulled for the turn). Stamps only; never
 * flips anything — sync's contract is that it can never break a reply.
 */
export async function stampVerifiedFromThread(leadId: string, thread: ThreadMessage[]): Promise<number> {
  try {
    const rows = await unverifiedRows(leadId);
    if (!rows.length) return 0;
    const { confirmed } = matchRowsAgainstThread(rows, thread);
    await stampInboxVerified(confirmed.map((r) => r.id));
    return confirmed.length;
  } catch (e) {
    console.error("[inbox-verify] thread stamp failed:", e);
    return 0;
  }
}

export type ReconcileResult = {
  verified: number;
  vanished: number;
  /** True when the audit actually read the mirror (there was something to
   *  check). The sweep budgets its GHL traffic on this, not on results. */
  fetched: boolean;
};

/**
 * THE AUDITOR, run from the sweep for leads with unverified recent sends.
 *
 * Stamps everything the mirror now shows, then applies the proven-absent
 * rule: a bubble ManyChat swore it sent, old enough that the mirror's
 * worst-case lag is long past, missing from a mirror that has PROVABLY moved
 * past the send moment (some other message sits comfortably after it) is
 * flipped back to undelivered — which is exactly the shape the exact-words
 * resend heals on this same sweep tick. Time-triggered rows are never
 * flipped (see NEVER_FLIP_TAGS); their vanish is logged for visibility only.
 */
export async function reconcileInboxTruth(params: {
  client: Client;
  lead: Lead;
}): Promise<ReconcileResult> {
  const { client, lead } = params;
  const out: ReconcileResult = { verified: 0, vanished: 0, fetched: false };
  try {
    const rows = await unverifiedRows(lead.id);
    if (!rows.length) return out;

    out.fetched = true;
    const thread = await readMirror(client, lead);
    if (thread === null) return out; // unreadable: no stamps, and NEVER a flip

    const { confirmed, missing } = matchRowsAgainstThread(rows, thread);
    if (confirmed.length) {
      await stampInboxVerified(confirmed.map((r) => r.id));
      out.verified = confirmed.length;
    }

    if (!missing.length) return out;
    const newestMirrorMs = thread.reduce((acc, m) => Math.max(acc, threadMs(m)), 0);
    const now = Date.now();

    for (const row of missing) {
      const at = sentAtMs(row);
      if (!at || now - at < PROVEN_ABSENT_MIN_AGE_MS) continue;
      // The mirror must have processed PAST this send and still not show it.
      if (newestMirrorMs < at + PROOF_MARGIN_MS) continue;

      const flippable = !NEVER_FLIP_TAGS.has(row.model_used ?? "");
      if (flippable) {
        const { error } = await supabase
          .from("messages")
          .update({ delivered_at: null })
          .eq("id", row.id)
          .is("inbox_verified_at", null);
        if (error) {
          console.error("[inbox-verify] vanish flip failed:", error.message);
          continue;
        }
      }
      out.vanished++;
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "message_vanished_from_inbox",
        metadata: {
          message_id: row.id,
          sent_at: row.delivered_at,
          resend_eligible: flippable,
          preview: (row.content || "").slice(0, 80),
        },
      }).catch(() => { /* observability only */ });
    }
    return out;
  } catch (e) {
    console.error("[inbox-verify] reconcile failed:", e);
    return out;
  }
}
