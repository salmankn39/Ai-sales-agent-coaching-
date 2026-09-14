/**
 * LEAD-MAGNET HANDOFF TICK — the every-minute backstop that fires any due
 * "setter takes over" openers a crashed/killed invocation left behind.
 *
 * The PRIMARY driver is the in-process timer scheduled by the invocation that
 * sent the book link (see lib/lead-magnet.ts advanceToLink) — that one lands
 * the opener ~45-55s after the link. This cron exists so a platform kill or
 * timeout can never orphan a handoff for more than ~a minute. Deliberately
 * tiny: ONE indexed query when nothing is due.
 *
 * Driven by Supabase pg_cron every minute (see db/magnet_cron.sql).
 *
 * GET /api/cron/magnet   (optional CRON_SECRET bearer auth)
 */
import { NextRequest, NextResponse } from "next/server";
import { flushLeadMagnetHandoffs } from "@/lib/lead-magnet";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  await flushLeadMagnetHandoffs();
  return NextResponse.json({ ok: true });
}
