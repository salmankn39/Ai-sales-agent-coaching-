import { claude } from "@/lib/anthropic";
// Named so this shows up as its own line in the spend report.
const anthropic = claude("lead_classify");

/**
 * IS THIS A LEAD, OR IS IT YOUR MATE SENDING YOU MEMES?
 *
 * The owner, 2026-08-04: "let it read all the inboxes and generally see who could be a
 * lead and create them in the CRM. The AI should be able... like, you, the app,
 * should be able to understand that if a conversation is a lead conversation or if
 * a conversation is just a friend texting or, like, sending memes to each other or
 * whatever. You know? And, uh, if it's more of a lead type of conversation, then
 * create them as a lead in the CRM of the student."
 *
 * This is the difference between a CRM worth opening and a CRM full of your mates.
 * A student's Instagram inbox is mostly not business, and pouring all of it onto
 * their board would bury the four people who matter under forty who do not.
 *
 * TWO STAGES, CHEAPEST FIRST.
 *
 *   1. A deterministic pre-filter that only ever says "obviously not" or "ask the
 *      model". It never says "lead" on its own - a keyword match is not a judgement,
 *      and this codebase has paid for keyword judgements all week.
 *   2. Claude, given the actual messages, answering one question.
 *
 * WHEN IN DOUBT IT SAYS NO. A missed lead shows up again the next time they speak,
 * because the sync reads the thread again when a new message lands. A wrong card
 * sits on the board being wrong until somebody deletes it. Those costs are not
 * symmetric, so the tie goes to leaving it off.
 */

export type Verdict = "lead" | "personal" | "unsure";

export type Judgeable = { name: string; messages: { fromThem: boolean; text: string }[] };

/** Under this many words across the whole thread there is nothing to judge. */
const MIN_WORDS = 6;

const REACTION_ONLY = /^[\s\p{Extended_Pictographic}‍️0-9]*$/u;

/**
 * The cheap pass. Returns "personal" only for threads that cannot be business by
 * their shape, "unsure" for everything else. Deliberately never returns "lead".
 */
export function preFilter(c: Judgeable): Verdict {
  const said = c.messages.map((m) => (m.text || "").trim()).filter(Boolean);
  if (!said.length) return "personal";
  // Reactions, single emoji, a lone "😂" repeated - no words means no conversation.
  if (said.every((t) => REACTION_ONLY.test(t))) return "personal";
  const words = said.join(" ").split(/\s+/).filter(Boolean).length;
  if (words < MIN_WORDS) return "personal";
  // One message, from them, that the student never answered, is not a conversation
  // either - it is usually a mass DM or a bot.
  if (c.messages.length === 1 && c.messages[0].fromThem) return "personal";
  return "unsure";
}

const SYS = [
  "You read one direct-message thread and answer ONE question: is this a business conversation",
  "the account owner should track as a sales lead, or is it personal?",
  "",
  "LEAD means there is any sign of business between them: the owner pitching or offering something,",
  "the other person asking what they do, asking about price or results, a call being discussed, a",
  "service being described, an intro to somebody who might buy, or a past or current client talking",
  "about the work.",
  "",
  "PERSONAL means friends, family, banter, memes, plans to meet socially, or a fan saying nice things",
  "with no business in it. Also PERSONAL: bots, giveaways, mass DMs, and people trying to sell TO the",
  "owner rather than buy from them.",
  "",
  "WHEN IT COULD GO EITHER WAY, ANSWER personal. A missed lead comes back the next time they speak.",
  "A wrong card sits on somebody's board being wrong until a human deletes it.",
  "",
  'Answer with one word and nothing else: lead, personal, or unsure.',
].join("\n");

function transcript(c: Judgeable): string {
  return c.messages.slice(-14)
    .map((m) => `${m.fromThem ? c.name || "Them" : "Owner"}: ${(m.text || "").slice(0, 400)}`)
    .join("\n").slice(0, 4000);
}

/**
 * One thread, judged. Returns "unsure" on any failure, and the caller must treat
 * "unsure" as "do not create a card" - a model that timed out has not agreed.
 */
export async function classify(c: Judgeable): Promise<Verdict> {
  const cheap = preFilter(c);
  if (cheap !== "unsure") return cheap;
  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001", max_tokens: 5, system: SYS,
      messages: [{ role: "user", content: transcript(c) }],
    });
    const word = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      .toLowerCase().replace(/[^a-z]/g, "");
    return word === "lead" ? "lead" : word === "personal" ? "personal" : "unsure";
  } catch {
    return "unsure";
  }
}

/** Only a confident yes gets a card. */
export const shouldTrack = (v: Verdict): boolean => v === "lead";
