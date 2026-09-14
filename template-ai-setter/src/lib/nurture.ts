/**
 * NURTURE ENGINE — proactive, time-gated outbound that keeps a BOOKED prospect
 * warm in the 24-72h between booking and their call with the closer. This is the
 * only part of the setter that messages a lead WITHOUT an inbound to reply to.
 *
 * Three timed touches (each a row in `nurture_jobs`, deduped per lead+kind):
 *   1. post_book_kickoff — right after booking: "perfect, the call's on google
 *      meet — what day & time is it saying on your end?" (kicks off the
 *      confirm → proof reel → training-video sequence, which is reactive).
 *   2. nurture_takeaway  — 30 MIN AFTER the training video link is sent:
 *      "what was your main takeaway from that video?" (per the owner's SOP).
 *   3. nurture_precall   — 24h before the call (or day-of, 8-12h before, if the
 *      call is <48h out): "do you have the link for the google meet btw?".
 *
 * The ASKING is templated + proactive (here). The lead's REPLIES are handled by
 * the normal reply pipeline railed to the post_book / proof / nurture stages —
 * so the setter answers pre-call questions and knows it's the SAME booked
 * person, never a new lead.
 *
 * SAFETY: nothing fires for a client unless clients.nurture_enabled = true.
 * The whole engine is dormant by default, so deploying it is harmless.
 *
 * Triggered (belt + suspenders, because Vercel Hobby caps cron at 1/day):
 *   - Supabase pg_cron pings /api/cron/nurture every few minutes (reliable timer)
 *   - the GHL webhook + the HQ pulse flush due jobs via waitUntil (active hours)
 */
import { supabase, logEvent, saveMessage, eventExists, acquireReplyLock, releaseReplyLock, type Lead } from "./supabase";
import { getContactUpcomingAppointment } from "./ghl";
import { sendLeadMessage } from "./send";

export const VIDEO_LINK = "linktw.in/BJlOPF";
const TAKEAWAY_DELAY_MS = 30 * 60_000; // 30 min after the video link is sent

type Kind = "post_book_kickoff" | "nurture_takeaway" | "nurture_precall";

// The lead's locked conversation language. Only a fully-locked "sv" speaks
// Swedish (mirrors the live reply pipeline + the follow-up engine); everything
// else => English. Keeps the WHOLE conversation — including nurture — in one
// language, never flipping.
type Lang = "en" | "sv";

const KICKOFF_MSG: Record<Lang, string> = {
  en: "perfect, the call will be on google meet — what day and time is it saying on your end?",
  sv: "perfekt, samtalet kommer vara på google meet — vilken dag och tid står det på din sida?",
};
const TAKEAWAY_MSGS: Record<Lang, string[]> = {
  en: [
    "yo brother, quick one — what was your main takeaway from that video i sent over?",
    "what'd you think of the video bro? whats the main thing you took from it?",
    "so what was your biggest takeaway from that training video?",
  ],
  sv: [
    "yo bror, snabb fråga — vad var din största takeaway från videon jag skickade?",
    "vad tyckte du om videon bror? vad var det viktigaste du tog med dig?",
    "så vad var din största insikt från träningsvideon?",
  ],
};
const PRECALL_MSGS: Record<Lang, string[]> = {
  en: ["do you have the link for the google meet btw?", "you got the google meet link for the call btw?"],
  sv: ["har du länken till google meet förresten?", "har du google meet-länken till samtalet förresten?"],
};
const pick = (a: string[]) => a[(Math.random() * a.length) | 0];

function messageFor(kind: Kind, lang: Lang): string {
  if (kind === "post_book_kickoff") return KICKOFF_MSG[lang];
  if (kind === "nurture_takeaway") return pick(TAKEAWAY_MSGS[lang]);
  return pick(PRECALL_MSGS[lang]);
}

/** When to fire the pre-call check, per the SOP (24h out if >48h away, else day-of). */
function precallRunAt(callAtISO: string): Date | null {
  const call = new Date(callAtISO).getTime();
  if (Number.isNaN(call)) return null;
  const now = Date.now();
  if (call <= now) return null;
  const hoursOut = (call - now) / 3_600_000;
  let runAt = hoursOut > 48 ? call - 24 * 3_600_000 : call - 10 * 3_600_000; // 24h before, or day-of ~10h
  runAt = Math.max(runAt, now + 30 * 60_000); // never in the past
  runAt = Math.min(runAt, call - 60 * 60_000); // always at least 1h before the call
  if (runAt <= now || runAt >= call) return null; // call too soon to bother
  return new Date(runAt);
}

/** Insert a job, ignoring if one of this kind already exists for the lead. */
async function scheduleJob(params: {
  clientId: string; lead: Lead; kind: Kind; runAt: Date; meta?: Record<string, unknown>;
}): Promise<void> {
  await supabase.from("nurture_jobs").upsert(
    {
      client_id: params.clientId,
      lead_id: params.lead.id,
      ghl_contact_id: params.lead.ghl_contact_id,
      kind: params.kind,
      run_at: params.runAt.toISOString(),
      meta: params.meta ?? {},
    },
    { onConflict: "lead_id,kind", ignoreDuplicates: true }
  );
}

/** Hook: an outbound message containing the training video link just went out.
 *  Logs the anchor event once and (only if nurture is live for this client)
 *  schedules the +30min takeaway. */
export async function recordVideoLinkSent(clientId: string, lead: Lead): Promise<void> {
  try {
    if (await eventExists(lead.id, "video_link_sent")) return;
    await logEvent({ client_id: clientId, lead_id: lead.id, event_type: "video_link_sent", metadata: { at: new Date().toISOString() } });
    if (lead.nurture_paused) return;
    const { data } = await supabase.from("clients").select("nurture_enabled").eq("id", clientId).maybeSingle();
    if ((data as { nurture_enabled?: boolean } | null)?.nurture_enabled) {
      await scheduleJob({ clientId, lead, kind: "nurture_takeaway", runAt: new Date(Date.now() + TAKEAWAY_DELAY_MS) });
    }
  } catch (err) {
    console.error("[nurture] recordVideoLinkSent failed:", err);
  }
}

interface EnabledClient { id: string; enabledAt: number }
async function enabledClients(): Promise<EnabledClient[]> {
  // .eq("is_active") — the system-wide setter switch. Without it, nurture drips
  // kept landing in real DMs after the owner switched the setter off (same defect
  // as followups.ts). "Off" means off on every outbound path.
  const { data } = await supabase.from("clients").select("id, nurture_enabled_at")
    .eq("is_active", true).eq("nurture_enabled", true);
  return (data ?? []).map((c) => {
    const row = c as { id: string; nurture_enabled_at: string | null };
    return { id: row.id, enabledAt: row.nurture_enabled_at ? new Date(row.nurture_enabled_at).getTime() : 0 };
  });
}

/**
 * SCHEDULE PASS — backfill jobs from signals the webhook can't see directly:
 *   - new bookings (appointment_booked events, logged by the pipeline watcher)
 *     → kickoff now + fetch the call time from GHL → pre-call reminder.
 *   - video_link_sent events without a takeaway job (redundancy for the hook).
 * Only runs for nurture-enabled clients, so it's silent when the engine is off.
 */
async function scheduleBacklog(clients: EnabledClient[]): Promise<void> {
  const clientIds = clients.map((c) => c.id);
  const enabledAt = new Map(clients.map((c) => [c.id, c.enabledAt]));
  // Recent only, AND never before the client switched nurture on (no retroactive
  // blasts of leads who booked / got the video before enabling).
  const floor = Date.now() - 36 * 3_600_000;
  const since = new Date(Math.max(floor, Math.min(...clients.map((c) => c.enabledAt)))).toISOString();
  const afterEnable = (clientId: string, atIso: string) => new Date(atIso).getTime() >= (enabledAt.get(clientId) ?? 0);

  // 1. Recent bookings → kickoff + pre-call.
  const { data: booked } = await supabase
    .from("events").select("lead_id, created_at, client_id")
    .eq("event_type", "appointment_booked").in("client_id", clientIds)
    .gte("created_at", since).order("created_at", { ascending: false }).limit(60);

  for (const ev of (booked ?? []) as { lead_id: string | null; created_at: string; client_id: string }[]) {
    if (!ev.lead_id || !afterEnable(ev.client_id, ev.created_at)) continue;
    const { data: leadRow } = await supabase.from("leads").select("*").eq("id", ev.lead_id).maybeSingle();
    const lead = leadRow as Lead | null;
    if (!lead || !lead.ghl_contact_id || lead.nurture_paused) continue;
    // Don't kick off a lead that already moved into / past the post-book flow.
    const already = ["post_book", "proof", "nurture"].includes(lead.funnel_stage ?? "");
    const videoOut = await eventExists(lead.id, "video_link_sent");
    if (!already && !videoOut) {
      await scheduleJob({ clientId: lead.client_id, lead, kind: "post_book_kickoff", runAt: new Date() });
    }
    // Pre-call reminder — needs the real call time from GHL.
    const { data: existing } = await supabase
      .from("nurture_jobs").select("id").eq("lead_id", lead.id).eq("kind", "nurture_precall").maybeSingle();
    if (!existing) {
      const callAt = await getContactUpcomingAppointment(/* apiKey */ (await clientKey(lead.client_id)) ?? "", lead.ghl_contact_id);
      if (callAt) {
        const runAt = precallRunAt(callAt);
        if (runAt) await scheduleJob({ clientId: lead.client_id, lead, kind: "nurture_precall", runAt, meta: { call_at: callAt } });
      }
    }
  }

  // 2. video_link_sent events → takeaway (redundant safety net for the hook).
  const { data: vids } = await supabase
    .from("events").select("lead_id, created_at, client_id")
    .eq("event_type", "video_link_sent").in("client_id", clientIds)
    .gte("created_at", since).limit(60);
  for (const ev of (vids ?? []) as { lead_id: string | null; created_at: string; client_id: string }[]) {
    if (!ev.lead_id || !afterEnable(ev.client_id, ev.created_at)) continue;
    const { data: job } = await supabase.from("nurture_jobs").select("id").eq("lead_id", ev.lead_id).eq("kind", "nurture_takeaway").maybeSingle();
    if (job) continue;
    const { data: leadRow } = await supabase.from("leads").select("*").eq("id", ev.lead_id).maybeSingle();
    const lead = leadRow as Lead | null;
    if (lead?.ghl_contact_id && !lead.nurture_paused) {
      await scheduleJob({ clientId: ev.client_id, lead, kind: "nurture_takeaway", runAt: new Date(new Date(ev.created_at).getTime() + TAKEAWAY_DELAY_MS) });
    }
  }
}

const keyCache = new Map<string, string | null>();
async function clientKey(clientId: string): Promise<string | null> {
  if (keyCache.has(clientId)) return keyCache.get(clientId)!;
  const { data } = await supabase.from("clients").select("ghl_api_key").eq("id", clientId).maybeSingle();
  const key = (data as { ghl_api_key: string | null } | null)?.ghl_api_key ?? null;
  keyCache.set(clientId, key);
  return key;
}

/** FLUSH PASS — send every due job (for enabled clients), with guards.
 *  Each job is CLAIMED atomically (pending → sending) before sending, so the
 *  three concurrent drivers (pg_cron / webhook / HQ pulse) can never send the
 *  same job twice. A claim stuck in "sending" >10min (crashed worker) is
 *  reclaimable. */
async function flushDue(clientIds: string[]): Promise<{ sent: number; skipped: number; failed: number }> {
  const nowIso = new Date().toISOString();
  const staleIso = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: due } = await supabase
    .from("nurture_jobs").select("id")
    .or(`status.eq.pending,and(status.eq.sending,sent_at.lt.${staleIso})`)
    .lte("run_at", nowIso).in("client_id", clientIds)
    .order("run_at").limit(40);
  let sent = 0, skipped = 0, failed = 0;

  for (const cand of (due ?? []) as { id: string }[]) {
    try {
      // Atomic claim: only the worker that flips pending→sending owns this job.
      const { data: claimedRows } = await supabase
        .from("nurture_jobs")
        .update({ status: "sending", sent_at: nowIso })
        .eq("id", cand.id)
        .or(`status.eq.pending,and(status.eq.sending,sent_at.lt.${staleIso})`)
        .select("*");
      const j = (claimedRows ?? [])[0] as NurtureJob | undefined;
      if (!j) { continue; } // someone else claimed it
      const { data: leadRow } = await supabase.from("leads").select("*").eq("id", j.lead_id).maybeSingle();
      const lead = leadRow as Lead | null;
      const { data: clientRow } = await supabase.from("clients").select("ghl_api_key, ghl_location_id, nurture_enabled, is_active").eq("id", j.client_id).maybeSingle();
      const client = clientRow as { ghl_api_key: string | null; ghl_location_id: string | null; nurture_enabled: boolean; is_active: boolean } | null;

      // Guards — re-check at send time, never step on a paused/finished/human chat.
      const skip = (reason: string) => { markDone(j.id, "skipped", reason); skipped++; };
      if (!lead || !lead.ghl_contact_id || !client?.ghl_api_key || !client.ghl_location_id) { skip("missing_lead_or_client"); continue; }
      // is_active is the MASTER switch and this re-check deliberately exists to
      // catch a state change mid-tick — it just never covered the one switch
      // The owner actually flips. Up to 40 already-claimed jobs could still deliver
      // seconds after he was told the setter was off.
      if (!client.is_active) { skip("setter_switched_off"); continue; }
      if (!client.nurture_enabled) { skip("client_disabled"); continue; }
      if (lead.nurture_paused) { skip("lead_nurture_paused"); continue; }
      if (lead.ai_paused) { skip("ai_paused"); continue; }
      if (lead.status === "done") { skip("lead_done"); continue; }
      if (j.kind === "nurture_precall" && j.meta?.call_at && new Date(String(j.meta.call_at)).getTime() <= Date.now()) { skip("call_passed"); continue; }
      // Don't talk over a live exchange. Release the claim (back to pending) and
      // try again later: a human takeover within 15 min defers an hour; any
      // message within 90s means an exchange is in flight, defer 5 min.
      const defer = async (ms: number) => {
        await supabase.from("nurture_jobs").update({ status: "pending", sent_at: null, run_at: new Date(Date.now() + ms).toISOString(), attempts: j.attempts + 1 }).eq("id", j.id);
        skipped++;
      };
      const { data: lastMsg } = await supabase.from("messages").select("role, created_at").eq("lead_id", lead.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      const lm = lastMsg as { role: string; created_at: string } | null;
      if (lm) {
        const age = Date.now() - new Date(lm.created_at).getTime();
        // A HAND-TYPED MESSAGE IS A TAKEOVER, NOT A BUSY SIGNAL (2026-08-09).
        // This used to defer an hour and then send anyway, so a thread the owner had
        // stepped into got a nurture drip on top of him sixty minutes later.
        // Whose message is LAST is the signal, with no expiry: if he spoke last,
        // the thread is his. Skipped rather than deferred, because deferring is
        // what let it come back.
        if (lm.role === "human") { skip("human_handling_thread"); continue; }
        if (age < 90_000) { await defer(5 * 60_000); continue; }
        // ONE PROACTIVE TOUCH PER PERSON PER QUARTER-HOUR, ACROSS ENGINES.
        // Nurture and the follow-up engine share the same cron minute and were
        // blind to each other: a lead due for both got the 🐶 chase AND "what'd
        // you think of the video" seconds apart (caught by the stress rig,
        // 2026-08-12) - which is exactly the double-texting bots do. If OUR
        // side said anything at all in the last 15 minutes, this job waits a
        // tick; deferred, not skipped, so the touch still lands.
        if (lm.role === "ai" && age < 15 * 60_000) { await defer(15 * 60_000); continue; }
      }

      // ONE MOUTH PER PERSON AT A TIME, ATOMICALLY (mirror of followups.ts).
      // The read guard above loses a true same-tick race - both engines read
      // the thread before either sends. The per-lead reply lock is the
      // arbiter; lock lost => the job defers and lands next tick.
      const touchStamp = await acquireReplyLock(lead.id, 60_000);
      if (!touchStamp) { await defer(5 * 60_000); continue; }
      try {

      const lang: Lang = lead.conversation_language === "sv" ? "sv" : "en";
      const text = messageFor(j.kind as Kind, lang);
      const res = await sendLeadMessage({
        ghl_api_key: client.ghl_api_key, ghl_location_id: client.ghl_location_id,
        ghl_contact_id: lead.ghl_contact_id, message: text, type: (j.channel as "IG") || "IG",
      });
      if (!res.success) {
        // 24H WINDOW CLOSED (Meta error 3031): retrying is pointless — the
        // platform will never accept an automated send until the lead speaks
        // again. Hand the drafted touch to the owner on Telegram instead (owner
        // rule 2026-08-08) and close the job so it never re-fires.
        if (/3031|24 hours?/i.test(res.error || "")) {
          const { sendTelegramCopyBlock, leadLabel, ghlContactLink } = await import("./telegram");
          // THE WORST-IDENTIFIED PING IN THE SYSTEM, until now: a bare
          // `full_name || ig_username || "this lead"` header, no reference, no
          // GHL link, and a copy block that could not record its subject. Every
          // 24h-window handoff was unanswerable - "turn him off" on it could
          // only ever ask him who he meant.
          const link = client.ghl_location_id && lead.ghl_contact_id
            ? `\n${ghlContactLink(client.ghl_location_id, lead.ghl_contact_id)}` : "";
          await sendTelegramCopyBlock(
            `${leadLabel(lead)}'s pre-call touch can't be sent automatically (their 24h Instagram window is closed). Tap to copy and send it from your phone:${link}`,
            text,
            { leadId: lead.id, clientId: lead.client_id, kind: "nurture_handoff" }
          ).catch(() => {});
          await supabase.from("nurture_jobs").update({ status: "handed_off", sent_at: new Date().toISOString() }).eq("id", j.id);
          await logEvent({ client_id: lead.client_id, lead_id: lead.id, event_type: "nurture_handed_off", metadata: { kind: j.kind } }).catch(() => {});
          failed++; continue;
        }
        const attempts = j.attempts + 1;
        await supabase.from("nurture_jobs").update({ attempts, status: attempts >= 4 ? "failed" : "pending", sent_at: null, run_at: new Date(Date.now() + 20 * 60_000).toISOString() }).eq("id", j.id);
        failed++; continue;
      }

      // The message is OUT — mark the job terminal IMMEDIATELY, retrying until it
      // sticks, so a crash/DB-blip in the bookkeeping below can never re-claim
      // and re-send it. (The 10-min stale-reclaim is the only other re-send path;
      // this loop makes a missed mark vanishingly unlikely.)
      for (let a = 0; a < 4; a++) {
        const { error } = await supabase.from("nurture_jobs").update({ status: "sent", sent_at: new Date().toISOString(), meta: {} }).eq("id", j.id);
        if (!error) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      sent++;
      // Best-effort bookkeeping: record the send as a normal AI message + advance
      // the stage so the lead's reply lands in the right context (booked, not new).
      // Wrapped so a DB blip here NEVER bubbles to the outer catch (which would
      // otherwise risk re-sending — the job is already terminal regardless).
      try {
        await saveMessage({ lead_id: lead.id, client_id: j.client_id, role: "ai", content: text, channel: "instagram", ghl_message_id: res.ghl_message_id, model_used: "nurture_engine", delivered: true });
        const nextStage = j.kind === "post_book_kickoff" ? "post_book" : j.kind === "nurture_takeaway" ? "nurture" : null;
        if (nextStage) {
          await supabase.from("leads").update({ funnel_stage: nextStage }).eq("id", lead.id);
          // The CRM paper trail (owner ask 2026-08-13): a nurture-driven stage
          // move gets a note like every reply-driven one.
          try {
            const { data: cRow } = await supabase.from("clients").select("*").eq("id", j.client_id).maybeSingle();
            if (cRow) {
              const { noteStageChange } = await import("./crm-notes");
              await noteStageChange({
                client: cRow as never,
                lead: lead as never,
                fromStage: (lead as { funnel_stage?: string | null }).funnel_stage ?? null,
                toStage: nextStage,
                stageData: (lead as { stage_data?: Record<string, unknown> | null }).stage_data ?? null,
              });
            }
          } catch (e) {
            console.error("[nurture] stage note failed (send already out):", e);
          }
        }
        await logEvent({ client_id: j.client_id, lead_id: lead.id, event_type: "nurture_sent", metadata: { kind: j.kind } });
      } catch (bk) {
        console.error("[nurture] post-send bookkeeping failed (message already sent):", j.id, bk);
      }
      } finally {
        await releaseReplyLock(lead.id, touchStamp);
      }
    } catch (err) {
      // Do NOT reset to pending here — that's a double-send vector if the throw
      // happened after the GHL send. A job genuinely stuck in "sending" (e.g.
      // crashed before sending) self-heals via the 10-min stale-reclaim, which
      // re-runs all the guards. Better a 10-min delay than a duplicate DM.
      console.error("[nurture] job errored (left for stale-reclaim):", cand.id, err);
      failed++;
    }
  }
  return { sent, skipped, failed };
}

function markDone(id: string, status: "sent" | "skipped", reason?: string) {
  supabase.from("nurture_jobs")
    .update({ status, sent_at: new Date().toISOString(), meta: reason ? { skip_reason: reason } : {} })
    .eq("id", id).then(undefined, () => {});
}

interface NurtureJob {
  id: string; client_id: string; lead_id: string; ghl_contact_id: string | null;
  channel: string; kind: string; run_at: string; status: string; attempts: number; meta: Record<string, unknown> | null;
}

/** Flush-only: send due jobs without the (heavier) scheduling pass. Used on the
 *  hot paths (webhook + HQ pulse) so jobs fire promptly during active hours. */
export async function flushNurtureDue(): Promise<void> {
  try {
    const clients = await enabledClients();
    if (clients.length) await flushDue(clients.map((c) => c.id));
  } catch (err) {
    console.error("[nurture] flushNurtureDue failed:", err);
  }
}

/** The whole engine: schedule new jobs, then send everything due. Safe no-op
 *  when no client has nurture_enabled. */
export async function runNurture(): Promise<{ enabled: number; sent: number; skipped: number; failed: number }> {
  try {
    const clients = await enabledClients();
    if (!clients.length) return { enabled: 0, sent: 0, skipped: 0, failed: 0 };
    await scheduleBacklog(clients);
    const r = await flushDue(clients.map((c) => c.id));
    return { enabled: clients.length, ...r };
  } catch (err) {
    console.error("[nurture] runNurture failed:", err);
    return { enabled: 0, sent: 0, skipped: 0, failed: 0 };
  }
}
