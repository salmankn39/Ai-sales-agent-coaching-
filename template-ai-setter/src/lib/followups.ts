/**
 * FOLLOW-UP ENGINE — proactive re-engagement of leads who went quiet. Reuses
 * the proven proactive-send pattern (claim-lock via a unique insert, gated by a
 * flag, enable boundary, guards) so it can't double-send or talk over a live
 * chat. Timing is 100% code-controlled (the AI only writes the words, never
 * decides when). Two buckets, two cadences, all measured from the stall anchor
 * (the lead's last inbound):
 *
 *   Bucket A — ghosted mid-conversation (pre-pitch): 30min(🐶), 23h
 *   Bucket B — cold feet (pitched / sent link, didn't book): 15min, 6h(🐶), 18h
 *  (All land INSIDE Instagram's 24h window — a closed window blocks the send —
 *   and each is built to pull a reply, since a reply reopens another 24h. The 🐶
 *   touch is the side-eye meme image, sent on its OWN with no caption. Every line
 *   is rendered in the lead's locked language — Swedish stays Swedish, never flips.
 *   Spacing between touches is enforced from BOTH the anchor and the previous send,
 *   so a long-quiet lead can never get a catch-up burst of several at once.)
 *
 * The asking is proactive (here); the lead's REPLIES flow back through the
 * normal reply pipeline at their existing stage — so follow-ups only ever act
 * in the silence, never alongside a live exchange.
 *
 * SAFETY: dormant unless clients.followup_enabled = true, and it only acts on
 * stalls that happen AFTER followup_enabled_at (no retroactive blasts).
 */
import { supabase, logEvent, saveMessage, eventExists, recentEventExists, setLeadManychatSubscriberId, acquireReplyLock, releaseReplyLock, type Lead } from "./supabase";
import { sendLeadMessage, sendLeadMessageSequence, sendingIsSwitchedOff } from "./send";
import { splitReply } from "./brain";
import { sendTelegramPing, sendTelegramCopyBlock, ghlContactLink, leadLabel } from "./telegram";
import { resolveSubscriberId, sendManychatVoice } from "./manychat";
import { makeVoiceClipWav, voiceActive, voiceIdForLang } from "./voice";

// The lead's locked conversation language. Only a fully-locked "sv" speaks
// Swedish (mirrors the live reply pipeline, where 'sv_pending'/'en_declined'
// still reply in English). Everything else => English.
type Lang = "en" | "sv";
function leadLang(lead: Lead): Lang {
  return (lead as { conversation_language?: string | null }).conversation_language === "sv" ? "sv" : "en";
}

const STAGES_A = ["opener", "transition_main_reason", "goals", "current_situation", "timeline", "problem", "consequence", "consequence_why"];
const STAGES_B = ["pitch_help", "book"];
// Hours from the stall anchor (the lead's last inbound). ALL touches land inside
// Instagram's 24h messaging window — a closed window blocks the send.
// A2 sits at 21h, NOT 23h (review 2026-08-08): with the manual-handoff cutoff
// at 23.5h and the anti-burst gap pushing A2's eligibility past ~23.2h, a 23h
// offset left a ~20-minute slot for the automated send — nearly every A2
// would have degraded into a manual Telegram chore. 21h gives the engine a
// real ~2.5h window while still landing squarely inside Meta's 24h rule.
const OFFSETS_H = { A: [0.5, 21], B: [0.25, 6, 18] };
// Which attempt (1-based) is the standalone side-eye dog image (no caption):
// Track A OPENS with it (30min); Track B's is its 2nd touch (6h). Either way the
// image is sent AT MOST ONCE per lead — a second one is skipped (see the loop).
const IMAGE_ATTEMPT: Record<"A" | "B", number> = { A: 1, B: 2 };
const MIN_GAP_FLOOR_H = 0.2; // absolute backstop: never two touches within ~12min
// Meta's 24h messaging window, with safety margin: past this quiet time an
// automated IG send is impossible (and against platform rules — owner rule
// 2026-08-08: "it's illegal to send automated shit after 24h"). Instead of
// attempting a send that Instagram will reject, the touch is handed to THE OWNER
// on Telegram as a copy-paste draft, once per stall.
const IG_WINDOW_CUTOFF_H = 23.5;
const MAX_PER_RUN = 25;  // global cap per tick — a surge drips over ticks, never blasts
// HIS PHONE IS A DESTINATION TOO. The handoff path (24h window closed) skipped
// the drip cap entirely because it never incremented `sent`, so a backlog of
// stalled leads turned into that many Telegram copy-blocks in one tick - 50
// tested, and a real backlog is bigger. An alert stream he has to scroll past
// is an alert stream he stops reading. The rest wait for the next tick; the
// claim rows make that resumption exact, never a re-send.
const MAX_HANDOFFS_PER_RUN = 8;
// The side-eye meme image, sent as its OWN message (empty caption — the same
// shape voice notes use). Must be a public, direct PNG/JPG URL that IG accepts
// via GHL. Unset => the image touch is skipped (the rest of the sequence still runs).
// Served from THIS deployment's own /public, not from a hardcoded host: the
// old absolute fallback pointed every copy of this app - including every
// student's - at the founder's deployment for the image, so his server carried
// their traffic and their follow-ups broke whenever his did.
const DOG_IMAGE_URL =
  process.env.FOLLOWUP_DOG_IMAGE_URL ||
  process.env.FOLLOWUP_A3_IMAGE_URL ||
  `${(process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/$/, "")}/followup-sideeye.png`;

interface FUClient { id: string; enabledAt: number; ghl_api_key: string | null; ghl_location_id: string | null; voice_samples: string | null; business_context: string | null; notifyEnabled: boolean; notifyOff: string[]; voice_enabled: boolean; voice_enabled_sv: boolean; setter_voice_id: string | null; setter_voice_id_sv: string | null; manychat_api_token: string | null; voice_settings: Record<string, unknown> | null }

async function enabledFollowupClients(): Promise<FUClient[]> {
  const { data } = await supabase.from("clients")
    .select("id, followup_enabled_at, ghl_api_key, ghl_location_id, voice_samples, business_context, setter_notify_enabled, setter_notify_off, voice_enabled, voice_enabled_sv, setter_voice_id, setter_voice_id_sv, manychat_api_token, voice_settings")
    // is_active is the SYSTEM-WIDE setter switch (the one the owner flips from
    // Telegram or HQ). It gated the reply engine and the magnet but not this
    // engine, so follow-ups kept going out to real people after he switched
    // the setter off — verified live: a touch sent 2026-08-02 17:55, a full
    // day after the switch. "Off" now means off on every outbound path.
    .eq("is_active", true)
    .eq("followup_enabled", true);
  return (data ?? []).map((c) => {
    const r = c as Record<string, unknown>;
    return {
      id: String(r.id), enabledAt: r.followup_enabled_at ? new Date(String(r.followup_enabled_at)).getTime() : 0,
      ghl_api_key: (r.ghl_api_key as string) ?? null, ghl_location_id: (r.ghl_location_id as string) ?? null,
      voice_samples: (r.voice_samples as string) ?? null, business_context: (r.business_context as string) ?? null,
      notifyEnabled: r.setter_notify_enabled === true,
      notifyOff: Array.isArray(r.setter_notify_off) ? (r.setter_notify_off as string[]) : [],
      voice_enabled: r.voice_enabled === true, voice_enabled_sv: r.voice_enabled_sv === true,
      setter_voice_id: (r.setter_voice_id as string) ?? null, setter_voice_id_sv: (r.setter_voice_id_sv as string) ?? null,
      manychat_api_token: (r.manychat_api_token as string) ?? null,
      voice_settings: (r.voice_settings as Record<string, unknown>) ?? null,
    };
  });
}

// Which follow-up touches go out as a VOICE NOTE in the cloned voice (via the
// ManyChat IG audio pipe — GHL can't deliver a real voice note). The owner's pick:
// Bucket A touch 1 ("lmk brother") and Bucket B touch 1 (the cold-feet opener).
// Everything else stays text/image. Best-effort: any miss falls back to text.
function isVoiceTouch(bucket: "A" | "B", attempt: number): boolean {
  return attempt === 1 && (bucket === "A" || bucket === "B");
}

/**
 * Try to deliver a follow-up touch as a voice note in the cloned voice (ManyChat
 * IG audio). Returns true ONLY on a real successful send. Best-effort and silent:
 * any miss (voice off for the client/lead/language, no manychat token/subscriber,
 * TTS/upload/send failure) returns false so the caller sends the same words as
 * TEXT instead. Never throws. Mirrors the live reply pipeline's voice path.
 */
async function tryFollowupVoice(client: FUClient, lead: Lead, text: string): Promise<boolean> {
  try {
    const token = client.manychat_api_token;
    if (!token) return false;
    const lr = lead as Record<string, unknown>;
    if (lr.voice_paused === true) return false; // lead is text-only
    const langState = leadLang(lead);
    const on = voiceActive({
      enabled: client.voice_enabled, enabledSv: client.voice_enabled_sv,
      voiceId: client.setter_voice_id, voiceIdSv: client.setter_voice_id_sv, langState,
    });
    if (!on) return false; // voice off for this language (Swedish stays text by default)
    const voiceId = voiceIdForLang({ voiceId: client.setter_voice_id, voiceIdSv: client.setter_voice_id_sv, langState });
    if (!voiceId) return false;
    let sub = (lr.manychat_subscriber_id as string) || null;
    if (!sub) {
      sub = await resolveSubscriberId(token, [lead.full_name, lead.ig_username]);
      if (sub) await setLeadManychatSubscriberId(lead.id, sub);
    }
    if (!sub) return false;
    const wavUrl = await makeVoiceClipWav(text, voiceId, client.voice_settings ?? null);
    if (!wavUrl) return false;
    // A voice touch talks to ManyChat directly rather than through the send
    // chokepoint, so the kill switch has to be re-read here or a follow-up
    // voice note goes out after the owner has switched the setter off (2026-08-09).
    const off = await sendingIsSwitchedOff({ client_id: client.id, lead_id: lead.id });
    if (off) return false;
    const r = await sendManychatVoice(token, sub, wavUrl);
    return r.success === true;
  } catch (e) {
    console.error("[followups] voice attempt failed (falling back to text):", e);
    return false;
  }
}

/** Only use the lead's first name if it's clearly a real name (not a handle
 *  like "Don Juba" or "Ali16539"). Otherwise return "" and we skip the name. */
function leadFirstName(lead: Lead): string {
  const fn = (lead.full_name || "").trim();
  if (!fn) return "";
  const first = fn.split(/\s+/)[0] || "";
  if (!/^[a-zA-Z]{2,15}$/.test(first)) return ""; // letters only, sane length
  if (first.toLowerCase() === (lead.ig_username || "").toLowerCase()) return "";
  if (["the", "official", "real", "its", "mr", "coach", "king", "ceo", "team"].includes(first.toLowerCase())) return "";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** Best-effort pull of the lead's stated goal from captured facts. The value
 *  gets glued into "closer to {goal}", so it must BE a goal: prefer the
 *  explicitly goal-shaped keys, and never a duration — `want_duration: "~3
 *  years"` once matched the loose /want/ pattern and produced a live voice
 *  note saying "closer to ~3 years". */
function pullGoal(lead: Lead): string {
  const sd = (lead.stage_data || {}) as Record<string, unknown>;
  const asGoal = (v: unknown): string =>
    typeof v === "string" && v.trim() && v.trim().length < 80 ? v.trim() : "";
  for (const k of ["main_reason", "deeper_outcome", "goal", "dream_outcome"]) {
    const g = asGoal(sd[k]);
    if (g) return g;
  }
  for (const k of Object.keys(sd)) {
    if (/duration/i.test(k)) continue; // "~3 years" is how LONG, never a goal
    if (/goal|outcome|dream|income|want|aspir/i.test(k)) {
      const g = asGoal(sd[k]);
      if (g) return g;
    }
  }
  return "";
}

// Attempt map (image touch handled by the caller, never here):
//   Track A: 1 = 🐶 image, 2 = goal-text nudge.
//   Track B: 1 = re-open, 2 = 🐶 image (skipped if already sent), 3 = final nudge.
function buildMessage(bucket: "A" | "B", attempt: number, lang: Lang, ctx: { goal: string; linkSent: boolean }): string {
  const sv = lang === "sv";
  const closerGoal = ctx.goal
    ? (sv ? `närmare ${ctx.goal}` : `closer to ${ctx.goal}`)
    : (sv ? `närmare dina mål` : `closer to your goals`);
  if (bucket === "A") {
    // attempt 1 is the 🐶 image (handled by the caller); the only text touch is
    // attempt 2 — the goal-text nudge, sent alone at 23h.
    if (sv) return ctx.goal
      ? `damn, märkte precis att vår konvo dog ut, säg till om ${ctx.goal} fortfarande är nåt du kämpar för, fråga gärna vad som helst, jag är oftast rätt aktiv i dmsen`
      : `damn, märkte precis att vår konvo dog ut, säg till om du fortfarande kollar på att börja tjäna pengar online brorsan, fråga gärna vad som helst, jag är oftast rätt aktiv i dmsen`;
    return ctx.goal
      ? `damn, just noticed our convo died out, lmk if ${ctx.goal} is still something you're striving for, feel free to ask any questions, i'm usually pretty active in the dms`
      : `damn, just noticed our convo died out, lmk if you're potentially looking into making money online brotha, feel free to ask any questions, i'm usually pretty active in the dms`;
  }
  // Bucket B
  if (attempt === 1) {
    if (sv) return ctx.linkSent
      ? `my bad bror, hoppade på ett snabbt samtal men säg mig, fick du bekräftelsemejlet?`
      : `my bad bror, hoppade på ett snabbt samtal men säg mig, känner du att ett snack med Ethan skulle kunna hjälpa dig att komma ${closerGoal}?`;
    return ctx.linkSent
      ? `my bad bro, jumped on a quick call but tell me, you got the confirmation email?`
      : `my bad bro, jumped on a quick call but tell me, do you feel like talking to Ethan could help you get ${closerGoal}?`;
  }
  // attempt 2 is the 🐶 image (handled by the caller); attempt 3 — final nudge.
  return sv
    ? `hey bror, har försökt nå dig några gånger de senaste dagarna för att potentiellt hjälpa dig komma ${closerGoal}\n\nmen hörde inget tillbaka...\n\nsäg till vart du vill ta det härifrån?`
    : `hey brother, been trying to reach you a few times these last days to potentially help you get ${closerGoal}\n\nbut didn't hear back from you...\n\nlmk where you want to take it from here?`;
}

/** Mark revival when a lead replied after we'd sent follow-ups (idempotent). */
async function checkRevival(leadId: string, clientId: string, lastLeadAt: string): Promise<void> {
  const { data } = await supabase.from("follow_up_log")
    .update({ revived_at: new Date().toISOString() })
    .eq("lead_id", leadId).is("revived_at", null).lt("sent_at", lastLeadAt).eq("status", "sent")
    .select("id");
  if ((data ?? []).length > 0) {
    await logEvent({ client_id: clientId, lead_id: leadId, event_type: "lead_revived", metadata: { via: "follow_up", count: (data ?? []).length } });
  }
}

/** The whole engine: sweep stalled leads and send any due follow-up. Safe no-op
 *  unless a client has followup_enabled = true. */
export async function runFollowups(): Promise<{ enabled: number; sent: number }> {
  let sent = 0;
  let handedOff = 0;
  try {
    const clients = await enabledFollowupClients();
    if (!clients.length) return { enabled: 0, sent: 0 };
    const minQuietMs = 12 * 60_000; // smallest cadence is B#1 at 15min — candidates must be quiet ≥12m
    const now = Date.now();

    for (const client of clients) {
      if (!client.ghl_api_key || !client.ghl_location_id) continue;
      const { data: leads } = await supabase.from("leads").select("*")
        .eq("client_id", client.id).eq("status", "engaged")
        .eq("ai_paused", false).eq("followup_paused", false)
        .in("funnel_stage", [...STAGES_A, ...STAGES_B])
        .lt("last_message_at", new Date(now - minQuietMs).toISOString())
        .order("last_message_at", { ascending: true }).limit(60);

      for (const leadRow of (leads ?? []) as Lead[]) {
        try {
          if (sent >= MAX_PER_RUN) break; // global drip cap — never blast
          const lead = leadRow;
          // REACHABLE, NOT NECESSARILY IN GHL (2026-08-09). This used to require
          // a GHL contact id, which structurally excluded every ManyChat-first
          // lead from follow-ups - and ManyChat-first is how new people arrive
          // now, with ghl_contact_id NULL by design. Sending goes through
          // ManyChat, so the subscriber id is the identity that matters; the GHL
          // id is only a join key. Either one is enough to reach them.
          if (!lead.ghl_contact_id && !lead.manychat_subscriber_id) continue;
          const { data: msgs } = await supabase.from("messages").select("role, created_at, model_used").eq("lead_id", lead.id).order("created_at", { ascending: false }).limit(12);
          const m = (msgs ?? []) as { role: string; created_at: string; model_used: string | null }[];
          if (!m.length) continue;

          // Replied since? → revival (and not our job; the reply pipeline owns it).
          if (m[0].role === "lead") { await checkRevival(lead.id, client.id, m[0].created_at); continue; }
          // A HUMAN sent the last message → someone's handling this lead by hand. Stand down.
          if (m[0].role === "human") continue;
          // ONE PROACTIVE TOUCH PER PERSON PER QUARTER-HOUR, ACROSS ENGINES
          // (mirror of the same guard in nurture.ts). If anything of ours went
          // out in the last 15 minutes - a nurture touch on the same cron
          // minute is the live case - this chase waits for the next tick. The
          // stall is still a stall then, and no claim row has been burned.
          // Never triggered by a NORMAL chase: the earliest touch fires 30min
          // after the lead's message, and our last reply predates that message.
          if (Date.now() - new Date(m[0].created_at).getTime() < 15 * 60_000) continue;

          const lastLead = m.find((x) => x.role === "lead");
          if (!lastLead) continue; // never replied to us → manual-outreach bucket (not ours)
          const anchorIso = lastLead.created_at;
          const anchorMs = new Date(anchorIso).getTime();
          if (anchorMs < client.enabledAt) continue; // enable boundary — only stalls after switch-on
          const quietH = (now - anchorMs) / 3_600_000;

          const stage = lead.funnel_stage || "";
          const bucket: "A" | "B" = STAGES_B.includes(stage) ? "B" : "A";
          const offsets = OFFSETS_H[bucket];

          const { data: prior } = await supabase.from("follow_up_log").select("attempt, anchor, sent_at, status").eq("lead_id", lead.id);
          const rows = (prior ?? []) as { attempt: number; anchor: string; sent_at: string | null; status: string }[];
          const attemptsSent = rows.filter((r) => r.anchor === anchorIso).length;
          if (attemptsSent >= offsets.length) continue; // exhausted this stall (all touches sent)
          if (quietH < offsets[attemptsSent]) continue; // not due yet (scheduled offset from the anchor)
          // ANTI-BURST: a touch must ALSO wait the intended spacing since the last
          // one we actually sent — the gap between its offset and the previous offset
          // (floored at MIN_GAP_FLOOR_H). So a lead who's been quiet past every offset
          // still gets the touches in their proper rhythm, never several at once.
          const prevOffset = attemptsSent === 0 ? 0 : offsets[attemptsSent - 1];
          const requiredGapH = Math.max(MIN_GAP_FLOOR_H, offsets[attemptsSent] - prevOffset);
          const lastSentMs = rows.filter((r) => r.status === "sent" && r.sent_at).map((r) => new Date(r.sent_at as string).getTime()).sort((a, b) => b - a)[0];
          if (lastSentMs && now - lastSentMs < requiredGapH * 3_600_000) continue;
          if (await eventExists(lead.id, "appointment_booked")) continue; // already booked → nurture's job

          // A follow-up is IMPOSSIBLE if WE ignored/failed the lead: only chase
          // someone who went quiet AFTER we successfully delivered a reply to
          // their last message. The AI message row is saved BEFORE the send, so
          // "the AI spoke last" is not proof of delivery — the `ai_replied` event
          // is logged ONLY on a successful send (and, now that voice never goes as
          // a silent GHL mp3, it reflects real delivery). No delivered reply after
          // the stall anchor => we never actually answered them, so we do not
          // chase; the reply pipeline owns getting them an answer.
          const answered = await recentEventExists({
            client_id: client.id, lead_id: lead.id, event_type: "ai_replied", since_iso: anchorIso,
          });
          // ONE DEFINITION OF "WE REPLIED" (audit 2026-07-24): nurture, the
          // lead magnet, and the handoff opener all save their message row ONLY
          // after a confirmed send but never log ai_replied — so a lead those
          // engines answered looked "ignored" here and was never chased. A
          // post-send engine row is delivery proof, exactly like the event.
          // NOT followup_engine itself (review P2): a touch must never be the
          // proof that licenses the next touch — only a real answer counts.
          const DELIVERED_ENGINE_ROWS = new Set(["nurture_engine", "lead_magnet", "manychat_handoff"]);
          const answeredByEngine = m.some(
            (x) => x.role === "ai" && x.created_at > anchorIso && DELIVERED_ENGINE_ROWS.has(x.model_used || "")
          );
          if (!answered && !answeredByEngine) continue;

          const attempt = attemptsSent + 1;

          // ── 24H WINDOW CLOSED → HAND TO THE OWNER, NEVER ATTEMPT IG ──────────
          // Every remaining touch for this stall is undeliverable by
          // automation (Meta blocks sends past 24h since the lead's last
          // inbound). One Telegram handoff per stall: the owner gets the drafted
          // touch in a tap-to-copy block and sends it from his own phone.
          if (quietH >= IG_WINDOW_CUTOFF_H) {
            if (rows.some((r) => r.anchor === anchorIso && r.status === "handed_off")) continue;
            // The drip cap applies to the owner's phone as well (see
            // MAX_HANDOFFS_PER_RUN). Nothing is lost by stopping here: the lead
            // is still stalled on the next tick and has no claim row yet.
            if (handedOff >= MAX_HANDOFFS_PER_RUN) continue;
            const { data: hoClaim } = await supabase.from("follow_up_log").upsert(
              { client_id: client.id, lead_id: lead.id, ghl_contact_id: lead.ghl_contact_id, bucket, attempt, anchor: anchorIso, stage_at_stall: stage, status: "handed_off", message: "(24h window closed - drafted to the owner on Telegram)", sent_at: new Date().toISOString() },
              { onConflict: "lead_id,anchor,attempt", ignoreDuplicates: true }
            ).select("id");
            if (!(hoClaim ?? [])[0]) continue;
            const lang2 = leadLang(lead);
            const textAttempt = attempt === IMAGE_ATTEMPT[bucket] ? (bucket === "A" ? 2 : 3) : attempt;
            const draft = buildMessage(bucket, textAttempt, lang2, {
              goal: pullGoal(lead),
              linkSent: bucket === "B" ? await eventExists(lead.id, "ai_sent_booking_link") : false,
            });
            const link = ghlContactLink(client.ghl_location_id ?? "", lead.ghl_contact_id ?? "");
            await sendTelegramCopyBlock(
              `${leadLabel(lead, "this lead")} went quiet ${Math.round(quietH)}h ago, so Instagram's 24h window is closed and I can't send the follow-up myself. Tap to copy and send it from your phone:${link ? `\n${link}` : ""}`,
              draft,
              { leadId: lead.id, clientId: client.id, kind: "followup_handoff" }
            ).catch(() => {});
            await logEvent({ client_id: client.id, lead_id: lead.id, event_type: "follow_up_handed_off", metadata: { bucket, attempt, quiet_h: Math.round(quietH * 10) / 10 } });
            handedOff++;
            continue;
          }

          // ONE MOUTH PER PERSON AT A TIME, ATOMICALLY. The 15-minute read
          // guard above cannot stop a true race: nurture and this engine both
          // read the thread BEFORE either has sent, both see silence, both
          // touch (caught live by the stress rig, 2026-08-12: the 🐶 chase and
          // the video question seconds apart). The per-lead reply lock is the
          // system's arbiter for exactly this - whoever holds it is the only
          // one allowed to speak to the person. Lock lost => next tick, and no
          // claim row has been burned.
          const touchStamp = await acquireReplyLock(lead.id, 60_000);
          if (!touchStamp) continue;
          try {

          // CLAIM atomically — unique (lead_id, anchor, attempt). Empty insert = another tick owns it.
          const { data: claimed } = await supabase.from("follow_up_log").upsert(
            { client_id: client.id, lead_id: lead.id, ghl_contact_id: lead.ghl_contact_id, bucket, attempt, anchor: anchorIso, stage_at_stall: stage, status: "sending" },
            { onConflict: "lead_id,anchor,attempt", ignoreDuplicates: true }
          ).select("id");
          const row = (claimed ?? [])[0] as { id: string } | undefined;
          if (!row) continue;

          const lang = leadLang(lead);
          const isImageTouch = attempt === IMAGE_ATTEMPT[bucket];
          const linkSent = bucket === "B" ? await eventExists(lead.id, "ai_sent_booking_link") : false;
          // The 🐶 image touch is sent ALONE — empty caption + attachment (the same
          // shape voice notes use). Every other touch is text only, in the lead's
          // locked language. `saveText` is what we store/log (the wire message for
          // the image is "", so we record a marker so transcripts stay readable).
          const text = isImageTouch ? "" : buildMessage(bucket, attempt, lang, { goal: pullGoal(lead), linkSent });
          const attachments = isImageTouch && DOG_IMAGE_URL ? [DOG_IMAGE_URL] : undefined;
          const saveText = isImageTouch ? "🐶" : text;
          // Image touch with no URL configured: nothing to send. Mark + move on so the
          // sequence isn't stuck and the next touch still fires.
          if (isImageTouch && !attachments) {
            await supabase.from("follow_up_log").update({ status: "skipped", message: "(image touch — no URL configured)" }).eq("id", row.id);
            continue;
          }
          // ONE 🐶 PER LEAD across their whole journey: if the side-eye image
          // already went out earlier (e.g. Track A's opener, then they cold-feet
          // into Track B), skip it here — don't repeat the meme. The attempt still
          // counts, so the sequence advances to the next (final) touch.
          if (isImageTouch) {
            const { data: priorDog } = await supabase.from("follow_up_log")
              .select("id").eq("lead_id", lead.id).eq("message", "🐶").eq("status", "sent").limit(1);
            if ((priorDog ?? []).length > 0) {
              await supabase.from("follow_up_log").update({ status: "skipped", message: "(🐶 already sent earlier)" }).eq("id", row.id);
              continue;
            }
          }

          // Designated voice touches (A1, B1) go out as a real IG voice note via
          // ManyChat; on ANY miss we fall straight back to the same words as text
          // through GHL. Image touches never voice.
          const voiceTouch = !isImageTouch && isVoiceTouch(bucket, attempt);
          let deliveredVoice = false;
          let res: { success: boolean; ghl_message_id?: string; error?: string } = { success: false };

          if (voiceTouch && (await tryFollowupVoice(client, lead, text))) {
            deliveredVoice = true;
            res = { success: true };
          }

          if (!deliveredVoice) {
            if (isImageTouch) {
              res = await sendLeadMessage({ client_id: client.id, lead_id: lead.id, manychat_token: client.manychat_api_token, manychat_subscriber_id: lead.manychat_subscriber_id, ghl_api_key: client.ghl_api_key, ghl_location_id: client.ghl_location_id, ghl_contact_id: lead.ghl_contact_id, full_name: lead.full_name, ig_username: lead.ig_username, message: text, type: "IG", attachments });
              // Image touch: one retry on a transient failure. No text fallback — the dog
              // lands on its own or not at all (the rest of the sequence still runs).
              if (!res.success) {
                res = await sendLeadMessage({ client_id: client.id, lead_id: lead.id, manychat_token: client.manychat_api_token, manychat_subscriber_id: lead.manychat_subscriber_id, ghl_api_key: client.ghl_api_key, ghl_location_id: client.ghl_location_id, ghl_contact_id: lead.ghl_contact_id, full_name: lead.full_name, ig_username: lead.ig_username, message: text, type: "IG", attachments });
              }
            } else {
              // Text touch: split into natural bubbles (same humanizer the live reply
              // path uses), so a multi-part re-engagement reads like a person texting
              // AND the [[SPLIT]] token is consumed by the splitter — never sent raw.
              const bubbles = splitReply(text);
              const seq = await sendLeadMessageSequence({
                client_id: client.id, lead_id: lead.id,
                manychat_token: client.manychat_api_token,
                manychat_subscriber_id: lead.manychat_subscriber_id,
                ghl_api_key: client.ghl_api_key, ghl_location_id: client.ghl_location_id,
                ghl_contact_id: lead.ghl_contact_id, type: "IG",
                full_name: lead.full_name, ig_username: lead.ig_username,
                messages: bubbles.length ? bubbles : [text],
              });
              const firstFail = seq.find((r) => !r.success);
              res = firstFail
                ? { success: false, error: firstFail.error }
                : { success: true, ghl_message_id: seq[seq.length - 1]?.ghl_message_id };
            }
          }
          if (!res.success) {
            await supabase.from("follow_up_log").update({ status: "failed", message: saveText }).eq("id", row.id);
            continue;
          }
          await supabase.from("follow_up_log").update({ status: "sent", message: saveText, ghl_message_id: res.ghl_message_id, sent_at: new Date().toISOString() }).eq("id", row.id);
          await saveMessage({ lead_id: lead.id, client_id: client.id, role: "ai", content: saveText, channel: "instagram", ghl_message_id: res.ghl_message_id, model_used: deliveredVoice ? "followup_engine_voice" : "followup_engine", delivery: deliveredVoice ? "voice" : undefined, delivered: true });
          await logEvent({ client_id: client.id, lead_id: lead.id, event_type: "follow_up_sent", metadata: { bucket, attempt, stage, image: isImageTouch, voice: deliveredVoice } });
          // Owner activity notification — follow-up sent (its OWN toggle: 'followup').
          if (client.notifyEnabled && !client.notifyOff.includes("followup")) {
            const link = ghlContactLink(client.ghl_location_id ?? "", lead.ghl_contact_id ?? "");
            const name = leadFirstName(lead) || lead.full_name || "this lead";
            const what = isImageTouch ? "🐶 (the side-eye image)" : `${deliveredVoice ? "🎤 " : ""}"${saveText.slice(0, 200)}"`;
            await sendTelegramPing(
              `📣 Follow-up sent to ${leadLabel(lead, name)} (track ${bucket}, touch ${attempt})\n${what}${link ? `\n${link}` : ""}`,
              true,
              { leadId: lead.id, clientId: client.id, kind: "followup_sent" }
            ).catch(() => {});
          }
          sent++;
          } finally {
            await releaseReplyLock(lead.id, touchStamp);
          }
        } catch (e) {
          console.error("[followups] lead failed:", leadRow.id, e);
        }
      }
      if (sent >= MAX_PER_RUN) break; // cap hit — stop sweeping further clients this tick
    }
    return { enabled: clients.length, sent };
  } catch (err) {
    console.error("[followups] runFollowups failed:", err);
    return { enabled: 0, sent };
  }
}
