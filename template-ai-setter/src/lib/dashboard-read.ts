/**
 * THE READ-OUT — three things worth the owner's attention, for the dates on screen.
 *
 * WHY IT IS BUILT THIS WAY
 * ========================
 * The owner: "I do not want a feature where it's just super rigid and stupid, like
 * 'you generated three hundred leads'. No bloody shit, I can see that."
 *
 * Two failure modes to dodge at once. A rules engine writes exactly that kind
 * of line. A model let loose on the database invents figures, which after a
 * week spent proving every number is real would be the worst possible ending.
 *
 * So the work is split:
 *
 *   get_dashboard_signals (SQL)  computes every number, its comparison against
 *                                the previous equal-length period, and the
 *                                sample size behind each rate.
 *   this file                    hands that pack to the model and asks only for
 *                                ranking and phrasing.
 *
 * The model is told plainly that it may not do arithmetic or recall a figure.
 * Everything it can say is already in front of it. And the signals come from
 * get_dashboard - the same function the tables on screen read - so the box can
 * never contradict the numbers underneath it.
 *
 * THE SHAPE (the owner's choice): one of each, always in this order.
 *   1  what is working, so he can double down
 *   2  what is leaking, so he can fix it
 *   3  what changed since last period
 *
 * A fixed shape is the point. He is scanning it daily, and a box whose meaning
 * moves around gets read slower each time.
 *
 * WHAT THE FIRST LIVE VERSION GOT WRONG
 * =====================================
 * The owner read it on 2026-08-04 and pulled four lines apart. None of them held
 * a fabricated figure - the arithmetic ban worked. Every one of them was a
 * fabricated CAUSE laid over real figures:
 *
 *   "The only cash this period came directly from the dialing."  It did not.
 *   "$15,418 outstanding is the leak."  It is a payment plan on schedule.
 *   "You made money by chasing old revenue."  He signed two new customers.
 *   "Calls book but nobody gets pitched."  Two showed, both disqualified for
 *   reasons the closer had already written down.
 *
 * So the pack now carries the causes explicitly (who signed, which channel
 * the money is attributed to, how much of the cohort is even logged, what the
 * closer wrote down, when each stream started being tracked) and the prompt
 * below forbids reaching a cause any other way. A writer handed a hole will
 * fill it with the nearest plausible story; the fix is to leave no hole.
 *
 * Belt and braces: numbersAreReal() below re-checks every figure in the
 * finished cards against the pack and drops any card that invented one.
 */
import { claude } from "./anthropic";
// Named so this shows up as its own line in the spend report.
const anthropic = claude("dashboard_read");
import { supabase } from "./supabase";

const MODEL = "claude-sonnet-4-6";

/**
 * Two fields, not three.
 *
 * There used to be a separate `numbers` line under each card, printed in gold.
 * The owner: "can you just remove these yellow texts and just have one bit of
 * text... then the boxes can be smaller." He is right, and it was never a
 * clean split: half the figures ended up in the sentence anyway and the rest
 * sat underneath as a list nobody reads. The numbers belong INSIDE the
 * sentence that makes them mean something.
 */
export type ReadOutCard = {
  slot: "working" | "leaking" | "changed";
  headline: string;
  detail: string;
};

export type ReadOut = { cards: ReadOutCard[]; generated_at: string } | null;

const SYSTEM = `You read a sales dashboard for a small online-income coaching business and tell the owner the three things worth his attention. He is not technical and has no patience for restating what he can already see.

You will be given a JSON pack of numbers that has ALREADY been computed. Your job is ranking and phrasing. Nothing else.

HARD RULES
- Never do arithmetic. Never state a number that is not in the pack. If you want to say something the pack does not support, say something else.
- Never call a segment better or worse when its "enough_to_judge" is false, or when the n behind a rate is under 10. With small numbers say so plainly: "too few to call yet".
- Never restate a bare figure as an insight. "45 leads" is not an insight. "45 leads produced 1 booking" is.
- A rate always travels with the count it came from.
- If a slot has nothing real in it, say so in one line. An empty slot is far better than an invented one.

WHERE MONEY CAME FROM - THE STRICTEST RULE HERE
Cash may be explained ONLY through money.attributed_to and money.customers_signed_this_period. Those blocks name the customers and the channels. Nothing else in the pack explains money.
- Never tie cash to an activity because both sit in the same period. Dials, outreaches, leads and replies are counted separately from payments and are NOT evidence of each other. "The cash came from the dialing" is the exact sentence that must never appear unless money.attributed_to says so by name.
- money.cash_from_new_signings is money from people who signed inside this period. money.cash_from_existing_customers is instalments from people who signed earlier and are still paying their plan. Never describe the second as chasing old revenue, and never present it as a sales result. It is collection on work already done.
- money.attributed_to.by_source and the top-level by_source are DIFFERENT vocabularies. by_source lists lead channels; money.attributed_to.by_source lists how a customer was won. A name that appears in one and not the other simply has no figure in the other, so never imply it has a small one.
- movement.closed_on_a_call counts CALL OUTCOMES only. A deal signed in the DMs with no call logged does not appear in it, so a zero there does not mean no deals. movement.new_customers_signed is the count of real signings. Quote that one when talking about deals.

THE THREE WAYS A PERSON ARRIVES, NEVER BLENDED
- activity.outreaches_logged is HIS effort: cold DMs he sent to new people. activity.replies_to_outreach is that effort converting.
- activity.inbound_dms is people who DMed HIM first and got answered: what his content and CTAs pull. Not an outreach, not an opt-in.
- movement.leads (opt-ins and captured leads) is people who gave contact details. An inbound DM can later opt in; that is one journey passing two stages, not a duplicate.
- A reply can land on an outreach sent before this window, so replies_to_outreach may exceed outreaches_logged. That is normal, never call it an error, and never compute a rate across them.

DATES AND DAYS
period.today is today's date and period.timezone is his. Use them.
- A booked call with no outcome is one of three completely different things, and calls_without_an_outcome keeps them apart. Never say "no outcome logged" without saying which.
  still_to_come: the call has not happened. Say WHEN, using the name and the date: "Wael's call is Thursday at 15:00". Nothing is wrong and nobody needs chasing.
  already_happened: the call has been and gone with nothing written up. Say how long ago: "Ahmed's call was 5 days ago and is still not logged". This one is chaseable.
  closed_as_history: the call is older than blocked.outcomes_only_tracked_from, the date the owner drew a line and closed the backlog. He said it plainly: nobody is going back to log old calls, only from that date forward. So no outcome is ever coming for it. It is HISTORY, never a job. Bring it up only to explain why an old period's show rate and close rate look thin, and never as something to fix or chase.
  no_call_time_recorded: the booking has no calendar slot, so nobody can tell whether it happened. The fix is getting a time on it.
- blocked.of_those_worth_chasing is the only one of those counts that is work. Quote that one when you tell him what to do, not the total.
- Prefer how he speaks: "in 3 days", "5 days ago", "yesterday", "today", "on Thursday". days_from_today is negative for the past and positive for the future, and call_at already carries the weekday and time.
- Never call a call that has not happened yet a no-show, a missed call, or an unpitched call.

WHAT IS NOT A LEAK
- A payment plan running to schedule. Only blocked.payments_overdue is chaseable money. Money still owed on a plan whose dates have not arrived is not a problem and must never be offered as one.
- A conversion step whose "enough_to_judge" is false.
- A step where outcome_coverage.outcome_missing is a large share of outcome_coverage.bookings_in_period. That rate is describing the paperwork, not the selling. If that is the real story, say the outcomes are not logged, not that the selling failed.
- Anything already explained in recorded_reasons. If the closer wrote down why a call did not progress, that is the answer, and repeating the rate as a mystery is worse than useless.
- A movement entry with "comparable": false. Its previous-period figure predates the tracking, so it is an artefact. Never call it a rise or a fall.
- A call older than blocked.outcomes_only_tracked_from. The owner closed that backlog: nobody goes back in time to log results for old calls, only forward from here. Offering one is offering a job nobody will ever do.
- Anything the owner cannot act on this week. If nothing in the pack is genuinely leaking, say the leaking slot is clear and why.

WHAT MAKES A GOOD LINE
- It compares. Against the previous period, or against another segment, or against the overall rate.
- It names the consequence in money or time where the pack supports it, not just the metric.
- It is specific enough that the owner could act on it this week.
- It names people where the pack names them. "Tom & Louis and Thomas Green signed" beats "2 new customers".

TWO THINGS THE RULES ABOVE MUST NOT TALK YOU OUT OF
- Quote the actual figures. The bans are on numbers you made up, never on numbers you were given. "$10,167 collected vs $8,500 last period" is right; "cash collected: now vs before (+19.6%)" is a description of a figure with the figure taken out, and it is useless to the owner. If a number is in the pack, write it.
- The two windows are always the same length. period.compared_with.days says so. Never suggest a difference in length explains a change.
- Never estimate how long a stream has been tracked. tracking_started.days_of_this_period_covered gives the exact number of days. It wrote "only 6 weeks of dialing" when dial logging covered 7 of the period's 65 days.
- Judge comparability one metric at a time. "comparable" is per entry, not per period. Dials being uncomparable says nothing about bookings, and calling the whole period uncomparable when only one stream is throws away a real move.

HOW TO WRITE IT - NINTH GRADE, OUT LOUD
The owner asked for ninth grade language, simple enough to understand all 3 boxes at a glance. Write like you are telling them over the phone, not like a report.
- Short sentences. Most under 18 words. One idea each.
- Put the numbers INSIDE the sentence they explain. "$10,167 came in, up from $8,500" is one thought. A list of figures on its own is not.
- Everyday words. Never: attributed, artefact, cohort, denominator, comparable, metric, conversion, baseline, volume, understated, instalment, aggregate, period-on-period, insufficient, granularity.
- His own words are fine and better: booked, showed, no-show, closed, signed, dials, leads, cash collected, pitched.
- Never print a field name from the pack. "enough_to_judge: false" means nothing to him. Say "too few to call yet".
- Say what to DO where there is something to do. "Get a time on both of those bookings" beats "there is a data gap".
- Names, not categories. "Wael and Israel" beats "two leads".

Return ONLY minified JSON, no prose, no code fences:
{"cards":[{"slot":"working","headline":"<=58 chars","detail":"2 or 3 short sentences with the numbers inside them"},{"slot":"leaking",...},{"slot":"changed",...}]}

headline: plain and concrete, no hype, no emoji. A headline can carry a number.
detail: 2 or 3 short sentences, written to him directly, with every supporting figure inside them. No em dashes, no emoji, no lists, no semicolons.`;

/**
 * Every figure a card quotes has to exist in the pack it was given.
 *
 * The prompt already forbids arithmetic and invention, and in practice it
 * holds. This is the check that does not depend on the model behaving. Digit
 * groups are compared after stripping the formatting a writer adds - commas,
 * currency, percent signs - so "$6,667" matches the pack's 6667.0.
 *
 * Numbers under two digits are skipped: 0 through 9 appear somewhere in any
 * pack of this size, so checking them proves nothing and only risks throwing
 * away a good card. The lie worth catching is a plausible-looking large one.
 */
export function numbersAreReal(card: ReadOutCard, packJson: string): boolean {
  const digits = packJson.replace(/[^0-9.]/g, " ");
  const quoted = `${card.headline} ${card.detail}`.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return quoted.every((raw) => {
    const n = raw.replace(/,/g, "");
    if (n.replace(/\D/g, "").length < 2) return true;
    return digits.includes(n);
  });
}

/**
 * No field name from the pack reaches the screen.
 *
 * Told plainly not to, it still wrote "funnel step rates all marked
 * enough_to_judge: false" and "movement.new_customers_signed confirms 2 real
 * signings". Those keys exist so the writer knows what it may claim, not so
 * they land in front of a man who has said many times he is not technical.
 *
 * snake_case and dotted paths do not occur in ordinary English, so matching
 * them is safe. A card that trips this is sent back once rather than dropped:
 * the finding is usually right and only the wording is wrong.
 */
export function readsLikeEnglish(card: ReadOutCard): boolean {
  const text = `${card.headline} ${card.detail}`;
  // Two or more letters each side of the dot, so an ordinary "e.g." is not
  // mistaken for a path.
  return !/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/.test(text) && !/\b[a-z]{2,}\.[a-z_]{2,}\b/.test(text);
}

/**
 * No em dashes reach the screen, whatever the model felt like typing.
 *
 * Including the ASCII disguise. Told not to use the character, it reached for
 * " -- " instead, which reads exactly the same on the page.
 */
function house(text: string): string {
  return (text ?? "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+--+\s+/g, ", ")
    .replace(/\s+--+/g, ",")
    .trim();
}

function clean(c: ReadOutCard): ReadOutCard {
  return {
    slot: c.slot,
    headline: house(c.headline),
    detail: house(c.detail),
  };
}

function parseCards(text: string): ReadOutCard[] {
  // Tolerate a stray fence rather than losing the whole box to it.
  const body = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(body) as { cards?: ReadOutCard[] };
  return (parsed.cards ?? [])
    .filter((c) => c && typeof c.headline === "string" && c.headline.length > 0)
    .map(clean);
}

/** What is wrong with a card, in the words the writer needs to hear. */
function faults(cards: ReadOutCard[], pack: string): string[] {
  const out: string[] = [];
  for (const c of cards) {
    if (!readsLikeEnglish(c))
      out.push(`The "${c.slot}" card prints a raw field name. Say the same thing in plain English.`);
    if (!numbersAreReal(c, pack))
      out.push(`The "${c.slot}" card quotes a figure that is not in the pack. Use only figures you were given.`);
  }
  return out;
}

export async function buildReadOut(start: string, end: string): Promise<ReadOut> {
  try {
    const { data: signals, error } = await supabase.rpc("get_dashboard_signals", {
      p_start: start,
      p_end: end,
    });
    if (error || !signals) {
      console.error("[read-out] signals failed:", error);
      return null;
    }

    const pack = JSON.stringify(signals);

    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 900,
      system: SYSTEM,
      messages: [{ role: "user", content: pack }],
    });

    const say = (r: { content: { type: string; text?: string }[] }) =>
      r.content.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("").trim();

    let text = say(res);
    let cards = parseCards(text);

    // One repair round. A card that trips a check is nearly always a true
    // finding in the wrong words, so asking again beats throwing it away.
    const wrong = faults(cards, pack);
    if (wrong.length) {
      console.error("[read-out] asking again:", wrong.join(" "));
      const retry = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 900,
        system: SYSTEM,
        messages: [
          { role: "user", content: pack },
          { role: "assistant", content: text },
          {
            role: "user",
            content: `${wrong.join("\n")}\n\nRewrite all three cards, keeping the findings, fixing those. Same JSON, nothing else.`,
          },
        ],
      });
      const repaired = parseCards(say(retry));
      if (repaired.length) cards = repaired;
    }

    // Whatever survives has to pass on its own. A card that still trips after
    // being told exactly what was wrong is dropped rather than shown.
    cards = cards.filter((c) => {
      if (readsLikeEnglish(c) && numbersAreReal(c, pack)) return true;
      console.error("[read-out] dropped a card that failed twice:", c.headline);
      return false;
    });
    if (!cards.length) return null;

    return { cards: cards.slice(0, 3), generated_at: new Date().toISOString() };
  } catch (e) {
    // The box is an extra. It must never take the dashboard down with it.
    console.error("[read-out] failed:", e);
    return null;
  }
}
