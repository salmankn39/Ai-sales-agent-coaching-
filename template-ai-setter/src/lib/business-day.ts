/**
 * THE WORKING DAY: the business timezone, rolling over at 04:00, not midnight.
 *
 * The Python side (intelligence/ghl/dm_tracker.py business_day) and the SQL
 * side (get_dashboard's "- interval '4 hours'" filters) both already count
 * this way, born from a real incident: at 01:22 Tuesday he said "i pitched
 * arabiconly YESTERDAY and i had the call with him TODAY", and by the plain
 * calendar both were Monday. He works past midnight; the calendar is wrong.
 *
 * The web dashboard, HQ pulse, HQ chat and the weekly digest all computed
 * "today" as the raw server-UTC calendar date instead, so for a window every
 * night (roughly 01:00-04:00 Stockholm) the website disagreed with Telegram
 * about what day it is. The 2026-08-12 audit found real DM events sitting in
 * exactly that window. Every date-range entry point now goes through here.
 */

import { businessTimezone } from "./tenant";

// Whose day it is comes from the deployment, not from this file (see
// lib/tenant.ts). Read per call so an env change needs no rebuild.
const TZ = () => businessTimezone();
const DAY_STARTS_AT_HOUR = 4;

const p2 = (n: number) => String(n).padStart(2, "0");
const fromUTC = (d: Date) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;

/** The business day `at` belongs to, as YYYY-MM-DD. */
export function businessDayISO(at: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) parts[p.type] = p.value;
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
  );
  return fromUTC(new Date(wall - DAY_STARTS_AT_HOUR * 3600_000));
}

/** The business day N days before the current one, as YYYY-MM-DD. */
export function businessDayBackISO(daysBack: number, at: Date = new Date()): string {
  const [y, m, d] = businessDayISO(at).split("-").map(Number);
  return fromUTC(new Date(Date.UTC(y, m - 1, d - daysBack)));
}

/** Monday of the current business week, as YYYY-MM-DD. */
export function businessWeekStartISO(at: Date = new Date()): string {
  const [y, m, d] = businessDayISO(at).split("-").map(Number);
  const bd = new Date(Date.UTC(y, m - 1, d));
  const day = bd.getUTCDay();
  const back = day === 0 ? 6 : day - 1;
  return fromUTC(new Date(Date.UTC(y, m - 1, d - back)));
}
