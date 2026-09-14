"use client";

import { useEffect, useRef, useState } from "react";

// ── Money Flow ───────────────────────────────────────────────────────────────
// A PURELY VISUAL strip that animates the pipeline turning into cash. It reads
// numbers the dashboard already computed (passed in as props) — it runs NO
// queries, writes nothing, and changes no logging or tracking. If a value is
// missing it just shows a dash. Safe to remove with zero side-effects.

const GOLD = "var(--gold)";
const GOLD2 = "var(--gold)";
const MUTED = "var(--sec)";

export type FlowNode = {
  label: string;
  value: number | null;
  kind?: "count" | "cash";
};

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const num = (n: number) => Math.round(n).toLocaleString("en-US");

function fmt(node: FlowNode): string {
  if (node.value == null) return "—";
  return node.kind === "cash" ? money(node.value) : num(node.value);
}

// Conversion between two adjacent stages (for the connector caption).
function rate(a: number | null, b: number | null): string | null {
  if (a == null || b == null || !b) return null;
  return `${Math.round((a / b) * 100)}%`;
}

export default function MoneyFlow({ nodes }: { nodes: FlowNode[] }) {
  // Honour reduced-motion: freeze the particles, keep the layout.
  const [animate, setAnimate] = useState(true);
  // Count the cash node up once when it scrolls into view (eye candy only).
  const cashRef = useRef<HTMLDivElement | null>(null);
  const [cashShown, setCashShown] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia) {
      setAnimate(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    }
  }, []);

  const cashTarget = nodes.find((n) => n.kind === "cash")?.value ?? null;
  useEffect(() => {
    if (cashTarget == null) return;
    if (!animate) { setCashShown(cashTarget); return; }
    const el = cashRef.current;
    if (!el || typeof IntersectionObserver === "undefined") { setCashShown(cashTarget); return; }
    let done = false;
    const io = new IntersectionObserver((entries) => {
      if (done || !entries.some((e) => e.isIntersecting)) return;
      done = true;
      io.disconnect();
      const start = performance.now();
      const dur = 1100;
      const tick = (t: number) => {
        const p = Math.min(1, (t - start) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        setCashShown(cashTarget * eased);
        if (p < 1) requestAnimationFrame(tick);
        else setCashShown(cashTarget);
      };
      requestAnimationFrame(tick);
    }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, [cashTarget, animate]);

  return (
    <div className="mf-wrap">
      {nodes.map((node, i) => {
        const isCash = node.kind === "cash";
        const conv = i > 0 ? rate(node.value, nodes[i - 1].value) : null;
        const displayCash = isCash && cashShown != null ? money(cashShown) : null;
        return (
          <div className="mf-seg" key={node.label}>
            {i > 0 && (
              <div className="mf-pipe" aria-hidden>
                <span className="mf-rail" />
                {animate ? (
                  <span className="mf-stream">
                    <span className="mf-orb" style={{ animationDelay: "0s" }} />
                    <span className="mf-orb" style={{ animationDelay: "-0.8s" }} />
                    <span className="mf-orb" style={{ animationDelay: "-1.6s" }} />
                  </span>
                ) : (
                  <span className="mf-orb mf-orb-static" />
                )}
                {conv && <span className="mf-conv">{conv}</span>}
              </div>
            )}
            <div
              className={`mf-node${isCash ? " mf-node-cash" : ""}`}
              ref={isCash ? cashRef : undefined}
            >
              <span className="mf-val">{displayCash ?? fmt(node)}</span>
              <span className="mf-label">{node.label}</span>
            </div>
          </div>
        );
      })}
      <style>{MF_CSS}</style>
    </div>
  );
}

const MF_CSS = `
.mf-wrap{ display:flex; align-items:stretch; flex-wrap:nowrap; gap:0;
  overflow-x:auto; padding:4px 2px 6px; -webkit-overflow-scrolling:touch; }
.mf-seg{ display:flex; align-items:center; flex:1 1 0; min-width:0; }
.mf-node{ flex:0 0 auto; min-width:104px; padding:10px 14px; border-radius:var(--r-md); text-align:center;
  background: transparent; border:none;
  display:flex; flex-direction:column; gap:3px; }
.mf-val{ font-family: var(--font-ui); font-variant-numeric:tabular-nums; font-size:19px; font-weight:700; color:var(--ink); line-height:1.05;
  font-variant-numeric:tabular-nums; white-space:nowrap; }
.mf-label{ font-size:11px; letter-spacing:0; color:${MUTED}; white-space:nowrap; }
.mf-node-cash{ min-width:128px;
  background: var(--gold-soft);
  border-color: color-mix(in srgb, var(--gold) 30%, transparent); }
.mf-node-cash .mf-val{ color:${GOLD2}; font-size:22px; }
.mf-node-cash .mf-label{ color:${GOLD2}; }
/* The pipe is the gap between two boxes: a subtle rail with a small gold dot
   drifting from the left box toward the right one. The ::before/::after mark the
   quiet ports where the pipe meets each box. */
.mf-pipe{ position:relative; flex:1 1 auto; min-width:40px; height:18px; margin:0 6px; overflow:visible; }
.mf-pipe::before, .mf-pipe::after{ content:""; position:absolute; top:50%; width:6px; height:6px;
  transform:translateY(-50%); border-radius:50%; pointer-events:none;
  background: color-mix(in srgb, var(--gold) 45%, transparent); }
.mf-pipe::before{ left:-3px; }
.mf-pipe::after{ right:-3px; }
/* faint base rail so the path reads even between orbs */
.mf-rail{ position:absolute; top:50%; left:0; right:0; height:2px; transform:translateY(-50%); border-radius:2px;
  background:linear-gradient(90deg, transparent, var(--hair) 22%, var(--hair) 78%, transparent); }
.mf-stream{ position:absolute; inset:0; }
/* the travelling money dot */
.mf-orb{ position:absolute; top:50%; left:0; width:7px; height:7px; border-radius:50%;
  transform:translate(-50%,-50%) scale(.2); opacity:0;
  background: var(--gold);
  animation: mfTravel 2.6s cubic-bezier(.5,0,.5,1) infinite; }
.mf-orb-static{ left:50%; opacity:.9; transform:translate(-50%,-50%) scale(1); animation:none; }
.mf-conv{ position:absolute; top:-15px; left:50%; transform:translateX(-50%);
  font-family: var(--font-ui); font-size:11px; font-weight:600; color:${GOLD2}; white-space:nowrap; z-index:2; }
/* born small/dim at the source box -> drifts across -> fades into the next box */
@keyframes mfTravel{
  0%   { left:2%;   opacity:0; transform:translate(-50%,-50%) scale(.4); }
  15%  { opacity:.9;           transform:translate(-50%,-50%) scale(1); }
  50%  { left:50%;  opacity:.9; transform:translate(-50%,-50%) scale(1); }
  85%  { left:96%;  opacity:.9; transform:translate(-50%,-50%) scale(1); }
  100% { left:99%;  opacity:0; transform:translate(-50%,-50%) scale(.4); }
}
@media (prefers-reduced-motion: reduce){
  .mf-orb{ animation:none; } }
`;
