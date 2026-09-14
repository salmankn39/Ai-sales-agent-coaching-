/**
 * WHAT DID WE ACTUALLY SAY? Only what reached the lead.
 *
 * Owner rule, 2026-08-21 (Scott Hall incident): "the AI should always, always
 * always check the Instagram inbox to see if the message landed and got sent -
 * and not anything else."
 *
 * The engine saves its bubbles BEFORE sending them, so the messages table can
 * briefly (or, after a blocked/failed send, permanently) hold AI rows the lead
 * has never seen. Everything that reasons about the conversation - the repeat
 * check, the stage tracker, the history fed to the brain - must not see those
 * rows: a question that never landed was never asked.
 *
 * "Reached the lead" is deliberately generous, because a false positive here
 * erases real history while a false negative merely risks a repeat the
 * anti-repeat guard would catch:
 *   - delivered_at        stamped on transport success
 *   - inbox_verified_at   seen in the real conversation via the GHL mirror
 *   - send_attempted_at   the request LEFT and no failure came back (a killed
 *                         run mid-flight) - probably landed, treat as said
 *   - ghl_message_id      imported FROM the inbox mirror - said by definition
 *   - instant-ack rows    sent before saving; legacy ones carry no stamps
 * A known send failure clears its attempt stamp at result time, so the truly
 * never-sent row - the Scott bubble - has none of the above.
 *
 * AND IT IS BOUNDED BY RECENCY, which is the half that keeps it honest.
 * Stress-testing this against production (2026-08-21) found 514 of 1477 AI
 * rows carrying none of the four proofs - written before the delivery stamps
 * existed, mostly June. The leads received them. Filtering those would blank
 * the setter's memory of its own past messages and re-ask questions it had
 * already asked: the Asyah bug ("where you based" five times) reintroduced
 * wholesale. Past the window, absence of proof is not proof of absence. Same
 * reasoning as resendUndeliveredTail's ceiling: never resurrect ancient rows.
 */
import { INSTANT_ACK_TAG } from "./instant-ack";

/** How long an unproven bubble stays actionable as "they never saw this".
 *  Comfortably covers an in-flight volley, a blocked send and the sweep's
 *  retry cycle; short enough that historical rows are read as history. */
export const UNPROVEN_WINDOW_MS = 24 * 3600_000;

export function neverReachedLead(
  m: {
    role: string;
    model_used?: string | null;
    created_at?: string | null;
    delivered_at?: string | null;
    send_attempted_at?: string | null;
    ghl_message_id?: string | null;
    inbox_verified_at?: string | null;
  },
  nowMs: number = Date.now()
): boolean {
  if (m.role !== "ai") return false;
  if (m.model_used === INSTANT_ACK_TAG) return false;
  if (m.delivered_at || m.send_attempted_at || m.ghl_message_id || m.inbox_verified_at) {
    return false;
  }
  // No proof either way. Only recent rows are ghosts; older ones are history.
  // A missing/unparseable timestamp fails toward remembering, never toward
  // blanking the thread.
  const createdMs = m.created_at ? new Date(m.created_at).getTime() : NaN;
  if (!Number.isFinite(createdMs)) return false;
  return nowMs - createdMs < UNPROVEN_WINDOW_MS;
}
