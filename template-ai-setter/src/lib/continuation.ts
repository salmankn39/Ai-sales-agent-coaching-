/**
 * MID-SEND CONTINUATION JUDGMENT - is their extra bubble a new turn, or just
 * the tail of the reply we already answered?
 *
 * Owner rule, 2026-08-21 (Scott Hall incident): leads text the way the setter
 * does - one reply spread over several bubbles. A bubble that lands while OUR
 * volley is still going out ("Off and on", "yeah makes sense") is usually the
 * tail of the message we are already answering. Generating a whole new turn
 * for it is what created the Scott disaster: the second turn wedged an ack
 * into the middle of the first turn's volley, read the first turn's unsent
 * question as already-said, declared itself stuck and switched the AI off.
 * "We need to read them and see... if it didn't add any value, we should not
 * respond to it. We just tick our initial response and make sure it gets
 * completed."
 *
 * DELIBERATELY NARROWER than the deleted follow-on gate (2026-07-25, see
 * setter-invariants.test.ts). That gate ran on every inbound and its absorb
 * meant total silence - 24 dead conversations in 30 days. This judgment:
 *   - exists ONLY for a message that arrived while our volley was mid-send;
 *   - can only absorb when the delivered volley hands the lead something to
 *     answer or act on (a question, or a link/time), so on Instagram the
 *     thread still ends with OUR question landing AFTER their bubble;
 *   - fails toward responding on every ambiguous or broken path.
 * A wrongly-suppressed reply costs a lead. A wrongly-sent one costs nothing.
 */
import { claude } from "./anthropic";

// Same tier as the stage manager: this call can suppress a response, so it
// does not get the bargain model. It runs at most once per mid-send straggler,
// which live is a handful of times a week.
export const CONTINUATION_JUDGE_MODEL = "claude-sonnet-5";

// At or past this length the lead is clearly saying something with substance,
// and substance always deserves a response - no model opinion needed.
const SUBSTANTIAL_CHARS = 80;

export type PrecheckVerdict = "respond" | "judge";

const asksSomething = (texts: string[]) => texts.some((t) => t.includes("?"));
const carriesLinkOrTime = (texts: string[]) =>
  texts.some((t) => /https?:\/\/|\b\d{1,2}[:.]\d{2}\b|\bcalendar\b/i.test(t));

/**
 * The cheap half, which must never be clever: it may demand a response or
 * send the case to the model, and nothing else. Absorbing is exclusively the
 * model's call, and only from inside the narrow window this file describes.
 */
export function continuationPrecheck(
  stragglers: string[],
  deliveredVolley: string[]
): PrecheckVerdict {
  // Nothing actually landed, or what landed hands the lead nothing to answer
  // or act on - absorbing would leave the thread hanging on a statement.
  if (deliveredVolley.length === 0) return "respond";
  if (!asksSomething(deliveredVolley) && !carriesLinkOrTime(deliveredVolley)) return "respond";

  // They asked something. A question is never filler.
  if (asksSomething(stragglers)) return "respond";

  // They said something substantial. React to it like a person would.
  if (stragglers.some((t) => t.trim().length >= SUBSTANTIAL_CHARS)) return "respond";

  return "judge";
}

/**
 * Decide whether the mid-send straggler needs a reply of its own, or whether
 * the just-delivered volley (which ends on our question) already carries the
 * conversation. Returns "respond" on every failure or ambiguity.
 */
export async function classifyContinuation(params: {
  stragglers: string[];
  deliveredVolley: string[];
}): Promise<"respond" | "absorb"> {
  const { stragglers, deliveredVolley } = params;
  if (continuationPrecheck(stragglers, deliveredVolley) === "respond") return "respond";

  try {
    const resp = await claude("continuation_judge").messages.create({
      model: CONTINUATION_JUDGE_MODEL,
      max_tokens: 10,
      thinking: { type: "disabled" },
      system: `You are watching an Instagram DM conversation. The business owner's reply went out as several bubbles, and WHILE it was still sending, the lead sent one or more short bubbles of their own. Those bubbles were typed BEFORE the lead saw the owner's final bubble (a question they now have in front of them).

Decide: do the lead's bubbles need a response of their own, or are they just the tail of the message the owner already answered (filler, an acknowledgement, a detail that changes nothing)?

Answer with EXACTLY one word:
ABSORB - the bubbles add nothing that needs answering; the owner's delivered question already carries the conversation.
RESPOND - the bubbles contain anything worth acknowledging or answering (new information, emotion, hesitation, an objection, a correction).

When unsure, answer RESPOND.`,
      messages: [
        {
          role: "user",
          content: `Owner's delivered bubbles:\n${deliveredVolley.map((t) => `- ${t}`).join("\n")}\n\nLead's bubbles that arrived mid-send:\n${stragglers.map((t) => `- ${t}`).join("\n")}`,
        },
      ],
    });
    const text = resp.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { type: string; text?: string }) => b.text ?? "")
      .join("")
      .trim()
      .toUpperCase();
    // Strict: only the exact unambiguous verdict absorbs. A hedging sentence
    // that merely CONTAINS the word does not.
    return text === "ABSORB" ? "absorb" : "respond";
  } catch (err) {
    console.error("[continuation] judge failed - responding:", err);
    return "respond";
  }
}
