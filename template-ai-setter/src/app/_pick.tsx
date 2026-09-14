"use client";
import { useState } from "react";
import { createPortal } from "react-dom";

/**
 * Pick - the app's dropdown. The owner, 2026-08-07, looking at a native <select>
 * popup over the New-lead card: "this is a good example of something that looks
 * and feels old and ugly, its an ugly ass dropdown. FIX ALLLLLL dropdowns."
 *
 * A native select's POPUP belongs to the OS and cannot be styled, so this
 * replaces the whole control: a button that reads like an input, opening the
 * shared centered pop-card with one row per option - same veil, same spring,
 * same hand as every other dialog. Tap a row, it selects and closes.
 *
 * Shared by the student app and HQ (both load DS_CSS, where veil/pop-card live).
 */

export type PickOption = { value: string; label: string; hint?: string };

export default function Pick({ value, options, onChange, placeholder = "Choose…", title, style, disabled }: {
  value: string;
  options: PickOption[];
  onChange: (value: string) => void;
  /** Shown when nothing is selected. */
  placeholder?: string;
  /** The pop-card's heading; falls back to the placeholder. */
  title?: string;
  /** Extra styles for the closed control (width, flex, font-size...). */
  style?: React.CSSProperties;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  return (
    <>
      <button type="button" disabled={disabled} onClick={() => setOpen(true)} style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
        background: "var(--fill)", border: "1px solid var(--hair)", borderRadius: 10,
        color: current ? "var(--ink)" : "var(--ter)", padding: "9px 12px", fontSize: 13.5,
        fontFamily: "inherit", cursor: "pointer", textAlign: "left", minWidth: 0,
        boxSizing: "border-box", ...style,
      }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {current ? current.label : placeholder}
        </span>
        <span aria-hidden style={{ color: "var(--ter)", fontSize: 10, flex: "0 0 auto" }}>▾</span>
      </button>

      {/* PORTALED to <body> (the owner, 2026-08-07: options clipped top and bottom).
          A parent pop-card's backdrop-filter/transform makes it the containing
          block for fixed descendants, so a Pick opened INSIDE a modal was being
          centered and clipped within that card instead of the screen. The portal
          escapes every ancestor, so the option list always floats over the page. */}
      {open && typeof document !== "undefined" && createPortal(
        <div className="veil" onClick={(e) => { e.stopPropagation(); setOpen(false); }}>
          <div className="pop-card" onClick={(e) => e.stopPropagation()} style={{ padding: 14 }}>
            <div className="pop-title" style={{ marginBottom: 8, padding: "0 6px" }}>
              {title || placeholder}
              <button className="pop-x no-press" aria-label="Close" onClick={() => setOpen(false)}>✕</button>
            </div>
            <div style={{ display: "grid", gap: 2 }}>
              {options.map((o) => {
                const on = o.value === value;
                return (
                  <button key={o.value} type="button"
                    onClick={() => { onChange(o.value); setOpen(false); }}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                      background: on ? "var(--gold-soft)" : "transparent", border: "none",
                      borderRadius: 12, padding: "13px 12px", cursor: "pointer", textAlign: "left",
                      fontFamily: "inherit", width: "100%",
                    }}>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 14.5, fontWeight: on ? 700 : 500,
                        color: on ? "var(--gold)" : "var(--ink)" }}>{o.label}</span>
                      {o.hint && <span style={{ display: "block", fontSize: 11.5, color: "var(--sec)", marginTop: 1 }}>{o.hint}</span>}
                    </span>
                    {on && <span style={{ color: "var(--gold)", fontSize: 14, flex: "0 0 auto" }}>✓</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
