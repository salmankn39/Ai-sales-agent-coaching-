"use client";
/**
 * THE READ-OUT — three things worth attention, above everything else.
 *
 * Client-side on purpose. The box costs a model call, and making the whole
 * dashboard wait on it would make every page load feel broken. The numbers
 * render instantly; this fills in a moment later.
 *
 * It re-fetches whenever the dates change, because the whole point is that it
 * reads the period currently on screen.
 *
 * That re-fetch takes a few seconds against a model, and the first version
 * spent them showing three silent grey rectangles. The owner: "I changed the
 * timeline and it's just blank. Make it look like it's loading or thinking
 * instead of looking like it's broken." So the wait now says out loud what it
 * is doing, and the header keeps its label the whole time.
 *
 * ── THE LOOK ─────────────────────────────────────────────────────────────
 * The owner: "work on its visual appearance so it's easier to look at, more sexy,
 * iOS Apple."
 *
 * The first version was a gold-tinted panel holding three more gold-tinted
 * panels, painted in a hardcoded #D4AF37 that was not even the product's gold
 * (--gold is #e6c25a). A box inside a box inside a box, in the wrong colour.
 *
 * This follows the house design system in _skin.ts, whose card rule reads
 * "one subtle surface, soft shadow, NO hard border, NO double box". So the
 * outer panel is gone and the three cards sit directly on the page the way an
 * iOS grouped list does.
 *
 * The pass after that tried green, amber and blue rails, one per slot, so the
 * three were distinguishable before reading. He hated it: "change back to the
 * previous colours, I don't like this colour changing thing, just make them
 * all yellow, it's consistent, I don't like green and blue and shit." Fair.
 * Everything gold now, and the slots are told apart by their labels, which is
 * what labels are for.
 *
 * And each card is ONE block of text. There used to be a second gold line of
 * bare figures underneath. He asked for it gone, and the numbers now live
 * inside the sentences that make them mean something, which is what let the
 * cards get shorter and rounder.
 *
 * Every value comes from a skin token, so both skins and the light/dark
 * toggle work for free.
 */
import { useEffect, useState } from "react";

type Slot = "working" | "leaking" | "changed";
type Card = { slot: Slot; headline: string; detail: string };

const LABEL: Record<Slot, string> = {
  working: "Working",
  leaking: "Leaking",
  changed: "Changed",
};

const SUB: Record<Slot, string> = {
  working: "do more of this",
  leaking: "worth fixing",
  changed: "since last period",
};

const WAITING = [
  "Looking at what is working",
  "Looking for what is leaking",
  "Comparing with last period",
];

const CSS = `
.ro-wrap{ margin:2px 0 22px; }
.ro-head{ display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin:0 2px 11px; }
.ro-kicker{ font-size:13px; font-weight:590; color:var(--gold); letter-spacing:0; }
.ro-when{ font-size:12.5px; color:var(--ter); font-variant-numeric:tabular-nums; }
.ro-pulse{ width:6px; height:6px; border-radius:50%; background:var(--gold); align-self:center;
  animation:roPulse 1.2s var(--ease) infinite; }
@keyframes roPulse{ 0%,100%{opacity:.25; transform:scale(.85)} 50%{opacity:1; transform:scale(1)} }

.ro-grid{ display:grid; gap:var(--gap); grid-template-columns:repeat(auto-fit,minmax(264px,1fr)); }

/* Rounder and shorter than a normal card: this is a note, not a panel. The
   gold is a wash rather than a border, so it reads warm without boxing. */
.ro-card{ position:relative; border-radius:20px; padding:15px 18px 16px;
  display:flex; flex-direction:column; gap:6px;
  background:linear-gradient(180deg,
    color-mix(in srgb, var(--gold) 7%, var(--card)) 0%,
    var(--card) 62%);
  box-shadow:var(--shadow), inset 0 0 0 1px color-mix(in srgb, var(--gold) 15%, transparent);
  animation:roIn .42s var(--ease) both; }
.ro-card:nth-child(2){ animation-delay:.06s; }
.ro-card:nth-child(3){ animation-delay:.12s; }
@keyframes roIn{ from{ opacity:0; transform:translateY(7px) } to{ opacity:1; transform:none } }
@media(hover:hover){
  .ro-card{ transition:transform var(--dur) var(--ease), box-shadow var(--dur) ease; }
  .ro-card:hover{ transform:translateY(-2px);
    box-shadow:var(--shadow-lg), inset 0 0 0 1px color-mix(in srgb, var(--gold) 26%, transparent); }
}

.ro-tag{ display:flex; align-items:center; gap:7px; }
.ro-dot{ width:6px; height:6px; border-radius:50%; background:var(--gold); flex:0 0 auto; opacity:.9; }
.ro-slot{ font-size:10.5px; font-weight:660; letter-spacing:.07em; text-transform:uppercase; color:var(--gold); }
.ro-slotsub{ font-size:10.5px; color:var(--ter); }

.ro-headline{ font-size:15px; font-weight:650; line-height:1.3; letter-spacing:-0.012em; color:var(--ink); }
.ro-detail{ font-size:13.5px; line-height:1.55; color:var(--sec); }

.ro-skel{ border-radius:20px; min-height:104px; padding:15px 18px; display:flex; align-items:center;
  background:linear-gradient(180deg, color-mix(in srgb, var(--gold) 5%, var(--card)) 0%, var(--card) 62%);
  box-shadow:var(--shadow), inset 0 0 0 1px color-mix(in srgb, var(--gold) 10%, transparent);
  font-size:12.5px; color:var(--ter); animation:roBreathe 1.7s var(--ease) infinite; }
.ro-skel:nth-child(2){ animation-delay:.2s; }
.ro-skel:nth-child(3){ animation-delay:.4s; }
@keyframes roBreathe{ 0%,100%{opacity:.5} 50%{opacity:.95} }

@media (prefers-reduced-motion:reduce){
  .ro-card,.ro-skel,.ro-pulse{ animation:none; }
  .ro-card{ opacity:1; transform:none; }
}
`;

/** "1 Jun to 4 Aug", carrying the year only when the range crosses one. */
function range(start: string, end: string): string {
  const crosses = start.slice(0, 4) !== end.slice(0, 4);
  const fmt = (iso: string) => {
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      ...(crosses ? { year: "numeric" } : {}),
    });
  };
  return `${fmt(start)} to ${fmt(end)}`;
}

export default function ReadOut({ start, end }: { start: string; end: string }) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setCards(null);
    setFailed(false);
    fetch(`/api/dashboard/read?start=${start}&end=${end}`)
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        const c = (d?.cards ?? []) as Card[];
        if (c.length) setCards(c);
        else setFailed(true);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [start, end]);

  // Nothing to say is a legitimate answer, and an empty box shouting for
  // attention is worse than no box. Stay out of the way.
  if (failed) return null;

  const loading = cards === null;

  return (
    <div className="ro-wrap">
      <style>{CSS}</style>

      <div className="ro-head">
        <span className="ro-kicker">What&rsquo;s worth your attention</span>
        <span className="ro-when">{loading ? "reading these dates" : range(start, end)}</span>
        {loading && <span className="ro-pulse" aria-hidden />}
      </div>

      {loading ? (
        <div className="ro-grid" role="status" aria-live="polite">
          {WAITING.map((line) => (
            <div key={line} className="ro-skel">
              {line}
            </div>
          ))}
        </div>
      ) : (
        <div className="ro-grid">
          {cards.map((c, i) => (
            <div key={c.slot + i} className="ro-card">
              <div className="ro-tag">
                <span className="ro-dot" aria-hidden />
                <span className="ro-slot">{LABEL[c.slot] ?? c.slot}</span>
                <span className="ro-slotsub">{SUB[c.slot] ?? ""}</span>
              </div>
              <span className="ro-headline">{c.headline}</span>
              <span className="ro-detail">{c.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
