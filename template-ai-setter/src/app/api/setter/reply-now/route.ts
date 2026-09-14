/**
 * REPLY NOW - fresh-invocation reply runner (internal)
 * -------------------------------------------------------------------------
 * Runs the full reply engine for one lead in a BRAND-NEW invocation with its
 * own 60s budget. Exists because of a live failure at the worst possible
 * moment (booking stage): the ManyChat watchdog used to run the takeover
 * reply inside the ORIGINAL inbound invocation, which had already burned 25s
 * waiting - generation plus a 4-bubble paced send blew the platform's 60s
 * limit and the process was KILLED mid-send. The kill skips the engine's
 * finally, so the reply lock stayed set; the lead's NEXT message's watchdog
 * saw a fresh-looking lock, assumed a reply was in flight, and went silent -
 * the lead waited 5 minutes for the sweep.
 *
 * Callers (the ManyChat inbound watchdog + dead-GHL-contact backup mode) now
 * fire-and-forget a POST here instead of replying in-process. This route
 * answers immediately and does the debounce + generation + paced sends in
 * its own background window.
 *
 * SPENT-LOCK RECLAIM: before generating, a fresh-looking reply lock is
 * inspected rather than blindly trusted. If a non-ack AI (or human) message
 * was saved AFTER the lock was stamped, the locked generation already
 * delivered its reply - the lock is an orphan left by a killed invocation
 * and is released so this reply can proceed. If nothing was saved after the
 * stamp, a generation is genuinely mid-flight (its own straggler guard will
 * fold the new message in), so this call backs off.
 *
 * Auth: the same shared access key as the other key-gated setter routes.
 * Single-tenant on teu, same as /api/manychat/inbound.
 */
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import {
  supabase,
  getRecentMessages,
  getLatestLeadMessage,
  logEvent,
  recentEventExists,
  type Client,
  type Lead,
} from "@/lib/supabase";
import { getAccessKey } from "@/lib/prompter/access";
import { generateAndSendReply } from "@/lib/reply-engine";
import { handleLeadMagnet } from "@/lib/lead-magnet";
import { runFirstContactScreener, runOngoingTagging, standDownForHumanTakeover } from "@/lib/screener";
import { humanIsHoldingThread, syncConversationFromGHL } from "@/lib/conversation-sync";
import { INSTANT_ACK_TAG } from "@/lib/instant-ack";
import { replyLockIsSpent } from "@/lib/reply-lock";

export const dynamic = "force-dynamic";
// 300, not 60 (live incident 2026-08-13, Cody Brown): a full turn is quiet
// window + generation + humanizer hold (up to ~50s) + paced bubbles (up to
// ~16s) + inbox read-back. 60s guillotined a volley MID-TRANSPORT: bubble 3
// was accepted by Instagram but the run died before the response returned,
// the stamp never landed, and the sweep re-sent words the lead already had.
// The ceiling must sit far above the longest legitimate turn.
export const maxDuration = 300;

// Mirror of the engine's REPLY_LOCK_TTL_MS: a lock older than this is stale
// on its own and the engine will re-take it - only a younger one needs the
// spent-vs-in-flight inspection here.
const REPLY_LOCK_TTL_MS = 80_000;

export async function POST(req: NextRequest) {
  try {
    const k = req.nextUrl.searchParams.get("k") ?? "";
    const accessKey = await getAccessKey();
    if (!accessKey || k !== accessKey) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as {
      lead_id?: string;
      inbound_message_id?: string;
      debounce_ms?: number;
      reason?: string;
    } | null;
    const leadId = (body?.lead_id || "").trim();
    if (!leadId) return NextResponse.json({ ok: true, skipped: "no_lead_id" });

    // The LEAD names its client (students-kit, 2026-08-21). This route used to
    // look up the owner's default client by slug and require the lead to
    // belong to it - which silently ignored every lead of a second client on a
    // multi-client copy of the platform. The lead row already carries
    // client_id, so resolve the lead first and let IT say whose it is.
    const { data: leadRow } = await supabase
      .from("leads")
      .select("*")
      .eq("id", leadId)
      .maybeSingle();
    const lead = leadRow as Lead | null;
    if (!lead) return NextResponse.json({ ok: true, skipped: "no_lead" });

    const { data: clientRow } = await supabase
      .from("clients")
      .select("*")
      .eq("id", lead.client_id)
      .maybeSingle();
    const client = clientRow as Client | null;
    if (!client || !client.is_active) {
      return NextResponse.json({ ok: true, skipped: "no_client" });
    }
    if (lead.ai_paused) return NextResponse.json({ ok: true, skipped: "ai_paused" });

    // Lead-magnet gate ("reply BDP for the free book") — mirrors the main
    // pipeline, where it runs BEFORE the screened gate, so a takeover reply
    // can never talk over (or skip) a live magnet flow.
    const latestLeadMsg = await getLatestLeadMessage(lead.id);
    if (
      latestLeadMsg &&
      (await handleLeadMagnet({ client, lead, text: latestLeadMsg.content })) === "handled"
    ) {
      return NextResponse.json({ ok: true, mode: "lead_magnet" });
    }

    // Spent-lock reclaim (see header). Ack rows don't count as "delivered a
    // reply" - the ack path never holds the reply lock.
    const lockIso = lead.reply_lock_at ?? null;
    if (lockIso && Date.now() - new Date(lockIso).getTime() < REPLY_LOCK_TTL_MS) {
      const lockMs = new Date(lockIso).getTime();
      const recent = await getRecentMessages(lead.id, 10);
      // Rows the locked generation saved (non-ack AI or human, at/after the stamp).
      const ownerRows = recent.filter(
        (m) =>
          new Date(m.created_at).getTime() >= lockMs &&
          (m.role === "human" || (m.role === "ai" && m.model_used !== INSTANT_ACK_TAG))
      );
      // "Spent" must mean SEND-COMPLETE, not merely started: the engine saves
      // its bubbles BEFORE the paced sends, so during the ~20-40s of pacing the
      // rows exist with delivery stamps landing one by one. The old check here
      // accepted ONE delivered bubble as proof the volley was done - live
      // incident 2026-08-20 (Scott Hall): a mid-volley inbound reclaimed the
      // lock 0.5s after bubble 1 of 4 landed, ran a second concurrent turn,
      // and that turn switched the AI off, blocking bubble 4 (the question).
      // The full rules live in lib/reply-lock.ts, pinned by reply-lock.test.ts.
      if (!replyLockIsSpent(ownerRows, Date.now())) {
        return NextResponse.json({ ok: true, skipped: "reply_in_flight" });
      }
      // Compare-and-swap release: only free the EXACT lock we inspected. If it
      // changed hands between our read and now (the orphan expired and a new
      // generation re-took it in that sliver), backing off is the safe move -
      // freeing the new owner's lock could produce two concurrent replies.
      const { data: released, error: releaseErr } = await supabase
        .from("leads")
        .update({ reply_lock_at: null })
        .eq("id", lead.id)
        .eq("reply_lock_at", lockIso)
        .select("id");
      if (releaseErr || !released?.length) {
        return NextResponse.json({ ok: true, skipped: "lock_changed" });
      }
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "reply_lock_reclaimed",
        metadata: { lock_at: lockIso, reason: body?.reason ?? null },
      });
    }

    if (body?.reason === "watchdog") {
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "watchdog_reply_takeover",
        metadata: { via: "reply_now" },
      });
    }

    const inboundMessageId = body?.inbound_message_id || undefined;
    const debounceMs = typeof body?.debounce_ms === "number" ? body.debounce_ms : undefined;

    // MANYCHAT-FIRST (2026-07-09): a brand-new sender's lead is created by
    // /api/manychat/inbound and replied to from HERE — skipping unscreened
    // leads would leave every fresh conversation unanswered until GHL's slow
    // feed showed up (or forever, for a contactless lead GHL never webhooks).
    // Run the SAME first-contact screener the main pipeline uses; its verdict
    // decides whether the reply engine ever runs.
    if (lead.screened !== true) {
      waitUntil(
        (async () => {
          const outcome = await runFirstContactScreener({ client, lead });
          if (!outcome.shouldReply) return;
          await generateAndSendReply({
            client,
            lead,
            priorHistory: outcome.priorHistory,
            inboundMessageId,
            debounceMs,
          });
        })().catch((err) => console.error("[reply-now] first-contact reply failed:", err))
      );
      return NextResponse.json({ ok: true, mode: "first_contact_started" });
    }

    // BEFORE ASKING WHETHER HE IS IN THIS THREAD, GO AND LOOK.
    //
    // Nothing records a message the owner types in the Instagram app - our table
    // has never held a single role='human' row from that source. GHL does hold
    // the full two-sided thread, and conversation-sync imports it, but that
    // sync only ran inside the first-contact screener. So on an ongoing thread
    // the takeover check below would have been asking a table that could not
    // possibly know the answer.
    //
    // Once per SYNC_COOLDOWN_MS per lead, because a five-bubble burst must not
    // become five GHL round trips, and because GHL's feed lags 10-105 seconds
    // anyway so re-asking within the same beat learns nothing new.
    const SYNC_COOLDOWN_MS = 5 * 60_000;
    const syncedRecently = await recentEventExists({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "conversation_synced",
      since_iso: new Date(Date.now() - SYNC_COOLDOWN_MS).toISOString(),
    });
    if (!syncedRecently) {
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "conversation_synced",
        metadata: { via: "reply_now" },
      }).catch(() => { /* best-effort */ });
      await syncConversationFromGHL({ client, lead }).catch((err) =>
        console.error("[reply-now] conversation sync failed:", err)
      );
    }

    // HE IS IN THIS CONVERSATION HIMSELF (2026-08-09).
    //
    // The takeover check used to live only inside the first-contact screener,
    // and that screener runs ONCE per lead and never again (markScreened sets
    // leads.screened = true precisely so it "never re-runs"). So the protection
    // covered brand-new people and skipped every conversation the setter was
    // already having - which is exactly the set the owner jumps into. Live result:
    // the setter kept answering over the top of him mid-thread.
    //
    // The rule here is "his message is the LAST one from our side", not "a human
    // ever spoke": one DM he fired off weeks ago must not freeze a lead the
    // setter is legitimately working. A trailing instant ack does not count as
    // the setter taking the thread back.
    //
    // The stand-down is permanent and it silences follow-ups and nurture too,
    // because a thread he took over is his - and he is told on Telegram.
    if (await humanIsHoldingThread(lead.id)) {
      await standDownForHumanTakeover(client, lead);
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "reply_skipped_human_handled",
        metadata: { via: "reply_now" },
      }).catch(() => { /* best-effort */ });
      return NextResponse.json({ ok: true, mode: "human_handled" });
    }

    // Ongoing tagging (screener Part B) runs ALONGSIDE the reply on the
    // primary path too — it used to run only from the sweep's rescue
    // pipeline, so a mid-conversation friend claim / biz-owner reveal on a
    // live thread was invisible until minutes later. It can pause the lead;
    // the engine's pre-send pause re-check then withholds the reply.
    waitUntil(
      runOngoingTagging({ client, lead }).catch((err) =>
        console.error("[reply-now] ongoing tagging failed:", err)
      )
    );

    waitUntil(
      generateAndSendReply({ client, lead, inboundMessageId, debounceMs }).catch((err) =>
        console.error("[reply-now] reply failed:", err)
      )
    );

    return NextResponse.json({ ok: true, mode: "reply_started" });
  } catch (err) {
    console.error("[reply-now] error:", err);
    return NextResponse.json({ ok: false });
  }
}
