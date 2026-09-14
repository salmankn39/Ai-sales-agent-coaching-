"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { Skin } from "./_skin";

// The switch. Flips the whole product between the Dark (near-black) and Light
// (navy/gold) skins, persists the choice, and broadcasts it to every tab HQ
// loads in an iframe so they change together. Lives fixed in a corner so it is
// reachable from any screen.
export default function SkinToggle() {
  const [skin, setSkin] = useState<Skin>("dark");
  const [ready, setReady] = useState(false);
  const [embedded, setEmbedded] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const cur = (document.documentElement.getAttribute("data-skin") as Skin) || "dark";
    setSkin(cur);
    try { setEmbedded(window.self !== window.top); } catch { setEmbedded(true); }
    setReady(true);
    // If a parent (the HQ shell) flips the skin, reflect it here too.
    const onMsg = (e: MessageEvent) => {
      const n = (e.data && (e.data as { __hqSkin?: Skin }).__hqSkin) as Skin | undefined;
      if (n === "dark" || n === "light") setSkin(n);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const flip = () => {
    const next: Skin = skin === "dark" ? "light" : "dark";
    setSkin(next);
    document.documentElement.setAttribute("data-skin", next);
    try { localStorage.setItem("hq-skin", next); } catch { /* ignore */ }
    // Broadcast to embedded tabs and to a parent shell (if we are embedded).
    try {
      document.querySelectorAll("iframe").forEach((f) => f.contentWindow?.postMessage({ __hqSkin: next }, "*"));
      if (window.parent && window.parent !== window) window.parent.postMessage({ __hqSkin: next }, "*");
    } catch { /* ignore */ }
  };

  // Hidden inside HQ's embedded tabs (the shell's toggle drives them), on the
  // student-facing app (its own bottom tab bar owns that corner), and on the
  // public lead-magnet pages (strangers should never see HQ controls).
  if (!ready || embedded || pathname?.startsWith("/app") || pathname?.startsWith("/audit")
    || pathname?.startsWith("/map") || pathname?.startsWith("/s/")) return null;
  const isDark = skin === "dark";

  return (
    <button onClick={flip} className="skin-toggle" aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}
      title={`Theme: ${isDark ? "Dark" : "Light"} (tap to switch)`}>
      <span className={`st-track ${isDark ? "d" : "l"}`}>
        <span className="st-knob">{isDark ? moon : sun}</span>
      </span>
      <style>{`
        .skin-toggle{ position:fixed; left:16px; bottom:16px; z-index:2147483000;
          background:none; border:none; padding:0; cursor:pointer; -webkit-tap-highlight-color:transparent;
          opacity:0.62; transition:opacity .2s ease; }
        .skin-toggle:hover{ opacity:1; }
        .st-track{ display:inline-flex; align-items:center; width:56px; height:30px; border-radius:999px;
          padding:3px; box-shadow:0 4px 14px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(255,255,255,0.06);
          transition:background .28s var(--ease,ease); }
        .st-track.d{ background:#1c1c1f; justify-content:flex-start; }
        .st-track.l{ background:#20283f; justify-content:flex-end; }
        .st-knob{ width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center;
          background:linear-gradient(180deg,#f0d98a,#d8b24e); color:#1a1406;
          box-shadow:0 2px 6px rgba(0,0,0,0.4); transition:transform .28s var(--ease,ease); }
        .st-knob svg{ width:14px; height:14px; display:block; }
      `}</style>
    </button>
  );
}

const moon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);
const sun = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
