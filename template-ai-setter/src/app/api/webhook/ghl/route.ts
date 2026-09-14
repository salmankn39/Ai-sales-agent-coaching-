/**
 * GHL INBOUND WEBHOOK — RETIRED (2026-07-26, operator's decision)
 * ===============================================================
 * This endpoint used to be a second pair of ears on the same Instagram inbox
 * that ManyChat already listens to, and a second BRAIN that could reply to the
 * same message. That is what it cost:
 *
 *   - Oliver (oliverbutcherr) became TWO lead rows four seconds apart, one
 *     minted here and one minted by ManyChat, each running its own AI. He got
 *     doubled questions for a whole conversation, and pausing him only stopped
 *     one of the two. The owner said stop, three times, and the AI kept talking.
 *   - Every message from a ManyChat-known lead arrived twice and had to be
 *     de-duplicated by a message-level claim, which worked right up until the
 *     two ears disagreed about WHO the person was, at which point nothing
 *     could match them.
 *   - It dropped inbound DMs often enough that a whole recovery sweep
 *     (lib/ghl-ingest.ts) existed purely to find the ones it lost.
 *
 * Measured before cutting it: in 30 days it carried 0 human takeover messages,
 * detected 0 bookings (every appointment_booked event came from the Python
 * pipeline watcher polling the API, never from here), and its stop-tag gate was
 * already duplicated by the ManyChat route reading the same tags over the API.
 * The only thing it uniquely caught in 14 days was one Russian spam pitch, an
 * "I do", a "😍" and a "Yoooo broooo".
 *
 * SO: ManyChat is now the ONLY ear and the ONLY mouth. GoHighLevel remains the
 * CRM and nothing else — we CALL its API (contacts, tags, calendar slots,
 * opportunities, pipeline stages); it never pushes a conversation at us again.
 *
 * WHY THIS FILE STILL EXISTS instead of being deleted: GHL's own workflow may
 * still be pointed here, and a 404 would make it retry and alarm. This returns
 * 200 and does NOTHING — no lead, no message, no reply, no tag read. It records
 * one diagnostic row per hit so the owner can see whether GHL is still firing
 * and switch the workflow off whenever it suits him, with nothing depending on
 * the timing. Once his GHL workflow is off and this has been silent for a
 * while, the file can go.
 *
 * DO NOT reintroduce message handling here. If a DM needs to reach the setter,
 * it comes through /api/manychat/inbound. One ear, one brain, one lead row.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/** Best-effort diagnostic write; never throws, never blocks the 200. */
function recordIgnored(body: unknown, note: string): void {
  supabase
    .from("webhook_debug_logs")
    .insert({
      parse_result: "ghl_webhook_ignored",
      extracted_data: { note, body } as never,
    })
    .then(undefined, () => {});
}

export async function POST(req: NextRequest) {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = "<unparseable>";
  }
  recordIgnored(body, "GHL webhook retired 2026-07-26 — ManyChat is the only ear");
  return NextResponse.json({
    ok: true,
    ignored: true,
    reason: "ghl_webhook_retired",
    detail: "Inbound is handled exclusively by /api/manychat/inbound.",
  });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "ai-setter-webhook",
    status: "retired",
    inbound: "/api/manychat/inbound",
    since: "2026-07-26",
  });
}
