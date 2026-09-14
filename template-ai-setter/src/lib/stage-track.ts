/**
 * TRACKED-ONLY STAGE TRACKING — zero difference between AI on and AI off.
 *
 * Owner rule, 2026-08-13: "yes i want there to be ZERO difference between
 * when the ai is off or on" - about tracking. Off has always meant "no
 * sending, tracking untouched", but the funnel STAGE tracker lived inside
 * the reply turn, so a lead messaging while the setter was off (or while
 * paused for a human-held conversation) moved through the funnel invisibly:
 * no stage update, no captured facts, no CRM note.
 *
 * This runs the SAME stage resolution the reply engine uses - same stages,
 * same facts, same one-step-forward safety, same CRM note on a move - with
 * ZERO outbound of any kind. It is called from the inbound route's
 * tracked-only branches (setter off system-wide, lead paused).
 *
 * Guards, in order:
 *  - no stages configured → no-op (same as the live path);
 *  - unscreened lead → no-op. Screening decides lead-vs-friend and only runs
 *    on the reply path; stage-tracking an unscreened sender would build a
 *    funnel paper trail on the owner's friends. Same rule as the ack gate.
 *  - burst guard: a stage resolution in the last 60s means this burst is
 *    already tracked; the next message after the window re-reads the WHOLE
 *    thread, so nothing is lost by skipping - resolution is stateless over
 *    history.
 *
 * Best-effort and non-throwing: tracking can never break the inbound path.
 */

import {
  getRecentMessages,
  updateLeadStage,
  logEvent,
  recentEventExists,
  type Client,
  type Lead,
} from "./supabase";
import { parseStages, resolveStage } from "./stages";
import { noteStageChange } from "./crm-notes";

const BURST_GUARD_MS = 60_000;

export async function trackStageForInbound(params: {
  client: Client;
  lead: Lead;
}): Promise<void> {
  const { client, lead } = params;
  try {
    const stages = parseStages(client.stages);
    if (!stages.length) return;
    if (lead.screened !== true) return;

    const justTracked = await recentEventExists({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "stage_resolved",
      since_iso: new Date(Date.now() - BURST_GUARD_MS).toISOString(),
    });
    if (justTracked) return;

    const history = await getRecentMessages(lead.id, 30);
    if (!history.length) return;

    const resolution = await resolveStage({
      stages,
      currentStageId: lead.funnel_stage ?? null,
      stageData: lead.stage_data ?? {},
      messages: history.map((m) => ({ role: m.role, content: m.content })),
      // Pain-dig shapes a REPLY and whale-radar pings the owner about a lead
      // the AI is working; neither belongs to a pure tracking pass.
      painEnabled: false,
      painProtocol: null,
      whaleEnabled: false,
    });

    const previousStage = lead.funnel_stage ?? null;
    await updateLeadStage({
      lead_id: lead.id,
      stage: resolution.stage.id,
      stage_data: resolution.stageData,
    });
    if (resolution.stage.id !== previousStage) {
      await noteStageChange({
        client,
        lead,
        fromStage: previousStage,
        toStage: resolution.stage.id,
        stageData: resolution.stageData,
      });
    }
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "stage_resolved",
      metadata: {
        stage: resolution.stage.id,
        advanced: resolution.advanced,
        captured: Object.keys(resolution.stageData || {}),
        reason: (resolution.reason || "").slice(0, 200),
        tracked_only: true,
      },
    });
  } catch (e) {
    console.error("[stage-track] tracked-only stage pass failed (inbound unaffected):", e);
  }
}
