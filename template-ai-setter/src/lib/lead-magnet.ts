/**
 * ============================================================================
 * LEAD MAGNET FLOW — "reply BDP for the free book"
 * ============================================================================
 * A story/post CTA asks people to DM a keyword to get a free lead magnet
 * (right now: the "BDP" free book). This runs a tiny, FIXED, non-AI script
 * before the normal setter brain ever sees the lead:
 *
 *   1. keyword detected (first contact, no magnet state yet)
 *        -> send a canned "cool, drop your email" line
 *   2. next reply from that lead
 *        -> send the book link (best-effort: pull an email out of their
 *           reply for the GHL contact record, but never block on it)
 *        -> schedule the handoff 60-120s out
 *   3. once the handoff is due (flushed on webhook hits + the nurture cron)
 *        -> the real AI setter opens with its normal first line and takes
 *           over completely from there
 *
 * No email/GHL-form confirmation gates the handoff — it fires on a timer
 * regardless, per the operator's call. This module is fully additive: a lead
 * who never sends a magnet keyword is completely unaffected (magnet_state
 * stays null forever and handleLeadMagnet always returns "not_triggered").
 * ============================================================================
 */
import { supabase, saveMessage, logEvent, type Lead, type Client } from "./supabase";
import { sendLeadMessage } from "./send";
import { HANDOFF_OPENER } from "./manychat-handoff";
// The keyword + wording + link live in their own file so the student kit can
// ship an empty catalogue instead of somebody else's free book.
import { MAGNETS, defaultMagnetKey, type MagnetConfig } from "./lead-magnet-config";


/**
 * Damerau edit distance (tiny inputs — a 3-letter keyword vs one word). Counts
 * an adjacent letter SWAP as a single edit ("bpd" -> "bdp"), since transposition
 * is one of the most common phone-typing mistakes.
 */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[m][n];
}

/**
 * Does an inbound message trigger this magnet? Deliberately forgiving, because a
 * story CTA is a keyword people type from memory: case-insensitive, ignores
 * punctuation/emoji/spacing, and — for a SHORT bare reply (the shape of a
 * "reply BDP" answer) — tolerates a single-letter typo ("Pdp", "bdo", "bpd").
 * NOTE (operator decision 2026-07-08): a standalone keyword ANYWHERE in the
 * message triggers — even inside a long message or a shared-promo transcript.
 * A short length/media guard existed briefly and was reverted on his call.
 */
function keywordMatches(text: string, keyword: string): boolean {
  const kw = keyword.toLowerCase();
  const words: string[] = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (!words.length) return false;
  // Exact keyword as a standalone word, anywhere (e.g. "yo bdp please").
  if (words.includes(kw)) return true;
  // Whole message collapses to the keyword (e.g. "b.d.p", "B D P", "bdp!!").
  const collapsed = words.join("");
  if (collapsed === kw) return true;
  // Short bare reply (≤2 words) within one typo of the keyword — "Pdp" etc.
  if (words.length <= 2 && words.some((w) => Math.abs(w.length - kw.length) <= 1 && editDistance(w, kw) <= 1))
    return true;
  if (collapsed.length <= kw.length + 1 && editDistance(collapsed, kw) <= 1) return true;
  return false;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

// Handoff fires ~45-55s after the link — the operator wants the setter IN THE
// CHAT within 60s. Kept under a minute so the in-process timer (scheduled by
// the same invocation that sent the link, see advanceToLink) fits inside the
// 60s Vercel function budget; the every-minute pg_cron tick is the backstop
// for a crashed/killed invocation.
const HANDOFF_MIN_MS = 45_000;
const HANDOFF_MAX_MS = 55_000;
function handoffDelayMs(): number {
  return HANDOFF_MIN_MS + Math.random() * (HANDOFF_MAX_MS - HANDOFF_MIN_MS);
}

type LeadWithMagnet = Lead & {
  magnet_state?: string | null;
  magnet_keyword?: string | null;
};

export type MagnetOutcome = "handled" | "not_triggered";

function detectMagnet(text: string): { key: string; cfg: MagnetConfig } | null {
  for (const [key, cfg] of Object.entries(MAGNETS)) {
    if (keywordMatches(text, cfg.keyword)) return { key, cfg };
  }
  return null;
}

/** Test-only hooks (not part of the runtime API). */
export const __test = { detectMagnet, keywordMatches };

/**
 * MANUAL trigger — operator/admin lever (via /api/setter/diag POST) to put a
 * lead into the magnet flow when the automatic detection was missed (e.g. a
 * keyword typo handled before typo-tolerance shipped, or a lead the screener
 * mis-routed). 'ask_email' starts the flow (sends the email ask); 'send_link'
 * advances a lead already in the flow (sends the book link + schedules the
 * timed handoff), with `text` treated as their email-bearing reply.
 */
export async function manualTriggerMagnet(params: {
  client: Client;
  lead: Lead;
  mode: "ask_email" | "send_link";
  keyword?: string;
  text?: string;
}): Promise<{ ok: boolean; note: string }> {
  const { client, lead, mode } = params;
  const key = params.keyword && MAGNETS[params.keyword] ? params.keyword : defaultMagnetKey();
  if (!key) return { ok: false, note: "no lead magnets are set up (see lib/lead-magnet-config.ts)" };
  if (mode === "ask_email") {
    await startMagnet(client, lead, key, MAGNETS[key]);
    return { ok: true, note: `magnet '${key}' started (awaiting_email)` };
  }
  await advanceToLink(client, { ...(lead as LeadWithMagnet), magnet_keyword: key }, params.text ?? "");
  return { ok: true, note: `magnet '${key}' link sent (awaiting_handoff)` };
}

async function send(client: Client, lead: Lead, text: string): Promise<void> {
  // ONE DOOR (2026-08-09). This used to call ManyChat directly and keep
  // sendLeadMessage only as a GHL fallback, which was a leftover from the era
  // when GHL could still send. The direct call skipped the chokepoint entirely,
  // and the chokepoint is where the outbound scrub, the internal-text tripwire
  // and the live kill switch live — so a magnet message could go out after
  // The owner switched the setter off, carrying text nothing had checked. GHL
  // cannot send at all anymore, so there is nothing left to fall back TO: the
  // whole branch was dead weight hiding a hole.
  const res = await sendLeadMessage({
    client_id: client.id,
    lead_id: lead.id,
    manychat_token: client.manychat_api_token,
    manychat_subscriber_id: lead.manychat_subscriber_id,
    ghl_contact_id: lead.ghl_contact_id,
    full_name: lead.full_name,
    ig_username: lead.ig_username,
    message: text,
  });
  if (!res.success) return;
  const ghlMessageId = res.ghl_message_id;
  await saveMessage({
    lead_id: lead.id,
    client_id: client.id,
    role: "ai",
    content: text,
    channel: "instagram",
    ghl_message_id: ghlMessageId,
    model_used: "lead_magnet",
    // Only reached after a confirmed send, so stamp it — an unstamped row is a
    // resend candidate (see saveMessage's `delivered`).
    delivered: true,
  });
}

async function startMagnet(client: Client, lead: Lead, key: string, cfg: MagnetConfig): Promise<void> {
  await send(client, lead, cfg.askEmail);
  await supabase.from("leads").update({ magnet_state: "awaiting_email", magnet_keyword: key }).eq("id", lead.id);
  await logEvent({ client_id: client.id, lead_id: lead.id, event_type: "lead_magnet_triggered", metadata: { keyword: key } });
}

async function advanceToLink(client: Client, lead: LeadWithMagnet, text: string): Promise<void> {
  const key = lead.magnet_keyword ?? defaultMagnetKey();
  const cfg = (key && MAGNETS[key]) || null;
  // A lead cannot be mid-flow for a magnet that no longer exists, but if the
  // catalogue was edited underneath them, stop rather than send a broken link.
  if (!cfg) return;

  // Best-effort email pull — never blocks sending the link either way. Saved
  // ONLY in our own DB. Deliberately NOT written to the GHL contact: per the
  // operator, the flow just continues on seeing an email — no GHL lookups or
  // writes — and a GHL email write can trigger GHL's dedupe-merge, which is
  // part of the duplicate-contact churn.
  const match = text.match(EMAIL_RE);
  const email = match ? match[0] : null;
  if (email) {
    await supabase
      .from("leads")
      .update({ magnet_email: email, ...(lead.email ? {} : { email }) })
      .eq("id", lead.id);
  }

  await send(client, lead, cfg.linkMessage(cfg.link));

  const delayMs = handoffDelayMs();
  const handoffAt = new Date(Date.now() + delayMs).toISOString();
  await supabase
    .from("leads")
    .update({
      magnet_state: "awaiting_handoff",
      magnet_link_sent_at: new Date().toISOString(),
      magnet_handoff_at: handoffAt,
    })
    .eq("id", lead.id);

  await logEvent({
    client_id: client.id,
    lead_id: lead.id,
    event_type: "lead_magnet_link_sent",
    metadata: { keyword: key, email_captured: !!email, handoff_at: handoffAt },
  });

  // PRIMARY handoff driver: THIS invocation stays alive (waitUntil) and fires
  // the flush the moment the delay passes — the setter is in the chat ~45-55s
  // after the link, guaranteed, instead of waiting for the next cron tick
  // (which is only the backstop for a crashed invocation). The flush's atomic
  // claim makes a double-fire with the cron impossible.
  try {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(
      (async () => {
        await new Promise((r) => setTimeout(r, delayMs + 1_000));
        await flushLeadMagnetHandoffs();
      })()
    );
  } catch (e) {
    // Outside a Vercel request context (tests/local) — the cron backstop owns it.
    console.error("[lead-magnet] in-process handoff timer unavailable:", e);
  }
}

/**
 * Gate + drive the lead-magnet flow. Call this BEFORE the ManyChat handoff
 * gate / screener / reply-engine — "handled" means this inbound is fully
 * dealt with (no further pipeline steps should run for it this turn).
 */
export async function handleLeadMagnet(params: {
  client: Client;
  lead: Lead;
  text: string;
}): Promise<MagnetOutcome> {
  const { client, lead, text } = params;
  const l = lead as LeadWithMagnet;
  const state = l.magnet_state ?? null;

  // Timer already scheduled — stay silent, the flush pass will open for real.
  if (state === "awaiting_handoff") return "handled";

  if (state === "awaiting_email") {
    await advanceToLink(client, l, text);
    return "handled";
  }

  // Terminal state ("handed_off"): the person already completed the flow. If
  // they send the KEYWORD again they want the link again (lost it / testing) —
  // resend it and stop this turn, but do NOT restart the email ask or the
  // handoff timer: the real setter already owns this conversation. Anything
  // that isn't the keyword is fully normal from here. (Live: a completed lead
  // re-sent "BDP" and got a stage question instead of the book, 2026-07-10.)
  if (state) {
    const rehit = detectMagnet(text);
    if (rehit) {
      await send(client, lead, rehit.cfg.linkMessage(rehit.cfg.link));
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "lead_magnet_link_resent",
        metadata: { keyword: rehit.key },
      });
      return "handled";
    }
    return "not_triggered";
  }

  const hit = detectMagnet(text);
  if (!hit) return "not_triggered";

  await startMagnet(client, lead, hit.key, hit.cfg);
  return "handled";
}

/**
 * FLUSH — fire the real setter's opener for every lead-magnet handoff that's
 * due. Called from the webhook (active hours) and the nurture cron tick
 * (belt+suspenders for quiet hours) — deliberately independent of
 * clients.nurture_enabled, since this handoff is a core flow, not the
 * optional nurture add-on.
 *
 * Each row is claimed atomically (awaiting_handoff -> handed_off) before
 * sending, so concurrent flushes can never double-send the opener.
 */
export async function flushLeadMagnetHandoffs(): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    const { data: due } = await supabase
      .from("leads")
      .select("id, client_id")
      .eq("magnet_state", "awaiting_handoff")
      .lte("magnet_handoff_at", nowIso)
      .limit(40);

    for (const row of (due ?? []) as { id: string; client_id: string }[]) {
      const { data: claimedRows } = await supabase
        .from("leads")
        .update({ magnet_state: "handed_off" })
        .eq("id", row.id)
        .eq("magnet_state", "awaiting_handoff")
        .select("*");
      const lead = (claimedRows ?? [])[0] as Lead | undefined;
      if (!lead) continue; // someone else claimed it

      // Fire-time gates (the state was set 1-2 min ago; things can change):
      // a paused lead or a globally-OFF setter must NOT get the opener. The
      // claim above already flipped the state to handed_off, so a skipped
      // handoff never re-fires — the normal pipeline owns the lead from here.
      if (lead.ai_paused) {
        await logEvent({ client_id: row.client_id, lead_id: lead.id, event_type: "lead_magnet_handoff_skipped", metadata: { reason: "ai_paused" } });
        continue;
      }
      const { data: clientRow } = await supabase.from("clients").select("*").eq("id", row.client_id).maybeSingle();
      const client = clientRow as Client | null;
      // The opener needs SOME channel: GHL when the lead has a contact, else
      // the ManyChat channel (a ManyChat-first lead may still be contactless).
      const canGhl = Boolean(client?.ghl_api_key && client?.ghl_location_id && lead.ghl_contact_id);
      const canManychat = Boolean(client?.manychat_api_token && lead.manychat_subscriber_id);
      if (!client || (!canGhl && !canManychat)) continue;
      if (!client.is_active) {
        await logEvent({ client_id: client.id, lead_id: lead.id, event_type: "lead_magnet_handoff_skipped", metadata: { reason: "setter_off" } });
        continue;
      }

      await send(client, lead, HANDOFF_OPENER);
      await logEvent({ client_id: client.id, lead_id: lead.id, event_type: "lead_magnet_handoff_sent", metadata: {} });
    }
  } catch (err) {
    console.error("[lead-magnet] flushLeadMagnetHandoffs failed:", err);
  }
}
