/**
 * The read-out box's data. Cached per date range.
 *
 * The box costs a model call and the same range gets opened over and over, so
 * a generated read is stored against (start, end) and only rebuilt when it
 * ages out. A range that is still running (end date today or later) goes stale
 * quickly because the numbers underneath are still moving; a closed range in
 * the past cannot change, so its read is kept far longer.
 *
 * READ_VERSION exists because that second rule bites when the READING changes
 * rather than the numbers. The owner pulled four lines apart, the prompt and the
 * signals pack were rewritten, and every closed range would still have served
 * the old bad text for another month. Bump READ_VERSION whenever the pack or
 * the prompt changes and every cached read rebuilds on its next view.
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { buildReadOut } from "@/lib/dashboard-read";
import { businessDayISO } from "@/lib/business-day";

const READ_VERSION = 13;

const FRESH_OPEN_RANGE_MS = 2 * 60 * 60_000;   // period still running
const FRESH_CLOSED_RANGE_MS = 30 * 24 * 60 * 60_000; // period already over

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const start = req.nextUrl.searchParams.get("start") ?? "";
  const end = req.nextUrl.searchParams.get("end") ?? "";
  if (!ISO.test(start) || !ISO.test(end)) {
    return NextResponse.json({ error: "start and end must be YYYY-MM-DD" }, { status: 400 });
  }

  // The BUSINESS day (04:00 Stockholm), not UTC (audit 2026-08-13): every
  // other surface counts days with business-day.ts, and judging "still
  // running" on the UTC date served a 30-day-stale cached read for a range
  // that is genuinely still open around the boundary hours.
  const today = businessDayISO();
  const stillRunning = end >= today;
  const maxAge = stillRunning ? FRESH_OPEN_RANGE_MS : FRESH_CLOSED_RANGE_MS;

  try {
    const { data: cached } = await supabase
      .from("dashboard_reads")
      .select("payload, created_at")
      .eq("start_date", start)
      .eq("end_date", end)
      .maybeSingle();

    const current = cached?.payload?.v === READ_VERSION;
    if (current && Date.now() - new Date(cached!.created_at).getTime() < maxAge) {
      return NextResponse.json({ ...cached!.payload, cached: true });
    }

    const fresh = await buildReadOut(start, end);
    if (!fresh) {
      // Serve a stale read rather than an empty box, but only one written by
      // the current reading. Text the reader has already disowned is worse
      // than no box at all.
      if (current) return NextResponse.json({ ...cached!.payload, cached: true, stale: true });
      return NextResponse.json({ cards: [] });
    }

    const payload = { ...fresh, v: READ_VERSION };
    await supabase
      .from("dashboard_reads")
      .upsert(
        { start_date: start, end_date: end, payload, created_at: new Date().toISOString() },
        { onConflict: "start_date,end_date" }
      );

    return NextResponse.json(payload);
  } catch (e) {
    console.error("[dashboard/read] failed:", e);
    // Never take the dashboard down over the extra box.
    return NextResponse.json({ cards: [] });
  }
}
