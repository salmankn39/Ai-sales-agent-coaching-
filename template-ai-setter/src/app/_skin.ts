// ─────────────────────────────────────────────────────────────────────────────
// TWO-SKIN DESIGN SYSTEM
//
// One Apple-grade design (layout, spacing, type, motion, feel) with two
// interchangeable COLOR skins that the user flips with a switch:
//   - "dark"  : the near-black, iOS-dark look (default)
//   - "light" : the current navy + gold palette
//
// Everything is driven by CSS custom properties, so flipping data-skin on <html>
// re-colors the whole product instantly, structure untouched. The skin persists
// in localStorage and syncs live across the tabs HQ loads in iframes.
//
// New surfaces are built against these tokens (var(--bg), var(--card), ...).
// The master HQ_THEME switch in _hq-theme.ts still reverts the entire redesign.
// ─────────────────────────────────────────────────────────────────────────────

export type Skin = "dark" | "light";
export const DEFAULT_SKIN: Skin = "dark";

// Shared structure tokens + both color palettes. Injected once from the root layout.
export const SKIN_CSS = `
:root{
  /* structure - identical across skins */
  --font-ui:-apple-system,'SF Pro Display','SF Pro Text','Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
  --r-lg:22px; --r-card:20px; --r-md:16px; --r-sm:14px; --r-pill:980px;
  --ease:cubic-bezier(.2,.7,.2,1); --dur:.24s;
  --pad-card:18px; --gap:12px;
}

/* ── DARK: near-black, iOS dark mode ── */
:root[data-skin="dark"]{
  --bg:#0a0a0c; --bg-2:#0f0f12;
  --card:#161618; --card-2:#1c1c1f; --card-hover:#1e1e21;
  --ink:#f5f5f7; --sec:rgba(235,235,245,0.58); --ter:rgba(235,235,245,0.32);
  --hair:rgba(255,255,255,0.07); --fill:rgba(235,235,245,0.06); --fill-2:rgba(235,235,245,0.10);
  --gold:#e6c25a; --gold-soft:rgba(230,194,90,0.14); --gold-ink:#1a1406;
  --green:#32d74b; --red:#ff453a; --amber:#ffd60a; --blue:#0a84ff; --violet:#bf5af2;
  --shadow:0 6px 20px rgba(0,0,0,0.4); --shadow-lg:0 18px 46px rgba(0,0,0,0.55);
}

/* ── LIGHT: the current navy + gold palette ── */
:root[data-skin="light"]{
  --bg:#0b1020; --bg-2:#0e1426;
  --card:#141b30; --card-2:#1a2138; --card-hover:#1d2540;
  --ink:#f5f0e1; --sec:rgba(245,240,225,0.6); --ter:rgba(245,240,225,0.34);
  --hair:rgba(201,168,76,0.16); --fill:rgba(201,168,76,0.08); --fill-2:rgba(201,168,76,0.14);
  --gold:#d8b862; --gold-soft:rgba(216,184,98,0.16); --gold-ink:#1a1406;
  --green:#6fcf97; --red:#ff9d97; --amber:#e0b25a; --blue:#7db3ff; --violet:#c98af0;
  --shadow:0 10px 30px rgba(0,0,0,0.42); --shadow-lg:0 22px 52px rgba(0,0,0,0.6);
}

/* Surfaces built on the system fade smoothly when the skin flips. */
.skinned, .skinned *{ transition:background-color var(--dur) var(--ease), border-color var(--dur) var(--ease), color var(--dur) var(--ease); }
`;

// Pre-paint: apply the saved skin before first paint (no flash) and keep tabs
// (iframes) in sync via postMessage. Sits alongside the HQ_THEME script.
export const SKIN_SCRIPT = `(function(){
  function set(s){ if(s!=='dark'&&s!=='light')return; document.documentElement.setAttribute('data-skin',s);
    try{localStorage.setItem('hq-skin',s);}catch(e){} }
  var s='dark'; try{ var v=localStorage.getItem('hq-skin'); if(v==='light'||v==='dark')s=v; }catch(e){}
  document.documentElement.setAttribute('data-skin',s);
  window.addEventListener('message',function(e){ if(e&&e.data&&e.data.__hqSkin){
    var n=e.data.__hqSkin; if(n===document.documentElement.getAttribute('data-skin'))return; set(n);
    /* relay down to any nested frames so every tab stays in sync */
    try{ var f=document.querySelectorAll('iframe'); for(var i=0;i<f.length;i++){ if(f[i].contentWindow) f[i].contentWindow.postMessage({__hqSkin:n},'*'); } }catch(_){}
  }});
})();`;

// ─────────────────────────────────────────────────────────────────────────────
// SHARED APPLE COMPONENTS
// A small, token-driven component library so every rebuilt tab uses the SAME
// building blocks (title, card, list group, chip, button, segmented control,
// status dot, big stat). All colour comes from the skin vars, so both skins and
// the toggle work everywhere for free. Prefixed .x- to never clash with the
// surfaces' legacy classes during the rebuild.
// ─────────────────────────────────────────────────────────────────────────────
export const DS_CSS = `
/* Native form controls follow the skin. A <select>'s POPUP belongs to the OS
   and can't be styled (use the Pick component for those), but color-scheme at
   least stops it rendering as a white 2004 menu over a dark app. */
[data-skin="dark"]{ color-scheme:dark; }
[data-skin="light"]{ color-scheme:light; }

.x-app{ background:var(--bg); color:var(--ink); font-family:var(--font-ui); -webkit-font-smoothing:antialiased; min-height:100vh; }

/* No text ever escapes its box (the owner, 2026-08-07: "I don't want any text to be
   outside of the boxes"). Long handles, URLs and pasted strings wrap instead of
   punching through card edges, everywhere, both apps. */
.card, .glass, .pop-card, .x-card, .x-group, .tile, .panel { overflow-wrap: break-word; }

/* iOS large title */
.x-kicker{ font-size:13px; font-weight:590; color:var(--gold); letter-spacing:0; }
.x-title{ font-size:30px; font-weight:700; letter-spacing:-0.021em; color:var(--ink); margin-top:3px; line-height:1.08; }
.x-sub{ font-size:15px; color:var(--sec); margin-top:5px; }
.x-seclabel{ font-size:13px; font-weight:590; color:var(--sec); margin:26px 2px 10px; }

/* clean card - one subtle surface, soft shadow, NO hard border, NO double box */
.x-card{ background:var(--card); border-radius:var(--r-card); padding:var(--pad-card); box-shadow:var(--shadow); border:none; }
.x-card.tap{ cursor:pointer; transition:transform var(--dur) var(--ease), background var(--dur) ease, box-shadow var(--dur) ease; }
@media(hover:hover){ .x-card.tap:hover{ transform:translateY(-2px); background:var(--card-hover); box-shadow:var(--shadow-lg); } }

/* iOS inset grouped list */
.x-group{ background:var(--card); border-radius:var(--r-md); overflow:hidden; }
.x-row{ display:flex; align-items:center; gap:12px; padding:14px 16px; }
.x-row + .x-row{ border-top:1px solid var(--hair); }
.x-row-name{ font-size:15px; font-weight:560; color:var(--ink); }
.x-row-sub{ font-size:12.5px; color:var(--sec); margin-top:1px; }
.x-row-r{ margin-left:auto; font-size:13px; color:var(--sec); display:flex; align-items:center; gap:8px; }
.x-chev{ color:var(--ter); font-size:16px; }

/* status dot */
.x-dot{ width:8px; height:8px; border-radius:50%; flex:0 0 auto; background:var(--ter); }
.x-dot.ok{ background:var(--green); } .x-dot.down{ background:var(--red); } .x-dot.warn{ background:var(--amber); } .x-dot.info{ background:var(--blue); }

/* chip / pill */
.x-chip{ display:inline-flex; align-items:center; gap:5px; font-size:11.5px; font-weight:520; color:var(--sec);
  background:var(--fill); border:1px solid var(--hair); border-radius:var(--r-pill); padding:5px 10px; white-space:nowrap; }
.x-chip.gold{ color:var(--gold); background:var(--gold-soft); border-color:transparent; }

/* buttons */
.x-btn{ font-family:var(--font-ui); font-size:13px; font-weight:540; color:var(--ink); background:var(--fill);
  border:1px solid var(--hair); border-radius:var(--r-pill); padding:9px 16px; cursor:pointer; transition:.18s; }
.x-btn:hover{ background:var(--fill-2); }
.x-btn.primary{ background:var(--gold); color:var(--gold-ink); font-weight:700; border-color:transparent; box-shadow:0 6px 18px var(--gold-soft); }
.x-btn.primary:hover{ filter:brightness(1.05); }

/* segmented control (iOS) */
.x-seg{ display:inline-flex; gap:3px; padding:3px; border-radius:12px; background:var(--fill); border:1px solid var(--hair); }
.x-segbtn{ background:transparent; border:none; color:var(--sec); cursor:pointer; font-size:13.5px; font-weight:560; padding:7px 15px; border-radius:9px; transition:.2s; }
.x-segbtn:hover{ color:var(--ink); }
.x-segbtn.on{ color:var(--ink); background:var(--card-2); box-shadow:0 1px 3px rgba(0,0,0,0.35); }

/* inputs */
.x-input{ width:100%; box-sizing:border-box; background:var(--fill); border:1px solid var(--hair); border-radius:var(--r-sm);
  color:var(--ink); font-family:var(--font-ui); font-size:14.5px; padding:11px 13px; outline:none; transition:border-color .15s; }
.x-input:focus{ border-color:color-mix(in srgb,var(--gold) 55%,transparent); }
.x-input::placeholder{ color:var(--ter); }

/* big stat number */
.x-num{ font-size:30px; font-weight:730; color:var(--ink); letter-spacing:-0.02em; font-variant-numeric:tabular-nums; line-height:1; }
.x-num.gold{ color:var(--gold); }
.x-numlabel{ font-size:11px; color:var(--sec); margin-top:4px; }

/* thin progress track */
.x-track{ height:7px; background:var(--fill); border-radius:var(--r-pill); overflow:hidden; }
.x-fill{ height:100%; border-radius:var(--r-pill); background:linear-gradient(90deg,color-mix(in srgb,var(--gold) 70%,#000),var(--gold)); }

/* ── THE centered card modal (the owner, 2026-08-07: "a pop up in the middle of the
   screen... a card appears... imagine if Netflix and iOS and Apple made this").
   Defined HERE, at the root, so the student app and every HQ surface share ONE
   modal language - not the three incompatible hand-rolled ones this replaces
   (.pl-modal, .fac-drawer, and app-layout's local copy). Blurred veil, one
   rounded card, calm quick spring (the "calm and quick" motion ruling). ─────── */
@keyframes veilIn{from{opacity:0}to{opacity:1}}
@keyframes popIn{from{opacity:0;transform:scale(.92) translateY(12px)}to{opacity:1;transform:none}}
.veil{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.55);
  backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);
  display:flex;align-items:center;justify-content:center;
  padding:18px calc(18px + env(safe-area-inset-right,0px)) calc(18px + env(safe-area-inset-bottom,0px)) calc(18px + env(safe-area-inset-left,0px));
  animation:veilIn .18s ease both;}
.pop-card{width:min(430px,100%);max-height:86dvh;overflow-y:auto;
  background:var(--card);border-radius:22px;padding:20px;
  box-shadow:0 24px 80px rgba(0,0,0,.55);
  animation:popIn .32s cubic-bezier(.3,1.25,.4,1) both;}
.pop-card.wide{width:min(560px,100%);}
.pop-title{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;
  font-size:17px;font-weight:720;color:var(--ink);letter-spacing:-0.01em;}
.pop-x{width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:14px;flex:0 0 auto;
  border:1px solid var(--hair);background:var(--fill);color:var(--sec);}

/* The gold loading ring - the app's one "working on it" mark for full-surface
   waits (the owner, 2026-08-07: "when I enter the scanner I need to see the golden
   circle loading so it doesn't look like it's bugging"). */
@keyframes ringSpin{to{transform:rotate(360deg)}}
.gold-ring{width:34px;height:34px;border-radius:50%;margin:40px auto;box-sizing:border-box;
  border:3px solid var(--fill);border-top-color:var(--gold);
  animation:ringSpin .8s linear infinite;}
@media(prefers-reduced-motion:reduce){.veil,.pop-card{animation:none}.gold-ring{animation-duration:1.6s}}
`;
