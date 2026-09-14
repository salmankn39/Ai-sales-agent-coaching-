"use client";
import { useState } from "react";
import { HQ_THEME } from "../_hq-theme";

const GOLD2 = "var(--gold)";
const MUTED = "var(--sec)";
const dash = "—";
const num = (n: number | null | undefined) => (n == null ? dash : Number(n).toLocaleString("en-US"));
const step = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null || !b ? dash : `${Math.round((a / b) * 100)}%`;

export type FunnelRow = { label: string; value: number | null; prev?: number | null; sub?: boolean };

function StageRow({ r, maxV }: { r: FunnelRow; maxV: number }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginBottom: 5 }}>
        <span style={{ color: "var(--sec)" }}>{r.label}</span>
        <span style={{ color: "var(--ink)", fontWeight: 700, fontFamily: "var(--mono)" }}>
          {num(r.value)}
          {r.prev !== undefined && (
            <span style={{ color: GOLD2, fontWeight: 600, marginLeft: 8, fontSize: 12 }}>{step(r.value, r.prev)}</span>
          )}
        </span>
      </div>
      <div className="funnel-track">
        <div className="funnel-fill" style={{ width: `${Math.max(2, (Number(r.value || 0) / maxV) * 100)}%` }} />
      </div>
    </div>
  );
}

function SubRow({ r }: { r: FunnelRow }) {
  return (
    <div className="funnel-sub">
      <span style={{ color: MUTED }}>↳ {r.label}</span>
      <span style={{ fontFamily: "var(--mono)", color: "var(--sec)" }}>{num(r.value)}</span>
    </div>
  );
}

// A funnel: main stages always shown; the indented follow-up sub-rows are the DETAIL.
// Under the "apple" theme they collapse behind a single quiet tap per card, so the
// dashboard leads with the stages that matter (at-a-glance). Reversible via HQ_THEME.
export default function Funnel({ rows }: { rows: FunnelRow[] }) {
  const maxV = Math.max(1, ...rows.filter((r) => !r.sub).map((r) => Number(r.value || 0)));
  const subCount = rows.filter((r) => r.sub).length;
  const [showSubs, setShowSubs] = useState(false);
  const apple = HQ_THEME === "apple";
  const hideSubs = apple && subCount > 0 && !showSubs;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      {rows.map((r, i) => {
        if (r.sub) {
          if (hideSubs) return null;
          return <SubRow key={i} r={r} />;
        }
        return <StageRow key={i} r={r} maxV={maxV} />;
      })}
      {apple && subCount > 0 && (
        <button onClick={() => setShowSubs((s) => !s)}
          style={{
            alignSelf: "flex-start", marginTop: 2, background: "none", border: "none", cursor: "pointer",
            fontFamily: "var(--mono)", fontSize: 11.5, letterSpacing: 0.4, color: GOLD2, padding: "3px 0",
          }}>
          {showSubs ? "Hide follow-ups ▴" : `Show ${subCount} follow-up${subCount > 1 ? "s" : ""} ▾`}
        </button>
      )}
    </div>
  );
}
