// Best-guess TOF/MOF/BOF for a content card. The owner, 2026-08-06: "make your best
// guess on if that idea is a top of funnel, middle of funnel, or bottom of funnel
// idea and already decide it for them, so we can to a seventy, eighty percent
// accuracy see how much of each they're posting."
//
// Keyword-scored, not AI-called: a guess this cheap can run on every card ever
// created (and the backfill) without a token bill, and 70-80% is exactly what a
// good keyword net delivers. The student can always override the chip by hand -
// the guess just means the Results funnel mix is never empty.
//
// The three levels, in the students' world:
//   TOF - broad awareness: documenting the journey, story, identity, entertainment
//   MOF - trust and value: teaching, how-to, mistakes, frameworks
//   BOF - the ask: offers, proof, client results, "DM me" / "book a call"

export type FunnelLevel = "tof" | "mof" | "bof";

const BOF: RegExp[] = [
  /\bdm me\b/, /\blink in bio\b/, /\bbook (a |your )?(free )?(call|audit|demo|consult)/,
  /\bwork with (me|us)\b/, /\bspots? (left|open|available)\b/, /\bapply\b/, /\bfree audit\b/,
  /\bclient (result|win)/, /\bcase stud/, /\btestimonial/, /\bjoin (my|the|us)\b/,
  /\bmy (coaching|program|course|offer|service)\b/, /\bpricing?\b/, /\bguarantee\b/,
  /\bclose[sd]? (a|another|my first) client\b/, /\bsigned? (a|another|my first) client\b/,
  /\bbefore (and|&) after\b/, /\bresults? (i|we) got\b/, /\bwhat it('s| is) like to work\b/,
];

const MOF: RegExp[] = [
  /\bhow to\b/, /\bhow i\b/, /\bstep(s| by step|-by-step)\b/, /\bmistakes?\b/, /\btips?\b/,
  /\btutorial\b/, /\bguide\b/, /\bframework\b/, /\bsystem\b/, /\bstrateg/, /\bbreakdown\b/,
  /\bstop (doing|posting|sending|wasting)\b/, /\bdo this\b/, /\bavoid\b/, /\blessons?\b/,
  /\bthe truth about\b/, /\bnobody tells\b/, /\bwhy (you|your|most)\b/, /\bteach/,
  /\bexplained?\b/, /\bwhat i('d| would) do\b/, /\btop \d/, /\b\d+ (ways|things|reasons|tools)\b/,
  /\btool(s| stack)?\b/, /\bbeginners?\b/, /\bfaster\b/, /\bwithout\b/,
];

const TOF: RegExp[] = [
  /\bjourney\b/, /\bday in the life\b/, /\bi quit\b/, /\bmy story\b/, /\bdocument/,
  /\bvlog\b/, /\bweek \d/, /\bday \d/, /\bmy (goal|why|dream)\b/, /\bwhy i (left|quit|started)\b/,
  /\bstarting (from|my|over|out)\b/, /\bi('m| am) (starting|building|leaving|going all in|done)\b/,
  /\breact/, /\bopinion\b/, /\brant\b/, /\bstory ?time\b/, /\bchallenge\b/, /\bpov\b/,
  /\bfrom (zero|scratch|nothing)\b/, /\bmy first\b/, /\bbehind the scenes\b/, /\bhonest(ly)?\b/,
  /\bwhat i learned\b/, /\bmonths? (ago|in|of)\b/, /\bupdate\b/,
];

function score(text: string, res: RegExp[]): number {
  let n = 0;
  for (const re of res) if (re.test(text)) n++;
  return n;
}

/** The guess. Ties break toward the more committed end of the funnel (a "how to
 * work with me" reel is a pitch wearing a tutorial's clothes); no signal at all
 * is TOF, because an idea that neither teaches nor sells is almost always the
 * journey/identity kind - the default mode of a beginner's content. */
export function guessFunnelLevel(text: string): FunnelLevel {
  const t = String(text || "").toLowerCase();
  const bof = score(t, BOF), mof = score(t, MOF), tof = score(t, TOF);
  if (bof > 0 && bof >= mof && bof >= tof) return "bof";
  if (mof > 0 && mof >= tof) return "mof";
  return "tof";
}
