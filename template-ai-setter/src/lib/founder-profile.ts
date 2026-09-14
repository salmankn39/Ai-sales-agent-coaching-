/**
 * The Founder Profile: a validated personality instrument, ~8 minutes.
 *
 * EVERY ITEM IS VERBATIM FROM A PUBLISHED SCALE. The owner, 2026-08-13: "all
 * questions and all results should all be and ONLY be sciencebased!!! no bs
 * questions dont even make it obvious that its entrepreneurial questoins
 * thats not what personality tests do no?" He is right, and the first draft
 * broke both rules: 20 of its 40 items were written by me, and they read as
 * an entrepreneur quiz ("asking someone for money makes me freeze"), which
 * tells the taker exactly what to answer. That draft is gone.
 *
 * SOURCE. All 40 items are the preliminary IPIP scales measuring constructs
 * similar to the 30 NEO-PI-R facet scales, fetched verbatim from
 * ipip.ori.org/newNEOFacetsKey.htm on 2026-08-13. The International
 * Personality Item Pool is public domain: "in the public domain,
 * intentionally not copyrighted, free for use in research or commercial
 * applications" (Goldberg et al., 2006, Journal of Research in Personality).
 * The BFI-2 is deliberately absent: its authors state it is non-commercial
 * only, verified on the Berkeley Personality Lab page.
 *
 * ── THE 2026-08-14 CORRECTION ────────────────────────────────────────────
 * The items were always real. The INTERPRETATIONS were not, and an audit of
 * all 24 of them found the report was quietly arguing whichever side the
 * taker landed on. Four things were wrong, and all four are fixed here.
 *
 * 1. EVIDENCE WAS PER-BAND, SO IT COULD BE CHERRY-PICKED. Adventurousness
 *    HIGH cited openness raising the odds of profitability; adventurousness
 *    LOW cited preference for low-risk projects raising the odds, from the
 *    same table of the same paper. Whichever way you scored, the science
 *    appeared to endorse you. Evidence is now PER FACET: one line, shown
 *    identically to a high, mid and low scorer, reporting both numbers where
 *    the paper reports both. You cannot cherry-pick a constant.
 *
 * 2. CLAIMS THAT CONTRADICTED THEIR OWN CITATION. "Sustained profitability
 *    tracked conscientiousness, NOT risk appetite (Hagenauer and Zipko
 *    2025)" was false about that paper, and this very file cited its risk
 *    odds ratio 95 lines later. Verified 2026-08-14: openness OR 1.616,
 *    conscientiousness OR 1.279, preference for low-risk projects OR 1.607,
 *    age under 50 OR 2.126, in 4,470 solo-founded ventures.
 *
 * 3. OVERSTATEMENT. "Neuroticism was negatively related to EVERY outcome
 *    studied" was wrong: verified against the paper, it did not predict
 *    whether a startup raised any funding at all, only what happened after.
 *    Unverifiable decimals (rho .18) and superlatives ("the strongest
 *    buildable predictor") are gone. Nothing is stated as a number here
 *    unless it was read off the source.
 *
 * 4. THE POPULATION WAS NEVER NAMED. Most of this literature studies
 *    venture-backed technology startups and counts success as raising money
 *    or being acquired, and two of the studies estimated personality from
 *    founders' public posts rather than asking them. The owner's readers are
 *    building small businesses of their own. SCOPE_NOTE says so on the page.
 *
 * WHAT THIS IS NOT. It does not score anyone as a good or bad founder. No
 * composite "entrepreneur score" exists here on purpose: the weights would
 * be my opinion until the owner's own cohort data earns them. A score is a
 * measurement, a reading is an interpretation, and the evidence line is a
 * third thing that belongs to the facet rather than to your result.
 */

export type Facet =
  | "self_efficacy" | "achievement" | "discipline" | "composure"
  | "calm" | "assertiveness" | "activity" | "adventurousness";

export type Item = {
  id: string;
  /** Verbatim IPIP item. Presented under the standard IPIP stem, so it reads
   * as an ordinary personality question and nothing else. */
  text: string;
  facet: Facet;
  /** true when agreeing with the item means LESS of the named facet. */
  reverse?: boolean;
};

/** The instruction every real IPIP administration carries. */
export const STEM = "Describe yourself as you generally are now, not as you wish to be in the future.";

export const SCALE = [
  "Very inaccurate", "Moderately inaccurate", "Neither", "Moderately accurate", "Very accurate",
] as const;

// ── The 40 items, all verbatim from IPIP's NEO facet scales ────────
export const ITEMS: Item[] = [
  // C1 SELF-EFFICACY (alpha .78 per IPIP)
  { id: "se1", text: "Complete tasks successfully.", facet: "self_efficacy" },
  { id: "se2", text: "Excel in what I do.", facet: "self_efficacy" },
  { id: "se3", text: "Know how to get things done.", facet: "self_efficacy" },
  { id: "se4", text: "Misjudge situations.", facet: "self_efficacy", reverse: true },
  { id: "se5", text: "Have little to contribute.", facet: "self_efficacy", reverse: true },

  // C4 ACHIEVEMENT-STRIVING (.78)
  { id: "ac1", text: "Go straight for the goal.", facet: "achievement" },
  { id: "ac2", text: "Work hard.", facet: "achievement" },
  { id: "ac3", text: "Turn plans into actions.", facet: "achievement" },
  { id: "ac4", text: "Do just enough work to get by.", facet: "achievement", reverse: true },
  { id: "ac5", text: "Put little time and effort into my work.", facet: "achievement", reverse: true },

  // C5 SELF-DISCIPLINE (.85)
  { id: "sd1", text: "Get chores done right away.", facet: "discipline" },
  { id: "sd2", text: "Start tasks right away.", facet: "discipline" },
  { id: "sd3", text: "Carry out my plans.", facet: "discipline" },
  { id: "sd4", text: "Find it difficult to get down to work.", facet: "discipline", reverse: true },
  { id: "sd5", text: "Need a push to get started.", facet: "discipline", reverse: true },

  // N6 VULNERABILITY (.82), keyed so a high score means COMPOSURE
  { id: "co1", text: "Remain calm under pressure.", facet: "composure" },
  { id: "co2", text: "Readily overcome setbacks.", facet: "composure" },
  { id: "co3", text: "Know how to cope.", facet: "composure" },
  { id: "co4", text: "Panic easily.", facet: "composure", reverse: true },
  { id: "co5", text: "Become overwhelmed by events.", facet: "composure", reverse: true },

  // N1 ANXIETY (.83), keyed so a high score means CALM
  { id: "ca1", text: "Am relaxed most of the time.", facet: "calm" },
  { id: "ca2", text: "Am not easily bothered by things.", facet: "calm" },
  { id: "ca3", text: "Worry about things.", facet: "calm", reverse: true },
  { id: "ca4", text: "Get stressed out easily.", facet: "calm", reverse: true },
  { id: "ca5", text: "Fear for the worst.", facet: "calm", reverse: true },

  // E3 ASSERTIVENESS (.84)
  { id: "as1", text: "Take charge.", facet: "assertiveness" },
  { id: "as2", text: "Try to lead others.", facet: "assertiveness" },
  { id: "as3", text: "Seek to influence others.", facet: "assertiveness" },
  { id: "as4", text: "Wait for others to lead the way.", facet: "assertiveness", reverse: true },
  { id: "as5", text: "Hold back my opinions.", facet: "assertiveness", reverse: true },

  // E4 ACTIVITY LEVEL (.71)
  { id: "ac6", text: "Am always busy.", facet: "activity" },
  { id: "ac7", text: "Am always on the go.", facet: "activity" },
  { id: "ac8", text: "Do a lot in my spare time.", facet: "activity" },
  { id: "ac9", text: "Like to take it easy.", facet: "activity", reverse: true },
  { id: "ac10", text: "Like a leisurely lifestyle.", facet: "activity", reverse: true },

  // O4 ADVENTUROUSNESS (.77)
  { id: "ad1", text: "Prefer variety to routine.", facet: "adventurousness" },
  { id: "ad2", text: "Like to begin new things.", facet: "adventurousness" },
  { id: "ad3", text: "Like to visit new places.", facet: "adventurousness" },
  { id: "ad4", text: "Prefer to stick with things that I know.", facet: "adventurousness", reverse: true },
  { id: "ad5", text: "Am a creature of habit.", facet: "adventurousness", reverse: true },
];

export const FACETS: Facet[] = [
  "self_efficacy", "achievement", "discipline", "composure",
  "calm", "assertiveness", "activity", "adventurousness",
];

export const FACET_LABEL: Record<Facet, string> = {
  self_efficacy: "Self-Efficacy",
  achievement: "Achievement-Striving",
  discipline: "Self-Discipline",
  composure: "Composure",
  calm: "Calm",
  assertiveness: "Assertiveness",
  activity: "Activity Level",
  adventurousness: "Adventurousness",
};

/** The published scale each facet is taken from, shown in the report. */
export const FACET_SOURCE: Record<Facet, string> = {
  self_efficacy: "IPIP C1 Self-Efficacy",
  achievement: "IPIP C4 Achievement-Striving",
  discipline: "IPIP C5 Self-Discipline",
  composure: "IPIP N6 Vulnerability, reverse keyed",
  calm: "IPIP N1 Anxiety, reverse keyed",
  assertiveness: "IPIP E3 Assertiveness",
  activity: "IPIP E4 Activity Level",
  adventurousness: "IPIP O4 Adventurousness",
};

export type Scores = Record<Facet, number>;

/** answers: item id -> 1..5. 0-100 per facet, or null if anything is missing. */
export function scoreAnswers(answers: Record<string, number>): Scores | null {
  const sums: Partial<Record<Facet, { total: number; n: number }>> = {};
  for (const item of ITEMS) {
    const raw = answers[item.id];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1 || raw > 5 || Math.floor(raw) !== raw) return null;
    const v = item.reverse ? 6 - raw : raw;
    const s = (sums[item.facet] ||= { total: 0, n: 0 });
    s.total += v;
    s.n += 1;
  }
  const out = {} as Scores;
  for (const [facet, s] of Object.entries(sums) as [Facet, { total: number; n: number }][]) {
    out[facet] = Math.round(((s.total / s.n - 1) / 4) * 100);
  }
  return out;
}


// ── Interpretation ────────────────────────────────────────────────
// Three separate things live below, and keeping them separate is the point:
//   a SCORE is a measurement,
//   a READING is an interpretation of your band,
//   an EVIDENCE line belongs to the FACET, never to your band, so the
//     research says the same thing to you whichever way you scored.

export type Band = "high" | "mid" | "low";

/** 65 and 35, and they are not arbitrary. Five items scored 1-5 means only
 * multiples of 5 are reachable, and 65 / 35 are the reachable values nearest
 * the response anchors "moderately accurate" and "moderately inaccurate". So a
 * band says where your own answers sat on the scale. It says nothing about
 * where you sit against other people: this report has no norms and does not
 * pretend to. */
export function band(v: number): Band {
  return v >= 65 ? "high" : v <= 35 ? "low" : "mid";
}

/** Deliberately not "High" / "Low". Those words claim a comparison to other
 * people that nothing on this page supports. */
export const BAND_LABEL: Record<Band, string> = {
  high: "Leaned high",
  mid: "Mixed",
  low: "Leaned low",
};

/** One answer moved one step shifts a facet by exactly 5 points, so a band
 * boundary is one click wide. A score sitting on it should say so. */
export function nearLine(v: number): boolean {
  return Math.abs(v - 65) <= 5 || Math.abs(v - 35) <= 5;
}

export const SCALE_NOTE =
  "Each facet is five statements. A score is where your answers sat on the scale, " +
  "as a percentage of it. 65 means your five answers averaged about 3.6 out of 5, " +
  "just past 'moderately accurate'. These are not percentiles: nothing here compares " +
  "you to other people.";

export const SCOPE_NOTE =
  "Most research on founder personality studies venture-backed technology startups, " +
  "and counts success as raising money or getting acquired. The closest study to " +
  "building something small of your own followed 4,470 solo founders and asked a " +
  "simpler question: were they still profitable seven years later. Two of these " +
  "studies estimated personality from founders' public posts instead of asking them, " +
  "and their authors call the findings descriptive, not causal. Read all of it as " +
  "context, never as a forecast.";

// ── Evidence, one per facet ───────────────────────────────────────
// Every figure below was read off the source on 2026-08-14. Anything that
// could not be verified was cut rather than softened. Where a paper reports
// findings that pull in different directions, BOTH are here, in the same
// line, because splitting them by band is how the old version ended up
// flattering everybody.

export type Evidence = {
  /** The study and its sample, or "How this is measured" for a method note. */
  study: string;
  /** What was actually found. Plain language, no invented precision. */
  finding: string;
  /** What it does not show. Shown in a quieter style, never omitted. */
  limit?: string;
};

export const FACET_EVIDENCE: Record<Facet, Evidence> = {
  self_efficacy: {
    study: "Miao, Qian and Ma 2017, a meta-analysis pooling many studies",
    finding:
      "Believing you can do the specific tasks a business needs went with better firm performance across the studies they pooled.",
    limit:
      "They measured confidence at business tasks. This scale measures general self-belief, which is related but not the same thing, so treat the link as suggestive.",
  },
  achievement: {
    study: "Zhao and Seibert 2006, a meta-analysis comparing entrepreneurs with managers",
    finding:
      "The conscientiousness gap between the two groups sat in achievement motivation rather than in dependability. Entrepreneurs scored higher on wanting to hit targets, not on being reliable.",
    limit:
      "A difference between two groups is not evidence that scoring higher causes anything. It describes who ends up where.",
  },
  discipline: {
    study: "Hagenauer and Zipko 2025, 4,470 solo-founded ventures followed for seven years",
    finding:
      "Conscientiousness raised the odds of still being profitable after seven years, odds ratio 1.28. In the same model, preferring lower-risk projects raised them more, 1.61, and being under 50 raised them most, 2.13.",
    limit:
      "This is the closest study here to building a small business of your own, and it still only shows what went together, not what caused what.",
  },
  composure: {
    study: "Freiberg and Matz 2023, more than 10,000 technology startup founders",
    finding:
      "Higher neuroticism went with worse outcomes once a startup had already raised money: less funding, fewer investors, less chance of an exit. It did not predict whether a startup raised any funding in the first place.",
    limit:
      "Personality was estimated from founders' public posts, not asked. The authors write that their findings are purely descriptive.",
  },
  calm: {
    study: "How this is measured",
    finding:
      "Anxiety and vulnerability are both neuroticism scales, and IPIP scores them separately, which is why you see two numbers. Worrying about things and being knocked over by them are not the same experience.",
    limit:
      "Nobody cited here has shown these two predict different business outcomes. They are shown apart because they are measured apart.",
  },
  assertiveness: {
    study: "Freiberg and Matz 2023, more than 10,000 technology startup founders",
    finding:
      "Extraversion was the one Big Five trait with no significant relationship to any outcome they measured. Loud founders and quiet founders did about equally well.",
    limit:
      "That is a finding about outcomes, not about you. How you deal with people is still worth knowing, it just is not a scoreboard.",
  },
  activity: {
    study: "The thinnest evidence in this report",
    finding:
      "Pace describes how you like to work, and that is worth knowing about yourself.",
    limit:
      "No study cited here shows that working at a faster pace produces a better business. Treat this number as description, not advice.",
  },
  adventurousness: {
    study: "Hagenauer and Zipko 2025, 4,470 solo-founded ventures followed for seven years",
    finding:
      "Openness raised the odds of lasting profitability, odds ratio 1.62, the larger of the two personality effects in that model. In the same model, preferring lower-risk projects raised the odds almost as much, 1.61.",
    limit:
      "Those two point different ways and the paper reports both. Being open to new ideas is not the same as wanting to bet on them.",
  },
};

// ── Readings, per band ────────────────────────────────────────────
// What the score says about you, and one thing to do. No citations here on
// purpose: the research lives on the facet, above, identical for every band.
// Every top band carries a cost, because a report where the best score is
// pure good news is a horoscope.

export type Reading = { means: string; coach: string };

const READINGS: Record<Facet, Record<Band, Reading>> = {
  self_efficacy: {
    high: {
      means: "You expect to be able to handle what you take on, and you trust your own read over other people's.",
      coach: "Pick the last decision you made alone and find one person who has actually done it. Ask them what you missed.",
    },
    mid: {
      means: "You back yourself in the parts you have done before, and go quiet in the parts you have not.",
      coach: "Name the one skill you avoid. Do the smallest real version of it this week, then again next week.",
    },
    low: {
      means: "You doubt you can pull things off, including things you have already pulled off.",
      coach: "Write down what you finished each week, however small. This score usually survives on forgetting the evidence.",
    },
  },
  achievement: {
    high: {
      means: "You lock onto a target and push at it hard.",
      coach: "Before the next sprint, write one sentence on what hitting the target actually gets you. Effort is not your gap, aim is.",
    },
    mid: {
      means: "You work hard when the goal is clear and drift when it goes vague.",
      coach: "Put one number somewhere you see it daily. Your output follows how clear the target is.",
    },
    low: {
      means: "Targets do not pull you much. You are moved by other things.",
      coach: "Borrow the pull from outside: a deadline someone else is waiting on beats a goal you set yourself.",
    },
  },
  discipline: {
    high: {
      means: "You start without waiting to feel ready, and you finish what you start.",
      coach: "Check what you are being consistent at. This trait will keep you busy on the easy thing just as reliably as the important one.",
    },
    mid: {
      means: "You start well when there is momentum and stall when it breaks.",
      coach: "Decide now what the first small action is after a break, and make it too small to argue with.",
    },
    low: {
      means: "Starting is the hard part, harder than the work itself once you are in it.",
      coach: "Rent structure instead of generating it: fixed times, someone expecting you, a board you can see.",
    },
  },
  composure: {
    high: {
      means: "Setbacks land and then leave. You do not stay knocked over.",
      coach: "You can take more swings than most people because they cost you less. Take them on bigger things, not safer ones.",
    },
    mid: {
      means: "You cope with most of it, and certain hits take days off you.",
      coach: "Work out which kind of setback costs you days, and plan that day before it happens.",
    },
    low: {
      means: "Pressure and setbacks hit hard and stay with you a while.",
      coach: "Build shorter cycles and fewer all-or-nothing bets, so a bad week costs a week and not a quarter.",
    },
  },
  calm: {
    high: {
      means: "You do not go looking for things to worry about, and stress has to work to find you.",
      coach: "Write down the downside case for your current plan even though you do not feel it. Calm people underplan for risk.",
    },
    mid: {
      means: "Some things get to you and some slide off, and you know roughly which is which.",
      coach: "Notice which specific situations spike it. The real pattern is usually narrower than the feeling.",
    },
    low: {
      means: "You worry, often well ahead of the thing you are worrying about.",
      coach: "Worry earns its place when it improves the plan and costs you when it delays the start. Give it ten minutes, then move.",
    },
  },
  assertiveness: {
    high: {
      means: "You speak first, take the lead, and push your view.",
      coach: "In your next important conversation, ask a question and then say nothing until they finish. This trait opens conversations, it does not close them.",
    },
    mid: {
      means: "You can take the lead when it is needed without needing to.",
      coach: "Leave it alone. Pick the moments that matter rather than trying to be louder generally.",
    },
    low: {
      means: "You hold your opinion back and let other people set the direction.",
      coach: "Play to it rather than fixing it: written pitches and one-to-one conversations beat performing in a room.",
    },
  },
  activity: {
    high: {
      means: "You keep a lot moving at once and you prefer it that way.",
      coach: "Once this week, write down where your hours actually went. Busy and effective come apart quietly.",
    },
    mid: {
      means: "You work at a normal pace and can lift it when something matters.",
      coach: "Keep it. This pace outlasts sprinting for most ways of making money.",
    },
    low: {
      means: "You would rather have fewer things running and go deeper on them.",
      coach: "Build the kind of business that rewards depth: fewer, larger, better-finished bets.",
    },
  },
  adventurousness: {
    high: {
      means: "New pulls you and routine drains you.",
      coach: "Finish the current thing before you start the next one. This trait is why the last three are unfinished.",
    },
    mid: {
      means: "You will try a new approach without needing everything to be new.",
      coach: "Put one deliberate test in the calendar each month, and leave everything else alone until it reports back.",
    },
    low: {
      means: "You would rather run something proven than start something unproven.",
      coach: "Copy what already works and stop apologising for it. Just schedule one deliberate test a month so you notice when the proven thing stops working.",
    },
  },
};

/** Short verb phrases used to build the opening read. */
const FACET_SHORT: Record<Facet, string> = {
  self_efficacy: "back your own judgement",
  achievement: "chase targets",
  discipline: "start without waiting",
  composure: "shake off setbacks",
  calm: "stay unbothered",
  assertiveness: "take charge",
  activity: "keep a lot moving",
  adventurousness: "want variety",
};

const FACET_SHORT_LOW: Record<Facet, string> = {
  self_efficacy: "doubting your own judgement",
  achievement: "not being pulled by targets",
  discipline: "finding it hard to start",
  composure: "carrying setbacks a while",
  calm: "worrying ahead of time",
  assertiveness: "holding back",
  activity: "preferring fewer things at once",
  adventurousness: "preferring the proven",
};

export type Report = {
  facets: {
    facet: Facet; label: string; source: string; score: number;
    band: Band; bandLabel: string; nearLine: boolean;
    reading: Reading; evidence: Evidence;
  }[];
  /** Rank ordered, highest first. */
  ranked: Report["facets"];
  /** ARRAYS, because ties are real and silently picking one is a lie. */
  highest: Facet[];
  lowest: Facet[];
  /** Highest minus lowest. A flat profile and a 60 point spread mean
   * different things and the old report showed them identically. */
  spread: number;
  /** The opening paragraph. Deterministic, built from the actual numbers. */
  read: string;
  /** The one facet to act on first, and why it was chosen. facet is null
   * when every score tied: there is no lowest, and picking one anyway would
   * be declaration order pretending to be a recommendation. */
  startHere: { facet: Facet | null; why: string };
};

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] || "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * THE READ. One paragraph that treats the eight numbers as one person.
 *
 * Fully deterministic and derived only from the scores, never a model call:
 * the same answers must always produce the same report, and a report that
 * quietly rewrites itself is not a measurement.
 */
function buildRead(ranked: Report["facets"], spread: number): string {
  const highs = ranked.filter((f) => f.band === "high");
  const lows = ranked.filter((f) => f.band === "low");
  const topScore = ranked[0].score;
  const botScore = ranked[ranked.length - 1].score;

  // Guarded on spread for the same reason as `bottom` below: with eight
  // identical scores nothing "sits at the top", and naming the first three
  // is declaration order wearing a finding's clothes. All-100 answers used to
  // say the scores came out the same and then immediately name three of them
  // as the standouts.
  const top = spread === 0 ? [] : ranked.slice(0, 3).filter((f) => f.band === "high");
  // A facet only counts as "lower down" if it is genuinely lower: either it
  // landed in the low band, or it sits a clear 15 points under the top. On a
  // perfectly flat profile nothing qualifies, which is correct. The first
  // version took the last two of the ranked list unconditionally and so told
  // a taker with eight identical scores which two of them were their weak
  // spots, purely on declaration order.
  const bottom = spread === 0 ? [] : [...ranked].reverse().slice(0, 2)
    .filter((f) => f.band === "low" || (f.band !== "high" && topScore - f.score >= 15));

  const shape =
    spread === 0
      ? `Every one of your eight scores came out the same, which usually means the answers were closer to a default than to a description.`
      : spread >= 40
        ? `Your scores are a long way apart, ${spread} points between the highest and the lowest, so this profile has a clear shape rather than a general level.`
        : spread <= 15
          ? `Your eight scores sit within ${spread} points of each other, so no single trait runs you.`
          : `There is a ${spread} point gap between your highest and lowest score.`;

  const strong = top.length
    ? ` What sits at the top is that you ${joinList(top.map((f) => FACET_SHORT[f.facet]))}.`
    : botScore === topScore
      ? ""
      : ` Nothing here sits high enough to call a defining strength.`;

  const weak = bottom.length
    ? ` Lower down: ${joinList(bottom.map((f) => FACET_SHORT_LOW[f.facet]))}.`
    : "";

  // The tension sentence. Only stated when the profile actually has one.
  //
  // These read RELATIVE position, not just the band. A facet 25+ points below
  // the rest of a profile is the story of that profile even when it lands in
  // "Mixed" on the absolute scale: the owner's own result has Adventurousness at
  // 40 against seven scores of 65 to 100, which is obviously his shape, and a
  // band-only rule stayed silent about it.
  const bandOf = (f: Facet) => ranked.find((r) => r.facet === f)!.band;
  const rankOf = (f: Facet) => ranked.findIndex((r) => r.facet === f);
  // A facet can only be the "low" half of a tension if it did NOT lean high.
  // Without that guard, six 100s and two 70s fired the low-adventurousness
  // tension line while the facet card on the same page read "Leaned high",
  // so the report contradicted itself a scroll apart.
  const low = (f: Facet) =>
    bandOf(f) === "low" ||
    (bandOf(f) !== "high" && rankOf(f) >= ranked.length - 2 && spread >= 25);
  const high = (f: Facet) => bandOf(f) === "high";

  let tension = "";
  if (low("adventurousness") && (high("discipline") || high("achievement"))) {
    tension = " That combination usually runs one proven thing hard and stalls when the thing itself has to change.";
  } else if (high("adventurousness") && low("discipline")) {
    tension = " That combination starts far more than it finishes, and the finishing is where the money is.";
  } else if (high("assertiveness") && low("composure")) {
    tension = " You push into rooms easily and pay for them afterwards, which is a stamina problem rather than a confidence one.";
  } else if (high("activity") && low("achievement")) {
    tension = " You are busy without being aimed, which feels like work and does not compound like it.";
  } else if (high("self_efficacy") && low("calm")) {
    tension = " You trust yourself and still brace for the worst, so the cost here is hesitation rather than capability.";
  } else if (highs.length >= 6 && lows.length === 0 && spread <= 20) {
    // Only when the profile is genuinely flat and high. With a real low point
    // the shape is the finding, and this sentence would talk over it.
    tension = " Almost everything here leaned high and there is no real low point. Either you are built for this, or you answered how you would like to be, and a retake in a few months is what tells you which.";
  }

  return shape + strong + weak + tension;
}

/** The one to act on first. Lowest score wins, unless everything leaned high,
 * in which case the top score is the one that will cost you something.
 *
 * When every score is identical there is no lowest, and picking one anyway
 * would be declaration order pretending to be a finding. That case says so. */
function pickStartHere(ranked: Report["facets"], spread: number): { facet: Facet | null; why: string } {
  const first = ranked[0];
  const last = ranked[ranked.length - 1];

  if (spread === 0) {
    return {
      facet: null,
      why: "Your eight scores came out identical, so nothing here stands out as the place to start. Take it again and answer faster, first instinct rather than considered, and the differences usually appear.",
    };
  }
  if (last.band !== "high") {
    return {
      facet: last.facet,
      why: "This is your lowest score, so it is where a small change is most likely to show up in how your week actually goes.",
    };
  }
  return {
    facet: first.facet,
    why: "Every facet leaned high, so there is no weak spot to shore up. Your strongest trait is the one with the sharpest edge, so start where it cuts.",
  };
}

export function buildReport(scores: Scores): Report {
  const facets = FACETS.map((facet) => {
    const score = scores[facet];
    const b = band(score);
    return {
      facet,
      label: FACET_LABEL[facet],
      source: FACET_SOURCE[facet],
      score,
      band: b,
      bandLabel: BAND_LABEL[b],
      nearLine: nearLine(score),
      reading: READINGS[facet][b],
      evidence: FACET_EVIDENCE[facet],
    };
  });

  // Stable rank: score desc, then declaration order, so ties never reshuffle
  // between renders of the same result.
  const ranked = [...facets].sort(
    (a, b) => b.score - a.score || FACETS.indexOf(a.facet) - FACETS.indexOf(b.facet),
  );
  const top = ranked[0].score;
  const bot = ranked[ranked.length - 1].score;

  return {
    facets,
    ranked,
    highest: ranked.filter((f) => f.score === top).map((f) => f.facet),
    lowest: ranked.filter((f) => f.score === bot).map((f) => f.facet),
    spread: top - bot,
    read: buildRead(ranked, top - bot),
    startHere: pickStartHere(ranked, top - bot),
  };
}

/** One line for the owner's Telegram and the student's own agent context. */
export function profileSummaryLine(scores: Scores): string {
  return FACETS.map((f) => `${FACET_LABEL[f]} ${scores[f]}`).join(", ");
}

/**
 * "top X, lowest Y" for the dashboard table and the GHL note.
 *
 * Handles the tie honestly. Joining highest and lowest unconditionally meant a
 * flat profile printed all eight facet names as BOTH the top and the lowest in
 * the same sentence, which is worse than saying nothing.
 */
export function topBottomLine(report: Report): string {
  if (report.spread === 0) return "no standout, all eight scores tied";
  const name = (fs: Facet[]) => fs.map((f) => FACET_LABEL[f]).join(" and ");
  return `top ${name(report.highest)}, lowest ${name(report.lowest)}`;
}
