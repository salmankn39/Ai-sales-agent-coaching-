/**
 * ============================================================================
 * THE SEND CHOKEPOINT — every message to a lead leaves through ManyChat
 * ============================================================================
 * The owner, 2026-07-26: "NO NO GHL AT ALL!!!! just pretend as if ghl cant send
 * msgs or anything!!! imagine if we were only using manychat!!!! and ghl
 * happens to be our crm like hubspot or monday."
 *
 * So GoHighLevel has no send surface left in this codebase. Not as a primary,
 * not as a fallback, not for a stray follow-up image. GHL is the CRM: contacts,
 * tags, calendar, opportunities, pipeline stages. It does not talk to leads.
 *
 * THE EVIDENCE THAT THIS COSTS NOTHING. Before cutting the fallback I pulled
 * every failed ManyChat send in the system's history — 37 of them:
 *   - 36 were HTTP 401 "Only account with integrations ability can use API",
 *     all before 2026-07-10. That was the free ManyChat plan. The account is
 *     Pro now, so that entire class is gone.
 *   - 1 was Instagram error 3031: "Subscriber's last interaction was more than
 *     24 hours ago." That is a META platform rule, not a ManyChat limitation —
 *     GoHighLevel is bound by the exact same 24-hour messaging window, so the
 *     GHL fallback would NOT have delivered that message either.
 * The fallback was protecting against nothing.
 *
 * WHY ONE CHOKEPOINT AND NOT SEVEN CALL SITES: scrubOutboundText has to run on
 * every single outbound string (a raw "[[SPLIT]]" once reached a real
 * prospect's DMs). One door means one scrub, one retry policy, one place a
 * tripwire can watch.
 * ============================================================================
 */
import { supabase, logEvent } from "./supabase";
import { scrubOutboundText, looksLikeInternalMeta } from "./outbound";
import { sendTelegramPing } from "./telegram";
import {
  sendManychatText,
  sendManychatImage,
  sendManychatVoice,
  resolveSubscriberId,
} from "./manychat";
import { ownerSlug } from "./tenant";

const SEND_MAX_ATTEMPTS = 3;

export interface SendMessageResult {
  success: boolean;
  ghl_message_id?: string;
  error?: string;
  /** Always "manychat" now. Kept so existing readers of this field still work. */
  via?: "manychat";
  /** Legacy flag from the GHL era. Never set anymore; nothing can delete a ManyChat subscriber mid-thread. */
  ghl_gone?: boolean;
}

/**
 * WHO to send to. Callers pass whatever they're holding; we work out the rest.
 * ghl_contact_id is accepted purely as a JOIN KEY to find the lead row that
 * carries the ManyChat subscriber id — never as a send destination.
 */
export interface SendTarget {
  client_id?: string | null;
  manychat_token?: string | null;
  manychat_subscriber_id?: string | null;
  lead_id?: string | null;
  ghl_contact_id?: string | null;
  full_name?: string | null;
  ig_username?: string | null;

  // ---- Accepted and IGNORED, on purpose -----------------------------------
  // Callers across seven files already hold these and pass them. Accepting them
  // means the cut to ManyChat-only did not have to rewrite ten call-site object
  // literals, where a fat-fingered edit could silently drop a real field.
  // Nothing here reaches the transport: ghl_api_key/ghl_location_id are dead
  // (GHL cannot send), and `type` is moot because ManyChat is Instagram-only.
  // They can be swept out later in a pure-cleanup pass with no behaviour risk.
  ghl_api_key?: string | null;
  ghl_location_id?: string | null;
  type?: "IG" | "SMS" | "Email" | "WhatsApp" | "FB";
}

export interface SendMessageParams extends SendTarget {
  message: string;
  /** Public image URLs. Sent as real IG image messages via ManyChat. */
  attachments?: string[];
}

// One cached read per client keeps the hot send path from re-fetching the
// client row on every bubble. KEYED BY CLIENT (audit 2026-08-13): a single
// global cache slot meant that the day a second client onboards, its sends
// could resolve the FIRST client's cached token and deliver through the wrong
// Instagram account. Callers that don't pass a client_id fall back to the
// original single-tenant slug lookup, cached under its own key.
const tokenCache = new Map<string, { at: number; token: string | null }>();
const TOKEN_TTL_MS = 5 * 60_000;

async function manychatToken(target: SendTarget): Promise<string | null> {
  if (target.manychat_token) return target.manychat_token;
  const key = target.client_id || "slug:teu";
  const hit = tokenCache.get(key);
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.token;
  const q = supabase.from("clients").select("manychat_api_token");
  const { data } = target.client_id
    ? await q.eq("id", target.client_id).maybeSingle()
    : await q.eq("slug", ownerSlug()).maybeSingle();
  const token = (data as { manychat_api_token?: string | null } | null)?.manychat_api_token ?? null;
  tokenCache.set(key, { at: Date.now(), token });
  return token;
}

/**
 * Find the ManyChat subscriber for this person, cheapest source first, and
 * CACHE it back onto the lead so the next send skips all of this.
 *
 * Self-healing on purpose: a lead created before ManyChat owned inbound may
 * carry only a GHL contact id, and the old code would simply have sent through
 * GHL. Now that GHL cannot send, we have to be able to find the subscriber from
 * whatever identity we do hold.
 */
export async function resolveSendSubscriber(
  target: SendTarget
): Promise<{ token: string; subscriberId: string } | null> {
  const token = await manychatToken(target);
  if (!token) return null;

  if (target.manychat_subscriber_id) {
    return { token, subscriberId: target.manychat_subscriber_id };
  }

  // 1. The lead row (by id, else by GHL contact id) may already have it.
  let leadId = target.lead_id ?? null;
  let name = target.full_name ?? null;
  let handle = target.ig_username ?? null;

  if (leadId || target.ghl_contact_id) {
    const q = supabase.from("leads").select("id, manychat_subscriber_id, full_name, ig_username");
    const { data } = leadId
      ? await q.eq("id", leadId).maybeSingle()
      : await q.eq("ghl_contact_id", target.ghl_contact_id!).limit(1).maybeSingle();
    const row = data as {
      id: string;
      manychat_subscriber_id: string | null;
      full_name: string | null;
      ig_username: string | null;
    } | null;
    if (row) {
      leadId = row.id;
      name = name || row.full_name;
      handle = handle || row.ig_username;
      if (row.manychat_subscriber_id) {
        return { token, subscriberId: row.manychat_subscriber_id };
      }
    }
  }

  // 2. Ask ManyChat by name/handle, then remember the answer.
  const found = await resolveSubscriberId(token, [handle, name]);
  if (!found) return null;
  if (leadId) {
    await supabase
      .from("leads")
      .update({ manychat_subscriber_id: found })
      .eq("id", leadId)
      .then(undefined, () => { /* best-effort */ });
  }
  return { token, subscriberId: found };
}

/**
 * THE KILL SWITCH, RE-READ AT THE LAST POSSIBLE MOMENT.
 *
 * Found by the stress harness (2026-08-09): flipping the setter off mid-turn
 * did NOT stop a reply that was already in flight, and it delivered anyway.
 * Every switch check in the system used to happen at the START of a turn, but
 * a turn is not instant — an 8 second burst debounce, then generation, then a
 * humanizer hold of up to ~20 seconds, then paced bubbles. So there is a window
 * of roughly a minute where the owner has pressed off, believes he has pressed off,
 * and the setter keeps typing. In a burst that is several messages into a
 * conversation he was trying to rescue. That is exactly the complaint: "when I
 * turn off the ai i need all sending to be turned off".
 *
 * Checking here, at the one door every outbound leaves through, closes the
 * whole window at once — for replies, acks, follow-ups, nurture and the magnet
 * alike, including HALFWAY THROUGH a multi-bubble sequence.
 *
 * Two deliberate choices:
 *   - It reads live, never from a cache. A cached kill switch is not a kill
 *     switch.
 *   - It FAILS OPEN. If the database cannot answer, the send proceeds, because
 *     the upstream check at the start of the turn already passed. This guard
 *     can only ever add safety; a blip must never silence a working setter.
 *
 * Returns why sending must stop (plus the ids it resolved on the way, so the
 * refusal can be logged against the right lead), or null to proceed.
 */
export async function sendingIsSwitchedOff(
  target: SendTarget
): Promise<{ reason: string; clientId: string | null; leadId: string | null } | null> {
  try {
    let clientId = target.client_id ?? null;

    // Per-lead pause. "Turn off the AI for this person" means everything,
    // follow-ups and nurture included, so this is checked for every send and
    // not just for replies.
    const leadQuery = supabase.from("leads").select("id, ai_paused, client_id");
    const leadRow = target.lead_id
      ? (await leadQuery.eq("id", target.lead_id).maybeSingle()).data
      : target.ghl_contact_id
        ? (await leadQuery.eq("ghl_contact_id", target.ghl_contact_id).limit(1).maybeSingle()).data
        : target.manychat_subscriber_id
          ? (await leadQuery.eq("manychat_subscriber_id", target.manychat_subscriber_id).limit(1).maybeSingle()).data
          : null;
    const lead = leadRow as { id: string; ai_paused: boolean; client_id: string } | null;
    if (lead?.client_id) clientId = clientId || lead.client_id;
    if (lead?.ai_paused) {
      return { reason: "lead_ai_paused", clientId, leadId: lead.id };
    }

    // System-wide switch.
    const clientQ = supabase.from("clients").select("is_active");
    const { data: clientRow } = clientId
      ? await clientQ.eq("id", clientId).maybeSingle()
      : await clientQ.eq("slug", ownerSlug()).maybeSingle();
    const c = clientRow as { is_active?: boolean } | null;
    if (c && c.is_active === false) {
      return { reason: "setter_switched_off", clientId, leadId: lead?.id ?? target.lead_id ?? null };
    }

    return null;
  } catch {
    return null; // fail open — see the note above
  }
}

/**
 * Send ONE message to a lead. Text, plus any image attachments.
 * Retries transient failures; never throws.
 */
export async function sendLeadMessage(
  params: SendMessageParams
): Promise<SendMessageResult> {
  // Final safety net: scrub internal tokens before anything can reach the lead.
  const safeMessage = scrubOutboundText(params.message);
  const hasAttachments = !!(params.attachments && params.attachments.length);

  // Text that was ONLY tokens, with nothing else to send, is a no-op success —
  // never post an empty bubble or break a paced sequence over it.
  if (!safeMessage.trim() && !hasAttachments) {
    if (params.message && params.message.trim()) {
      console.error("[send] outbound text was all internal tokens — skipped:", params.message.slice(0, 120));
    }
    return { success: true };
  }

  // TRIPWIRE (owner rule, absolute): text that reads like an internal
  // notification / refusal / owner ping is BLOCKED at the chokepoint — it can
  // never reach a lead, no matter which engine produced it. The owner gets
  // told on Telegram (where this text belonged in the first place); the
  // caller sees a failed send, so its ghost-guard erases the bubble from the
  // AI's memory and the sweep retries with a fresh generation later.
  if (safeMessage.trim() && looksLikeInternalMeta(safeMessage)) {
    console.error("[send] BLOCKED internal-sounding outbound to a lead:", safeMessage.slice(0, 200));
    await sendTelegramPing(
      `BLOCKED: a message was about to go to a lead on Instagram but read as internal/meta text, so it never sent (internal notes must never reach leads):\n"${safeMessage.slice(0, 300)}"`,
      true,
      // Answerable like every other lead ping: seeing this is a very likely
      // moment for the owner to reply "turn him off".
      { leadId: params.lead_id ?? null, clientId: params.client_id ?? null, kind: "blocked_internal_meta" }
    ).catch(() => {});
    return { success: false, error: "blocked_internal_meta" };
  }

  // Off means off, including for a turn that was already under way when the
  // switch was flipped. See sendingIsSwitchedOff.
  const switchedOff = await sendingIsSwitchedOff(params);
  if (switchedOff) {
    const { reason, clientId, leadId } = switchedOff;
    console.log(`[send] not sending - ${reason} (lead ${leadId ?? params.ghl_contact_id ?? "?"})`);
    if (clientId) {
      await logEvent({
        client_id: clientId,
        lead_id: leadId ?? undefined,
        event_type: "send_blocked_switched_off",
        metadata: { reason, preview: safeMessage.slice(0, 120) },
      }).catch(() => { /* best-effort */ });
    }
    return { success: false, error: reason };
  }

  const who = await resolveSendSubscriber(params);
  if (!who) {
    return { success: false, error: "no ManyChat subscriber for this lead" };
  }

  let lastError = "unknown error";
  for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
    let ok = true;

    if (hasAttachments) {
      for (const url of params.attachments!) {
        const r = await sendManychatImage(who.token, who.subscriberId, url);
        if (!r.success) { ok = false; lastError = r.error || `image ${r.status}`; break; }
      }
    }

    if (ok && safeMessage.trim()) {
      const r = await sendManychatText(who.token, who.subscriberId, safeMessage);
      if (!r.success) { ok = false; lastError = r.error || `text ${r.status}`; }
    }

    if (ok) return { success: true, via: "manychat" };

    // The 24h window and a rejected token are permanent for this attempt —
    // retrying just burns the function budget.
    if (/3031|24 hours|integrations ability|Unauthorized/i.test(lastError)) {
      return { success: false, error: lastError, via: "manychat" };
    }
    if (attempt < SEND_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, attempt * attempt * 200 + 200));
    }
  }
  return { success: false, error: lastError };
}

// Human-like cadence: think -> write -> send, then the next one. Each bubble
// waits a pause proportional to ITS OWN length BEFORE it's sent (so a short
// "ok bro" fires fast and a longer line takes a beat to "type"), instead of a
// flat gap that makes a volley feel scripted or land in a burst.
const TYPE_BASE_MS = 700;
const TYPE_CHARS_PER_SEC = 10;
const MIN_BUBBLE_PAUSE_MS = 900;
const MAX_BUBBLE_PAUSE_MS = 6_500;
const PAUSE_JITTER_MS = 500;
/** Cap total inter-bubble sleep so voice replies still finish inside the 60s budget. */
export const MAX_TOTAL_PACING_MS = 16_000;

/** Length-proportional "typing" pause for a single bubble. */
function typingPauseFor(text: string): number {
  const chars = (text || "").length;
  const want = TYPE_BASE_MS + (chars / TYPE_CHARS_PER_SEC) * 1000;
  const jitter = (Math.random() - 0.5) * PAUSE_JITTER_MS;
  return Math.min(Math.max(MIN_BUBBLE_PAUSE_MS, Math.round(want + jitter)), MAX_BUBBLE_PAUSE_MS);
}

/**
 * Send multiple messages as one paced sequence (a reply split on [[SPLIT]]).
 * Every bubble after the first waits a typing-speed pause, capped by a total
 * budget, so a volley reads like a person texting. Stops on the first failure.
 */
export async function sendLeadMessageSequence(
  params: SendTarget & { messages: string[] }
): Promise<SendMessageResult[]> {
  const results: SendMessageResult[] = [];
  let pacingSpent = 0;

  for (let i = 0; i < params.messages.length; i++) {
    const msg = params.messages[i];
    if (i > 0 && pacingSpent < MAX_TOTAL_PACING_MS) {
      const pause = Math.min(typingPauseFor(msg), MAX_TOTAL_PACING_MS - pacingSpent);
      pacingSpent += pause;
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
    const result = await sendLeadMessage({ ...params, message: msg });
    results.push(result);
    if (!result.success) break;
  }
  return results;
}

export interface OutboundItem {
  message: string;          // text body ("" when this item is a voice note)
  voiceWavUrl?: string;     // public WAV URL → a real IG voice note
  fallbackText?: string;    // if the voice send fails, send THIS as text instead
}

/**
 * Send a paced sequence where each item is a text bubble or a voice note.
 *
 * Voice is a real Instagram voice note (ManyChat's audio message type, WAV
 * only — Instagram rejects mp3 with error 3046). If a voice send fails we send
 * the spoken words as TEXT instead, so a voice hiccup can never drop a reply.
 */
export async function sendLeadMixedSequence(
  params: SendTarget & {
    items: OutboundItem[];
    /**
     * Called the instant a bubble's send returns SUCCESS, so the caller can
     * stamp it delivered IMMEDIATELY. Post-loop stamping was skipped entirely
     * when the platform killed the invocation mid-sequence, leaving delivered
     * bubbles unmarked and the trailing one indistinguishable (live: Love,
     * 2026-07-10).
     */
    onSent?: (index: number, result: SendMessageResult) => Promise<void> | void;
    /**
     * Called right BEFORE a bubble's transport call fires (after pacing and
     * the kill-switch re-read). The caller stamps send_attempted_at with it,
     * which is what lets the resend backstop tell "never tried" apart from
     * "tried, answer unknown" when the platform kills the run MID-FLIGHT
     * (live 2026-08-13: a bubble Instagram had already delivered was re-sent
     * because nothing recorded that its request had ever left).
     */
    onAttempt?: (index: number) => Promise<void> | void;
  }
): Promise<SendMessageResult[]> {
  const results: SendMessageResult[] = [];
  let pacingSpent = 0;
  const onSent = params.onSent;
  const onAttempt = params.onAttempt;

  // Resolve once for the whole volley instead of per bubble.
  const who = await resolveSendSubscriber(params);

  for (let i = 0; i < params.items.length; i++) {
    const item = params.items[i];
    if (i > 0 && pacingSpent < MAX_TOTAL_PACING_MS) {
      const want = typingPauseFor(item.message || item.fallbackText || "");
      const pause = Math.min(want, MAX_TOTAL_PACING_MS - pacingSpent);
      pacingSpent += pause;
      await new Promise((resolve) => setTimeout(resolve, pause));
    }

    let result: SendMessageResult;

    if (item.voiceWavUrl && who) {
      // A voice note skips sendLeadMessage entirely, so the kill switch has to
      // be re-read HERE too. Without this, "off" stopped the text bubbles of a
      // volley and let the voice note through mid-sequence.
      const off = await sendingIsSwitchedOff(params);
      if (off) {
        results.push({ success: false, error: off.reason });
        break;
      }
      if (onAttempt) {
        try { await onAttempt(i); } catch (e) { console.error("[send] onAttempt hook failed:", e); }
      }
      const mc = await sendManychatVoice(who.token, who.subscriberId, item.voiceWavUrl);
      if (mc.success) {
        result = { success: true, via: "manychat" };
      } else if (item.fallbackText?.trim()) {
        console.error("[send] voice note failed — sending the words as text");
        result = await sendLeadMessage({ ...params, message: item.fallbackText });
      } else {
        result = { success: false, error: mc.error };
      }
    } else {
      if (onAttempt) {
        try { await onAttempt(i); } catch (e) { console.error("[send] onAttempt hook failed:", e); }
      }
      result = await sendLeadMessage({
        ...params,
        manychat_subscriber_id: who?.subscriberId ?? params.manychat_subscriber_id,
        message: item.message,
      });
    }

    results.push(result);
    if (result.success && onSent) {
      // Best-effort per-bubble stamp — never let bookkeeping abort the sequence.
      try { await onSent(i, result); } catch (e) { console.error("[send] onSent hook failed:", e); }
    }
    if (!result.success) break;
  }

  return results;
}
