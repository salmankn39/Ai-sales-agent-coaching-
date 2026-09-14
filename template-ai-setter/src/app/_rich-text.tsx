"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * RICH TEXT, THE WAY THE OWNER PASTES IT.
 *
 * His shoot scripts and edit briefs come out of Claude as markdown: ## headings,
 * **bold**, bullet lists, numbered lists, --- rules. Copied into a card they used
 * to render as one flat wall - every line the same size, the same color, the
 * literal asterisks still in the text (the owner, 2026-08-13: "there is no difference
 * between a headline and a regular text... I can't read anything"). This renders
 * that text the way it looked in Claude: headings bold and bigger, lists hanging,
 * bold actually bold. Same font throughout, on purpose - hierarchy comes from
 * size, weight and color only.
 *
 * React elements all the way down - no dangerouslySetInnerHTML, so pasted text
 * can never become live HTML.
 *
 * Shared between the HQ pipeline and the student app; both skins define the
 * tokens used here (--ink, --sec, --gold, --hair, --fill). --ter is deliberately
 * never used for text: at 32% opacity it lands near 2.5:1 on these backgrounds.
 */

/** **bold** and `code` inside one line. Everything else passes through as text. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Split on **bold** first; render `code` spans inside the leftovers.
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  parts.forEach((p, i) => {
    if (!p) return;
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) {
      out.push(<b key={`${keyBase}b${i}`} style={{ color: "var(--ink)", fontWeight: 700 }}>{p.slice(2, -2)}</b>);
      return;
    }
    p.split(/(`[^`]+`)/g).forEach((q, j) => {
      if (!q) return;
      if (q.startsWith("`") && q.endsWith("`") && q.length > 2) {
        out.push(
          <span key={`${keyBase}c${i}-${j}`} style={{ background: "var(--fill)", borderRadius: 5, padding: "1px 5px", fontSize: "0.92em" }}>
            {q.slice(1, -1)}
          </span>,
        );
      } else {
        out.push(q);
      }
    });
  });
  return out;
}

/** A heading's visual rank: h1/h2 pasted from Claude land big, h3+ a step down. */
function headStyle(rank: 1 | 2 | 3): React.CSSProperties {
  if (rank === 1) return { fontSize: "1.3em", fontWeight: 800, color: "var(--ink)", letterSpacing: "-0.01em", lineHeight: 1.3, margin: "18px 0 6px" };
  if (rank === 2) return { fontSize: "1.14em", fontWeight: 750, color: "var(--gold)", letterSpacing: "0.01em", lineHeight: 1.35, margin: "16px 0 5px" };
  return { fontSize: "1.04em", fontWeight: 750, color: "var(--ink)", margin: "13px 0 3px" };
}

const BULLET_RE = /^[-*•]\s+(.*)$/;
const NUM_RE = /^(\d{1,3})[.)]\s+(.*)$/;

export function RichBody({ text }: { text: string }) {
  const lines = (text || "").replace(/\r/g, "").replace(/[ \t]+$/gm, "").split("\n");
  const out: ReactNode[] = [];
  let gap = 0; // pending blank lines -> one spacer

  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (!t) { gap++; return; }
    if (gap > 0 && out.length) out.push(<div key={`g${i}`} style={{ height: 12 }} />);
    gap = 0;

    // --- horizontal rule
    if (/^(-{3,}|—{2,}|═{3,}|━{3,})$/.test(t)) {
      out.push(<hr key={i} style={{ border: "none", borderTop: "1px solid var(--hair)", margin: "12px 0" }} />);
      return;
    }
    // # headings (markdown), 1-3+ hashes
    const mHash = t.match(/^(#{1,6})\s+(.*)$/);
    if (mHash) {
      const rank = (Math.min(mHash[1].length, 3)) as 1 | 2 | 3;
      out.push(<div key={i} style={headStyle(rank)}>{inline(mHash[2].replace(/\*\*/g, ""), `h${i}`)}</div>);
      return;
    }
    // A line that is entirely **bold** reads as a heading - Claude often writes
    // section titles that way ("**THE SHOOTING BRIEF**").
    const mAllBold = t.match(/^\*\*([^*].*?)\*\*:?$/);
    if (mAllBold) {
      out.push(<div key={i} style={headStyle(2)}>{mAllBold[1]}</div>);
      return;
    }
    // ALL-CAPS line = a shouted section header (WHAT THIS REEL IS, THE SCRIPT).
    const noLead = t.replace(/^[^\p{L}\p{N}]+/u, "");
    if (noLead.length >= 4 && noLead === noLead.toUpperCase() && /[A-Z]/.test(noLead) && noLead.length <= 80) {
      out.push(<div key={i} style={headStyle(2)}>{t}</div>);
      return;
    }
    // "Label: rest" where the label is short and bold-ish (Set:, Camera:, Delivery -)
    const mLabel = t.match(/^\*{0,2}([A-Z][A-Za-z0-9 /'’-]{1,28}?)\*{0,2}\s*[:—]\s+(.*)$/);
    if (mLabel && !BULLET_RE.test(t) && !NUM_RE.test(t)) {
      out.push(
        <div key={i} style={{ lineHeight: 1.65, margin: "4px 0", color: "var(--ink)" }}>
          <b style={{ color: "var(--gold)", fontWeight: 700 }}>{mLabel[1]}: </b>
          <span>{inline(mLabel[2], `l${i}`)}</span>
        </div>,
      );
      return;
    }
    // - bullets
    const mB = t.match(BULLET_RE);
    if (mB) {
      out.push(
        <div key={i} style={{ display: "flex", gap: 10, margin: "5px 0 5px 2px", lineHeight: 1.65 }}>
          <span style={{ color: "var(--gold)", flex: "0 0 auto" }}>•</span>
          <span style={{ color: "var(--ink)", minWidth: 0 }}>{inline(mB[1], `b${i}`)}</span>
        </div>,
      );
      return;
    }
    // 1. numbered lists
    const mN = t.match(NUM_RE);
    if (mN) {
      out.push(
        <div key={i} style={{ display: "flex", gap: 10, margin: "5px 0 5px 2px", lineHeight: 1.65 }}>
          <span style={{ color: "var(--gold)", fontWeight: 700, flex: "0 0 auto", minWidth: 20, fontVariantNumeric: "tabular-nums" }}>{mN[1]}.</span>
          <span style={{ color: "var(--ink)", minWidth: 0 }}>{inline(mN[2], `n${i}`)}</span>
        </div>,
      );
      return;
    }
    // indented continuation ("   from: ...") - keep it visibly nested and muted
    if (/^\s{2,}/.test(raw)) {
      out.push(
        <div key={i} style={{ color: "var(--sec)", margin: "3px 0 3px 30px", lineHeight: 1.6 }}>
          {inline(t, `i${i}`)}
        </div>,
      );
      return;
    }
    // plain line
    out.push(
      <div key={i} style={{ color: "var(--ink)", lineHeight: 1.65, margin: "4px 0", overflowWrap: "anywhere" }}>
        {inline(t, `p${i}`)}
      </div>,
    );
  });

  return <div>{out}</div>;
}

/**
 * FULLSCREEN READER/EDITOR. The card's little box is for glancing; this is for
 * actually reading a brief or fixing it. Fills the viewport above everything,
 * same formatting as the box, an Edit toggle that swaps in a full-height
 * textarea, Copy, and it leaves on ✕ or Esc. Edits flow back through onChange
 * (the same state the card saves), and onDirty tells the card something changed
 * so it can persist on close.
 */
export function FullscreenText({ title, text, onChange, onClose }: {
  title: string;
  text: string;
  onChange?: (v: string) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    // The page behind must not scroll while reading.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey, true); document.body.style.overflow = prev; };
  }, [onClose]);

  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* clipboard denied - nothing to do */ }
  }

  const btn: React.CSSProperties = {
    border: "1px solid var(--hair)", background: "var(--fill)", color: "var(--ink)", borderRadius: 9,
    padding: "7px 14px", fontSize: 12.5, fontWeight: 650, cursor: "pointer", fontFamily: "inherit",
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 300, background: "var(--bg, #0a0a0c)", display: "flex", flexDirection: "column" }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flex: "0 0 auto",
        padding: "calc(12px + env(safe-area-inset-top, 0px)) 18px 12px", borderBottom: "1px solid var(--hair)",
      }}>
        <div style={{ fontSize: 13, fontWeight: 750, color: "var(--gold)", letterSpacing: "0.04em", textTransform: "uppercase", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </div>
        <div style={{ display: "flex", gap: 8, flex: "0 0 auto" }}>
          <button style={btn} onClick={copy}>{copied ? "Copied ✓" : "Copy"}</button>
          {onChange && (
            <button style={{ ...btn, ...(editing ? { color: "var(--gold)", borderColor: "var(--gold)" } : {}) }} onClick={() => setEditing((v) => !v)}>
              {editing ? "Done ✓" : "✎ Edit"}
            </button>
          )}
          <button aria-label="Close fullscreen" style={{ ...btn, width: 34, padding: 0 }} onClick={onClose}>✕</button>
        </div>
      </div>

      {editing && onChange ? (
        <div style={{ flex: "1 1 auto", display: "flex", justifyContent: "center", minHeight: 0 }}>
          <textarea
            value={text}
            onChange={(e) => onChange(e.target.value)}
            autoFocus
            style={{
              flex: "1 1 auto", maxWidth: 780, height: "100%", resize: "none", border: "none", outline: "none",
              background: "transparent", color: "var(--ink)", fontFamily: "inherit", fontSize: 15, lineHeight: 1.65,
              padding: "22px 24px calc(28px + env(safe-area-inset-bottom, 0px))",
            }}
          />
        </div>
      ) : (
        <div ref={boxRef} style={{ flex: "1 1 auto", overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
          <div style={{ maxWidth: 760, margin: "0 auto", padding: "16px 18px calc(40px + env(safe-area-inset-bottom, 0px))", fontSize: 15 }}>
            {text.trim() ? <RichBody text={text} /> : <div style={{ color: "var(--sec)" }}>Nothing here yet.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
