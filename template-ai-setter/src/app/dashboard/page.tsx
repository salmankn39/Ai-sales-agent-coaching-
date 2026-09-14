import { supabase } from "@/lib/supabase";
import { businessDayISO, businessWeekStartISO } from "@/lib/business-day";
import Filters from "./filters";
import SalesFunnelSelect from "./sales-funnel-select";
import MoneyFlow from "./money-flow";
import Funnel, { type FunnelRow } from "./_funnel";
import ReadOut from "./ReadOut";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── get_dashboard(p_start, p_end, p_source, p_funnel) jsonb shape ──
type Reason = { reason: string; name: string | null; date: string | null };
type Dashboard = {
  period: { start: string; end: string; source: string; funnel: string };
  outbound: {
    new_followers: number | null; outreaches: number | null; replies: number | null;
    inbound_dms: number | null; conversations_started: number | null;
    followups_outreach: number | null; followups_convo: number | null;
    icp: number | null; qualified: number | null;
    call_pitched: number | null; followups_pitched: number | null;
    booked: number | null; reply_rate: number | null;
    qualified_to_pitched: number | null; pitched_to_booked: number | null;
  };
  inbound: {
    new_leads: number | null; dials: number | null; followups_dials: number | null;
    pickups: number | null; icp: number | null;
    qualified: number | null; call_pitched: number | null; booked: number | null;
    dial_coverage: number | null; dialed_people: number | null; dialable_people: number | null;
    pickup_connect_rate: number | null; pitched_to_booked: number | null;
  };
  sales: {
    booked: number | null; showed: number | null; offer_pitched: number | null; closed: number | null;
    no_shows: number | null; losts: number | null; awaiting_outcome: number | null;
    reschedules: number | null; rescheduled_bookings: number | null; reschedule_rate: number | null;
    calls_reset: number | null;
    avg_call_minutes_on_close: number | null;
    show_rate: number | null; close_rate: number | null; booked_to_close: number | null;
    cash_collected: number | null; revenue_signed: number | null; cash_collected_pct: number | null;
    average_deal_size: number | null; average_first_payment: number | null;
    cash_per_booked_call: number | null; cash_per_outreach: number | null; pif_rate: number | null;
    disputes: number | null; money_lost_to_disputes: number | null; dispute_rate: number | null;
    ai_booked: number | null; ai_booked_pct: number | null;
  };
  // First-set calls vs ones that got moved before they happened. A reschedule
  // is NOT an extra booking, so these two buckets partition `sales.booked`.
  // Whole-business, NOT affected by the date filter. Deliberately outside
  // `sales` so a number that never moves when you change the range does not
  // read as a broken period metric.
  business?: {
    customers: number | null; ltv_cash: number | null;
    ltv_contract: number | null; outstanding: number | null;
  };
  by_reschedule?: Record<string, {
    booked: number | null; moves: number | null; showed: number | null;
    no_shows: number | null; calls_reset: number | null; awaiting_outcome: number | null;
    offer_pitched: number | null; closed: number | null;
    show_rate: number | null; close_rate: number | null;
    revenue_signed: number | null; cash_collected: number | null;
    average_ticket: number | null; cash_collected_pct: number | null;
  }>;
  by_source: { source: string | null; leads: number; booked: number; won: number }[];
  by_partner: { partner: string | null; leads: number; booked: number; won: number }[];
  revenue_by_source: { source: string | null; clients: number; signed: number | null; cash: number | null }[];
  revenue_by_campaign: { campaign: string | null; clients: number; signed: number | null; cash: number | null }[];
  revenue_by_placement: { placement: string | null; clients: number; signed: number | null; cash: number | null }[];
  revenue_by_content: { content: string | null; clients: number; signed: number | null; cash: number | null }[];
  revenue_by_booking_method: { method: string | null; clients: number; signed: number | null; cash: number | null }[];
  by_placement: { placement: string | null; leads: number }[];
  by_campaign: { campaign: string | null; leads: number }[];
  by_content: { content: string | null; leads: number }[];
  by_booking_method: { method: string | null; booked: number }[];
  reasons_no_close: Reason[];
  reasons_no_pitch: Reason[];
  speed: {
    median_reply_seconds: number | null; p90_reply_seconds: number | null;
    slowest_reply_seconds: number | null; replies_measured: number | null;
    median_first_reply_seconds: number | null; leads_gone_quiet: number | null;
    median_days_lead_to_booked: number | null; median_booked_to_call_days: number | null;
    median_sales_cycle_days: number | null;
  };
};

const GOLD = "var(--gold)";
const GOLD2 = "var(--gold)";
const MUTED = "var(--sec)";

// ── period → [start,end], on the owner's 04:00 Stockholm business day, the same
// day rule Telegram's EOD report and get_dashboard itself use. This computed
// raw server-UTC dates before, so the website and Telegram disagreed about
// "today" every night between roughly 01:00 and 04:00 his time.
const pad = (n: number) => String(n).padStart(2, "0");
const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

function computeRange(period: string, sp: { start?: string; end?: string }): { start: string; end: string } {
  const end = businessDayISO();
  if (period === "custom") {
    let s = isDate(sp.start) ? sp.start : `${end.slice(0, 7)}-01`;
    let e = isDate(sp.end) ? sp.end : end;
    if (s > end) s = end; // no future dates
    if (e > end) e = end;
    return s <= e ? { start: s, end: e } : { start: e, end: s };
  }
  if (period === "today") return { start: end, end };
  if (period === "week") return { start: businessWeekStartISO(), end };
  if (period === "year") return { start: `${end.slice(0, 4)}-01-01`, end };
  if (period === "all") return { start: "2000-01-01", end };
  return { start: `${end.slice(0, 7)}-01`, end };
}

// ── formatters ──
const dash = "-";
const money = (n: number | null | undefined) => (n == null ? dash : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }));
const money2 = (n: number | null | undefined) => (n == null ? dash : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const num = (n: number | null | undefined) => (n == null ? dash : Number(n).toLocaleString("en-US"));
const pct = (n: number | null | undefined) => (n == null ? dash : `${Math.round(Number(n))}%`);
const step = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null || !b ? dash : `${Math.round((a / b) * 100)}%`;
const dec = (n: number | null | undefined, digits = 1) => (n == null ? dash : Number(n).toLocaleString("en-US", { maximumFractionDigits: digits }));
const speedFmt = (s: number | null | undefined) => {
  if (s == null) return dash;
  const x = Math.round(Number(s));
  return x < 60 ? `${x}s` : `${Math.floor(x / 60)}m ${x % 60}s`;
};
const daysFmt = (n: number | null | undefined) => {
  if (n == null) return dash;
  const x = Number(n);
  const r = x < 10 ? Math.round(x * 10) / 10 : Math.round(x);
  return `${r} ${r === 1 ? "day" : "days"}`;
};
const dateOnly = (d: string | null) => (d ? d.slice(0, 10) : "");

const METHOD_LABELS: Record<string, string> = { manual_dm: "Manual DM", ai_dm: "AI DM", self_serve: "Self-serve", dialing: "Dialing" };
function methodLabel(m: string | null): string {
  if (!m) return "Unknown";
  if (m === "(none)") return "(none)";
  if (METHOD_LABELS[m]) return METHOD_LABELS[m];
  return m.split(/[_\s]+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

// ── presentational atoms ──
function Card({ titleText, children, delay, headerRight, style, subtitle }: {
  titleText: string; children: React.ReactNode; delay: number;
  headerRight?: React.ReactNode; style?: React.CSSProperties; subtitle?: string;
}) {
  return (
    <section className="hud-card" style={{ animationDelay: `${delay}ms`, ...style }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: subtitle ? 4 : 14 }}>
        <div className="hud-title" style={{ marginBottom: 0 }}>{titleText}</div>
        {headerRight}
      </div>
      {subtitle && <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 13, lineHeight: 1.4 }}>{subtitle}</div>}
      {children}
    </section>
  );
}
function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div>
      <div className={big ? "metric metric-lg" : "metric"}>{value}</div>
      <div className="cap">{label}</div>
    </div>
  );
}

// Funnel (with at-a-glance follow-up collapse) lives in _funnel.tsx as a client
// component so the sub-rows can be tucked behind a tap under the apple theme.
function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <span className="kpi-badge" title={hint}>
      <span className="cap" style={{ marginTop: 0 }}>{label}</span>
      <span className="metric" style={{ fontSize: 16 }}>{value}</span>
    </span>
  );
}

// ── DEMO data: a believable, impressive snapshot built fresh each load ──
function fakeDashboard(start: string, end: string, source: string, funnel: string): Dashboard {
  const R = (a: number, b: number) => a + Math.floor(Math.random() * (b - a));
  const leads = R(420, 680), reps = R(180, 320), icp = R(90, 160), qual = R(48, 90);
  const pitched = R(30, 55), booked = R(22, 40), showed = Math.round(booked * 0.72), closed = Math.round(showed * 0.42);
  const aiBooked = Math.round(booked * 0.64);
  const cash = R(38, 72) * 1000, signed = cash + R(20, 60) * 1000;
  const srcs = ["YouTube", "IG", "Referrals", "Ads", "TikTok"];
  return {
    period: { start, end, source: source || "all sources", funnel },
    outbound: {
      new_followers: R(800, 1600), outreaches: reps + R(120, 260), replies: reps, inbound_dms: R(20, 60), conversations_started: reps + R(20, 60), followups_outreach: R(60, 140),
      followups_convo: R(40, 90), icp, qualified: qual, call_pitched: pitched, followups_pitched: R(10, 30),
      booked, reply_rate: R(38, 62), qualified_to_pitched: R(55, 78), pitched_to_booked: R(60, 82),
    },
    inbound: {
      new_leads: R(120, 260), dials: R(80, 180), followups_dials: R(30, 70), pickups: R(40, 90), icp: R(40, 80),
      qualified: R(30, 60), call_pitched: R(20, 40), booked: R(10, 22), dial_coverage: R(70, 95),
      dialed_people: R(80, 160), dialable_people: R(200, 400),
      pickup_connect_rate: R(35, 60), pitched_to_booked: R(55, 80),
    },
    sales: {
      booked, showed, offer_pitched: showed, closed, no_shows: booked - showed, losts: showed - closed,
      awaiting_outcome: 0, calls_reset: R(2, 8), reschedules: R(4, 14), rescheduled_bookings: R(3, 10), reschedule_rate: R(4, 12),
      avg_call_minutes_on_close: R(34, 52), show_rate: Math.round((showed / booked) * 100),
      close_rate: Math.round((closed / showed) * 100), booked_to_close: Math.round((closed / booked) * 100),
      cash_collected: cash, revenue_signed: signed, cash_collected_pct: Math.round((cash / Math.max(1, signed)) * 1000) / 10,
      average_deal_size: Math.round(signed / Math.max(1, closed)),
      average_first_payment: R(1500, 3200), cash_per_booked_call: Math.round(cash / Math.max(1, booked)),
      cash_per_outreach: Math.round((cash / Math.max(1, reps)) * 100) / 100, pif_rate: R(30, 55),
      disputes: R(0, 2), money_lost_to_disputes: R(0, 1) * 1500, dispute_rate: R(0, 3),
      ai_booked: aiBooked, ai_booked_pct: Math.round((aiBooked / booked) * 100),
    },
    by_source: srcs.map((s) => ({ source: s, leads: R(40, 180), booked: R(3, 14), won: R(1, 6) })),
    by_partner: [{ partner: "Oskar", leads: R(4, 18), booked: R(1, 4), won: R(0, 2) }],
    revenue_by_source: srcs.map((s) => ({ source: s, clients: R(1, 6), signed: R(8, 30) * 1000, cash: R(5, 22) * 1000 })),
    revenue_by_campaign: [{ campaign: "Q2 Push", clients: R(2, 8), signed: R(20, 50) * 1000, cash: R(14, 36) * 1000 }],
    revenue_by_placement: [{ placement: "Reels", clients: R(2, 7), signed: R(16, 44) * 1000, cash: R(10, 30) * 1000 }],
    revenue_by_content: [{ content: "how-to-hit-10k-month", clients: R(1, 4), signed: R(8, 24) * 1000, cash: R(5, 16) * 1000 }],
    revenue_by_booking_method: [
      { method: "ai_dm", clients: R(3, 8), signed: R(24, 52) * 1000, cash: R(16, 38) * 1000 },
      { method: "manual_dm", clients: R(1, 4), signed: R(8, 20) * 1000, cash: R(5, 14) * 1000 },
    ],
    by_placement: [{ placement: "Reels", leads: R(120, 300) }, { placement: "Stories", leads: R(60, 160) }],
    by_campaign: [{ campaign: "Q2 Push", leads: R(150, 380) }],
    by_content: [{ content: "how-to-hit-10k-month", leads: R(20, 60) }, { content: "profile_description", leads: R(30, 90) }],
    by_booking_method: [{ method: "ai_dm", booked: aiBooked }, { method: "manual_dm", booked: booked - aiBooked }],
    reasons_no_close: [{ reason: "Needs to talk to partner", name: "Demo Lead", date: end }],
    reasons_no_pitch: [{ reason: "Not qualified yet", name: "Demo Lead", date: end }],
    speed: {
      median_reply_seconds: R(6, 30), p90_reply_seconds: R(30, 60),
      slowest_reply_seconds: R(60, 400), replies_measured: R(80, 400),
      median_first_reply_seconds: R(8, 45), leads_gone_quiet: R(10, 40),
      median_days_lead_to_booked: R(1, 4), median_booked_to_call_days: R(1, 3), median_sales_cycle_days: R(3, 9),
    },
  };
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; source?: string; start?: string; end?: string; funnel?: string; demo?: string }>;
}) {
  const sp = await searchParams;
  const period = ["today", "week", "month", "year", "all", "custom"].includes(sp.period || "")
    ? (sp.period as string)
    : "month";
  const source = (sp.source || "").trim();
  const funnel = ["all", "outbound", "inbound"].includes(sp.funnel || "") ? (sp.funnel as string) : "all";
  const { start, end } = computeRange(period, sp);

  // DEMO VIEW (?demo=1, driven by Jarvis HQ): fabricated impressive numbers,
  // zero real data — safe to show on a sales call.
  const demoView = sp.demo === "1" || sp.demo === "true";

  // The period's data (4th arg = the Sales block's funnel filter).
  const { data, error } = demoView
    ? { data: fakeDashboard(start, end, source, funnel) as Dashboard, error: null }
    : await supabase.rpc("get_dashboard", {
      p_start: start, p_end: end, p_source: source || null, p_funnel: funnel,
    });

  // Jarvis-booked money — deals whose booking came from the AI setter (all time).
  let aiCash = 0, aiSigned = 0;
  if (demoView) {
    aiCash = 41200; aiSigned = 78500;
  } else {
    const { data: aiDeals } = await supabase.from("customers").select("id, contract_value").eq("booking_method", "ai_dm");
    const aiIds = (aiDeals ?? []).map((c) => c.id);
    if (aiIds.length) {
      const { data: aiPays } = await supabase.from("payments").select("amount").in("customer_id", aiIds);
      aiCash = (aiPays ?? []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    }
    aiSigned = (aiDeals ?? []).reduce((sum, c) => sum + (Number(c.contract_value) || 0), 0);
  }

  // Follow-up engine performance + the leak map (where leads stall in the DMs).
  const FUNNEL_SEQ = ["opener", "transition_main_reason", "goals", "current_situation", "timeline", "problem", "consequence", "consequence_why", "pitch_help", "book"];
  const STAGE_LABELS: Record<string, string> = {
    opener: "Opener", transition_main_reason: "Main reason", goals: "Goals", current_situation: "Situation",
    timeline: "Timeline", problem: "Problem", consequence: "Consequence", consequence_why: "Why not", pitch_help: "Pitch", book: "Booking", post_book: "Post-book", proof: "Proof", nurture: "Nurture",
  };
  let fu = { sent_7d: 0, sent_30d: 0, sent_total: 0, revived_7d: 0, revived_total: 0, rebooked_total: 0 };
  let leak: { funnel_stage: string; stalled: number }[] = [];
  if (demoView) {
    fu = { sent_7d: 34, sent_30d: 121, sent_total: 121, revived_7d: 9, revived_total: 31, rebooked_total: 7 };
    leak = [{ funnel_stage: "problem", stalled: 11 }, { funnel_stage: "pitch_help", stalled: 7 }, { funnel_stage: "goals", stalled: 5 }, { funnel_stage: "book", stalled: 3 }];
  } else {
    const [fuRow, leakRows] = await Promise.all([
      supabase.from("reporting_followups").select("*").maybeSingle(),
      supabase.from("reporting_leak_map").select("*"),
    ]);
    if (fuRow.data) fu = fuRow.data as typeof fu;
    leak = (leakRows.data ?? []) as { funnel_stage: string; stalled: number }[];
  }
  leak = leak.sort((a, b) => FUNNEL_SEQ.indexOf(a.funnel_stage) - FUNNEL_SEQ.indexOf(b.funnel_stage));
  const leakMax = Math.max(1, ...leak.map((l) => l.stalled));

  // Fixed source list (always shown, even at zero leads). "All sources" is the
  // dropdown's built-in default; a selection passes through as p_source as-is.
  const sourceOptions = ["YouTube", "IG", "Referrals", "Affiliates", "Ads",
    "TikTok", "LinkedIn", "X", "Threads", "Facebook"];
  // Keep a non-list source (e.g. from an old URL) visible as the selection.
  if (source && !sourceOptions.includes(source)) sourceOptions.push(source);

  if (error || !data) {
    return (
      <main className="hud-main" style={pageStyle}>
        <div className="hud-card" style={{ maxWidth: 640, margin: "40px auto", color: "var(--red)", animationDelay: "0ms" }}>
          Couldn&apos;t load the dashboard{error ? `: ${error.message}` : "."}
        </div>
        <style>{HUD_CSS}</style>
      </main>
    );
  }

  const d = data as Dashboard;
  const ob = d.outbound;
  const ib = d.inbound;
  const s = d.sales;
  // Derived call-quality gaps (the "didn't happen" side of each step).
  const notPitched = s.showed != null && s.offer_pitched != null ? s.showed - s.offer_pitched : null;
  const notClosed = s.offer_pitched != null && s.closed != null ? s.offer_pitched - s.closed : null;
  const noCalls = !s.showed; // 0 or null → flag that figures are all zero this period

  const outboundRows: FunnelRow[] = [
    { label: "New followers", value: ob.new_followers },
    { label: "Outreaches", value: ob.outreaches, prev: ob.new_followers },
    { label: "Follow-ups on outreaches", value: ob.followups_outreach, sub: true },
    // No percentage against outreaches on purpose: a reply can land on an
    // outreach sent before this window (Haseef replied today to a July DM),
    // so the ratio legitimately exceeds 100% and would read as broken.
    { label: "Replies to outreach", value: ob.replies },
    // They came to HIM: keyword replies, book interest, anyone opening a DM.
    // This is what his content and CTAs pull, which is why it is its own row
    // (the owner, 2026-08-08: an inbound DM is attention, an opt-in is capture,
    // and neither is an outreach).
    { label: "Inbound DMs", value: ob.inbound_dms },
    // The two arrival lanes joining into one number. Mutually exclusive by
    // construction (who sent the thread's first message ever decides which
    // lane a person is in), so this is a true total, never a double count.
    { label: "Conversations started", value: ob.conversations_started },
    { label: "Follow-ups on conversations", value: ob.followups_convo, sub: true },
    { label: "ICP", value: ob.icp, prev: ob.conversations_started },
    { label: "Qualified", value: ob.qualified, prev: ob.icp },
    { label: "Call pitched", value: ob.call_pitched, prev: ob.qualified },
    { label: "Follow-ups on calls pitched", value: ob.followups_pitched, sub: true },
    { label: "Booked", value: ob.booked, prev: ob.call_pitched },
  ];
  const inboundRows: FunnelRow[] = [
    { label: "New leads", value: ib.new_leads },
    { label: "Dials", value: ib.dials, prev: ib.new_leads },
    { label: "Follow-ups on dials", value: ib.followups_dials, sub: true },
    { label: "Pickups", value: ib.pickups, prev: ib.dials },
    { label: "ICP", value: ib.icp, prev: ib.pickups },
    { label: "Qualified", value: ib.qualified, prev: ib.icp },
    { label: "Call pitched", value: ib.call_pitched, prev: ib.qualified },
    { label: "Booked", value: ib.booked, prev: ib.call_pitched },
  ];

  return (
    <main className="hud-main" style={pageStyle}>
      <div style={{ position: "relative", zIndex: 1, maxWidth: 1260, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        {/* HEADER */}
        <header style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <div className="hud-brand">Dashboard</div>
            <div style={{ fontSize: 14, color: MUTED, marginTop: 5 }}>
              {d.period.start} → {d.period.end} · {d.period.source}
            </div>
          </div>
          <Filters period={period} source={source} sources={sourceOptions} start={start} end={end} />
        </header>

        {/* The read-out sits above everything: three things worth attention for
            the dates on screen. Client-side so the numbers below never wait on
            a model call. Demo mode skips it - fabricated numbers deserve no
            analysis. */}
        {!demoView && <ReadOut start={start} end={end} />}

        {/* TWO FUNNELS */}
        <div className="dash-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Card
            titleText="Outbound, IG DMs"
            delay={60}
            headerRight={<Kpi label="Reply rate" value={pct(ob.reply_rate)} />}
          >
            <Funnel rows={outboundRows} />
          </Card>

          <Card
            titleText="Inbound, opt-ins + dials"
            delay={110}
            headerRight={
              <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Kpi
                  label="Dial coverage"
                  value={pct(ib.dial_coverage)}
                  hint={
                    ib.dialed_people != null && ib.dialable_people != null
                      ? `${ib.dialed_people} of ${ib.dialable_people} dialable people reached this period`
                      : undefined
                  }
                />
                <Kpi label="Pickup connect" value={pct(ib.pickup_connect_rate)} />
              </span>
            }
          >
            <Funnel rows={inboundRows} />
          </Card>
        </div>

        {/* MONEY FLOW — purely-visual pipeline → cash strip. Reads numbers
            already computed above; runs no queries, changes no data/logging. */}
        <Card titleText="Money flow, DMs to cash" delay={140}>
          <MoneyFlow nodes={[
            { label: "Outreaches", value: ob.outreaches },
            { label: "Replies", value: ob.replies },
            { label: "Booked", value: s.booked },
            { label: "Closed", value: s.closed },
            { label: "Cash collected", value: s.cash_collected, kind: "cash" },
          ]} />
        </Card>

        {/* FOLLOW-UPS — re-engagement performance + where leads die */}
        <Card titleText="Follow-ups, re-engaging quiet leads" delay={150}
          headerRight={<Kpi label="Sent · 7d" value={num(fu.sent_7d)} />}>
          <div className="dash-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1.25fr", gap: 22 }}>
            <div>
              <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
                <Stat big label="Leads revived" value={num(fu.revived_total)} />
                <Stat big label="Rebooked from follow-ups" value={num(fu.rebooked_total)} />
              </div>
              <div style={{ marginTop: 14, paddingTop: 13, borderTop: "1px solid var(--hair)", display: "flex", gap: 18, flexWrap: "wrap" }}>
                <Stat label="Follow-ups sent · 7d" value={num(fu.sent_7d)} />
                <Stat label="Follow-ups sent · 30d" value={num(fu.sent_30d)} />
                <Stat label="Revived · 7d" value={num(fu.revived_7d)} />
              </div>
            </div>
            <div>
              <span className="cap" style={{ color: GOLD2 }}>Where leads die (stalled 24h+ by stage)</span>
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 7 }}>
                {leak.length === 0 ? (
                  <span style={{ color: MUTED, fontSize: 13 }}>No stalled leads right now.</span>
                ) : leak.map((l) => (
                  <div key={l.funnel_stage} style={{ display: "grid", gridTemplateColumns: "92px 1fr 32px", alignItems: "center", gap: 8, fontSize: 13 }}>
                    <span style={{ color: "var(--sec)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{STAGE_LABELS[l.funnel_stage] || l.funnel_stage}</span>
                    <span className="funnel-track" style={{ height: 8 }}>
                      <span className="funnel-fill" style={{ display: "block", height: "100%", width: `${(l.stalled / leakMax) * 100}%` }} />
                    </span>
                    <span style={{ textAlign: "right", color: "var(--ink)", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{l.stalled}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>

        {/* SALES (full width, own funnel dropdown) */}
        <Card
          titleText={`Sales, ${funnel === "all" ? "all funnels" : funnel}`}
          delay={160}
          headerRight={<SalesFunnelSelect funnel={funnel} />}
        >
          <div className="dash-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1.25fr", gap: 22 }}>
            {/* money */}
            <div>
              <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
                <Stat big label="Cash collected" value={money(s.cash_collected)} />
                <Stat big label="Revenue contracted" value={money(s.revenue_signed)} />
                <Stat label="Collected %" value={pct(s.cash_collected_pct)} />
              </div>
              {/* deal economics */}
              <div style={{ marginTop: 14, paddingTop: 13, borderTop: "1px solid var(--hair)", display: "flex", gap: 18, flexWrap: "wrap" }}>
                <Stat label="Avg deal size" value={money(s.average_deal_size)} />
                <Stat label="Avg first payment" value={money(s.average_first_payment)} />
                <Stat label="PIF rate (paid in full)" value={pct(s.pif_rate)} />
              </div>
              {/* cash efficiency */}
              <div style={{ marginTop: 14, paddingTop: 13, borderTop: "1px solid var(--hair)", display: "flex", gap: 18, flexWrap: "wrap" }}>
                <Stat label="Cash / booked call" value={money(s.cash_per_booked_call)} />
                <Stat label="Cash / outreach" value={money2(s.cash_per_outreach)} />
              </div>
              {/* lifetime value */}
              <div style={{ marginTop: 14, paddingTop: 13, borderTop: "1px solid var(--hair)", display: "flex", gap: 18, flexWrap: "wrap" }}>
                {/* Lifetime figures live in their own labelled row below, not
                    here: inside a date-filtered card they look frozen. */}
              </div>
              <div style={{ marginTop: 14, paddingTop: 13, borderTop: "1px solid var(--hair)", display: "flex", gap: 18, flexWrap: "wrap" }}>
                <Stat label="Disputes" value={num(s.disputes)} />
                <Stat label="Lost to disputes" value={money(s.money_lost_to_disputes)} />
                <Stat label="Dispute rate" value={pct(s.dispute_rate)} />
              </div>
            </div>

            {/* calls */}
            <div>
              {/* Booked by AI — hero metric, per the selected funnel filter */}
              <div className="kpi-badge" style={{ display: "flex", gap: 14, alignItems: "baseline", padding: "12px 16px", marginBottom: 10 }}>
                <span className="cap" style={{ color: GOLD2, marginTop: 0 }}>Booked by Jarvis</span>
                <span className="metric metric-lg" style={{ color: GOLD2 }}>{num(s.ai_booked)}</span>
                <span className="cap" style={{ marginTop: 0 }}>({pct(s.ai_booked_pct)} of bookings)</span>
              </div>
              {/* Jarvis-booked deals that turned into MONEY (all time) */}
              <div className="kpi-badge" style={{ display: "flex", gap: 14, alignItems: "baseline", padding: "12px 16px", marginBottom: 14 }}>
                <span className="cap" style={{ color: GOLD2, marginTop: 0 }}>Jarvis → cash</span>
                <span className="metric metric-lg" style={{ color: GOLD2 }}>{money(aiCash)}</span>
                <span className="cap" style={{ marginTop: 0 }}>collected · {money(aiSigned)} signed · all time</span>
              </div>
              {/* call-quality counts — always shown (0s are real data, not "missing") */}
              <div style={{ display: "flex", gap: 18, rowGap: 14, flexWrap: "wrap" }}>
                <Stat label="Booked" value={num(s.booked)} />
                <Stat label="Showed" value={num(s.showed)} />
                <Stat label="No-shows" value={num(s.no_shows)} />
                <Stat label="Pitched" value={num(s.offer_pitched)} />
                <Stat label="Not pitched" value={num(notPitched)} />
                <Stat label="Closed" value={num(s.closed)} />
                <Stat label="Not closed" value={num(notClosed)} />
                <Stat label="Losts" value={num(s.losts)} />
                {/* The third state of a booked call. Without it the row reads as
                    if calls went missing, when they simply haven't happened (or
                    been logged) yet: booked = showed + no-shows + awaiting. */}
                {/* A reset call is NOT a no-show: the booked call did not
                    happen because it was moved, which is a different and far
                    less damning thing than someone ghosting. Ethan logs these
                    as "Rs". booked = showed + no-shows + reset + awaiting. */}
                <Stat label="Reset / moved" value={num(s.calls_reset)} />
                <Stat label="Awaiting outcome" value={num(s.awaiting_outcome)} />
                {/* A reschedule is the SAME call moved, so it is deliberately
                    not part of `booked`. Shown next to it because "how many of
                    the calls we booked got moved" is the question it answers. */}
                <Stat label="Rescheduled" value={num(s.rescheduled_bookings)} />
              </div>
              <div style={{ marginTop: 13, paddingTop: 12, borderTop: "1px solid var(--hair)", display: "flex", gap: 18, rowGap: 14, flexWrap: "wrap" }}>
                <Stat label="Show rate" value={pct(s.show_rate)} />
                <Stat label="Pitch rate" value={step(s.offer_pitched, s.showed)} />
                <Stat label="Close rate" value={pct(s.close_rate)} />
                <Stat label="Booked → close" value={pct(s.booked_to_close)} />
                <Stat label="Reschedule rate" value={pct(s.reschedule_rate)} />
              </div>
              {noCalls && (
                <div style={{ color: MUTED, fontSize: 12.5, marginTop: 10 }}>
                  No calls have shown up in this period yet, so every figure above is a real zero.
                </div>
              )}
              <div style={{ marginTop: 13, paddingTop: 12, borderTop: "1px solid var(--hair)" }}>
                <Stat label="Avg call length (closes)" value={s.avg_call_minutes_on_close == null ? dash : `${dec(s.avg_call_minutes_on_close)} min`} />
              </div>
              {d.business && (
                <div style={{ marginTop: 13, paddingTop: 12, borderTop: "1px solid var(--hair)" }}>
                  <div className="cap" style={{ marginBottom: 8 }}>
                    All time, whole business (the date filter does not change these)
                  </div>
                  <div style={{ display: "flex", gap: 18, rowGap: 14, flexWrap: "wrap" }}>
                    <Stat label="Customers" value={num(d.business.customers)} />
                    <Stat label="Avg LTV / customer (cash)" value={money(d.business.ltv_cash)} />
                    <Stat label="Avg LTV / customer (contract)" value={money(d.business.ltv_contract)} />
                    <Stat label="Outstanding (contracted − collected)" value={money(d.business.outstanding)} />
                  </div>
                </div>
              )}
                            {/* FIRST SET vs RESCHEDULED. The question this answers is whether
                  a call that got moved performs worse than one held as first
                  set, so both columns sit side by side rather than behind a
                  filter. The two buckets partition `booked` exactly. */}
              {d.by_reschedule && (
                <div style={{ marginTop: 13, paddingTop: 12, borderTop: "1px solid var(--hair)" }}>
                  <div className="cap" style={{ marginBottom: 8 }}>First set vs rescheduled</div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", fontSize: 12.5, minWidth: 480 }}>
                      <thead>
                        <tr style={{ color: MUTED, textAlign: "left" }}>
                          {["", "Booked", "Moves", "Showed", "No show", "Reset", "Awaiting", "Show rate", "Closed", "Cash"].map((h) => (
                            <th key={h} style={{ padding: "4px 12px 6px 0", fontWeight: 500 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(["first_set", "rescheduled"] as const).map((k) => {
                          const r = d.by_reschedule?.[k];
                          if (!r) return null;
                          return (
                            <tr key={k} style={{ borderTop: "1px solid var(--hair)" }}>
                              <td style={{ padding: "6px 12px 6px 0" }}>{k === "first_set" ? "First set" : "Rescheduled"}</td>
                              <td style={{ padding: "6px 12px 6px 0" }}>{num(r.booked)}</td>
                              <td style={{ padding: "6px 12px 6px 0" }}>{num(r.moves)}</td>
                              <td style={{ padding: "6px 12px 6px 0" }}>{num(r.showed)}</td>
                              <td style={{ padding: "6px 12px 6px 0" }}>{num(r.no_shows)}</td>
                              <td style={{ padding: "6px 12px 6px 0" }}>{num(r.calls_reset)}</td>
                              <td style={{ padding: "6px 12px 6px 0" }}>{num(r.awaiting_outcome)}</td>
                              <td style={{ padding: "6px 12px 6px 0" }}>{pct(r.show_rate)}</td>
                              <td style={{ padding: "6px 12px 6px 0" }}>{num(r.closed)}</td>
                              <td style={{ padding: "6px 12px 6px 0" }}>{money(r.cash_collected)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ color: MUTED, fontSize: 12, marginTop: 8 }}>
                    Cash here needs the customer linked to their lead when a deal closes; where
                    that link is missing the money shows against no booking at all.
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>

        {/* BREAKDOWNS — lead acquisition (counts of people, from tracked leads).
            Ordered as the actual drill-down: source (platform) → placement
            (where on it) → campaign (which offer) → content (which specific
            video/post/story). Booking method is a separate dimension (how the
            call got on the calendar, not how the lead arrived), kept last. */}
        <div style={grid(6)}>
          <Card titleText="By source" delay={220}
            subtitle="Leads we tracked, by where they came from. Counts of people, not money.">
            <Table head={["Source", "Leads", "Booked", "Won"]} align={["l", "r", "r", "r"]}
              rows={[...d.by_source].sort((a, b) => b.leads - a.leads).map((x) => [x.source ?? "Unknown", num(x.leads), num(x.booked), num(x.won)])} />
          </Card>
          <Card titleText="By placement" delay={260}>
            <Table head={["Placement", "Leads"]} align={["l", "r"]}
              rows={[...d.by_placement].sort((a, b) => b.leads - a.leads).map((x) => [x.placement ?? "Unknown", num(x.leads)])} />
          </Card>
          <Card titleText="By campaign" delay={300}>
            <Table head={["Campaign", "Leads"]} align={["l", "r"]}
              rows={[...d.by_campaign].sort((a, b) => b.leads - a.leads).map((x) => [x.campaign ?? "Unknown", num(x.leads)])} />
          </Card>
          <Card titleText="By content" delay={320}
            subtitle="Which specific video/post/story, not the campaign.">
            <Table head={["Content", "Leads"]} align={["l", "r"]}
              rows={[...d.by_content].sort((a, b) => b.leads - a.leads).map((x) => [x.content ?? "Unknown", num(x.leads)])} />
          </Card>
          <Card titleText="By partner" delay={330}
            subtitle="Affiliates and students who sent traffic. Kept off the source list so a person can never look like a platform.">
            <Table head={["Partner", "Leads", "Booked", "Won"]} align={["l", "r", "r", "r"]}
              empty="No partner traffic this period."
              rows={[...(d.by_partner ?? [])].sort((a, b) => b.leads - a.leads)
                .map((x) => [x.partner ?? "Unknown", num(x.leads), num(x.booked), num(x.won)])} />
          </Card>
          <Card titleText="By booking method" delay={340}>
            <Table head={["Method", "Booked"]} align={["l", "r"]}
              rows={[...d.by_booking_method].sort((a, b) => b.booked - a.booked).map((x) => [methodLabel(x.method), num(x.booked)])} />
          </Card>
        </div>

        {/* REVENUE BREAKDOWNS — money (clients closed + $, from the customer records).
            2-up so the wide $ figures never overflow the card. */}
        <div style={grid(2)}>
          <Card titleText="Revenue by source" delay={360}
            subtitle="Paying clients and their money, by source. Signed = total deal value · Cash = collected so far.">
            <Table head={["Source", "Clients", "Signed", "Cash"]} align={["l", "r", "r", "r"]} empty={dash}
              rows={[...(d.revenue_by_source ?? [])].sort((a, b) => Number(b.cash || 0) - Number(a.cash || 0))
                .map((x) => [x.source ?? "Unknown", num(x.clients), money(x.signed), money(x.cash)])} />
          </Card>
          <Card titleText="Revenue by campaign" delay={380}
            subtitle="Paying clients and their money, by campaign.">
            <Table head={["Campaign", "Clients", "Signed", "Cash"]} align={["l", "r", "r", "r"]} empty={dash}
              rows={[...(d.revenue_by_campaign ?? [])].sort((a, b) => Number(b.cash || 0) - Number(a.cash || 0))
                .map((x) => [x.campaign ?? "Unknown", num(x.clients), money(x.signed), money(x.cash)])} />
          </Card>
          <Card titleText="Revenue by placement" delay={400}
            subtitle="Paying clients and their money, by placement.">
            <Table head={["Placement", "Clients", "Signed", "Cash"]} align={["l", "r", "r", "r"]} empty={dash}
              rows={[...(d.revenue_by_placement ?? [])].sort((a, b) => Number(b.cash || 0) - Number(a.cash || 0))
                .map((x) => [x.placement ?? "Unknown", num(x.clients), money(x.signed), money(x.cash)])} />
          </Card>
          <Card titleText="Revenue by content" delay={410}
            subtitle="Paying clients and their money, by which specific video/post/story.">
            <Table head={["Content", "Clients", "Signed", "Cash"]} align={["l", "r", "r", "r"]} empty={dash}
              rows={[...(d.revenue_by_content ?? [])].sort((a, b) => Number(b.cash || 0) - Number(a.cash || 0))
                .map((x) => [x.content ?? "Unknown", num(x.clients), money(x.signed), money(x.cash)])} />
          </Card>
          <Card titleText="Revenue by booking method" delay={420}
            subtitle="Paying clients and their money, by how the call was booked.">
            <Table head={["Method", "Clients", "Signed", "Cash"]} align={["l", "r", "r", "r"]} empty={dash}
              rows={[...(d.revenue_by_booking_method ?? [])].sort((a, b) => Number(b.cash || 0) - Number(a.cash || 0))
                .map((x) => [methodLabel(x.method), num(x.clients), money(x.signed), money(x.cash)])} />
          </Card>
        </div>

        {/* SPEED */}
        <Card titleText="Speed" delay={380}
          subtitle="How fast leads move through the machine. Reply speed counts EVERY reply, timed from the lead's last message until the FULL reply (all bubbles) is confirmed delivered.">
          <div style={{ display: "flex", gap: 26, rowGap: 16, flexWrap: "wrap" }}>
            <Stat
              label={`Reply speed, typical${d.speed.replies_measured ? ` (${num(d.speed.replies_measured)} replies)` : ""}`}
              value={speedFmt(d.speed.median_reply_seconds)}
            />
            <Stat label="Reply speed, slowest 10%" value={speedFmt(d.speed.p90_reply_seconds)} />
            <Stat label="Slowest single reply" value={speedFmt(d.speed.slowest_reply_seconds)} />
            <Stat label="First reply only" value={speedFmt(d.speed.median_first_reply_seconds)} />
            <Stat label="Lead → booked" value={daysFmt(d.speed.median_days_lead_to_booked)} />
            <Stat label="Booked → call" value={daysFmt(d.speed.median_booked_to_call_days)} />
            <Stat label="Sales cycle (1st contact → close)" value={daysFmt(d.speed.median_sales_cycle_days)} />
            <Stat label="Leads gone quiet" value={num(d.speed.leads_gone_quiet)} />
          </div>
        </Card>

        {/* REASONS */}
        <div style={grid(2)}>
          <Card titleText="Why calls aren't closing" delay={420}><Reasons rows={d.reasons_no_close} /></Card>
          <Card titleText="Why leads weren't pitched" delay={460}><Reasons rows={d.reasons_no_pitch} /></Card>
        </div>

        <div style={{ textAlign: "center", color: "var(--ter)", fontSize: 12, padding: "6px 0 28px", letterSpacing: 0 }}>
          All figures from get_dashboard · read-only
        </div>
      </div>

      <style>{HUD_CSS}</style>
    </main>
  );
}

// Capped so a table with a growing number of rows (more campaigns, more
// content slugs over time) scrolls internally instead of stretching the card
// — and every card in the same grid row — taller with every new row.
const TABLE_MAX_HEIGHT = 280;

function Table({ head, rows, align, empty = "No data this period." }: {
  head: string[]; rows: (string | number)[][]; align: ("l" | "r")[]; empty?: string;
}) {
  return (
    <div className="hud-table-scroll" style={{ maxHeight: TABLE_MAX_HEIGHT, overflowY: "auto", overflowX: "hidden" }}>
      <table className="hud-table" style={{ tableLayout: "fixed", width: "100%" }}>
        <thead>
          <tr>{head.map((h, i) => <th key={h} style={{ textAlign: align[i] === "r" ? "right" : "left", position: "sticky", top: 0, background: "var(--card)" }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={head.length}><span style={{ color: MUTED }}>{empty}</span></td></tr>
          ) : (
            rows.map((row, ri) => (
              <tr key={ri}>{row.map((c, ci) => <td key={ci} style={{ textAlign: align[ci] === "r" ? "right" : "left", fontFamily: ci === 0 ? undefined : "var(--mono)", wordBreak: "break-word", overflowWrap: "break-word" }}>{c}</td>)}</tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Reasons({ rows }: { rows: { reason: string; name: string | null; date: string | null }[] }) {
  if (!rows || rows.length === 0) return <div style={{ color: MUTED }}>{dash}</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {rows.map((row, i) => (
        <div key={i} style={{ borderLeft: `2px solid ${GOLD}`, paddingLeft: 10 }}>
          <div style={{ fontSize: 14, color: "var(--ink)" }}>{row.reason}</div>
          <div style={{ fontSize: 12, color: MUTED }}>{(row.name || "Unknown") + (row.date ? ` · ${dateOnly(row.date)}` : "")}</div>
        </div>
      ))}
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  color: "var(--ink)",
  fontFamily: "var(--font-ui)",
  padding: "26px 22px",
  position: "relative",
};
function grid(cols: number): React.CSSProperties {
  return { display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`, gap: 16 };
}

// ── Dashboard theme — token-driven, both skins. Clean cards, no neon/scanlines. ──
const HUD_CSS = `
:root{ --mono: var(--font-ui); }  /* figures use SF Pro + tabular-nums, not a coding font (Apple: Wallet/Stocks/Numbers) */
.hud-main{ background: var(--bg); }
.hud-brand{
  font-family: var(--font-ui); font-size: 30px; font-weight: 700; letter-spacing: -0.02em;
  color: var(--ink); line-height: 1.08;
}
.hud-card{
  position: relative;
  background: var(--card);
  border-radius: var(--r-card);
  padding: var(--pad-card);
  box-shadow: var(--shadow);
  border: none;
  opacity: 0; transform: translateY(10px);
  animation: hudIn .5s var(--ease) forwards;
  transition: transform .25s var(--ease), box-shadow .25s var(--ease), background .25s ease;
}
@media (hover: hover){ .hud-card:hover{ transform: translateY(-2px); box-shadow: var(--shadow-lg); } }
@keyframes hudIn{ to{ opacity:1; transform:none; } }
.hud-title{ font-size:13px; font-weight:560; letter-spacing:0; color:var(--sec); margin-bottom:14px; }
.cap{ font-size:11.5px; letter-spacing:0; color:var(--sec); margin-top:4px; }
.metric{ font-family: var(--mono); font-size:18px; font-weight:700; color:var(--ink); line-height:1.08; font-variant-numeric:tabular-nums; }
.metric-lg{ font-size:30px; font-weight:730; letter-spacing:-0.02em; }
.funnel-track{ height:8px; background:var(--fill); border-radius:var(--r-pill); overflow:hidden; }
.funnel-fill{ height:100%; border-radius:var(--r-pill); background:linear-gradient(90deg, color-mix(in srgb, var(--gold) 70%, #000), var(--gold)); }
.funnel-sub{ display:flex; justify-content:space-between; align-items:center; font-size:12.5px;
  margin: -2px 0 0 18px; padding: 5px 12px; border-left: 2px solid var(--hair);
  background: var(--fill); border-radius: 0 var(--r-sm) var(--r-sm) 0; }
.kpi-badge{ display:inline-flex; align-items:center; gap:10px; padding:6px 12px; border-radius:var(--r-pill);
  background: var(--fill); border:1px solid var(--hair); }
.hud-table{ width:100%; border-collapse:collapse; font-size:13px; }
.hud-table th{ padding:6px 8px; font-weight:560; color:var(--sec); border-bottom:1px solid var(--hair); letter-spacing:0; font-size:11.5px; }
.hud-table td{ padding:7px 8px; border-bottom:1px solid var(--hair); color:var(--ink); font-variant-numeric:tabular-nums; }
.hud-table tr:hover td{ background: var(--fill); }
/* Scrolls (vertically only) once a breakdown table outgrows TABLE_MAX_HEIGHT,
   with the scrollbar itself hidden — wheel/trackpad scroll still works. */
.hud-table-scroll{ scrollbar-width:none; -ms-overflow-style:none; }
.hud-table-scroll::-webkit-scrollbar{ display:none; width:0; height:0; }
.hud-preset{ font-family: var(--font-ui); padding:8px 15px; font-size:13px; font-weight:540; border-radius:var(--r-pill); cursor:pointer; white-space:nowrap;
  border:1px solid var(--hair); background: var(--fill); color:var(--sec); transition: all .18s ease; }
.hud-preset:hover{ background: var(--fill-2); color:var(--ink); }
.hud-preset.active{ border-color:transparent; background: var(--gold); color:var(--gold-ink); font-weight:700; }
.hud-preset:disabled{ opacity:.45; cursor:not-allowed; }
.hud-date, .hud-select{ font-family: var(--font-ui); padding:8px 12px; font-size:13px; border-radius:var(--r-sm); color:var(--ink); color-scheme:dark;
  border:1px solid var(--hair); background: var(--fill); }
.hud-date:focus, .hud-select:focus{ outline:none; border-color: color-mix(in srgb, var(--gold) 55%, transparent); }
@media (max-width: 920px){ .dash-2col{ grid-template-columns:1fr !important; } }
@media (prefers-reduced-motion: reduce){ .hud-card{ animation:none; opacity:1; transform:none; } }
`;
