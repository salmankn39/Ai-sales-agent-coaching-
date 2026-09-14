/** GENERATED from domain/spec — do not edit. Run `node domain/codegen/generate.mjs`. */

/** All funnel stage ids, in canonical order (== hq/chat FUNNEL_ORDER). */
export const STAGE_IDS = ["opener","transition_main_reason","goals","current_situation","timeline","problem","consequence","consequence_why","pitch_help","book","post_book","proof","nurture"] as const;

/** Pre-pitch qualifying bucket (== followups.ts STAGES_A). */
export const STAGES_A = ["opener","transition_main_reason","goals","current_situation","timeline","problem","consequence","consequence_why"] as const;

/** Pitched bucket (== followups.ts STAGES_B). */
export const STAGES_B = ["pitch_help","book"] as const;

/** The leak-map display sequence (== dashboard FUNNEL_SEQ). */
export const FUNNEL_SEQ = ["opener","transition_main_reason","goals","current_situation","timeline","problem","consequence","consequence_why","pitch_help","book"] as const;

/** Human labels per stage (== dashboard STAGE_LABELS == hq/chat STAGE_LABEL). */
export const STAGE_LABELS: Record<string, string> = {
  "opener": "Opener",
  "transition_main_reason": "Main reason",
  "goals": "Goals",
  "current_situation": "Situation",
  "timeline": "Timeline",
  "problem": "Problem",
  "consequence": "Consequence",
  "consequence_why": "Why not",
  "pitch_help": "Pitch",
  "book": "Booking",
  "post_book": "Post-book",
  "proof": "Proof",
  "nurture": "Nurture"
};

/** Funnel stage -> GHL pipeline stage name (== pipeline-sync.ts FUNNEL_TO_GHL). */
export const FUNNEL_TO_GHL: Record<string, string> = {
  "opener": "Waiting For Reply (lead needs to msg)",
  "transition_main_reason": "Waiting For Reply (lead needs to msg)",
  "goals": "Waiting For Reply (lead needs to msg)",
  "current_situation": "Waiting For Reply (lead needs to msg)",
  "timeline": "Waiting For Reply (lead needs to msg)",
  "problem": "Waiting For Reply (lead needs to msg)",
  "consequence": "Waiting For Reply (lead needs to msg)",
  "consequence_why": "Waiting For Reply (lead needs to msg)",
  "pitch_help": "Call Pitched",
  "book": "Call Pitched",
  "post_book": "Call Pitched",
  "proof": "Call Pitched",
  "nurture": "Call Pitched"
};

/** Stages the setter "owns" (drives the conversation in). */
export const SETTER_OWNED = ["opener","transition_main_reason","goals","current_situation","timeline","problem","consequence","consequence_why","pitch_help","book"] as const;
