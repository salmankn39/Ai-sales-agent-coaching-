// ─────────────────────────────────────────────────────────────────────────────
// JARVIS HQ — one shared "Apple calm" theme, fully reversible.
//
// Every HQ surface (the shell, the dashboard, students, factory, content
// pipeline, the student app) has its own inline CSS. This file layers ONE warm
// Gold Glass skin on top of all of them at once, from the root layout, so:
//   - it reaches every route, including the tabs HQ loads in iframes;
//   - it is a pure override (keyed on html[data-hq-theme="apple"]), so nothing
//     is deleted - flip HQ_THEME to "classic" (one line) and the whole product
//     snaps back to exactly how it was.
//
// Live escape hatch (no redeploy): add ?hq=v1 to any page URL to preview the
// old look, ?hq=v2 to force the new one. Handled by the tiny script the layout
// injects. "Reverse it" = set HQ_THEME below to "classic".
// ─────────────────────────────────────────────────────────────────────────────

export type HqTheme = "apple" | "classic";

// The master switch. "apple" = the new calm warm-glass look everywhere.
// Set to "classic" to revert the ENTIRE product in one line.
export const HQ_THEME: HqTheme = "apple";

// Reads ?hq=v1 / ?hq=v2 client-side and stamps data-hq-theme on <html> so a
// single URL can preview either look without a deploy. Runs before paint.
export const HQ_THEME_SCRIPT = `(function(){try{
  var q=new URLSearchParams(location.search).get('hq');
  var t=q==='v1'?'classic':q==='v2'?'apple':null;
  if(t)document.documentElement.setAttribute('data-hq-theme',t);
}catch(e){}})();`;

// The skin. Design language = the warm Gold Glass the student tabs use:
//   surfaces  linear-gradient(180deg,#181f36d1,#0d1222d1) + 1px gold border + soft shadow, 20px radius
//   actions   gold pill (980px), warm gradient
//   inputs    calm dark fill, 14px radius
//   motion    subtle; neon glows and HUD textures dialed down to Apple calm
// Signature moments kept loud on purpose: the JARVIS orb + its "SYSTEMS ONLINE".
export const HQ_THEME_CSS = `
:root[data-hq-theme="apple"]{
  --hqg:#c9a84c; --hqg-l:#f0e1aa; --hqg-d:#8b6914;
  --hq-ink:#f5f0e1; --hq-muted:rgba(245,240,225,0.55);
  --hq-surface:linear-gradient(180deg,rgba(24,31,54,0.82),rgba(13,18,34,0.82));
  --hq-surface-2:linear-gradient(180deg,rgba(28,36,62,0.86),rgba(15,20,38,0.86));
  --hq-border:1px solid rgba(201,168,76,0.2);
  --hq-shadow:0 10px 30px rgba(0,0,0,0.36),inset 0 1px 0 rgba(255,255,255,0.05);
  --hq-radius:20px;
  --hq-ease:cubic-bezier(.2,.7,.2,1);
}

/* ---- Calm the HUD atmosphere: drop scanlines + grid texture so screens breathe.
   (The JARVIS orb page keeps its own glow - those elements aren't touched.) ---- */
:root[data-hq-theme="apple"] .hud-main::after,
:root[data-hq-theme="apple"] .hud-main::before{ opacity:0 !important; }

/* ═══ SURFACES: cards / panels across every tab → one warm glass ═══ */
:root[data-hq-theme="apple"] .hud-card,
:root[data-hq-theme="apple"] .glass,
:root[data-hq-theme="apple"] .panel,
:root[data-hq-theme="apple"] .tile,
:root[data-hq-theme="apple"] .fac-card,
:root[data-hq-theme="apple"] .fac-drawer,
:root[data-hq-theme="apple"] .pl-card,
:root[data-hq-theme="apple"] .pl-modal,
:root[data-hq-theme="apple"] .hq-panel,
:root[data-hq-theme="apple"] .hq-holo-card{
  background:var(--hq-surface) !important;
  border:var(--hq-border) !important;
  border-radius:var(--hq-radius) !important;
  box-shadow:var(--hq-shadow) !important;
  backdrop-filter:none !important; -webkit-backdrop-filter:none !important;
}
/* Softer, calmer hover - a small lift, no neon bloom. */
:root[data-hq-theme="apple"] .hud-card:hover,
:root[data-hq-theme="apple"] .fac-card:hover,
:root[data-hq-theme="apple"] .pl-card:hover,
:root[data-hq-theme="apple"] .hq-panel:hover{
  border-color:rgba(201,168,76,0.4) !important;
  box-shadow:0 16px 40px rgba(0,0,0,0.46),inset 0 1px 0 rgba(255,255,255,0.06) !important;
  transform:translateY(-2px) !important;
}

/* Kanban columns: quiet container, not a heavy glowing card. */
:root[data-hq-theme="apple"] .pl-column{
  background:linear-gradient(180deg,rgba(18,24,44,0.5),rgba(10,14,28,0.5)) !important;
  border:1px solid rgba(201,168,76,0.12) !important; border-radius:var(--hq-radius) !important;
  box-shadow:none !important; backdrop-filter:none !important; -webkit-backdrop-filter:none !important;
}
:root[data-hq-theme="apple"] .pl-column::before{ opacity:0 !important; }
/* Kanban cards: tighter radius than full panels so the board stays dense but calm. */
:root[data-hq-theme="apple"] .pl-card{ border-radius:16px !important; }

/* Factory source-health rows: warm surface + rounder, but KEEP the green/red
   status bar on the left edge (only the other three borders are restyled). */
:root[data-hq-theme="apple"] .fac-hrow{
  background:var(--hq-surface) !important; border-radius:16px !important;
  border-top-color:rgba(201,168,76,0.14) !important;
  border-right-color:rgba(201,168,76,0.14) !important;
  border-bottom-color:rgba(201,168,76,0.14) !important;
}
/* Preserve the "picked" opportunity card's green outline. */
:root[data-hq-theme="apple"] .fac-card.picked{ border-color:rgba(143,227,184,0.5) !important; }

/* ═══ TYPE: calmer glows, cleaner hierarchy ═══ */
:root[data-hq-theme="apple"] .metric,
:root[data-hq-theme="apple"] .metric-lg{ text-shadow:none !important; letter-spacing:-0.01em !important; }
:root[data-hq-theme="apple"] .hud-brand{ text-shadow:0 0 1px rgba(201,168,76,0.4) !important; letter-spacing:2px !important; }
:root[data-hq-theme="apple"] .hud-title,
:root[data-hq-theme="apple"] .pl-collabel,
:root[data-hq-theme="apple"] .db-head,
:root[data-hq-theme="apple"] .fac-hrow-name{ color:var(--hqg) !important; }

/* ═══ FUNNEL bars: soften the neon fill ═══ */
:root[data-hq-theme="apple"] .funnel-track,
:root[data-hq-theme="apple"] .bar,
:root[data-hq-theme="apple"] .db-score-bar{
  background:rgba(6,9,18,0.6) !important; border:1px solid rgba(201,168,76,0.14) !important; border-radius:999px !important;
}
:root[data-hq-theme="apple"] .funnel-fill,
:root[data-hq-theme="apple"] .db-score-bar > *{
  background:linear-gradient(90deg,var(--hqg-d),var(--hqg)) !important; box-shadow:none !important; border-radius:999px !important;
}
/* Follow-up sub-rows: quieter, so the main funnel stages lead the eye. */
:root[data-hq-theme="apple"] .funnel-sub{
  background:rgba(201,168,76,0.03) !important; border-left:2px solid rgba(201,168,76,0.18) !important;
  border-radius:0 10px 10px 0 !important;
}

/* ═══ BADGES / CHIPS: calm pills ═══ */
:root[data-hq-theme="apple"] .kpi-badge,
:root[data-hq-theme="apple"] .badge,
:root[data-hq-theme="apple"] .pl-chip,
:root[data-hq-theme="apple"] .chip2{
  border-radius:999px !important; box-shadow:none !important;
  background:rgba(201,168,76,0.08) !important; border:1px solid rgba(201,168,76,0.28) !important;
}

/* ═══ ACTIONS: one gold pill everywhere ═══ */
:root[data-hq-theme="apple"] .btn:not(.ghost),
:root[data-hq-theme="apple"] .b-send,
:root[data-hq-theme="apple"] .pl-btn-go,
:root[data-hq-theme="apple"] .fac-launch,
:root[data-hq-theme="apple"] .hq-go,
:root[data-hq-theme="apple"] .hud-preset.active{
  border-radius:980px !important;
  background:linear-gradient(180deg,#e6cd7a,#c9a84c) !important;
  color:#1a1406 !important; font-weight:800 !important; border:none !important;
  box-shadow:0 6px 18px rgba(201,168,76,0.24) !important;
}
/* Secondary / segmented controls: quiet pills, gold only when active. */
:root[data-hq-theme="apple"] .hud-preset,
:root[data-hq-theme="apple"] .pl-btn,
:root[data-hq-theme="apple"] .tab2,
:root[data-hq-theme="apple"] .pl-lvlbtn,
:root[data-hq-theme="apple"] .hq-tab{
  border-radius:980px !important; box-shadow:none !important;
}
:root[data-hq-theme="apple"] .hq-tab.on,
:root[data-hq-theme="apple"] .tab2.on{
  background:linear-gradient(180deg,#e6cd7a,#c9a84c) !important; color:#1a1406 !important; border-color:transparent !important;
}

/* ═══ INPUTS / SELECTS: calm, 14px ═══ */
:root[data-hq-theme="apple"] .hud-select,
:root[data-hq-theme="apple"] .hud-date,
:root[data-hq-theme="apple"] .pl-input,
:root[data-hq-theme="apple"] .stu-search,
:root[data-hq-theme="apple"] .ta{
  border-radius:14px !important; background:rgba(6,9,18,0.6) !important;
  border:1px solid rgba(201,168,76,0.28) !important; box-shadow:none !important;
  backdrop-filter:none !important; -webkit-backdrop-filter:none !important;
}

/* ═══ FRAMES: the iframe wrappers HQ renders tabs into ═══ */
:root[data-hq-theme="apple"] .hq-frame{ border-radius:22px !important; }

/* ═══ MOTION: keep it subtle app-wide (signature orb/flame excluded) ═══ */
@media (prefers-reduced-motion: no-preference){
  :root[data-hq-theme="apple"] .hud-card,
  :root[data-hq-theme="apple"] .fac-card,
  :root[data-hq-theme="apple"] .pl-card{ transition:transform .24s var(--hq-ease),box-shadow .24s ease,border-color .24s ease !important; }
}
`;
