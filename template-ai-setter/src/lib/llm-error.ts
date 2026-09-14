/**
 * WHAT KIND OF FAILURE WAS THAT, AND CAN RETRYING POSSIBLY HELP?
 *
 * Incident 2026-08-16. The Anthropic org ran out of credit at 15:36 UTC. Every
 * generation after that died on:
 *
 *   400 {"type":"error","error":{"type":"invalid_request_error","message":
 *   "Your credit balance is too low to access the Anthropic API. Please go to
 *   Plans & Billing to upgrade or purchase credits."}}
 *
 * Nothing in the codebase looked at that error. The reply engine retried it
 * three times with backoff, the sweep re-ran the whole pipeline every five
 * minutes for two hours, and each doomed attempt cost real time on a live
 * inbound. Retrying a 400 cannot ever succeed: the account is out of money, and
 * no amount of waiting changes that. Meanwhile the one message the owner actually
 * received truncated the error at "Please go", cutting off the half that says
 * what to do about it.
 *
 * This module is the missing distinction, and nothing more:
 *
 *   transient      the model or the network wobbled. Retrying is the right
 *                  move (529 overloaded, 500, 503, timeouts, connection resets).
 *   accountLevel   the account itself is refused: out of credit, bad key,
 *                  permission revoked, hard quota. Retrying is pointless, this
 *                  is the same answer for EVERY lead, and it needs a human.
 *   other          a genuine bad request from our own code. Retrying is also
 *                  pointless, but it is our bug, not a billing problem.
 *
 * Deliberately not a circuit breaker, not a health table, not a new subsystem.
 * The alerting, throttling and health machinery all already exist; they were
 * only ever missing the answer to "is this worth retrying, and what do I tell
 * him".
 */

export type LLMFailureKind = "transient" | "account" | "other";

export interface LLMFailure {
  kind: LLMFailureKind;
  /** Retrying this exact call has a real chance of a different answer. */
  retryable: boolean;
  /** One plain sentence fit to put in front of a human, no JSON envelope. */
  message: string;
  /** The provider's HTTP status when we could find one. */
  status: number | null;
}

/** Anthropic errors carry `status`; some wrappers only stringify. Try both. */
function readStatus(err: unknown): number | null {
  const e = err as { status?: unknown; statusCode?: unknown } | null;
  const direct = typeof e?.status === "number" ? e.status
    : typeof e?.statusCode === "number" ? e.statusCode
    : null;
  if (direct) return direct;
  // The SDK stringifies as `400 {json}` and some call sites only keep the text.
  const m = /^\s*(\d{3})\b/.exec(errText(err));
  return m ? Number(m[1]) : null;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message ?? "";
  if (typeof err === "string") return err;
  // JSON.stringify returns undefined for undefined and for a function, so the
  // ?? is load-bearing: without it this returned undefined and every caller's
  // .trim() threw, turning a failure handler into a second failure.
  try { return JSON.stringify(err) ?? String(err); } catch { return String(err); }
}

/**
 * Pull the human sentence out of Anthropic's JSON envelope.
 *
 * The raw text is 194 characters of which the first 71 are pure envelope, so a
 * naive slice(0, 140) keeps mostly punctuation and throws away the instruction.
 * Falls back to the whole string when it is not the shape we expect.
 */
export function humanMessage(err: unknown): string {
  const raw = errText(err);
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`).trim();
    } catch {
      return m[1].replace(/\\"/g, '"').trim();
    }
  }
  return raw.trim();
}

const ACCOUNT_PATTERNS = [
  /credit balance is too low/i,
  /purchase credits/i,
  /insufficient (?:credit|funds|quota|balance)/i,
  /billing/i,
  /exceeded your current quota/i,
  /invalid x-api-key/i,
  /authentication[_ ]error/i,
  /permission[_ ]error/i,
  /organization has been disabled/i,
  /out of usage credits/i,
];

/**
 * Classify a thrown LLM error. Never throws, always returns something usable.
 */
export function classifyLLMError(err: unknown): LLMFailure {
  const status = readStatus(err);
  const message = humanMessage(err);
  const raw = errText(err);

  // Account-level first: a 400 that says "credit balance" is NOT the same
  // animal as a 400 from a malformed request, and only the text tells them
  // apart. 401/403 are always account-level whatever they say.
  if (ACCOUNT_PATTERNS.some((p) => p.test(raw)) || status === 401 || status === 403) {
    return { kind: "account", retryable: false, message, status };
  }

  // 429 is a rate limit: genuinely transient, the SDK already backs off.
  // 5xx and 529 (overloaded) are the model wobbling. Everything network-shaped
  // has no status at all.
  if (status === 429 || status === 529 || (status !== null && status >= 500) || status === null) {
    return { kind: "transient", retryable: true, message, status };
  }

  // A remaining 4xx is our own bad request. Retrying re-sends the same bad
  // request, so it is pointless, but it is a bug rather than a billing wall.
  return { kind: "other", retryable: false, message, status };
}

/**
 * The sentence the owner should read. Account failures get the action attached,
 * because "your credits ran out" without "top up here" is half a message.
 */
export function ownerSentence(f: LLMFailure): string {
  if (f.kind === "account") {
    return `The AI brain is switched off at the account level: ${f.message} Nothing can reply to anyone until that is fixed at console.anthropic.com under Plans and Billing. Turning on auto-reload there stops it happening again.`;
  }
  if (f.kind === "other") {
    return `The AI brain rejected our request${f.status ? ` (${f.status})` : ""}: ${f.message} That is a bug on our side, not a billing problem.`;
  }
  return `The AI brain failed to answer${f.status ? ` (${f.status})` : ""}: ${f.message}`;
}
