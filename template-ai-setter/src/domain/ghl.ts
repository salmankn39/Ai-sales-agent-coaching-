/** GENERATED from domain/spec — do not edit. Run `node domain/codegen/generate.mjs`. */

export const GHL_API_BASE = "https://services.leadconnectorhq.com";
export const GHL_API_VERSION = "2021-07-28";
export const AI_SALES_PIPELINE_ID = "guHUTUQU0FaKR1xfTfwT";
export const DISQUALIFIED_STAGE = "Disqualified";

/** The canonical "AI off" tag Jarvis WRITES to pause a lead. */
export const PAUSE_TAG = "ai off";

/** Every tag that means "the AI must NOT handle this contact". The setter
 *  disengages on ANY of these, so BOTH engines must COUNT all of them as paused. */
export const STOP_TAGS: readonly string[] = ["ai off","ai-off","aioff","stop ai","stop-ai","stopai","do not contact","dnc","human","handover","no ai"];

/** True if the contact's tags contain any stop tag. Accepts a comma-separated
 *  GHL tag string OR an array of tags. Byte-identical logic on both runtimes. */
export function hasStopTag(tags: string | string[] | undefined | null): boolean {
  if (!tags) return false;
  const set = (Array.isArray(tags) ? tags : tags.split(",")).map((t) => t.trim().toLowerCase());
  return STOP_TAGS.some((stop) => set.includes(stop));
}

/** The subset of STOP_TAGS meaning the person asked to be left alone ENTIRELY -
 *  only these may drop an inbound message unrecorded. Everything else in
 *  STOP_TAGS is the ai-off family: OUR pause vocabulary, which stops sending
 *  but never tracking (2026-08-20, Scott Hall). */
export const OPT_OUT_TAGS: readonly string[] = ["do not contact","dnc"];

/** True if the contact's tags contain a full opt-out tag. */
export function hasOptOutTag(tags: string | string[] | undefined | null): boolean {
  if (!tags) return false;
  const set = (Array.isArray(tags) ? tags : tags.split(",")).map((t) => t.trim().toLowerCase());
  return OPT_OUT_TAGS.some((stop) => set.includes(stop));
}

/** Lowercased GHL stage name -> forward rank (== pipeline-sync.ts SETTER_OWNED_RANK). */
export const SETTER_OWNED_RANK: Record<string, number> = {
  "new lead": 0,
  "outreach to (ai needs to msg)": 1,
  "waiting for reply (lead needs to msg)": 1,
  "call pitched": 2
};

/** GHL stage name -> event_type (== pipeline_watcher.py STAGE_EVENT_MAP). */
export const STAGE_EVENT_MAP: Record<string, string | null> = {
  "New Lead": null,
  "No Pickup": "dial_no_pickup",
  "Not interested/wrong number": "dial_not_interested",
  "Wrong number": "dial_wrong_number",
  "Picked up (not interested)": "dial_not_interested",
  "Call Pitched": "call_pitched",
  "Lead Magnet Sent": "lead_magnet_sent",
  "Appointment Booked": "call_booked",
  "Contacted": "closer_contacted",
  "Appointment Confirmed": "appointment_confirmed",
  "No Show - Re-Nurture": "call_no_show",
  "Client Won": "deal_won",
  "Lead Lost": "deal_lost",
  "Following Up On": "follow_up_started",
  "No Response After Follow Ups": "follow_up_exhausted",
  "Disqualified": "lead_disqualified"
};

export const CONVERSATION_STARTED_STAGES = ["Outreach To (AI needs to msg)","Waiting For Reply (lead needs to msg)"] as const;
export const BOOKED_OR_BEYOND_STAGES = ["Appointment Booked","Contacted","Appointment Confirmed","No Show - Re-Nurture","Client Won"] as const;

export function ghlHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Version: GHL_API_VERSION, "Content-Type": "application/json" };
}
