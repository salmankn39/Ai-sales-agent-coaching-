/**
 * RESEND UNDELIVERED TAIL — recover bubbles the setter wrote but never sent.
 *
 * A multi-bubble reply is saved to the DB first, then sent as a paced sequence.
 * If the platform kills the invocation mid-sequence (Vercel's 60s ceiling —
 * hit live when debounce + quiet window + generation + pacing stacked up), the
 * bubbles already sent are marked delivered (per-bubble stamping, ghl.ts
 * onSent), but the TRAILING bubbles — which usually include the QUESTION —
 * were never sent and stay delivered_at = null. The lead's turn just ends on a
 * flat statement with no ask, and momentum dies (live: Love, 2026-07-10 — the
 * money question "how much do you need to be making a month" was written but
 * guillotined).
 *
 * This resends exactly those: the run of AI bubbles at the very TAIL of the
 * thread (nothing from the lead after them) that are still undelivered. It is
 * SAFE against double-sends because per-bubble stamping means a delivered
 * bubble is never null, and because time-triggered sends (acks, follow-ups,
 * nurture, magnet) are excluded outright — see NEVER_RESEND_TAGS.
 * Best-effort; returns the count actually resent.
 */
import {
  getRecentMessages,
  markMessageDelivered,
  markMessageAttempted,
  setMessageGhlId,
  logEvent,
  type Client,
  type Lead,
  type DbMessage,
} from "./supabase";
import { sendLeadMixedSequence } from "./send";
import { readMirror, matchRowsAgainstThread } from "./delivery-verify";
import { INSTANT_ACK_TAG } from "./instant-ack";

// Rows this recovery must NEVER touch, matched on model_used.
//
// The whole mechanism rests on one assumption: delivered_at = null means the
// bubble never reached the lead. That holds for the REPLY engine, which stamps
// every bubble the instant it lands. It did NOT hold for the time-triggered
// engines, which send first and save once afterwards, leaving delivered_at
// null forever on a message the lead had already received. This recovery then
// read that null as a guillotined send and sent it a second time — 7 real
// people got the same follow-up twice, roughly 5 minutes apart.
//
// The root fix is saveMessage's `delivered` flag, which stamps those rows
// truthfully. This set is the second lock: even a new engine that forgets the
// flag, or a historical row written before it existed, can never be resent.
// A proactive touch is also simply not a tail worth recovering — it answered
// nothing, so a late duplicate is pure noise to the lead.
const NEVER_RESEND_TAGS = new Set<string>([
  INSTANT_ACK_TAG,
  "followup_engine",
  "followup_engine_voice",
  "nurture_engine",
  "lead_magnet",
  "manychat_handoff",
]);

// A bubble must be at least this old before we resend it — long enough that a
// still-running paced send (which can legitimately take ~30-40s) is never
// mistaken for a dropped one and double-sent.
const MIN_UNDELIVERED_AGE_MS = 60_000;
// Never resurrect ancient rows — only a recent kill is worth recovering.
const MAX_UNDELIVERED_AGE_MS = 30 * 60_000;

export async function resendUndeliveredTail(params: {
  client: Client;
  lead: Lead;
}): Promise<number> {
  const { client, lead } = params;
  if (lead.ai_paused) return 0;

  const history = (await getRecentMessages(lead.id, 20)) as DbMessage[];
  if (!history.length) return 0;

  // Walk from the newest backwards: collect the trailing AI bubbles, stop at
  // the first lead/human message. If ANY lead message is newer than an
  // undelivered AI bubble, that bubble is no longer the current tail — a fresh
  // reply is (or should be) in flight for the newer message, so we leave it.
  const tail: DbMessage[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "lead" || m.role === "human") break;
    tail.push(m);
  }
  tail.reverse(); // oldest-first, matching send order

  const now = Date.now();
  let undelivered = tail.filter((m) => {
    if (m.role !== "ai") return false;
    if (m.delivered_at) return false; // already reached the lead
    if (NEVER_RESEND_TAGS.has(m.model_used ?? "")) return false;
    const ageMs = now - new Date(m.created_at).getTime();
    return ageMs >= MIN_UNDELIVERED_AGE_MS && ageMs <= MAX_UNDELIVERED_AGE_MS;
  });
  if (!undelivered.length) return 0;

  // ── ATTEMPTED IS NOT UNDELIVERED (live incident 2026-08-13, Cody Brown) ──
  // A run killed at the platform ceiling can die WHILE a bubble's request is
  // in flight: Instagram delivers it, the response never returns, nothing gets
  // stamped. Blindly re-sending that bubble is how a real lead got the same
  // question twice. send_attempted_at (stamped right before each transport
  // call) splits the tail in two:
  //   - never attempted → the true guillotine case; resend exactly as always.
  //   - attempted, answer unknown → the request LEFT, so it probably arrived.
  //     Ask the inbox mirror when it is readable (presence settles it as
  //     delivered; proven absence clears it for resend). When the mirror is
  //     unreadable - every ManyChat-first lead - assume delivered and say so
  //     on the record (delivery_assumed_unconfirmed): a rare lost mid-volley
  //     bubble costs less than a certain duplicate, and a KNOWN send failure
  //     never gets here (its attempt stamp is cleared at result time).
  const attempted = undelivered.filter((m) => m.send_attempted_at);
  if (attempted.length) {
    const thread = await readMirror(client, lead);
    const settle: DbMessage[] = [];
    let resendable: DbMessage[] = [];
    if (thread === null) {
      settle.push(...attempted);
    } else {
      const { confirmed, missing } = matchRowsAgainstThread(
        attempted.map((m) => ({
          id: m.id,
          content: m.content,
          created_at: m.created_at,
          delivered_at: null,
          delivery: m.delivery ?? null,
          model_used: m.model_used ?? null,
        })),
        thread
      );
      const confirmedIds = new Set(confirmed.map((r) => r.id));
      settle.push(...attempted.filter((m) => confirmedIds.has(m.id)));
      const newestMirrorMs = thread.reduce(
        (acc, t) => Math.max(acc, new Date(t.created_at).getTime() || 0), 0
      );
      for (const m of attempted.filter((x) => !confirmedIds.has(x.id))) {
        const at = new Date(m.send_attempted_at as string).getTime();
        // Proven absent only once the mirror has visibly moved past the
        // attempt; a merely-lagging mirror defers to the next tick.
        if (newestMirrorMs >= at + 2 * 60_000) resendable = [...resendable, m];
      }
    }
    for (const m of settle) {
      await markMessageDelivered(m.id);
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "delivery_assumed_unconfirmed",
        metadata: { message_id: m.id, preview: (m.content || "").slice(0, 80) },
      }).catch(() => { /* observability only */ });
    }
    const resendableIds = new Set(resendable.map((m) => m.id));
    undelivered = undelivered.filter(
      (m) => !m.send_attempted_at || resendableIds.has(m.id)
    );
    if (!undelivered.length) return 0;
  }

  // Resend in order through the SAME channel as a normal reply — ManyChat, the
  // only channel there is. Per-bubble stamping marks each as it lands, so a
  // second kill mid-recovery still can't double-send.
  const results = await sendLeadMixedSequence({
    lead_id: lead.id,
    ghl_contact_id: lead.ghl_contact_id ?? "",
    full_name: lead.full_name ?? null,
    ig_username: lead.ig_username ?? null,
    manychat_token: client.manychat_api_token ?? null,
    manychat_subscriber_id: lead.manychat_subscriber_id ?? null,
    items: undelivered.map((m) => ({ message: m.content })),
    onSent: async (i, r) => {
      const row = undelivered[i];
      if (!row) return;
      if (r.ghl_message_id) await setMessageGhlId(row.id, r.ghl_message_id);
      await markMessageDelivered(row.id);
    },
    // The recovery volley can be mid-flight-killed exactly like a live one;
    // the stamp keeps a second sweep from double-sending what this one sent.
    onAttempt: async (i) => {
      const row = undelivered[i];
      if (row) await markMessageAttempted(row.id);
    },
  });

  const sent = results.filter((r) => r?.success).length;
  if (sent > 0) {
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "undelivered_tail_resent",
      metadata: { count: sent, of: undelivered.length },
    });
  }
  return sent;
}
