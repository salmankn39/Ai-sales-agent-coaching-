import { supabase } from "@/lib/supabase";
import { getAccessKey } from "@/lib/prompter/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner-gated AI cost meter: what Claude is costing this month, broken down by action and by student.
// Reads the ai_usage log, which BOTH halves now write on every Claude call: the Python service via
// intelligence/cost.py and this app via lib/ai-usage.ts. Open with ?k=<access key>.
type Row = { action: string; student_id: number | null; model: string; cost_usd: number | string };

// Plain English, because the person reading this page is the one paying the bill and does not
// think in function names. An unlabelled bucket falls through to its raw key rather than being
// hidden, so a new spender shows up here the day it starts spending.
const ACTION_LABELS: Record<string, string> = {
  generate_ideas: "Generate 3 ideas", make_hooks: "Make hooks", screen_hooks: "On-screen hooks",
  interest_peaks: "Interest peaks", cut_script: "Cut script", parse_message: "Read student texts",
  ruling_draft: "Ruling drafts", jarvis: "Jarvis (your chat)", content: "Other content", other: "Other / system",
  // The setter and the rest of the DM machine.
  setter_reply: "Setter replies to leads", dm_screen: "Screening old DMs", screener: "Screening a new lead",
  instant_ack: "Instant acknowledgement", stage_manager: "Tracking lead stage", lead_classify: "Lead or not a lead",
  language_detect: "Detecting language", closer_brief: "Call briefs", media_describe: "Reading images and voice notes",
  dm_intel: "DM intel", story_engine: "Story replies", factory_drafter: "Draft factory",
  // HQ and the student app.
  hq_chat: "Jarvis HQ (your chat)", hq_strategic_read: "HQ strategic read", dashboard_read: "Dashboard read",
  student_agent: "Student assistant", student_report: "Student reports", student_strategy: "Student strategy",
  content_studio: "Content studio", content_edit: "Content edits", content_matcher: "Content matching",
  planner_chat: "Planner chat", audit: "Automation audit", audit_generate: "Audit map",
  audit_interview: "Audit interview",
  // The Telegram bot.
  jarvis_router: "Telegram routing", jarvis_chat: "Telegram chat", setter_agent: "Telegram setter",
  admin_agent: "Telegram admin", capture_agent: "Logging what you tell it", capture_flow: "Capture flows",
  reporting: "Telegram reports",
  // Background intelligence.
  thumbnail_gen: "Thumbnails", demand_engine: "Demand research", icp_comments: "Comment research",
  bootstrap: "Startup key check", unattributed: "Unlabelled (still counted)",
};
const money = (n: number) => `$${n.toFixed(2)}`;

export default async function UsagePage({ searchParams }: { searchParams: Promise<{ k?: string }> }) {
  const sp = await searchParams;
  const accessKey = await getAccessKey();
  if (!accessKey || (sp.k || "") !== accessKey) {
    return <main style={wrap}><div style={{ color: "#c9a84c", fontFamily: "ui-monospace,monospace" }}>ACCESS LOCKED — open from your cockpit.</div></main>;
  }

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [{ data: rowsRaw }, { data: studs }] = await Promise.all([
    supabase.from("ai_usage").select("action,student_id,model,cost_usd").gte("occurred_at", monthStart).limit(200000),
    supabase.from("students").select("id,name"),
  ]);
  const rows = (rowsRaw || []) as Row[];
  const names = new Map<number, string>(((studs || []) as { id: number; name: string | null }[]).map((s) => [s.id, s.name || `#${s.id}`]));

  const num = (v: number | string) => (typeof v === "number" ? v : Number(v) || 0);
  const total = rows.reduce((s, r) => s + num(r.cost_usd), 0);
  const byKey = (key: (r: Row) => string) => {
    const m = new Map<string, { cost: number; n: number }>();
    for (const r of rows) { const k = key(r); const e = m.get(k) || { cost: 0, n: 0 }; e.cost += num(r.cost_usd); e.n += 1; m.set(k, e); }
    return [...m.entries()].sort((a, b) => b[1].cost - a[1].cost);
  };
  const byAction = byKey((r) => r.action || "other");
  const byStudent = byKey((r) => (r.student_id == null ? "—" : names.get(r.student_id) || `#${r.student_id}`));
  const byModel = byKey((r) => r.model || "unknown");
  const monthName = now.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <main style={wrap}>
      <div style={{ fontSize: 11, letterSpacing: 3, color: "#c9a84c", textTransform: "uppercase", fontFamily: "ui-monospace,monospace" }}>Jarvis HQ · AI costs</div>
      <h1 style={{ fontSize: 30, fontWeight: 800, margin: "6px 0 2px" }}>{money(total)} <span style={{ fontSize: 15, color: "#8a8576", fontWeight: 600 }}>this month ({monthName})</span></h1>
      <div style={{ fontSize: 12.5, color: "#8a8576", marginBottom: 18 }}>{rows.length.toLocaleString()} AI calls. Rates are approximate (set in intelligence/cost.py).</div>

      <div style={grid}>
        <Card title="By action">{byAction.map(([k, v]) => <RowLine key={k} label={ACTION_LABELS[k] || k} cost={v.cost} n={v.n} />)}</Card>
        <Card title="By student">{byStudent.map(([k, v]) => <RowLine key={k} label={k} cost={v.cost} n={v.n} />)}</Card>
        <Card title="By model">{byModel.map(([k, v]) => <RowLine key={k} label={k.replace("claude-", "").replace("-20251001", "")} cost={v.cost} n={v.n} />)}</Card>
      </div>
      {rows.length === 0 && <div style={{ color: "#8a8576", marginTop: 20 }}>No AI calls logged yet this month. Numbers appear here as students + the system use Claude.</div>}
    </main>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "linear-gradient(180deg,rgba(13,19,36,0.7),rgba(6,9,18,0.6))", border: "1px solid rgba(201,168,76,0.18)", borderRadius: 14, padding: "14px 16px" }}>
      <div style={{ fontSize: 11, letterSpacing: 1.5, color: "#c9a84c", textTransform: "uppercase", fontFamily: "ui-monospace,monospace", marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}
function RowLine({ label, cost, n }: { label: string; cost: number; n: number }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, padding: "5px 0", borderTop: "1px solid rgba(201,168,76,0.07)" }}>
      <span style={{ color: "#d9d3c0", fontSize: 13.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label} <span style={{ color: "#6b6750", fontSize: 11 }}>· {n}</span></span>
      <span style={{ color: "#f0e1aa", fontFamily: "ui-monospace,monospace", fontWeight: 700, fontSize: 13.5 }}>${cost.toFixed(2)}</span>
    </div>
  );
}

const wrap: React.CSSProperties = {
  minHeight: "100vh", color: "#f5f0e1", padding: "32px clamp(24px,4vw,72px) 80px",
  fontFamily: "-apple-system,'Segoe UI',Roboto,sans-serif",
  background: "radial-gradient(1100px 460px at 50% -8%,rgba(201,168,76,0.10),rgba(10,14,26,0) 60%),#0a0e1a",
};
const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16 };
