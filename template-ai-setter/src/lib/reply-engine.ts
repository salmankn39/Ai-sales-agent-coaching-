import { waitUntil } from "@vercel/functions";
import {
  getRecentMessages,
  getLatestLeadMessage,
  saveMessage,
  setMessageGhlId,
  markMessageDelivered,
  markMessageAttempted,
  clearMessageAttempt,
  updateLeadStage,
  updateLeadLanguage,
  setLeadManychatSubscriberId,
  acquireReplyLock,
  releaseReplyLock,
  logEvent,
  logAIDecision,
  eventExists,
  countAiMessagesSince,
  countClientAiMessagesSince,
  recentEventExists,
  supabase,
  type Client,
  type Lead,
  type DbMessage,
} from "@/lib/supabase";
import { tagBookingLinks } from "@/lib/sourcing";
import { splitLongBubble } from "@/lib/outbound";
// No Anthropic client here on purpose. This file orchestrates the reply; the
// single model call lives in lib/brain.ts, which owns its own metered client.
// A duplicate `claude("setter_reply")` sat here unused until 2026-08-17 — it
// billed nothing, but it was the shape a future call site would copy, and a copy
// that reached for a raw SDK client instead would spend invisibly.
import { generateReply, PRODUCTION_MODEL } from "@/lib/brain";
import { getFreeSlots, updateContactEmail } from "@/lib/ghl";
import { sendLeadMixedSequence } from "@/lib/send";
import { verifyReplyInInbox } from "@/lib/delivery-verify";
import { noteStageChange, noteMilestone } from "@/lib/crm-notes";
import { pauseLead } from "@/lib/screener";
import { resolveConversationLanguage } from "@/lib/language";
import { resolveStage, parseStages } from "@/lib/stages";
import { painDigInstruction, painProtocolFor } from "@/lib/paindig";
import { makeVoiceClipWav, voiceEligible, voiceActive, voiceIdForLang, VOICE_INSTRUCTION, VOICE_MARKER_RE } from "@/lib/voice";
import { resolveSubscriberId } from "@/lib/manychat";
import { maybeSendInstantAck, INSTANT_ACK_TAG } from "@/lib/instant-ack";
import { recordVideoLinkSent, VIDEO_LINK } from "@/lib/nurture";
import { syncPipelineFunnel, syncPipelineDisqualified } from "@/lib/pipeline-sync";
import { isRepeatReply } from "@/lib/dedup";
import { neverReachedLead } from "@/lib/delivered-truth";
import { classifyContinuation } from "@/lib/continuation";
import { countryToTimezone } from "@/lib/timezones";
import { sendTelegramPing, sendTelegramCopyBlock, ghlContactLink, leadLabel } from "@/lib/telegram";
import { classifyLLMError, ownerSentence } from "@/lib/llm-error";
import { type Message, type StageContext } from "@/lib/prompts/master";

// The QUIET WINDOW the reply pipeline waits before answering, to coalesce a
// burst of rapid lead messages into a SINGLE reply. Each inbound DM spawns its
// own background invocation; after this wait, only the invocation still holding
// the newest lead message proceeds (the others yield), so the lead gets ONE
// reply once they pause. The owner can override this with
// clients.reply_delay_min/max_seconds (set from Jarvis); see replyDelayMs().
//
// 12s, up from 4s (live bug 2026-07-08): a lead typing multi-bubble answers got
// ONE REPLY PER BUBBLE — the setter answered bubble 1 while bubbles 2-3 were
// still in flight, then answered those too ("spamming", and it reads as a bot).
// The cause is upstream jitter: GHL delivers inbound DMs with a measured lag of
// p50 ~10s / p90 ~11s PER MESSAGE, so two bubbles sent 3s apart can reach us
// ~10s apart — far outside a 4s window. 12s absorbs that jitter so a burst
// lands as one reply. Perceived latency is covered by the instant ack, which
// now fires BEFORE this wait (see generateAndSendReply).
const QUIET_WINDOW_MS = 12_000;

// How long a per-lead reply lock stays valid before it's considered stale and
// can be re-taken. The lock is acquired AFTER the debounce, so a live invocation
// only holds it for at most (maxDuration - debounce) ≈ 54s — this TTL sits safely
// above that so a running reply is never stolen, but is low enough that if an
// invocation is KILLED (e.g. a 60s timeout, which skips the finally that frees the
// lock), the NEXT lead message can re-take the lock within ~80s instead of being
// silently skipped for a full 2 minutes and getting no reply at all.
const REPLY_LOCK_TTL_MS = 80_000;

// Hard platform cap on the configurable delay: the whole invocation
// (delay + generation + GHL sends) must finish inside maxDuration (60s on
// Vercel Hobby), so the wait itself may never exceed this.
const MAX_REPLY_DELAY_MS = 30_000;

// Floor on ANY reply delay: even if the owner configures 0/0, never wait
// less than this before replying. The wait is what coalesces a lead's burst
// ("yes bro" ... "Exactly." 10s later) into ONE reply — see the freshness
// check in generateAndSendReply — so it must never collapse toward zero.
const MIN_REPLY_DELAY_MS = 8_000;

// Outbound circuit breakers (anti-ban): ceilings on AI send volume that only
// catch a RUNAWAY, not normal high-volume setting. On 2026-06-08 the setter
// sent 116 DMs to ONE lead inside 40 minutes — a marathon loop that gets an
// IG account flagged. These caps are set well above real conversation pace
// (no human gets ~100 messages/hour in a real back-and-forth) so booking
// throughput is untouched; they exist purely to halt a bug like that one.
// When a ceiling is hit the reply is HELD, an event is logged, and the owner
// is pinged once per episode; the lead gets their next reply once the rolling
// hour clears.
const MAX_AI_MSGS_PER_LEAD_PER_HOUR = 100;
const MAX_AI_MSGS_PER_CLIENT_PER_HOUR = 320;

// Max DM bubbles per reply. The model splits replies into short bubbles with
// [[SPLIT]]; anything past this is merged into the final bubble instead of
// stacking a 6-7 message volley (production hit runs of 7 in a row).
const MAX_BUBBLES_PER_REPLY = 4;

// Hard per-bubble length enforcement lives in lib/outbound.ts (pure + tested):
// any bubble over MAX_BUBBLE_CHARS is split at sentence boundaries before
// sending — the fix for the "copied and pasted bro way to quick" wall of text.

// NOTE: the "leave it on read" / late-straggler silence rule was REMOVED (owner
// decision) — the setter now replies to EVERY lead message, including a bare
// "ok"/👍 and including right after we asked a question. There is no NO_REPLY
// suppression anywhere in the reply path.

// Whale radar: only ping the owner when a lead's expected-value score is this
// high — keeps it rare (true whales only), once per lead.
const WHALE_THRESHOLD = 80;

// ── THE FOLLOW-ON GATE WAS DELETED (2026-07-25) ────────────────────────────
// It was added 2026-07-08 to avoid re-replying when a lead's extra bubble
// "added nothing new": a Haiku call judged each message and could choose to
// send NOTHING. In 30 days it fired 53 times and left 24 conversations in
// total silence - including a hot lead who answered a direct money question
// and never heard back. A judgment call that can end a conversation is worth
// far less than the leads it costs, and it contradicts the operator's hard
// rule that the setter always replies and always ends on a question.
// Burst coalescing is handled deterministically by the quiet-window debounce
// + the straggler guard below, which never decide to stay silent.
// DO NOT REINTRODUCE a "should we reply at all" model call. See the invariants
// test: src/lib/__tests__/setter-invariants.test.ts

/**
 * The wait before replying. When the owner set a delay range on the client
 * (reply_delay_min/max_seconds), pick a random duration inside it — this
 * REPLACES the fixed debounce but still coalesces bursts the same way.
 * When unset (null), keep the original fixed debounce. Always clamped to
 * [MIN_REPLY_DELAY_MS, MAX_REPLY_DELAY_MS].
 */
function replyDelayMs(client: {
  reply_delay_min_seconds: number | null;
  reply_delay_max_seconds: number | null;
}): number {
  const minS = client.reply_delay_min_seconds;
  const maxS = client.reply_delay_max_seconds;
  if (minS == null && maxS == null) return QUIET_WINDOW_MS;
  const lo = Math.max(0, Number(minS ?? maxS ?? 0));
  const hi = Math.max(lo, Number(maxS ?? minS ?? 0));
  const picked = (lo + Math.random() * (hi - lo)) * 1000;
  return Math.min(
    Math.max(Math.round(picked), MIN_REPLY_DELAY_MS),
    MAX_REPLY_DELAY_MS
  );
}

// Max messages fed into the reply generator. Previously the generation path
// capped history at 50 messages, which on long threads dropped the early part
// of the conversation and made the setter re-ask questions it had already
// answered (income/savings/credit twice on a real lead). IG-DM threads are
// small, so we raise the cap far beyond any realistic thread length to pass
// the FULL conversation to the model.
const MAX_GENERATION_HISTORY = 1000;

export async function generateAndSendReply(params: {
  client: Client | null;
  lead: Lead | null;
  // Prior thread (oldest-first) fetched from GHL by the screener, fed in so a
  // newly-screened conversation continues seamlessly. Usually undefined.
  priorHistory?: Message[];
  // The id of the inbound lead message this invocation is handling. Used to
  // coalesce rapid bursts: if a newer lead message lands during the debounce
  // wait, that later invocation owns the reply and this one bails.
  inboundMessageId?: string;
  // Override the burst debounce. The watchdog path has ALREADY waited ~25s
  // before calling (which coalesced any burst), so it passes ~1s here — both
  // to reply promptly and to keep the total invocation inside the platform's
  // 60s limit even for clients with a long configured reply delay.
  debounceMs?: number;
}) {
  const { client, lead, priorHistory, inboundMessageId, debounceMs } = params;
  if (!client || !lead) return;

  // ── PER-REPLY STOPWATCH ────────────────────────────────────────────────────
  // Every stage of the wait is timed and written to reply_timings by
  // runReplyGeneration. Added 2026-07-25 after the dashboard reported 13s while
  // the real lead-experienced wait was ~27s: the AI itself only thinks for ~2s,
  // and nothing measured where the other ~25s went. The debounce is measured
  // HERE (it happens before generation) and handed down.
  const T0 = Date.now();
  let debounceActualMs = 0;

  // NOTE: there is deliberately NO "should we reply at all" check here anymore
  // (see the deleted follow-on gate above). Every lead message gets a reply.

  // INSTANT REACTION — fired BEFORE the quiet window, not after (moved 2026-07-08):
  // with the window at 12s, an ack that waited for it landed ~20s+ after the lead
  // spoke (window + GHL's ~10s inbound lag), which reads as dead air. Firing it
  // here puts a human reaction in their thread within ~1-2s of us seeing the
  // message. Safe pre-lock: maybeSendInstantAck has its own atomic ack lock, a
  // recent-ack history check, and a substance filter, so a burst still gets at
  // most ONE reaction. Best-effort — returns null on a bare "ok"/emoji/any error.
  const ack = await maybeSendInstantAck({ client, lead });

  // --- Burst debounce (quiet window): wait, then only proceed if no newer lead
  //     message has arrived. Each inbound DM spawns its own background
  //     invocation; they all wait the same quiet window, so when a lead fires
  //     several messages a few seconds apart, every earlier invocation sees a
  //     newer message and yields, and only the one holding the latest message
  //     proceeds. Net effect: the lead gets ONE reply, ~a quiet window after
  //     their LAST message. A message sent minutes later is past the window and
  //     correctly gets its own reply. An explicit debounceMs (the watchdog's
  //     ~1s) always wins; a follow-on with new content waits the longer 30s. ---
  const debounceStart = Date.now();
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      debounceMs != null ? Math.max(0, debounceMs) : replyDelayMs(client)
    )
  );
  debounceActualMs = Date.now() - debounceStart;

  if (inboundMessageId) {
    try {
      const latest = await getLatestLeadMessage(lead.id);
      if (latest && latest.id !== inboundMessageId) {
        console.log(
          "[webhook] newer lead message arrived during quiet window — yielding to it"
        );
        // Logged so monitoring can tell a deliberate yield from an engine
        // death, and verify the newer message's own invocation actually
        // replied (its handler can be dead — a dropped webhook, a failed
        // reply-now kickoff — in which case EVERY invocation yields and only
        // the sweep saves the thread).
        await logEvent({
          client_id: client.id,
          lead_id: lead.id,
          event_type: "reply_yielded",
          metadata: { yielded_to_message_id: latest.id, own_message_id: inboundMessageId },
        }).catch(() => { /* best-effort */ });
        return;
      }
    } catch (err) {
      // Fail-safe: never DROP a reply because the freshness check failed. The
      // single-flight lock below still prevents a duplicate if we proceed.
      console.error(
        "[webhook] quiet-window freshness check failed — proceeding to reply:",
        err
      );
    }
  }

  // --- Single-flight lock: only ONE invocation may generate + send for this
  //     lead at a time. If another already holds it, this burst is being
  //     handled there, so we bail. Together with the quiet window above this is
  //     the hard guarantee of EXACTLY ONE reply per burst — it closes the race
  //     where a 2nd/3rd fast message's invocation slips past the freshness
  //     check and would otherwise fire its own (often repeated) reply. ---
  const lockStamp = await acquireReplyLock(lead.id, REPLY_LOCK_TTL_MS);
  if (!lockStamp) {
    console.log("[webhook] a reply is already in flight for this lead — skipping");
    // Logged: if the lock-holder dies mid-generation, every inbound for the
    // next 80s lands here — a run of these events with no ai_replied after
    // them is the signature of a dead holder, invisible before this line.
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "reply_lock_skipped",
      metadata: { inbound_message_id: inboundMessageId ?? null },
    }).catch(() => { /* best-effort */ });
    return;
  }

  try {
    // The lock-holder is the SOLE replier, so it must also account for messages
    // that land WHILE it's generating (their own invocations are locked out here).
    // runReplyGeneration re-reads the full thread each pass; if a newer lead
    // message appeared just before it would send, it bails WITHOUT sending and asks
    // us to regenerate — folding a fast 2nd/3rd message into ONE reply instead of
    // answering a beat too late. Bounded so a lead who keeps typing can't loop us.
    // (The instant reaction fired BEFORE the quiet window at the top of this
    // function; `ack` carries its text so the reply never double-acknowledges.)
    const loopStart = Date.now();
    const REGEN_BUDGET_MS = 15_000; // stop regenerating past this so stacked passes never blow the 60s function limit
    let sawNewerMidGeneration = false;
    for (let pass = 0; pass < 3; pass++) {
      const lowOnTime = Date.now() - loopStart > REGEN_BUDGET_MS;
      const res = await runReplyGeneration({
        client,
        lead,
        priorHistory: pass === 0 ? priorHistory : undefined,
        alreadyAcked: ack ?? undefined,
        // Last allowed pass, OR we're low on the function's time budget: send what
        // we have rather than risk a timeout (a timeout is worse — it kills the reply
        // AND leaves a stale lock that blocks the next message).
        forceSend: pass === 2 || lowOnTime,
        // On a regeneration pass the newest lead message arrived while WE were
        // still composing - the model must not read it as an answer to the
        // question it was about to ask (live case: it did exactly that).
        stragglerRegen: sawNewerMidGeneration,
        // Stopwatch context measured out here, before generation started.
        turnStartedAt: T0,
        debounceMsActual: debounceActualMs,
      });
      if (!res?.retryForNewer) break;
      // A post-send retry means a volley WAS delivered this turn: the next
      // pass sees it in the thread, and the crossed-messages timing note (not
      // the mid-generation one) is the correct framing for the model.
      if (!res.postSend) sawNewerMidGeneration = true;
    }
  } finally {
    // Always free the lock — even if generation/sending threw — so the next
    // inbound for this lead is never blocked by a stuck lock. Stamp-guarded:
    // if reply-now reclaimed this lock mid-send and another generation now
    // owns a NEWER stamp, this release is a no-op instead of freeing theirs.
    await releaseReplyLock(lead.id, lockStamp);
  }
}

/**
 * Owner ACTIVITY ping (audit mode). When clients.setter_notify_enabled is on,
 * The owner gets a Telegram message for what the SETTER does on a live lead.
 * Each KIND is individually mutable via clients.setter_notify_off (a list of
 * muted kinds): 'started' | 'replied' | 'silent' | 'failed' | 'followup'. A ping
 * fires only when the master switch is on AND its kind isn't muted. Follow-ups
 * have their OWN kind ('followup') so they can be turned on/off separately.
 * Best-effort: never throws, never blocks the reply (runs after the send).
 */
function notifyEnabled(
  client: { setter_notify_enabled?: boolean | null; setter_notify_off?: string[] | null },
  kind: string
): boolean {
  if (client?.setter_notify_enabled !== true) return false;
  const off = Array.isArray(client?.setter_notify_off) ? client.setter_notify_off : [];
  return !off.includes(kind);
}

async function notifySetterActivity(
  client: { setter_notify_enabled?: boolean | null; setter_notify_off?: string[] | null; ghl_location_id: string | null },
  lead: { id?: string | null; full_name: string | null; ghl_contact_id: string | null },
  kind: string,
  text: string
): Promise<void> {
  try {
    if (!notifyEnabled(client, kind)) return;
    const link = ghlContactLink(client.ghl_location_id ?? "", lead.ghl_contact_id ?? "");
    // `about` is what makes this ping answerable: replying "turn him off" to it
    // resolves the person by the Telegram message id, not by re-reading the prose.
    await sendTelegramPing(`${text}${link ? `\n${link}` : ""}`, true, {
      leadId: lead.id ?? null,
      kind,
    });
  } catch (err) {
    console.error("[webhook] setter activity ping failed:", err);
  }
}

/**
 * Generate the lead's single reply and send it. Runs UNDER the per-lead
 * single-flight lock held by the caller, after the quiet window has already
 * chosen this invocation to answer the burst. Reads the FULL conversation
 * (every message in the burst) so it's all answered at once, and refuses to
 * re-send a near-duplicate of its own previous reply.
 */
async function runReplyGeneration(params: {
  client: Client | null;
  lead: Lead | null;
  priorHistory?: Message[];
  // On the final allowed regeneration pass, send even if a newer message just
  // arrived — so a lead who keeps typing still always gets a reply.
  forceSend?: boolean;
  // The text of a quick instant-reaction we already sent this turn (if any), so
  // the considered reply doesn't acknowledge again.
  alreadyAcked?: string;
  // True on a regeneration pass triggered by a lead message that arrived while
  // the previous pass was still composing. The model gets a timing note so it
  // never reads that message as an answer to a question it hadn't sent yet.
  stragglerRegen?: boolean;
  // Per-reply stopwatch context from the caller: when this turn began, and how
  // long the burst debounce actually held before generation started.
  turnStartedAt?: number;
  debounceMsActual?: number;
}): Promise<{ retryForNewer: true; postSend?: boolean } | void> {
  const { client, lead, priorHistory, forceSend, alreadyAcked, stragglerRegen,
          turnStartedAt, debounceMsActual } = params;
  if (!client || !lead) return;

  const T0 = turnStartedAt ?? Date.now();
  const timing: {
    debounce_ms?: number; model_ms?: number;
    lead_msg_at?: string | null; inbound_source?: string | null;
  } = { debounce_ms: debounceMsActual };

  // Full conversation history (no practical cap): IG-DM threads are small
  // enough that the whole thread fits, and the generator must see everything
  // already covered so it never re-asks answered questions.
  let dbMessages = await getRecentMessages(lead.id, MAX_GENERATION_HISTORY);

  // THE INBOX IS THE ONLY TRUTH (owner rule 2026-08-21, Scott Hall incident):
  // a bubble we saved but never got out - blocked, failed, cleared after a
  // known send failure - was never SAID. Nothing downstream may see it: not
  // the brain's history, not the anti-repeat guard, not the stage tracker.
  // Live damage of not filtering: Scott's unsent main-reason question sat in
  // the table, a concurrent turn read it as already-asked, judged its own next
  // line a repeat, and switched the AI off for him. Attempted-unknown and
  // mirror-imported rows count as said - see lib/delivered-truth.ts.
  dbMessages = dbMessages.filter((m) => !neverReachedLead(m));

  // Trim a just-sent instant-ack (a fast reaction bubble) off the TAIL so the
  // thread still ends with the LEAD's message the considered reply must answer
  // (the model is told about the ack via extraInstruction below, so it won't
  // re-react). Only ever removes a reaction we sent this turn — nothing else is
  // tagged INSTANT_ACK. Capture its text: when the ack came from the fast
  // ManyChat path, this invocation's own maybeSendInstantAck call below will
  // correctly no-op (an ack already exists), so `alreadyAcked` arrives here as
  // undefined — trailingAck is what lets the considered reply still be told it
  // already reacted, instead of re-acknowledging.
  let trailingAck: string | undefined;
  while (
    dbMessages.length &&
    dbMessages[dbMessages.length - 1].role === "ai" &&
    dbMessages[dbMessages.length - 1].model_used === INSTANT_ACK_TAG
  ) {
    trailingAck = dbMessages[dbMessages.length - 1].content;
    dbMessages = dbMessages.slice(0, -1);
  }

  if (dbMessages.length === 0) {
    console.warn("[webhook] no messages found after save");
    return;
  }

  // A MESSAGE FROM THE FUTURE IS NOT PART OF THIS TURN. GHL-imported rows
  // carry GHL's clock (conversation-sync clamps new imports now, but rows
  // written before that fix - or any other skewed writer - can still be
  // stamped ahead of us). A future-stamped echo of our own reply lands at the
  // END of the ordered thread, so BOTH turn guards read it as "we already
  // answered" - this one, and the brain's own last-message check, which then
  // fails all three generation attempts. Either way the lead's turn is eaten,
  // silently. Dropped from the working set entirely (never persisted-to), so
  // it cannot end the history the model sees either. Two seconds of tolerance
  // so ordinary same-second writes are never touched.
  const skewCutoffMs = Date.now() + 2_000;
  const settledMessages = dbMessages.filter(
    (m) => new Date(m.created_at).getTime() <= skewCutoffMs
  );
  if (settledMessages.length) dbMessages = settledMessages;
  const lastMsg = dbMessages[dbMessages.length - 1];
  if (lastMsg.role !== "lead") {
    console.log("[webhook] skipping: already replied (burst handling)");
    return;
  }
  // Clock start for total_ms: the lead's LAST message (what they were waiting
  // on when the reply finally landed), not the first of their burst.
  timing.lead_msg_at = lastMsg.created_at ?? null;
  timing.inbound_source = lastMsg.source ?? "ghl";

  // --- Outbound circuit breakers (see constants at top). Fail-open when a
  //     count comes back null (transient DB error): a hiccup must not silence
  //     the setter, and the lock/debounce/dedup guards still apply. ---
  const hourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const [leadHourCount, clientHourCount] = await Promise.all([
    countAiMessagesSince(lead.id, hourAgoIso),
    countClientAiMessagesSince(client.id, hourAgoIso),
  ]);
  const leadLimited =
    leadHourCount != null && leadHourCount >= MAX_AI_MSGS_PER_LEAD_PER_HOUR;
  const clientLimited =
    clientHourCount != null && clientHourCount >= MAX_AI_MSGS_PER_CLIENT_PER_HOUR;
  if (leadLimited || clientLimited) {
    const event_type = leadLimited
      ? "rate_limit_lead_hold"
      : "rate_limit_client_hold";
    const alreadyPinged = await recentEventExists({
      client_id: client.id,
      lead_id: leadLimited ? lead.id : undefined,
      event_type,
      since_iso: hourAgoIso,
    });
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type,
      metadata: { lead_hour: leadHourCount, client_hour: clientHourCount },
    });
    if (!alreadyPinged) {
      await sendTelegramPing(
        leadLimited
          ? `🛑 Setter safety brake: this lead already got ${leadHourCount} AI messages in the last hour, so I'm holding further replies to them for now (protects the IG account from spam flags). They'll get a reply on their next message once it cools down.\n${ghlContactLink(client.ghl_location_id ?? "", lead.ghl_contact_id ?? "")}`
          : `🛑 Setter safety brake: ${clientHourCount} AI DMs went out in the last hour across all leads — holding replies until volume drops (protects the IG account from spam flags).`,
        true,
        { leadId: leadLimited ? lead.id : null, clientId: client.id, kind: "rate_limit_hold" }
      );
    }
    console.log("[webhook] rate-limit hold:", event_type, {
      leadHourCount,
      clientHourCount,
    });
    return;
  }

  // The full conversation fed to both the stage manager and the generator.
  const history: Message[] = [
    ...(priorHistory ?? []),
    ...dbMessages.map((m) => ({
      role: m.role,
      content: m.content,
      created_at: m.created_at,
    })),
  ];

  // --- Stage tracking: figure out exactly where in the funnel we are, capture
  //     any new facts, and rail the reply to this one step. No-ops cleanly if
  //     the client has no stages configured (legacy full-script behaviour). ---
  let stageContext: StageContext | undefined;
  // Carried out of the stages block so the post-send GHL pipeline auto-move
  // (below, once the reply is actually delivered) knows where in the funnel we
  // landed. Stays null for legacy clients with no stages → auto-move no-ops.
  let resolvedFunnelStageId: string | null = null;
  // "Dig deeper into pain" overlay: when the tracker flags an emotionally heavy
  // disclosure, this carries the per-reply empathy directive out of the stages
  // block to the generateReply call. Stays undefined unless the client has
  // pain_dig_enabled AND the tracker fired this turn → totally inert when off.
  let painInstruction: string | undefined;
  const stages = parseStages(client.stages);
  if (stages.length > 0) {
    const resolution = await resolveStage({
      stages,
      // The setter's OWN funnel position — NOT lead.stage (the GHL pipeline
      // stage, owned by the Jarvis watcher). Reading lead.stage here is what
      // used to corrupt the funnel ("New Lead" => reset to opener => re-ask).
      currentStageId: lead.funnel_stage ?? null,
      stageData: lead.stage_data ?? {},
      messages: history.map((m) => ({ role: m.role, content: m.content })),
      painEnabled: client.pain_dig_enabled === true,
      painProtocol: client.pain_protocol ?? null,
      whaleEnabled: client.whale_radar_enabled === true,
    });

    // WHALE RADAR: the first time a lead scores as a high-value whale, ping the
    // owner (only him) so he/Ethan can jump in personally. Once per lead, and
    // skipped entirely for any lead he's muted (whale_paused).
    if (client.whale_radar_enabled === true && lead.whale_paused !== true && resolution.whale && resolution.whale.score >= WHALE_THRESHOLD) {
      const alreadyFlagged = await eventExists(lead.id, "whale_flagged");
      if (!alreadyFlagged) {
        await logEvent({
          client_id: client.id,
          lead_id: lead.id,
          event_type: "whale_flagged",
          metadata: { score: resolution.whale.score, reason: resolution.whale.reason },
        });
        const nm = lead.full_name || lead.ig_username || "a lead";
        const handle = lead.ig_username ? ` (@${lead.ig_username})` : "";
        const link = client.ghl_location_id && lead.ghl_contact_id
          ? `\nJump in: ${ghlContactLink(client.ghl_location_id, lead.ghl_contact_id)}` : "";
        await sendTelegramPing(
          `🐳 WHALE in the DMs — ${nm}${handle}\n${resolution.whale.reason} (score ${resolution.whale.score}/100)${link}`,
          true,
          { leadId: lead.id, clientId: client.id, kind: "whale" }
        );
      }
    }

    // Emotionally heavy moment → pause the funnel and dig with empathy this
    // reply. The stage is already held (resolveStage froze it); here we just
    // build the per-reply directive and note it for the brain. Captured pain
    // facts are persisted with stage_data below, so they're remembered for the
    // rest of the conversation and available at pitch time.
    if (resolution.digPain) {
      painInstruction = painDigInstruction(
        painProtocolFor(client.pain_protocol),
        resolution.stageData
      );
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "pain_dig",
        metadata: { stage: resolution.stage.id, reason: resolution.reason },
      });
    }

    // Capture BEFORE the write: the previous stage is what decides whether a
    // note is due, and the write below must not be able to shadow it.
    const previousStage = lead.funnel_stage ?? null;

    // Persist where we are + what we've learned (sticky across messages).
    await updateLeadStage({
      lead_id: lead.id,
      stage: resolution.stage.id,
      stage_data: resolution.stageData,
    });

    // THE CRM PAPER TRAIL (owner ask 2026-08-13): every stage move lands as a
    // note on the lead's GHL contact - where they moved to and everything
    // learned so far - so opening their card in the CRM shows the same story
    // the setter is working from. Best-effort; a note can never break a turn.
    if (resolution.stage.id !== previousStage) {
      await noteStageChange({
        client,
        lead,
        fromStage: previousStage,
        toStage: resolution.stage.id,
        stageData: resolution.stageData,
      });
    }
    resolvedFunnelStageId = resolution.stage.id;

    // OBSERVABILITY: record what the stage tracker decided each turn. A silent
    // capture failure (fail-closed keeps the stage with NO facts) used to be
    // invisible — the setter then re-asked an answered question and there was
    // nothing in the data to say why. Now every turn shows its stage, whether
    // it advanced, and exactly which facts were captured.
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "stage_resolved",
      metadata: {
        stage: resolution.stage.id,
        advanced: resolution.advanced,
        objection: resolution.objection,
        captured: Object.keys(resolution.stageData || {}),
        reason: (resolution.reason || "").slice(0, 200),
      },
    });

    if (resolution.advanced) {
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "stage_advanced",
        metadata: { stage: resolution.stage.id, reason: resolution.reason },
      });
    }

    // Sync the captured email onto the GHL contact (once) so when the lead books
    // via the calendar widget, GHL matches them to this SAME contact instead of
    // creating a duplicate. The IG contact otherwise has no email to dedupe on.
    const capturedEmail = resolution.stageData.email;
    if (
      typeof capturedEmail === "string" &&
      capturedEmail.includes("@") &&
      client.ghl_api_key &&
      lead.ghl_contact_id
    ) {
      const alreadySynced = await eventExists(lead.id, "contact_email_synced");
      if (!alreadySynced) {
        const r = await updateContactEmail(
          client.ghl_api_key,
          lead.ghl_contact_id,
          capturedEmail.trim()
        );
        if (r.success) {
          await logEvent({
            client_id: client.id,
            lead_id: lead.id,
            event_type: "contact_email_synced",
            metadata: { email: capturedEmail.trim() },
          });
        }
      }
    }

    // Disqualify branch (e.g. 3rd-world location per the operator's rules):
    // pause the AI (pauseLead pings the owner), and do NOT reply.
    if (resolution.disqualify) {
      await pauseLead({ client, lead, notify: { label: "Disqualified lead (auto-paused)", reason: resolution.reason } });
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "stage_disqualified",
        metadata: { stage: resolution.stage.id, reason: resolution.reason },
      });
      // Move the GHL card to "Disqualified" too (best-effort, forward-guarded —
      // leaves a booked/won card alone). The watcher logs the GHL milestone on
      // its next pass.
      await syncPipelineDisqualified({ client, lead });
      return;
    }

    // On the Book stage, pull Ethan's REAL open slots so the setter offers
    // actual availability instead of inventing times. We fetch them IN THE
    // LEAD'S timezone (derived from the country we captured), so GHL returns the
    // slots already in their local time and we never have to convert by hand.
    // Best-effort: any failure leaves availableSlots undefined and the Book
    // stage falls back to a concrete range (the prompt handles that branch).
    let availableSlots: string[] | undefined;
    const leadTimezone =
      countryToTimezone(
        typeof resolution.stageData.location === "string"
          ? resolution.stageData.location
          : null
      ) || client.timezone;
    if (
      resolution.stage.id === "book" &&
      client.ghl_calendar_id &&
      client.ghl_api_key
    ) {
      try {
        const free = await getFreeSlots(client.ghl_api_key, client.ghl_calendar_id, {
          timezone: leadTimezone,
        });
        availableSlots = free.slots;
      } catch (err) {
        console.error("[webhook] getFreeSlots failed:", err);
      }
    }

    stageContext = {
      name: resolution.stage.name,
      goal: resolution.stage.goal,
      playbook: resolution.stage.playbook,
      knownFacts: resolution.stageData,
      objection: resolution.objection,
      funnelMap: stages.map((s) => s.name),
      availableSlots,
      slotsTimezone: leadTimezone,
    };
  }

  // --- Conversation language: detect Swedish, ask "snackar du svenska?" once,
  //     then LOCK the thread to Swedish and remember it. Runs only when there's
  //     a Swedish hint (or we're awaiting an answer), so plain English threads
  //     pay nothing extra. Best-effort: on any error it leaves language as-is. ---
  const knownLocation =
    lead.stage_data?.location ?? stageContext?.knownFacts?.location;
  const lang = await resolveConversationLanguage({
    current: lead.conversation_language,
    history,
    knownLocation,
  });
  if (lang.state !== (lead.conversation_language ?? "en")) {
    await updateLeadLanguage(lead.id, lang.state);
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type:
        lang.state === "sv"
          ? "language_locked_sv"
          : lang.state === "sv_pending"
          ? "language_ask_swedish"
          : lang.state === "en_declined"
          ? "language_declined"
          : "language_changed",
      metadata: { from: lead.conversation_language ?? "en", to: lang.state },
    });
  }

  const genClient = {
    name: client.name,
    slug: client.slug,
    system_prompt: client.system_prompt,
    voice_samples: client.voice_samples,
    active_rules: client.active_rules,
    business_context: client.business_context,
    timezone: client.timezone,
  };

  // 'Leave it on read' silence REMOVED (owner decision): the setter replies to
  // EVERY lead message now — including a bare "ok"/👍, and including after we
  // asked a question. No straggler judgment, no NO_REPLY, no dedup-suppress.
  // Voice notes: tell the brain it can speak a message (in the operator's voice)
  // only when the overlay is live for this thread (enabled + clone id + English).
  const voiceOn = lead.voice_paused !== true && voiceActive({
    enabled: client.voice_enabled,
    enabledSv: client.voice_enabled_sv === true,
    voiceId: client.setter_voice_id,
    voiceIdSv: client.setter_voice_id_sv,
    langState: lang.state,
  });
  const voiceId = voiceIdForLang({
    voiceId: client.setter_voice_id,
    voiceIdSv: client.setter_voice_id_sv,
    langState: lang.state,
  });
  // Voice cadence nudge: the beat list alone under-delivers (live threads have
  // gone entire stretches all-text). When voice is live and nothing was VOICED
  // recently, actively push the next eligible beat to be spoken. The hard
  // quota (max one per reply, none right after a voice bubble) still caps it.
  const aiRows = dbMessages.filter((m) => m.role === "ai");
  const lastVoiceIdx = aiRows.map((m) => m.delivery === "voice").lastIndexOf(true);
  const bubblesSinceVoice = lastVoiceIdx === -1 ? aiRows.length : aiRows.length - 1 - lastVoiceIdx;
  const voiceNudge =
    voiceOn && (lastVoiceIdx === -1 ? aiRows.length >= 6 : bubblesSinceVoice >= 8)
      ? `\n\nVOICE CADENCE CHECK: none of your recent messages was a voice note, so you're currently UNDER the ~1-in-4 target. If this reply lands on ANY of the voice beats above, deliver that beat as a [[VOICE]] note. Mark at most ONE bubble as [[VOICE]], never more.`
      : "";
  // CONGRUENCE with the hard quota (audit 2026-07-24): when a voice note just
  // went out, the quota below will strip any [[VOICE]] anyway — so tell the
  // model UP FRONT instead of letting it compose a voice-shaped message that
  // arrives as oddly-shaped text.
  const voiceCoolingDown = aiRows.slice(-3).some((m) => m.delivery === "voice");
  const voiceInstruction = voiceOn
    ? voiceCoolingDown
      ? VOICE_INSTRUCTION + `\n\nVOICE COOLDOWN: one of your last messages already went out as a voice note. Do NOT mark any [[VOICE]] in this reply - plain text bubbles only this time.`
      : VOICE_INSTRUCTION + voiceNudge
    : undefined;
  // ManyChat is the channel that can deliver a REAL Instagram voice note (GHL
  // can't). When the client has a ManyChat token, voice notes route through it
  // as WAV; text stays on GHL. We resolve the lead's ManyChat subscriber LAZILY
  // (only when a voice segment is actually produced) and cache it on the lead,
  // so a text-only reply never makes an extra API call.
  const manychatToken = client.manychat_api_token || "";
  let manychatSubId: string | null = lead.manychat_subscriber_id || null;
  let manychatResolveTried = false;
  const ensureManychatSub = async (): Promise<string | null> => {
    if (manychatSubId || manychatResolveTried || !manychatToken) return manychatSubId;
    manychatResolveTried = true;
    // Try several identities so the FIRST voice send resolves even when the lead's
    // ManyChat name isn't an exact match for our stored full name: the @handle, the
    // full name, and each name token (first/last) on its own. Once resolved, the id
    // is cached on the lead so we never look it up again.
    const nameTokens = (lead.full_name || "").trim().split(/\s+/).filter((t) => t.length >= 2);
    const candidates = [lead.ig_username, lead.full_name, ...nameTokens];
    manychatSubId = await resolveSubscriberId(manychatToken, candidates);
    if (manychatSubId) await setLeadManychatSubscriberId(lead.id, manychatSubId);
    return manychatSubId;
  };
  // The per-reply directive(s) folded into THIS reply: voice capability and/or
  // the pain-dig empathy overlay (when it fired).
  // If we already fired a quick reaction this turn — either THIS invocation's own
  // maybeSendInstantAck call (alreadyAcked) or the fast ManyChat path's ack that
  // arrived before we even started generating (trailingAck, trimmed from the
  // thread tail above) — the considered reply must NOT acknowledge again.
  // The delivered reaction is fed to the brain as an assistant PREFILL (see
  // generateReply.ackPrefill) — the model continues its own already-started
  // reply, so it structurally can't re-react. The prefill's bridging user note
  // (brain.ts) labels it in-conversation; a separate system-prompt instruction
  // repeating the same words was pure noise and was removed (prompt diet,
  // audit 2026-07-24) — the hard ack-echo filter below still backstops it.
  const effectiveAcked = alreadyAcked ?? trailingAck;

  // --- MESSAGE-TIMING attribution: two ways a lead message can "cross" ours.
  //     (a) stragglerRegen: it arrived while THIS reply was mid-generation -
  //     nothing new from us has been delivered, so it can only be answering our
  //     earlier messages. (b) crossed sends: it was written before (or seconds
  //     after) our last bubbles actually REACHED their phone - delivered_at is
  //     stamped when the paced send sequence completes, so if their message
  //     predates that moment plus a short reading window, they almost certainly
  //     had not read our newest bubbles yet. Live case of (b): the setter
  //     pitched the call while the lead was still typing "Yeah" to the previous
  //     question, then read the "Yeah" as a yes to the pitch it had just sent.
  //     Legacy rows without delivered_at fall back to created_at (save time),
  //     which only makes the check more conservative - never noisier.
  //     The comparison window compensates for how STALE the lead row's
  //     created_at is relative to when they actually hit send: a ManyChat-saved
  //     row lands ~1s after they sent (tiny buffer), a GHL-saved row ~10s after
  //     (the measured webhook lag). Anything wider over-fires on genuine fast
  //     repliers and makes the model second-guess real answers. ---
  let timingNote: string | undefined;
  if (stragglerRegen) {
    timingNote = `TIMING NOTE: the lead's newest message(s) arrived WHILE you were still composing - nothing new from you has been delivered since your last message in the thread above. They were responding to those earlier messages, not to anything you were about to send. Never treat their newest message as the answer to a question you have not actually sent.`;
  } else {
    const priorAi = dbMessages.filter((m) => m.role === "ai");
    const lastAi = priorAi[priorAi.length - 1];
    if (lastAi) {
      const deliveredMs = new Date(lastAi.delivered_at ?? lastAi.created_at).getTime();
      const saveLagMs = lastMsg.source === "manychat" ? 2_000 : 10_000;
      if (new Date(lastMsg.created_at).getTime() < deliveredMs + saveLagMs) {
        timingNote = `CROSSED MESSAGES: their newest message was written before (or right as) your last message(s) reached their phone - they most likely had NOT read your latest bubbles yet when they sent it. Read it as a response to your EARLIER messages, not as an answer to the newest question you asked. If it could plausibly be their answer to that newest question, casually confirm which one they meant in one short line instead of assuming.`;
      }
    }
  }

  const baseInstruction =
    [timingNote, voiceInstruction, painInstruction].filter(Boolean).join("\n\n") || undefined;

  let aiResult;
  const modelStart = Date.now();
  {
    // A transient LLM error (rate limit, blip, malformed response) must NOT leave
    // the lead with no reply. Try up to 3 times with a short backoff before giving
    // up — and even when we do give up, the unanswered-leads sweep (cron) will
    // re-attempt later, so a lead never stays silent because of a one-off failure.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        aiResult = await generateReply({
          client: genClient,
          history,
          stage: stageContext,
          language: lang.directive ?? undefined,
          extraInstruction: baseInstruction,
          ackPrefill: effectiveAcked,
          // WHO IT IS TALKING TO (incident 2026-08-08). The model got no name,
          // no handle and no sense of how long the thread had been running, so
          // it opened on people the operator had known for months as if they
          // were strangers. Thread age is derived inside brain.ts.
          lead: { displayName: lead.full_name, handle: lead.ig_username },
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        console.error(`[webhook] generateReply failed (attempt ${attempt + 1}/3):`, err);
        // DO NOT RETRY WHAT CANNOT SUCCEED (incident 2026-08-16). This loop
        // retried anything, so when the Anthropic account ran out of credit it
        // fired three identical doomed requests with 4.5s of backoff between
        // them, on a live inbound, and then did it again on every five-minute
        // sweep tick for two hours. A 400 saying "your credit balance is too
        // low" has exactly one answer no matter how many times it is asked.
        if (!classifyLLMError(err).retryable) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    if (lastErr || !aiResult) {
      const errMsg = lastErr instanceof Error ? lastErr.message : "Unknown error";
      await logAIDecision({
        lead_id: lead.id,
        client_id: client.id,
        system_prompt_used: "(failed before send)",
        conversation_context: { messages: dbMessages.length },
        raw_response: "",
        error: errMsg,
      });
      // A triple generation failure used to die into ai_decisions with zero
      // visibility (a live lead sat ack-only for hours before anyone knew).
      // Log the event always; ping the owner at most once per lead per hour.
      const failure = classifyLLMError(lastErr);
      const hourAgo = new Date(Date.now() - 3600_000).toISOString();
      const alreadyPinged = await recentEventExists({
        client_id: client.id, lead_id: lead.id, event_type: "ai_generate_failed", since_iso: hourAgo,
      });
      await logEvent({
        client_id: client.id, lead_id: lead.id, event_type: "ai_generate_failed",
        metadata: { error: errMsg.slice(0, 200), kind: failure.kind, status: failure.status },
      });
      // ACCOUNT-LEVEL FAILURES ARE ONE INCIDENT, NOT N LEAD PROBLEMS
      // (2026-08-16). The dedup below is keyed on the LEAD, which is right for
      // a per-lead fault and wrong for a dead account: ten people messaging
      // during one billing outage would have produced ten alarms naming ten
      // different leads, each reading like a lead-specific problem. An account
      // failure is the same sentence about the same cause for everyone, so it
      // dedups on the CLIENT instead and says so in the owner's own terms.
      const accountPingedRecently = failure.kind === "account"
        ? await recentEventExists({
            client_id: client.id, event_type: "llm_account_down", since_iso: hourAgo,
          })
        : false;
      if (failure.kind === "account") {
        await logEvent({
          client_id: client.id, lead_id: lead.id, event_type: "llm_account_down",
          metadata: { status: failure.status, message: failure.message.slice(0, 300) },
        });
      }
      if (failure.kind === "account" ? !accountPingedRecently : !alreadyPinged) {
        const link = ghlContactLink(client.ghl_location_id ?? "", lead.ghl_contact_id ?? "");
        // The full sentence, not a 140-char slice that used to cut the
        // Anthropic error at "Please go" and drop the half saying what to do.
        const text = failure.kind === "account"
          ? ownerSentence(failure)
          : `The brain could not generate a reply for ${leadLabel(lead, "a lead")}. ${ownerSentence(failure)}${failure.retryable ? " The sweep will retry." : " Retrying will not help."}`;
        await sendTelegramPing(
          `${text}${link ? `\n${link}` : ""}`,
          true,
          { leadId: lead.id, clientId: client.id, kind: failure.kind === "account" ? "llm_account_down" : "generate_failed" }
        ).catch(() => {});
      }
      return; // the cron sweep will retry this lead
    }
  }

  // --- Anti-repeat guard: never re-send a near-copy of something we already
  //     said. If the fresh reply repeats a recent AI bubble, regenerate ONCE
  //     telling the model not to repeat. We ALWAYS send (never go silent). If the
  //     retry STILL repeats, the setter is genuinely STUCK — it can't find a way
  //     to move the conversation forward — so we send its best attempt AND flag
  //     it to ping the owner to jump in. The [[VOICE]] marker is stripped before
  //     comparing so a spoken line isn't mis-flagged. ---
  const stripMark = (segs: string[]) => segs.map((s) => s.replace(VOICE_MARKER_RE, "").trim());
  // NOTE: the turn's quick reaction is deliberately NOT in this comparison set.
  // Including it made isRepeatReply flag the reply's empathy wording against
  // the ack and fire false "setter stuck" escalations. The ack-echo problem is
  // solved structurally instead (assistant prefill + the hard filter below).
  const ackTexts = [...new Set([trailingAck, alreadyAcked].filter((s): s is string => !!s))];
  // Compare against the last 8 SUBSTANTIVE bubbles, with instant acks excluded:
  // acks used to eat most of a 6-row window (live: Asyah 2026-07-30 — "where
  // you based" asked FIVE times because each repeat's predecessor had already
  // been pushed out of the window by ack rows).
  const priorAiBubbles = dbMessages
    .filter((m) => m.role === "ai" && m.model_used !== INSTANT_ACK_TAG)
    .slice(-8)
    .map((m) => m.content);
  let stuck = false;
  if (isRepeatReply(stripMark(aiResult.segments), priorAiBubbles)) {
    console.log("[webhook] generated reply repeats a recent message — regenerating once");
    try {
      const antiRepeatInstruction =
        "You have ALREADY sent your most recent 'assistant' messages above. Do NOT repeat them, reword them, or re-ask a question you have already asked. The lead has seen them. Move the conversation FORWARD to the next step of the process instead.";
      const retry = await generateReply({
        client: genClient,
        history,
        stage: stageContext,
        language: lang.directive ?? undefined,
        extraInstruction: baseInstruction
          ? `${baseInstruction}\n\n${antiRepeatInstruction}`
          : antiRepeatInstruction,
        ackPrefill: effectiveAcked,
        // A retry must know the person just as well as the first pass did —
        // dropping it here would quietly hand the lead a stranger's reply.
        lead: { displayName: lead.full_name, handle: lead.ig_username },
      });
      // Still a near-duplicate after the retry → genuinely stuck. We still send
      // the best attempt (never ghost the lead); the owner gets pinged below.
      if (isRepeatReply(stripMark(retry.segments), priorAiBubbles)) stuck = true;
      aiResult = retry;
    } catch (err) {
      // A failed regeneration must not drop the reply — fall through and send
      // the original rather than leave the lead hanging.
      console.error("[webhook] anti-repeat regeneration failed:", err);
    }
  }

  // --- DEAD-END GUARD (operator rule, live incident 2026-07-25): a reply that
  //     ends on a pure reaction ("yeah that's a decent run") hands the thread
  //     back with nothing to answer, and the lead never restarts it — the
  //     conversation just dies mid-funnel. Every reply must end on a question
  //     that moves the stage forward. Regenerate ONCE when there's no question
  //     anywhere in the reply; if the retry still has none we send the best
  //     attempt anyway (never ghost the lead). Deliberately skipped when the
  //     reply carries a link or times (booking/logistics beats legitimately end
  //     on an instruction, not a question). ---
  const asksSomething = (segs: string[]) => segs.some((s) => s.includes("?"));
  const carriesLinkOrTime = (segs: string[]) =>
    segs.some((s) => /https?:\/\/|\b\d{1,2}[:.]\d{2}\b|\bcalendar\b/i.test(s));
  if (
    aiResult.segments.length &&
    !asksSomething(aiResult.segments) &&
    !carriesLinkOrTime(aiResult.segments)
  ) {
    console.log("[webhook] reply has no question — regenerating once (dead-end guard)");
    try {
      const askInstruction =
        "Your draft ends without asking anything, which hands the conversation back to them with nothing to answer — that kills the thread. Rewrite it so it still reacts to what they said, then ENDS on one natural question that moves the current step forward. One question, not two.";
      const retry = await generateReply({
        client: genClient,
        history,
        stage: stageContext,
        language: lang.directive ?? undefined,
        extraInstruction: baseInstruction ? `${baseInstruction}\n\n${askInstruction}` : askInstruction,
        ackPrefill: effectiveAcked,
        // Same as the retry above: the identity block must survive every path
        // that can produce the reply actually sent.
        lead: { displayName: lead.full_name, handle: lead.ig_username },
      });
      if (retry.segments.length) aiResult = retry;
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "dead_end_reply_regenerated",
        metadata: { recovered: asksSomething(retry.segments) },
      }).catch(() => { /* best-effort */ });
    } catch (err) {
      console.error("[webhook] dead-end regeneration failed:", err);
    }
  }

  // A rare empty completion (the model deemed the prefilled reaction a complete
  // reply) must not fabricate an "ai_replied" with zero bubbles — the thread
  // still ends on the lead's message, so the sweep/watchdog retries later.
  if (!aiResult.segments.length) {
    console.warn("[webhook] empty completion — nothing to send");
    // Logged so a thread stuck in a systematic empty-completion loop (same
    // prefill, same history, every 30-min sweep retry) is visible in events
    // instead of only as a console line nobody reads.
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "ai_empty_completion",
      metadata: { acked: Boolean(effectiveAcked) },
    }).catch(() => { /* best-effort */ });
    return;
  }

  // ── HUMANIZER HOLD (owner rule 2026-08-08) ─────────────────────────────────
  // A considered reply that lands seconds after the lead's message screams
  // bot, no matter how good the words are. Before anything is committed or
  // sent, make sure a human-plausible amount of time has passed since THEIR
  // message:
  //   - short reply (1-2 sentences): at least ~8-12s end to end
  //   - longer reply (3+ sentences): at least 10s, plus "typing time"
  //     proportional to how much we wrote (a wall of text in 6s is impossible)
  // The target is randomized per reply so the cadence never looks scheduled.
  // Everything already spent (debounce + generation) counts toward the target,
  // so this usually adds only a few seconds; hard-capped so the total wait
  // never exceeds ~50s and the invocation stays inside the 60s platform
  // budget. Runs BEFORE the straggler re-check on purpose: a message that
  // arrives while we're "typing" is caught there and folded into ONE reply.
  // A sweep/watchdog rescue of an old message has a huge elapsed time, so the
  // hold naturally collapses to zero there.
  {
    const HOLD_CAP_MS = 20_000;           // max extra sleep this invocation will add
    const TOTAL_WAIT_CEILING_MS = 50_000; // owner rule: never wait more than 50s total
    // The hold must also respect the INVOCATION's own 60s platform budget:
    // debounce + generation (+ any regen passes) already spent part of it, and
    // the paced sends after us can take up to ~16s + bookkeeping. Never let
    // the sleep push the invocation past this mark, whatever the lead-side
    // math says — a killed invocation drops bubbles and strands the reply
    // lock, which is worse than a slightly-too-fast reply.
    const INVOCATION_HOLD_DEADLINE_MS = 38_000;
    const invocationElapsedMs = Date.now() - T0;
    const draft = aiResult.segments.join(" ");
    const sentenceCount = Math.max(1, (draft.match(/[.!?]+(?:\s|$)/g) || []).length, aiResult.segments.length);
    const isLong = sentenceCount > 2;
    const typingMs = draft.length * 55;      // ~how long a human takes to type it
    const baseMs = isLong ? 10_000 : 8_000;  // floors: 10s minimum for 3+ sentences
    const jitterMs = Math.random() * 4_000;
    const targetMs = Math.min(baseMs + typingMs + jitterMs, TOTAL_WAIT_CEILING_MS);
    const elapsedMs = Date.now() - new Date(lastMsg.created_at).getTime();
    const holdMs = Math.min(
      Math.max(0, Math.round(targetMs - elapsedMs)),
      HOLD_CAP_MS,
      Math.max(0, TOTAL_WAIT_CEILING_MS - elapsedMs),
      Math.max(0, INVOCATION_HOLD_DEADLINE_MS - invocationElapsedMs)
    );
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  }

  // --- STRAGGLER GUARD: a lead often fires a 2nd/3rd message a few seconds after
  //     the first ("Far bro" ... "I make 3k a month"). That later message's webhook
  //     can land AFTER we read the thread (top of this function) and DURING the
  //     ~15-25s it took to generate — and its own invocation is meanwhile locked
  //     out by ours. Without this check we'd commit a reply that ignores what they
  //     JUST said (e.g. ask "what do you make?" right after they answered "3k").
  //     So before we save or send anything, re-read the newest lead message: if a
  //     newer one arrived, DON'T send — bail and let the caller regenerate with the
  //     fuller thread, so the lead gets ONE reply that accounts for everything. ---
  if (!forceSend) {
    try {
      // SETTLE PAUSE before the re-check: GHL delivers a lead's bubbles with
      // seconds of lag EACH — live case: the reply asked "what country?" and
      // "from sweden" was delivered ONE second after the send. Generation just
      // finished, so a bubble typed during it is likely still in flight from
      // GHL right now; give it a beat to land, THEN check. Costs ~5s per reply,
      // erases the razor-edge race that made the setter look blind. Skipped on
      // a regeneration pass (pass 0 already paid it once — keeps the whole
      // invocation inside the 60s budget).
      // ManyChat-sourced rows land ~1s after the lead sends and in order, so
      // the GHL-lag settle pause is pure dead air on the primary path — only
      // pay it when the newest row came through GHL's laggy webhook.
      if (!stragglerRegen && lastMsg.source !== "manychat") await new Promise((r) => setTimeout(r, 5_000));
      const newestNow = await getLatestLeadMessage(lead.id);
      if (newestNow && newestNow.id !== lastMsg.id) {
        console.log("[webhook] newer lead message arrived during generation — regenerating before send");
        return { retryForNewer: true };
      }
    } catch (e) {
      // If the re-check itself fails, prefer sending what we have over dropping the reply.
      console.error("[webhook] straggler re-check failed — sending current reply:", e);
    }
  }

  // --- PAUSE RE-CHECK: a pause set WHILE this reply was generating (screener
  //     handoff, their-funnel stand-down, the owner hitting pause) must stop the
  //     send — the gate at the top of the pipeline ran seconds ago and can be
  //     stale. Fail-open on any error: a DB blip must not drop a normal reply. ---
  try {
    const { data: freshLead } = await supabase
      .from("leads")
      .select("ai_paused")
      .eq("id", lead.id)
      .maybeSingle();
    if ((freshLead as { ai_paused?: boolean } | null)?.ai_paused === true) {
      console.log("[webhook] lead was paused mid-generation — reply withheld");
      return;
    }
  } catch (e) {
    console.error("[webhook] pre-send pause re-check failed — sending:", e);
  }

  // --- Intra-reply de-dupe: the anti-repeat guard above only compares this reply against PRIOR
  //     replies, never within itself. If the model ever emits the same bubble twice in ONE reply
  //     (models occasionally loop), the lead would get the identical message back-to-back and it
  //     looks like a glitchy bot. Drop any bubble that is TRULY identical to an earlier bubble in
  //     THIS reply. The key strips the voice marker, normalises whitespace and case, and keeps
  //     punctuation, so genuinely distinct lines like "Great!" vs "Great." are BOTH kept. It
  //     only ever removes an exact repeat (never merges two distinct lines), so it can't cause a
  //     double-send; it prevents one. ---
  const dedupeKey = (s: string) => s.replace(VOICE_MARKER_RE, "").replace(/\s+/g, " ").trim().toLowerCase();
  const seenSegKeys = new Set<string>();
  const dedupedSegments = aiResult.segments.filter((s) => {
    const key = dedupeKey(s);
    if (!key) return true; // keep anything that normalizes to empty (edge only)
    if (seenSegKeys.has(key)) return false;
    seenSegKeys.add(key);
    return true;
  });

  // HARD ack-echo guard: the model is instructed not to repeat the quick
  // reaction that already went out this turn, but instructions aren't a
  // guarantee — a live reply once opened with a verbatim copy of its own ack.
  // Drop any bubble identical to the delivered ack (never the whole reply:
  // if everything matched, keep it rather than go silent).
  const ackKeys = new Set(ackTexts.map(dedupeKey).filter(Boolean));
  const nonEcho = dedupedSegments.filter((s) => !ackKeys.has(dedupeKey(s)));
  const finalSegments = nonEcho.length ? nonEcho : dedupedSegments;

  // --- HARD length enforcement: any bubble over MAX_BUBBLE_CHARS is split at
  //     sentence boundaries into texting-sized bubbles. The [[VOICE]] marker is
  //     preserved on the first chunk of a marked bubble (a split spoken line is
  //     still one voice candidate; overflow chunks go as text). ---
  const lengthEnforced = finalSegments.flatMap((seg) => {
    const marked = VOICE_MARKER_RE.test(seg);
    const body = seg.replace(VOICE_MARKER_RE, "").trim();
    const parts = splitLongBubble(body);
    return parts.map((p, i) => (marked && i === 0 ? `[[VOICE]] ${p}` : p));
  });

  // --- Cap the volley: past MAX_BUBBLES_PER_REPLY, merge the overflow into
  //     the last bubble instead of dropping it (a booking link in bubble 6
  //     must still reach the lead — just inside bubble 4). The merged tail is
  //     re-split at sentence boundaries (audit 2026-07-24: the raw join
  //     bypassed the per-bubble length law and recreated exactly the wall of
  //     text the cap exists to prevent), allowing up to 2 extra bubbles — a
  //     rare 5-6 bubble volley beats one unreadable block. ---
  let cappedSegments: string[];
  if (lengthEnforced.length <= MAX_BUBBLES_PER_REPLY) {
    cappedSegments = lengthEnforced;
  } else {
    const mergedTail = lengthEnforced.slice(MAX_BUBBLES_PER_REPLY - 1).join("\n");
    // Never truncate — dropped overflow could be the booking link itself. The
    // model's own output cap bounds the realistic worst case at ~6 bubbles.
    const resplitTail = splitLongBubble(mergedTail);
    cappedSegments = [...lengthEnforced.slice(0, MAX_BUBBLES_PER_REPLY - 1), ...resplitTail];
  }

  // ── STUCK → HAND OVER, DO NOT REPEAT YOURSELF ────────────────────────────
  //
  // `stuck` means the reply repeated something we already said, we regenerated
  // with an explicit "do not repeat" instruction, and it repeated ANYWAY. The
  // old contract was to send it regardless and ping the owner, on the grounds
  // that silence is worse. Live, that contract fired on 8 of 89 replies in 30
  // days - nearly one in ten - and it is what the lead experiences as the
  // setter having a stroke. Asyah got the same line three times in twenty
  // minutes; Oliver and Oskar too.
  //
  // The premise was wrong in one specific way: the alternative was never
  // silence. It is a HANDOVER. We stop the AI for this person (replies,
  // follow-ups and nurture together, the same shape as every other stand-down)
  // and put the drafted line in the owner's hands in a tap-to-copy block, with the
  // thread's last message and a link. He sends it, rewrites it, or takes the
  // conversation. Nobody is ghosted, and the lead never sees us stammer.
  //
  // Deliberately NOT saved as an ai message: it never reached them, and saving
  // it would poison both the thread history and the anti-repeat window that
  // caught it in the first place.
  if (stuck) {
    const draft = cappedSegments.map((s) => s.replace(VOICE_MARKER_RE, "").trim()).filter(Boolean).join("\n\n");
    // notify:false because the copy block below IS the notification, and it
    // carries the draft. pauseLead still does everything else: both pause
    // flags, nurture, and the 'ai off' tag on the CRM contact.
    await pauseLead({ client, lead, notify: false }).catch(() => { /* the ping still matters */ });
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "setter_stuck",
      metadata: {
        lead_message: lastMsg.content.slice(0, 140),
        suppressed_draft: draft.slice(0, 500),
        action: "handed_off",
      },
    }).catch(() => { /* best-effort */ });

    const link = ghlContactLink(client.ghl_location_id ?? "", lead.ghl_contact_id ?? "");
    await sendTelegramCopyBlock(
      `🆘 I'm going in circles with ${leadLabel(lead)} — my next line just repeats what I already said, so I did NOT send it and I've switched myself off for them.\nThem: "${lastMsg.content.slice(0, 160)}"${link ? `\n${link}` : ""}\n\nHere's what I would have sent, if it's actually fine:`,
      draft || "(nothing usable)",
      { leadId: lead.id, clientId: client.id, kind: "stuck_handoff" }
    ).catch(() => { /* best-effort */ });

    return;
  }

  // --- Phase 2: tag any booking/calendar link the AI is about to send with
  //     utm_medium=ai_dm. We save + send the SAME tagged text so the DB record
  //     and the lead's DM match. ---
  // --- Build the outbound plan. Each capped segment goes out as TEXT, or — when
  //     the brain marked it [[VOICE]] AND voice is live + the line is eligible
  //     (no links/times, right length) — as a VOICE NOTE in the operator's cloned
  //     voice. VOICE IS DELIVERED ONLY through ManyChat (a real IG voice note).
  //     GHL is NEVER used to send voice: an mp3 over GHL reports success but never
  //     shows on Instagram, so the setter would "think" it spoke while the lead
  //     saw nothing (the bug that started this). If ManyChat can't resolve the
  //     lead or the clip can't be built, the spoken words go out as TEXT instead.
  //     We always SAVE the words (so memory + anti-repeat work on text). When
  //     voice is off this loop is equivalent to the old tag+send path. ---
  type Outbound = { saveText: string; message: string; voiceWavUrl?: string; fallbackText?: string; hadBookingLink: boolean; voice: boolean };
  const plan: Outbound[] = [];
  // HARD voice quota (the prompt's "at most 1 in 4" is advisory; this enforces
  // it): max ONE voice note per reply, and none at all when any of the last 3
  // saved AI bubbles already went out as voice. delivery='voice' is stamped at
  // save time below, so this reads the actual sent history, not intent.
  const recentVoice = dbMessages
    .filter((m) => m.role === "ai")
    .slice(-3)
    .some((m) => m.delivery === "voice");
  for (const seg of cappedSegments) {
    const marked = VOICE_MARKER_RE.test(seg);
    const body = seg.replace(VOICE_MARKER_RE, "").trim();
    if (voiceOn && marked && voiceEligible(body) && voiceId && manychatToken) {
      const quotaAllowsVoice = !plan.some((p) => p.voice) && !recentVoice;
      if (!quotaAllowsVoice) {
        await logEvent({
          client_id: client.id,
          lead_id: lead.id,
          event_type: "voice_quota_suppressed",
          metadata: { recent_voice: recentVoice, chars: body.length },
        });
      } else {
        // The brain ASKED for a voice note here. Every way this can fall back
        // to text is logged (2026-07-25): it used to be a bare console.error,
        // so a lead whose ManyChat subscriber never resolved silently got text
        // forever and the voice feature looked "broken" with nothing to point
        // at. Now the reason is queryable per lead.
        const sub = await ensureManychatSub();
        if (sub) {
          const wavUrl = await makeVoiceClipWav(body, voiceId, client.voice_settings ?? null);
          if (wavUrl) {
            plan.push({ saveText: body, message: "", voiceWavUrl: wavUrl, fallbackText: body, hadBookingLink: false, voice: true });
            continue;
          }
          console.error("[webhook] voice synthesis returned nothing — sending as text");
          await logEvent({
            client_id: client.id, lead_id: lead.id, event_type: "voice_degraded_to_text",
            metadata: { reason: "tts_failed", chars: body.length },
          }).catch(() => { /* best-effort */ });
        } else {
          console.error("[webhook] manychat subscriber unresolved — sending as text");
          await logEvent({
            client_id: client.id, lead_id: lead.id, event_type: "voice_degraded_to_text",
            metadata: { reason: "no_manychat_subscriber", chars: body.length },
          }).catch(() => { /* best-effort */ });
        }
      }
    } else if (marked && voiceOn) {
      // Marked for voice but rejected before we ever tried to synthesize
      // (ineligible text, missing voice id or ManyChat token).
      await logEvent({
        client_id: client.id, lead_id: lead.id, event_type: "voice_degraded_to_text",
        metadata: {
          reason: !voiceId ? "no_voice_id" : !manychatToken ? "no_manychat_token" : "text_not_eligible",
          chars: body.length,
        },
      }).catch(() => { /* best-effort */ });
    }
    const t = tagBookingLinks(body);
    plan.push({ saveText: t.text, message: t.text, hadBookingLink: t.hadBookingLink, voice: false });
  }

  const segmentsToSend = plan.map((p) => p.saveText);
  const hadBookingLink = plan.some((p) => p.hadBookingLink);
  const voiceCount = plan.filter((p) => p.voice).length;

  // Save AI messages (content = the words said/typed), keeping the rows so we can
  // stamp each with its GHL id (lets the outbound webhook tell the AI's own echo
  // from a human send).
  const savedAiRows: (DbMessage | null)[] = [];
  for (let i = 0; i < plan.length; i++) {
    const row = await saveMessage({
      lead_id: lead.id,
      client_id: client.id,
      role: "ai",
      content: plan[i].saveText,
      model_used: PRODUCTION_MODEL,
      input_tokens: i === 0 ? aiResult.input_tokens : undefined,
      output_tokens: i === 0 ? aiResult.output_tokens : undefined,
      // Stamped from the PLAN: if ManyChat fails at delivery time and the words
      // fall back to text, the row still says 'voice' — deliberately conservative
      // (the quota only ever under-counts toward MORE text, never more voice).
      delivery: plan[i].voice ? "voice" : undefined,
    });
    savedAiRows.push(row);
  }

  await logAIDecision({
    lead_id: lead.id,
    client_id: client.id,
    system_prompt_used: aiResult.system_prompt_used,
    conversation_context: { messages: dbMessages.length },
    raw_response: aiResult.raw_response,
    final_reply: aiResult.reply,
    duration_ms: aiResult.duration_ms,
  });

  // Model work is done (generation + any anti-repeat / dead-end regeneration);
  // everything from here is send time.
  timing.model_ms = Date.now() - modelStart;
  const sendStart = Date.now();
  const sendResults = await sendLeadMixedSequence({
    // Every bubble leaves through ManyChat. The lead id and GHL contact id are
    // passed only so the sender can FIND the ManyChat subscriber when it isn't
    // already cached on the row — never as a delivery route.
    lead_id: lead.id,
    ghl_contact_id: lead.ghl_contact_id ?? "",
    full_name: lead.full_name ?? null,
    ig_username: lead.ig_username ?? null,
    manychat_token: manychatToken ?? null,
    manychat_subscriber_id: manychatSubId ?? null,
    items: plan.map((p) => ({ message: p.message, voiceWavUrl: p.voiceWavUrl, fallbackText: p.fallbackText })),
    // Stamp EACH bubble delivered the instant it lands — not after the whole
    // sequence. If the platform kills this invocation mid-send (60s limit), the
    // bubbles that DID go out are marked, so the resend backstop can retry ONLY
    // the truly-undelivered tail instead of double-sending everything.
    onSent: async (i, r) => {
      const row = savedAiRows[i];
      if (!row) return;
      if (r.ghl_message_id) await setMessageGhlId(row.id, r.ghl_message_id);
      await markMessageDelivered(row.id);
    },
    // Stamp the attempt BEFORE the transport fires (live incident 2026-08-13):
    // a run killed mid-flight leaves attempted-but-unconfirmed, which the
    // resend backstop treats as probably-delivered instead of blindly
    // re-sending words Instagram already showed the lead.
    onAttempt: async (i) => {
      const row = savedAiRows[i];
      if (row) await markMessageAttempted(row.id);
    },
  });

  // GHL's contact record for this lead is GONE (merged/cleaned inside GHL) and
  // the reply only got out because ManyChat rescued it AFTER GHL rejected the
  // send. Tell the owner ONCE per lead per day — the conversation continues,
  // but GHL-side things (their CRM card, calendar-booked matching) point at a
  // dead contact until the lead gets a fresh one. Keys on ghl_gone, NOT on
  // via: ManyChat is the primary send channel now, so via === "manychat" is
  // the normal case, not an outage signal.
  if (lead.ghl_contact_id && sendResults.some((r) => r?.ghl_gone)) {
    const dayAgoIso = new Date(Date.now() - 24 * 3600_000).toISOString();
    const alreadyPinged = await recentEventExists({
      client_id: client.id, lead_id: lead.id, event_type: "ghl_contact_gone_fallback", since_iso: dayAgoIso,
    });
    await logEvent({
      client_id: client.id, lead_id: lead.id, event_type: "ghl_contact_gone_fallback",
      metadata: { ghl_contact_id: lead.ghl_contact_id },
    });
    if (!alreadyPinged) {
      await sendTelegramPing(
        `⚠️ GHL deleted ${leadLabel(lead, "a lead")}'s contact record mid-conversation (happens when contacts get merged/cleaned in GHL). I'm keeping the conversation going through ManyChat instead, so they still get every reply — but their GHL contact/CRM card is dead until they get a fresh one. Worth checking GHL for duplicate contacts under this name.`,
        true,
        // This ping has no GHL link to fall back on BY DEFINITION - the contact
        // it is about was just deleted - so the recorded lead id is the only
        // way a reply to it can resolve.
        { leadId: lead.id, clientId: client.id, kind: "ghl_contact_gone" }
      ).catch(() => {});
    }
  }

  // Stamp the GHL message id onto each DELIVERED AI row for outbound-echo
  // dedupe, and delivered_at (the sequence just completed, so "now" IS the
  // moment the words reached the lead) for the crossed-messages timing check.
  // A KNOWN failure clears its attempt stamp: ManyChat answered and said no,
  // so the ambiguity the stamp guards against is gone and the exact-words
  // resend may safely have the bubble.
  for (let i = 0; i < sendResults.length; i++) {
    const r = sendResults[i];
    const row = savedAiRows[i];
    if (!row) continue;
    if (!r?.success) {
      await clearMessageAttempt(row.id);
      continue;
    }
    if (r.ghl_message_id) await setMessageGhlId(row.id, r.ghl_message_id);
    await markMessageDelivered(row.id);
  }

  const allSent = sendResults.length === plan.length && sendResults.every((r) => r.success);
  const anySent = sendResults.some((r) => r.success);

  // GHOST-MESSAGE GUARD: on a TOTAL failure, every bubble is deleted from the
  // AI's memory, so the setter can never "think" it said something the lead
  // can't see — the thread then ends on the lead's message and the unanswered
  // sweep regenerates the whole turn. On a PARTIAL failure the unsent rows are
  // deliberately KEPT, undelivered: that is precisely the shape the sweep's
  // resendUndeliveredTail exists to heal (it resends the exact missing bubbles
  // within minutes). Deleting them here starved that self-heal and left only a
  // Telegram ping — a notification where a fix should be. The memory being
  // briefly "ahead" of the lead is covered by the crossed-messages timing note,
  // and becomes true the moment the sweep delivers.
  if (!anySent) {
    for (let i = 0; i < savedAiRows.length; i++) {
      const delivered = sendResults[i]?.success === true;
      const row = savedAiRows[i];
      if (!delivered && row) {
        await supabase.from("messages").delete().eq("id", row.id)
          .then(undefined, (e) => console.error("[webhook] ghost-row cleanup failed:", e));
      }
    }
  }

  // LEDGER CORRECTION (review 2026-07-24, P1): saving the AI rows above already
  // closed this lead's inbound_outcomes rows as 'replied' — but saves happen
  // BEFORE the sends, and if EVERY send failed the ghost-guard just deleted
  // those very rows. Nothing reached the lead, so the ledger must not say
  // 'replied': reopen, so the monitor's escalation guarantee holds for exactly
  // the scenario it exists for (the engine "thinks" it spoke, the lead saw
  // nothing). Any-sent counts as replied — a partial volley still reached them.
  if (!anySent && plan.length > 0) {
    await supabase
      .from("inbound_outcomes")
      .update({ status: "open", closed_at: null })
      .eq("lead_id", lead.id)
      .eq("status", "replied")
      .gte("closed_at", new Date(Date.now() - 5 * 60_000).toISOString())
      .then(undefined, (e) => console.error("[webhook] ledger reopen failed:", e));
  }

  // ── A HALF-DELIVERED REPLY IS NOT A DELIVERED REPLY ────────────────────────
  // The volley stops on the first failed bubble, so a partial send is
  // precisely the shape the owner described live: the lead gets the empathy
  // bubble, the QUESTION never arrives, and the conversation dies looking
  // handled. THE FIX IS THE SWEEP, NOT THE OWNER: the unsent rows were kept
  // undelivered above, and resendUndeliveredTail delivers exactly those words
  // within minutes, automatically. The copy block below is the BACKUP layer -
  // visibility if the sweep itself cannot get through - never the primary fix.
  const failedBubbles = plan
    .map((p, i) => ({ text: p.fallbackText || p.message, ok: sendResults[i]?.success === true, attempted: i < sendResults.length }))
    .filter((b) => !b.ok && b.text && b.text.trim());
  if (anySent && failedBubbles.length > 0) {
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "reply_partially_sent",
      metadata: {
        sent: sendResults.filter((r) => r.success).length,
        lost: failedBubbles.length,
        first_error: sendResults.find((r) => !r.success)?.error?.slice(0, 160) ?? null,
      },
    }).catch(() => { /* best-effort */ });
    const link = ghlContactLink(client.ghl_location_id ?? "", lead.ghl_contact_id ?? "");
    await sendTelegramCopyBlock(
      `⚠ Half of my reply to ${leadLabel(lead)} did not send - they got the first bubble(s) but NOT the rest, so the conversation looks answered and is not. Tap to copy the missing part and send it from your phone:${link ? `\n${link}` : ""}`,
      failedBubbles.map((b) => b.text).join("\n\n"),
      { leadId: lead.id, clientId: client.id, kind: "partial_reply" }
    ).catch(() => { /* best-effort */ });
  }

  // ── INBOX READ-BACK (the root fix, owner rule 2026-08-12) ─────────────────
  // "Did it SHOW UP in the inbox field where the conversation is held, yes or
  // no. THEN it means it was sent." ManyChat's body verdict got these bubbles
  // stamped delivered; now the real conversation is read back through the GHL
  // mirror and every bubble actually VISIBLE in it is stamped
  // inbox_verified_at. Absence is NOT acted on here — the mirror lags up to
  // ~2 minutes — conversation-sync and the sweep finish the audit, and a
  // proven-vanished bubble flips back to undelivered so the exact-words
  // resend delivers it automatically. Nothing below depends on this result;
  // a GHL blip can never break a reply that already went out.
  if (anySent) {
    await verifyReplyInInbox({
      client,
      lead,
      rows: savedAiRows
        .map((row, i) =>
          sendResults[i]?.success && row
            ? {
                id: row.id,
                content: row.content,
                created_at: row.created_at,
                delivered_at: row.delivered_at ?? null,
                delivery: plan[i]?.voice ? "voice" : null,
              }
            : null
        )
        .filter((r): r is NonNullable<typeof r> => !!r),
      deadlineMs: T0 + 55_000,
    });
  }

  await logEvent({
    client_id: client.id,
    lead_id: lead.id,
    event_type: allSent ? "ai_replied" : "ai_reply_failed",
    metadata: {
      segments: segmentsToSend.length,
      voice_notes: voiceCount,
      duration_ms: aiResult.duration_ms,
      send_errors: sendResults.filter((r) => !r.success).map((r) => r.error),
    },
  });

  // ── PER-REPLY STOPWATCH: write the breakdown ───────────────────────────────
  // total_ms is measured to the LAST bubble CONFIRMED delivered (delivered_at
  // from the send path's own onSent callback), NOT to the row's save time and
  // NOT to the first bubble — those are what made the dashboard read 13s when
  // the lead was really waiting ~27s. Best-effort: a failed write must never
  // affect a reply that already went out.
  try {
    const deliveredRows = savedAiRows
      .map((row, i) => (sendResults[i]?.success ? row : null))
      .filter((r): r is NonNullable<typeof r> => !!r);
    const stamps = deliveredRows.length
      ? (
          await supabase
            .from("messages")
            .select("delivered_at")
            .in("id", deliveredRows.map((r) => r.id))
        ).data ?? []
      : [];
    const times = stamps
      .map((s) => (s.delivered_at ? new Date(s.delivered_at).getTime() : null))
      .filter((t): t is number => t != null);
    const firstAt = times.length ? Math.min(...times) : null;
    const lastAt = times.length ? Math.max(...times) : null;
    const leadAt = timing.lead_msg_at ? new Date(timing.lead_msg_at).getTime() : null;

    await supabase.from("reply_timings").insert({
      client_id: client.id,
      lead_id: lead.id,
      lead_msg_at: timing.lead_msg_at,
      pipeline_started_at: new Date(T0).toISOString(),
      debounce_ms: timing.debounce_ms ?? null,
      model_ms: timing.model_ms ?? null,
      send_ms: lastAt ? lastAt - sendStart : Date.now() - sendStart,
      // THE number: what the lead actually experienced, end to end.
      total_ms: leadAt && lastAt ? lastAt - leadAt : null,
      first_bubble_at: firstAt ? new Date(firstAt).toISOString() : null,
      last_bubble_at: lastAt ? new Date(lastAt).toISOString() : null,
      bubbles: plan.length,
      bubbles_delivered: deliveredRows.length,
      voice_notes: voiceCount,
      all_delivered: allSent,
      inbound_source: timing.inbound_source ?? null,
      model_used: PRODUCTION_MODEL,
    });
  } catch (e) {
    console.error("[webhook] reply_timings write failed (reply itself was fine):", e);
  }

  // --- Owner ACTIVITY notification (audit mode; gated by setter_notify_enabled).
  //     Tells the owner exactly what the setter just did on this lead so he can
  //     watch it. Follow-ups never reach here. ---
  {
    // EVERY ping must name someone the owner can act on. This block used to
    // build its own label, and that label had no reference in it and fell back
    // to the literal words "this lead" — which is the exact ping in the owner's
    // 2026-08-09 screenshot: he replied to it with "turn off ai for him" and
    // got "No lead found matching 'this lead'". The comment above it claimed
    // "the @handle is always present on ManyChat leads"; it is not. 910 of 951
    // leads have no handle at all, which is why the fallback was reached.
    //
    // leadLabel is the ONE place that decides how a lead is named to the owner,
    // and it appends the short reference, so this ping is now answerable even
    // for a lead with no name and no handle.
    const leadName = leadLabel(lead, "this lead");
    const them = lastMsg.content.slice(0, 160);
    const said = segmentsToSend.join("  |  ").slice(0, 400);
    if (allSent) {
      const firstReply = !dbMessages.some((m) => m.role === "ai");
      await notifySetterActivity(client, lead, firstReply ? "started" : "replied",
        firstReply
          ? `🆕 Setter STARTED a conversation with ${leadName}\nThem: "${them}"\nSetter: "${said}"`
          : `💬 Setter replied to ${leadName}\nThem: "${them}"\nSetter: "${said}"`);
    } else if (anySent) {
      await notifySetterActivity(client, lead, "failed",
        `⚠️ Setter only PARTLY reached ${leadName} — some of its messages failed to send.\nThem: "${them}"\nSetter tried: "${said}"`);
    } else {
      // Once per lead per ~6h: the sweep retries an unreachable lead every few
      // minutes, and each retry used to re-ping the owner (live: 10+ identical
      // overnight alarms for ONE lead, 2026-07-10). Every attempt still logs
      // its ai_reply_failed event above — only the Telegram noise is deduped.
      // The window's upper bound excludes THIS attempt's own just-logged event.
      const pingFloor = new Date(Date.now() - 6 * 3600_000).toISOString();
      const pingCeil = new Date(Date.now() - 60_000).toISOString();
      const { count: alreadyPinged } = await supabase
        .from("events")
        .select("id", { count: "exact", head: true })
        .eq("lead_id", lead.id)
        .eq("event_type", "ai_reply_failed")
        .gte("created_at", pingFloor)
        .lte("created_at", pingCeil);
      if (!alreadyPinged) {
        const mins = Math.max(0, Math.round((Date.now() - new Date(lastMsg.created_at).getTime()) / 60000));
        await notifySetterActivity(client, lead, "failed",
          `🚨 Setter's reply to ${leadName} did NOT send — they've received NOTHING. They messaged ~${mins} min ago.\nSetter tried: "${said}"\n(its memory was cleared, so it'll try again on their next message)`);
      }
    }
  }

  // (STUCK is handled far above, BEFORE anything is sent: the setter hands the
  // thread to the owner instead of delivering a line it already knows is a repeat.
  // It used to send it here and ping afterwards — see the handover block.)

  // Phase 2: the AI just sent a booking/calendar link.
  if (hadBookingLink && anySent) {
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "ai_sent_booking_link",
      metadata: { at: new Date().toISOString() },
    });
    await noteMilestone({
      client,
      lead,
      kind: "booking_link_sent",
      text: "Sent the booking/calendar link.",
    });
  }

  // Nurture anchor: the AI just sent the pre-call training video → schedule the
  // +30min "what was your takeaway?" touch (no-op if nurture is disabled).
  if (anySent && segmentsToSend.some((s) => s.includes(VIDEO_LINK))) {
    await recordVideoLinkSent(client.id, lead);
    await noteMilestone({
      client,
      lead,
      kind: "video_link_sent",
      text: "Sent the pre-call training video.",
    });
  }

  if (allSent) {
    await supabase
      .from("leads")
      .update({ status: "engaged" })
      .eq("id", lead.id)
      .eq("status", "new");
  }

  // --- GHL pipeline auto-move: now that a reply actually went out, nudge the
  //     lead's CARD forward to match where the setter's funnel landed (active
  //     conversation → "Waiting For Reply", pitch reached → "Call Pitched").
  //     Forward-only + move-only-never-create + booked/closed cards untouched.
  //     The Jarvis watcher logs the milestone event on its next pass, so the
  //     dashboard/HQ need no changes. Best-effort: never blocks anything. ---
  if (anySent) {
    await syncPipelineFunnel({ client, lead, funnelStageId: resolvedFunnelStageId });
  }

  // ── MID-SEND STRAGGLER (owner rule 2026-08-21, Scott Hall incident) ────────
  // Their extra bubble landed while OUR volley was still going out. The volley
  // is complete now, so on THEIR screen the thread ends with our question,
  // delivered after their bubble. Two cases:
  //   - the bubble was just the tail of the message we already answered
  //     ("Off and on", "yeah makes sense") -> the finished volley IS the
  //     response. Log the absorb: the event closes its ledger row and keeps
  //     the sweep's rescue off it, and nothing new is generated.
  //   - it carries anything worth answering -> run one more pass. The fresh
  //     pass reads the full thread (delivered volley included, so it cannot
  //     re-say any of it) and answers only what is actually new. postSend
  //     keeps stragglerRegen off so the crossed-messages timing note - the
  //     accurate one here - reaches the model.
  // Every failure path falls toward the extra pass, never toward silence: a
  // pass with nothing new to answer exits at the "already replied" gate.
  if (anySent) {
    try {
      const lastMsgMs = new Date(lastMsg.created_at).getTime();
      const freshTail = await getRecentMessages(lead.id, 10);
      const stragglers = freshTail.filter(
        (m) => m.role === "lead" && new Date(m.created_at).getTime() > lastMsgMs
      );
      if (stragglers.length > 0) {
        const deliveredVolley = plan
          .map((p, i) => (sendResults[i]?.success ? p.saveText : null))
          .filter((t): t is string => !!t);
        const verdict = await classifyContinuation({
          stragglers: stragglers.map((m) => m.content),
          deliveredVolley,
        });
        if (verdict === "respond") return { retryForNewer: true, postSend: true };
        for (const m of stragglers) {
          await logEvent({
            client_id: client.id,
            lead_id: lead.id,
            event_type: "continuation_absorbed",
            // Sliced to the sweep's TRACKED_ONLY_TEXT_LIMIT so its per-bubble
            // text match can attribute this absorb to exactly this message.
            metadata: { text: (m.content || "").slice(0, 120) },
          }).catch(() => { /* best-effort */ });
        }
      }
    } catch (e) {
      console.error("[webhook] mid-send straggler check failed - regenerating:", e);
      return { retryForNewer: true, postSend: true };
    }
  }
}
