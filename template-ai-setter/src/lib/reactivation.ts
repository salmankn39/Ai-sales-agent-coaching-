/**
 * REACTIVATION SEGMENT CLASSIFIER
 * --------------------------------
 * Which of two historical situations a dormant lead is in. This is decided
 * ONCE, deterministically, from the operator's note - not re-guessed by the
 * creative opener-writing call, and not re-guessed turn-by-turn by the
 * normal reply engine. It's then stored on the lead (leads.stage_data) so
 * every later reply in the conversation can see it as a known fact, the same
 * way any other captured fact (age, goal, etc.) already works.
 *
 * Same lightweight pattern as the stage tracker in lib/stages.ts: a small,
 * fast, strict-JSON classification call, separate from the main generation.
 */
import { claude } from "./anthropic";
const anthropic = claude("reactivation_segment");

export type ReactivationSegment = "never_attended" | "attended_before";

const SYSTEM_PROMPT = `Classify a short note about a dormant/old lead into exactly ONE category.

never_attended: they enquired or showed interest, but never actually attended a real session - this includes someone who booked a trial and no-showed, or simply never got round to booking at all.

attended_before: they attended at least one real session (a trial or a paid session) before they stopped engaging.

If the note is genuinely unclear or ambiguous, default to never_attended - that is the safer assumption, since it never risks implying they attended something that may not have actually happened.

Return ONLY strict minified JSON, nothing else: {"segment":"never_attended"} or {"segment":"attended_before"}`;

/** Fails closed to "never_attended" (the safer default) on any error. */
export async function classifyReactivationSegment(note: string): Promise<ReactivationSegment> {
  try {
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 50,
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: note.slice(0, 1000) }],
    });
    const raw = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return "never_attended";
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { segment?: string };
    return parsed.segment === "attended_before" ? "attended_before" : "never_attended";
  } catch (err) {
    console.error("[reactivation] segment classification failed, defaulting to never_attended:", err);
    return "never_attended";
  }
}
