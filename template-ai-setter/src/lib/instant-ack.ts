/**
 * INSTANT ACKNOWLEDGMENT
 * ----------------------
 * Fills the "dead air" while the considered reply is being written. The moment a
 * lead says something with real substance, the setter fires ONE short, tone-
 * matched human reaction ("damn that's real man", "yooo that's sick") in ~1s
 * using a FAST model — BEFORE the slower main reply is generated — so the lead
 * feels an instant human presence, then the real next move follows a beat later.
 * This is what stops the old "dead silence, then everything at once" feel.
 *
 * HUMAN TIMING (owner rule, 2026-08-08): the ack must NEVER land under 3
 * seconds after the lead's message — a sub-second reaction reads as a bot.
 * Before sending, we wait out the remainder of a randomized 3-6s target
 * measured from the LEAD's message timestamp, so generation time counts
 * toward the wait instead of stacking on top of it.
 *
 * Safety (this runs on a live revenue system):
 *  - Best-effort: any failure, or a bare "ok"/emoji that needs no reaction,
 *    returns null and the normal reply pipeline runs exactly as before.
 *  - NEVER throws into the reply path and never blocks it.
 *  - Output goes through the SAME outbound scrub as every other send.
 *  - META-FILTER (live incident 2026-07-30, Asyah): the ack model once
 *    REFUSED and its refusal text — "I need to pause here. This message
 *    (...) appears to be inappropriate or a test of my boundaries." — was
 *    sent to the LEAD's Instagram as the ack. Internal/meta commentary must
 *    never reach a lead: any output that reads like a refusal, an AI
 *    self-reference, or an internal note is dropped (no ack, normal reply
 *    continues), and anything over ACK_MAX_WORDS is dropped too (a real
 *    reaction is a few words; a refusal is a paragraph).
 *  - It is called from INSIDE generateAndSendReply (GHL path), AFTER every gate
 *    (banned / AI-paused / setter-off / stop-tag) AND after the single-flight
 *    reply lock — and ALSO from the fast ManyChat inbound trigger
 *    (/api/manychat/inbound), which runs its own equivalent gates before
 *    calling this. Either way it can never fire for a suppressed lead.
 *  - Double-fire protection: an internal ack_lock_at lock (mirror of the reply
 *    lock) serializes every call, because two ManyChat invocations for
 *    messages <2s apart can both pass the "did we already ack" history check
 *    before either has saved its ack row — only the atomic lock closes that.
 *  - The sent ack is saved with model_used="instant_ack" so (a) GHL's echo of it
 *    is recognised as ours and (b) the main generator trims it from the tail of
 *    the thread (so the thread still ends with the lead's message) while still
 *    being TOLD it reacted, so it never re-acknowledges.
 */
import { claude } from "./anthropic";
// Named so this shows up as its own line in the spend report.
const anthropic = claude("instant_ack");
import { supabase, saveMessage, getRecentMessages, acquireAckLock, releaseAckLock } from "./supabase";
import { sendLeadMessage } from "./send";
import { scrubOutboundText, looksLikeInternalMeta } from "./outbound";

// Fast, cheap model — a reaction needs speed, not deep reasoning.
const ACK_MODEL = "claude-haiku-4-5";
// The tag we stamp on a sent ack so the main generator can find + trim it.
export const INSTANT_ACK_TAG = "instant_ack";

// Human timing: the ack lands 3-6s after the LEAD's message, never earlier.
// Measured from the lead row's timestamp so model latency counts toward the
// wait. Owner rule 2026-08-08: "wait 3 seconds minimum".
const ACK_MIN_DELAY_MS = 3_000;
const ACK_MAX_DELAY_MS = 6_000;
// A real reaction is a few words. Anything longer is the model explaining
// itself (a refusal, a meta note) and must never reach the lead.
const ACK_MAX_WORDS = 12;

// Bare, low-substance replies get NO separate reaction — reacting to "ok" with
// "love that bro" feels robotic. These just flow into the normal reply.
const LOW_SUBSTANCE = new Set([
  "ok", "okay", "k", "kk", "yes", "ye", "yea", "yeah", "yep", "yup", "no", "nope",
  "nah", "sure", "cool", "word", "bet", "aight", "alright", "thanks", "thank you",
  "ty", "thx", "np", "lol", "lmao", "haha", "hahaha", "hmm", "ok bro", "yes bro",
  "yeah bro", "for sure", "sounds good", "gotcha", "true",
]);

/** Should this lead message get a separate instant reaction? Skip bare acks,
 *  emoji-only, and ultra-short no-content messages. */
export function warrantsAck(text: string): boolean {
  const t = (text || "").trim().toLowerCase().replace(/[.!?,]+$/g, "").trim();
  if (!t) return false;
  if (LOW_SUBSTANCE.has(t)) return false;
  if (!/[a-z]{3,}/i.test(t)) return false;          // emoji / punctuation only
  if (t.length < 6 && !t.includes(" ")) return false; // one tiny word => bare ack
  return true;
}

/** How many of our recent bubbles are looked at when deciding whether we have
 *  been reacting too often. Three AI turns back is one exchange's worth. */
const ACK_LOOKBACK_AI_TURNS = 3;
/** A gap this long means they went away and came back - worth a reaction even
 *  if we reacted last turn. */
const ACK_RETURNING_GAP_MS = 15 * 60_000;
/** A message this long is substantive enough to react to on its own. */
const ACK_SUBSTANTIAL_CHARS = 120;

type AckHistoryRow = {
  role: string;
  content: string;
  created_at: string;
  model_used?: string | null;
};

/**
 * Has this moment earned a separate reaction, or would it just be filler?
 *
 * Exported for testing: the whole point of this rule is the ratio it produces
 * over a long thread, which is a property worth pinning rather than trusting.
 */
// Mirror of the reply engine's REPLY_LOCK_TTL_MS: a lock younger than this
// means a considered turn is composing or pacing bubbles out right now.
const REPLY_LOCK_TTL_MS = 80_000;

/** Is a considered reply being composed/sent for this lead right now? */
export function volleyInFlight(replyLockAt: string | null, nowMs: number): boolean {
  if (!replyLockAt) return false;
  const age = nowMs - new Date(replyLockAt).getTime();
  return age >= 0 && age < REPLY_LOCK_TTL_MS;
}

export function ackIsWarrantedNow(history: AckHistoryRow[]): boolean {
  const last = history[history.length - 1];
  if (!last || last.role !== "lead") return false;

  // Our recent turns, newest first. An ack among them means we already reacted
  // recently, so this turn needs a REASON to react again.
  const recentAi = [...history].reverse().filter((m) => m.role === "ai").slice(0, ACK_LOOKBACK_AI_TURNS);
  const ackedRecently = recentAi.some((m) => m.model_used === INSTANT_ACK_TAG);
  if (!ackedRecently) return true; // opening move, or we have been quiet a while

  // They came back after a real gap - that IS a moment, react to it.
  const prevLead = [...history].reverse().find((m) => m !== last && m.role === "lead");
  if (prevLead) {
    const gapMs = new Date(last.created_at).getTime() - new Date(prevLead.created_at).getTime();
    if (gapMs >= ACK_RETURNING_GAP_MS) return true;
  }

  // They wrote something substantial. Reacting to a paragraph is human;
  // reacting to "yeah" for the fourth time in a row is not.
  if ((last.content || "").trim().length >= ACK_SUBSTANTIAL_CHARS) return true;

  return false;
}

type AckClient = {
  id: string;
  name?: string | null;
  voice_samples?: string | null;
  ghl_api_key?: string | null;
  ghl_location_id?: string | null;
  manychat_api_token?: string | null;
};
type AckLead = {
  id: string;
  ghl_contact_id?: string | null;
  manychat_subscriber_id?: string | null;
  // The thread's locked language (leads.conversation_language). The ack MUST
  // speak the same language the real reply will use — a Swedish-locked thread
  // with English acks reads as two different people (live complaint 2026-07-24).
  conversation_language?: string | null;
};

/**
 * Fire the instant reaction. Returns the text sent (so the main generator can be
 * told not to re-acknowledge it), or null if we skipped / it failed.
 *
 * Delivery: through the ONE send chokepoint (lib/send.ts) — ManyChat only.
 * GHL has no send surface; the ids on the lead are only used by the sender to
 * FIND the ManyChat subscriber.
 */
export async function maybeSendInstantAck(params: { client: AckClient; lead: AckLead }): Promise<string | null> {
  const { client, lead } = params;

  try {
    const history = await getRecentMessages(lead.id, 8);
    if (!history.length) return null;
    const last = history[history.length - 1];
    // Only react to a fresh LEAD message with real substance.
    if (last.role !== "lead" || !warrantsAck(last.content)) return null;
    // Don't stack reactions: if the most recent AI bubble was itself an instant
    // ack we just sent, skip a second one.
    const lastAi = [...history].reverse().find((m) => m.role === "ai");
    if (lastAi && lastAi.model_used === INSTANT_ACK_TAG) return null;

    // ── RATION IT ────────────────────────────────────────────────────────
    // The only guard used to be "the last AI message was not itself an ack",
    // which a normal turn always satisfies: ack, considered reply, ack,
    // considered reply. Live over 30 days that was 81 acks for 89 replies -
    // a filler bubble on 91% of turns. Ten turns in a row of "gotcha" then a
    // question is not what a person does, and it is the single most mechanical
    // thing in the thread.
    //
    // So the reaction is for the moments that earn one: the first substantive
    // thing they say, and anything they say after a real pause (they came back
    // to us) or that is long enough to be worth reacting to. Mid-volley, when
    // we are already going back and forth in seconds, the considered reply is
    // the whole answer and the ack is noise.
    if (!ackIsWarrantedNow(history)) return null;

    // A VOLLEY IN FLIGHT OWNS THE THREAD (owner rule 2026-08-21, Scott Hall):
    // if a considered reply for this lead is being composed or paced out RIGHT
    // NOW (fresh reply lock), their message is the tail of the exchange that
    // volley already answers - wedging a reaction bubble into the middle of
    // our own volley is what made the setter read as glitching. The volley
    // (or the post-send continuation pass) is the response; no filler.
    try {
      const { data: fresh } = await supabase
        .from("leads")
        .select("reply_lock_at")
        .eq("id", lead.id)
        .maybeSingle();
      const lockIso = (fresh as { reply_lock_at?: string | null } | null)?.reply_lock_at;
      if (volleyInFlight(lockIso ?? null, Date.now())) return null;
    } catch {
      // Can't read the lock -> fail toward acking (the old behaviour).
    }

    // Serialize the actual send: two invocations racing on messages <2s apart
    // both pass the checks above before either has saved its ack row, so only
    // an atomic lock (not the history checks) prevents a double ack. NOT 30s:
    // a stale 30s lock would wrongly suppress the ack for the lead's NEXT
    // message; released in the finally below the instant this call finishes.
    const ACK_LOCK_TTL_MS = 15_000;
    if (!(await acquireAckLock(lead.id, ACK_LOCK_TTL_MS))) return null;
    try {
      const transcript = history
        .slice(-6)
        .map((m) => `${m.role === "lead" ? "Them" : "You"}: ${m.content}`)
        .join("\n");
      const voice = (client.voice_samples || "").trim().slice(0, 1200);

      const system = `You are ${client.name || "the operator"} replying in an Instagram DM. The lead just said something and you want to react like a real person INSTANTLY — before you've even thought about your next question.

Send ONLY a single, very short human reaction to their LAST message. Rules:
- It is JUST a reaction — NO question, NO advice, NO moving the conversation forward. That comes in your next message.
- MATCH their emotion, ONE NOTCH CALMER. If they shared something hard or personal, be genuinely empathetic but grounded ("yeah, i hear you man" / "that's a rough spot honestly"). If it's exciting, warm but composed ("oh nice, love that"). If it's plain info, a light "gotcha" / "okay nice" is fine. NEVER react to something heavy with a cheerful throwaway.
- KEEP IT GROUNDED: no hype-slang stacking ("yooo", "damn i feel that bro", "that's sick brooo") unless THEY text with that exact energy first. Calm, warm, adult — like a sharp friend in his late 20s, not a teenager. Still never corporate, never "I understand" or "that's great to hear".
- If their message is basically just a NUMBER or amount (answering a question), keep the reaction NEUTRAL ("gotcha" / "okay okay, got you") — NEVER judge the number ("that's not far" / "that's a lot"): you can't be sure what it refers to (their income vs the gap vs a goal), and a wrong judgement reads terribly.
- ${lead.conversation_language === "sv"
        ? "This conversation is locked to SWEDISH — write the reaction in Swedish, matching the same casual register."
        : "Write the reaction in ENGLISH, even if their message mixes in another language."}
- Max ~8 words. One line only. No quotes around it.${voice ? `\n\nHere is how you actually text — match this voice:\n${voice}` : ""}`;

      const resp = await anthropic.messages.create({
        model: ACK_MODEL,
        max_tokens: 40,
        system,
        messages: [{ role: "user", content: transcript }],
      });
      const raw = resp.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("");
      // Same scrub as every outbound, then collapse to one clean short line.
      let ack = scrubOutboundText(raw).trim().replace(/^["']|["']$/g, "");
      ack = ack.split(/\n/)[0].trim().slice(0, 120);
      if (ack.length < 2) return null;

      // META-FILTER: a refusal / AI self-reference / internal note is NOT a
      // reaction — drop it entirely (the considered reply still handles the
      // message). Same for anything longer than a real reaction could be.
      if (
        looksLikeInternalMeta(ack) ||
        ack.split(/\s+/).filter(Boolean).length > ACK_MAX_WORDS
      ) {
        console.error("[instant-ack] output looked like internal/meta text — ack dropped:", ack.slice(0, 120));
        return null;
      }

      // HUMAN TIMING: never land under ACK_MIN_DELAY_MS after the lead's
      // message. Wait out the remainder of a randomized 3-6s target measured
      // from THEIR timestamp (generation time already counts toward it).
      const target =
        ACK_MIN_DELAY_MS + Math.random() * (ACK_MAX_DELAY_MS - ACK_MIN_DELAY_MS);
      const elapsed = Date.now() - new Date(last.created_at).getTime();
      const wait = Math.max(0, Math.round(target - elapsed));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));

      // ONE chokepoint, ManyChat only — the sender resolves the subscriber
      // from whatever identity the lead row carries.
      const res = await sendLeadMessage({
        client_id: client.id,
        lead_id: lead.id,
        manychat_token: client.manychat_api_token ?? null,
        manychat_subscriber_id: lead.manychat_subscriber_id ?? null,
        ghl_contact_id: lead.ghl_contact_id ?? null,
        message: ack,
      });
      if (!res.success) return null;

      await saveMessage({
        lead_id: lead.id,
        client_id: client.id,
        role: "ai",
        content: ack,
        channel: "instagram",
        model_used: INSTANT_ACK_TAG,
        // The send above already succeeded - stamp it, so the delivered-truth
        // filter (lib/delivered-truth.ts) never has to special-case new rows.
        delivered: true,
      });
      return ack;
    } finally {
      await releaseAckLock(lead.id);
    }
  } catch (e) {
    console.error("[instant-ack] failed (skipping — normal reply continues):", e);
    return null;
  }
}
