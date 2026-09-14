/**
 * LEAD PIPELINE — the shared "an inbound lead message needs handling" flow:
 *
 *   lead-magnet gate (e.g. "reply BDP for the free book")
 *     → ManyChat funnel email enrichment
 *     → first-contact screener (unscreened leads)
 *     → reply engine (+ ongoing tagging in parallel)
 *
 * Every inbound message runs through here, whether it arrived live on the
 * ManyChat webhook or was picked up by the unanswered-lead rescue in the
 * sweep — a rescued lead behaves exactly like a live one.
 * Route files can only export HTTP handlers, hence this lives in lib/.
 */
import { type Client, type Lead } from "./supabase";
import { handleLeadMagnet } from "./lead-magnet";
import { runFirstContactScreener, runOngoingTagging } from "./screener";
import { generateAndSendReply } from "./reply-engine";

export async function runLeadPipeline(params: {
  client: Client | null;
  lead: Lead | null;
  inboundMessageId?: string;
  messageText: string;
  // Debounce override passed straight to the reply engine. The sweep passes
  // ~1s: its message is minutes old, there is no burst left to coalesce, and
  // paying the full configured delay inside the 60s function budget was
  // getting rescue attempts killed mid-flight (then backed off 30 min).
  debounceMs?: number;
}) {
  const { client, lead, inboundMessageId, messageText, debounceMs } = params;
  if (!client || !lead) return;

  // --- Lead-magnet gate ("reply BDP for the free book") ------------------
  // A fixed, non-AI script owns the lead from the trigger keyword through the
  // book link. It runs BEFORE the ManyChat gate/screener/reply-engine, so a
  // triggered lead never sees the full brain until after the timed handoff.
  // "not_triggered" means this lead has no live magnet flow — proceed as normal.
  if ((await handleLeadMagnet({ client, lead, text: messageText })) === "handled") return;
  // -------------------------------------------------------------------------

  if (!lead.screened) {
    const outcome = await runFirstContactScreener({ client, lead });
    if (!outcome.shouldReply) return; // skip_owner / skip_friend / hold — no reply
    await generateAndSendReply({
      client,
      lead,
      priorHistory: outcome.priorHistory,
      inboundMessageId,
      debounceMs,
    });
    return;
  }

  // Already screened ICP lead: tag in the background, never blocking the reply.
  void runOngoingTagging({ client, lead }).catch((err) =>
    console.error("[lead-pipeline] ongoing tagging failed:", err)
  );
  await generateAndSendReply({ client, lead, inboundMessageId, debounceMs });
}
