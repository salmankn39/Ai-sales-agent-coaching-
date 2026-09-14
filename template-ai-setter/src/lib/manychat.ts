/**
 * ============================================================================
 * MANYCHAT CLIENT — send Instagram VOICE NOTES in the operator's cloned voice
 * ============================================================================
 * GoHighLevel can carry our text replies into the IG DM, but it can NOT deliver
 * a real Instagram voice note (an mp3 attachment just doesn't land as a playable
 * voice message). ManyChat CAN: its IG "audio" message type renders a genuine
 * voice note in the DM — as long as the file is WAV (it rejects mp3 with IG
 * error 3046). So the setter speaks a reply by:
 *   1. generating the clip as a hosted WAV (see lib/voice.ts makeVoiceClipWav),
 *   2. resolving the lead -> their ManyChat subscriber id (by IG name), and
 *   3. POSTing it through ManyChat's sendContent API.
 *
 * Text bubbles still go through GHL. Voice is just DELIVERED here.
 *
 * SAFETY: every call is best-effort and returns a result object (never throws),
 * so the caller can fall back to sending the spoken words as plain text — a
 * ManyChat hiccup can never drop a reply.
 *
 * Auth: per-client Private API token in clients.manychat_api_token (Supabase).
 * ============================================================================
 */
import { supabase } from "./supabase";

const MC_BASE = "https://api.manychat.com";

/**
 * Fire-and-forget diagnostic write (Vercel logs don't surface our console
 * output for hard cases). Records the raw ManyChat response so delivery can be
 * inspected from Supabase. Never throws.
 */
function writeDiag(kind: string, data: unknown): void {
  supabase
    .from("webhook_debug_logs")
    .insert({ parse_result: kind, extracted_data: data as never })
    .then(undefined, () => {});
}

/** One authenticated ManyChat API call. Returns status + parsed body; never
 *  throws. `raw` is the UNPARSED response text - load-bearing for reading
 *  Instagram ids, see readBigIntField. */
async function mc(
  token: string,
  path: string,
  init?: RequestInit
): Promise<{ status: number; ok: boolean; body: unknown; raw: string }> {
  try {
    const res = await fetch(`${MC_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
    const raw = await res.text();
    let body: unknown = raw;
    try { body = JSON.parse(raw); } catch { /* keep raw text */ }
    return { status: res.status, ok: res.ok, body, raw };
  } catch (e) {
    return { status: 0, ok: false, body: e instanceof Error ? e.message : "fetch_failed", raw: "" };
  }
}

/**
 * READ A HUGE NUMERIC ID WITHOUT LOSING DIGITS.
 *
 * PROVEN LIVE, 2026-08-14: ManyChat returns `ig_id` as a JSON NUMBER, and
 * Instagram's newer ids are 17 digits - past JavaScript's safe integer ceiling
 * (Number.MAX_SAFE_INTEGER is 9007199254740991, 16 digits). JSON.parse
 * silently ROUNDS them:
 *
 *   freyalindqvist  raw 26981294764882514  ->  parsed 26981294764882510
 *   arabiconly      raw 27820315540995794  ->  parsed 27820315540995790
 *
 * GoHighLevel returns the same id as a STRING, intact. So a parsed ManyChat id
 * compared against GHL's would falsely MISMATCH for every 17-digit account -
 * and, worse, storing the parsed value would write a permanently wrong
 * identity into our own database. Reading the digits out of the raw text
 * before any parser touches them is the only safe way.
 */
export function readBigIntField(raw: string, field: string): string | null {
  const m = new RegExp(`"${field}"\\s*:\\s*"?(\\d+)"?`).exec(raw || "");
  return m ? m[1] : null;
}

/**
 * Resolve a lead to their ManyChat subscriber id by trying each candidate name
 * (IG display name, then @handle) against ManyChat's findByName. Returns the
 * first match's id, or null if none of the names resolve. Never throws.
 */
export async function resolveSubscriberId(
  token: string,
  candidateNames: Array<string | null | undefined>
): Promise<string | null> {
  if (!token) return null;
  for (const raw of candidateNames) {
    const name = (raw || "").replace(/^@/, "").trim();
    if (!name) continue;
    const found = await mc(token, `/fb/subscriber/findByName?name=${encodeURIComponent(name)}`);
    const data = (found.body as { data?: unknown })?.data;
    const first = (Array.isArray(data) ? data[0] : data) as { id?: unknown } | undefined;
    const id = first?.id != null ? String(first.id) : "";
    if (id) return id;
  }
  return null;
}

/**
 * Fetch a subscriber's real identity (name + IG handle) straight from ManyChat
 * using their subscriber id.
 *
 * WHY THIS EXISTS (2026-07-26): ManyChat's webhook posts whatever fields the
 * flow was configured with, and when a merge field is unset it sends the
 * LITERAL template ("{{full_name}}"), which the inbound route correctly
 * rejects as garbage — leaving us a subscriber id and nothing else. A lead
 * minted from that has NO name, NO handle and NO Instagram id, so nothing can
 * ever match it to the same human's GHL-side row. Live: Oliver
 * (oliverbutcherr) forked into TWO lead rows 4 seconds apart and got TWO
 * parallel AI conversations; pausing one left the other talking.
 *
 * Asking ManyChat directly closes that hole at the source. Never throws.
 */
export async function fetchSubscriberInfo(
  token: string,
  subscriberId: string
): Promise<{
  name: string | null;
  igUsername: string | null;
  /** Instagram's own permanent user id for this person. The SAME value GHL
   *  stores as contact.attributionSource.igSid, which makes it the one key
   *  that ties a ManyChat subscriber to a CRM contact with certainty (a
   *  handle can be renamed; this cannot). Read digit-exact - see
   *  readBigIntField. */
  igSenderId: string | null;
} | null> {
  if (!token || !subscriberId) return null;
  const res = await mc(
    token,
    `/fb/subscriber/getInfo?subscriber_id=${encodeURIComponent(subscriberId)}`
  );
  if (!res.ok) {
    writeDiag("manychat_getinfo_failed", { subscriberId, status: res.status, body: res.body });
    return null;
  }
  const d = (res.body as { data?: Record<string, unknown> } | undefined)?.data;
  if (!d) return null;
  const pick = (v: unknown): string | null => {
    const s = typeof v === "string" ? v.trim() : "";
    // Same guard as the inbound door: an unrendered template is not an identity.
    if (!s || s.includes("{{") || s.includes("}}")) return null;
    return s;
  };
  const first = pick(d["first_name"]);
  const last = pick(d["last_name"]);
  const name =
    pick(d["name"]) ||
    ([first, last].filter(Boolean).join(" ").trim() || null);
  const igUsername = pick(d["ig_username"]) || pick(d["user_name"]);
  // From the RAW text, never from the parsed object (17-digit ids round).
  const igSenderId = readBigIntField(res.raw, "ig_id");
  return { name, igUsername, igSenderId };
}

export interface ManychatSendResult {
  success: boolean;
  status?: number;
  error?: string;
}

/**
 * Send a plain TEXT message to a ManyChat subscriber's Instagram DM.
 * This is the BACKUP text channel: normal text always goes through GHL, but
 * when GHL's contact record has been deleted mid-conversation (it happens —
 * contacts get merged/cleaned inside GHL), GHL rejects every send with
 * "Contact not found" while ManyChat can still reach the SAME Instagram
 * thread. Best-effort: returns success:false (never throws).
 */
/**
 * DELIVERED MEANS MANYCHAT SAID SO, IN THE BODY.
 *
 * Owner rule (2026-08-12, after live ghost replies): "the setter can never
 * think it has replied unless the message successfully showed up on ManyChat
 * with no errors whatsoever. That's the only time you can assume a message has
 * been sent."
 *
 * `res.ok` alone cannot promise that: ManyChat answers HTTP 200 with
 * {"status":"error", ...} in the BODY for a whole class of real failures.
 * Trusting the status line stamped those sends delivered, the engine walked
 * away believing it had replied, and the lead sat ignored - the exact
 * disappeared-mid-conversation incidents the owner caught by hand. A send counts
 * ONLY when the transport succeeded AND the body's own verdict is success.
 * An OK response whose body carries no readable verdict is treated as FAILED:
 * a rare retry against an already-delivered message knocks on the duplicate
 * gate; a ghost reply is invisible until a human notices a silent lead.
 */
function manychatConfirmed(res: { status: number; ok: boolean; body: unknown }): boolean {
  if (!res.ok) return false;
  const b = res.body as { status?: unknown } | null;
  return !!b && typeof b === "object" && String((b as { status?: unknown }).status).toLowerCase() === "success";
}

export async function sendManychatText(
  token: string,
  subscriberId: string,
  text: string
): Promise<ManychatSendResult> {
  const body = (text || "").trim();
  if (!token || !subscriberId || !body) {
    return { success: false, error: "missing token/subscriber/text" };
  }
  const res = await mc(token, `/fb/sending/sendContent`, {
    method: "POST",
    body: JSON.stringify({
      subscriber_id: subscriberId,
      data: {
        version: "v2",
        content: { type: "instagram", messages: [{ type: "text", text: body }] },
      },
    }),
  });
  writeDiag("manychat_text_send", { subscriberId, status: res.status, ok: res.ok, body: res.body });
  const confirmed = manychatConfirmed(res);
  return {
    success: confirmed,
    status: res.status,
    error: confirmed ? undefined : JSON.stringify(res.body).slice(0, 300),
  };
}

/**
 * Send an IMAGE to a ManyChat subscriber's Instagram DM.
 * Used by the follow-up engine's image touch (previously a GHL attachment).
 * Best-effort: returns success:false, never throws.
 */
export async function sendManychatImage(
  token: string,
  subscriberId: string,
  imageUrl: string
): Promise<ManychatSendResult> {
  if (!token || !subscriberId || !imageUrl) {
    return { success: false, error: "missing token/subscriber/url" };
  }
  const res = await mc(token, `/fb/sending/sendContent`, {
    method: "POST",
    body: JSON.stringify({
      subscriber_id: subscriberId,
      data: {
        version: "v2",
        content: { type: "instagram", messages: [{ type: "image", url: imageUrl }] },
      },
    }),
  });
  writeDiag("manychat_image_send", { subscriberId, status: res.status, ok: res.ok, body: res.body });
  const confirmed = manychatConfirmed(res);
  return {
    success: confirmed,
    status: res.status,
    error: confirmed ? undefined : JSON.stringify(res.body).slice(0, 300),
  };
}

/**
 * Send a hosted WAV as an Instagram voice note to a ManyChat subscriber.
 * The clip MUST be WAV — ManyChat/Instagram reject mp3 (error 3046).
 * Best-effort: returns success:false (never throws) so the caller can fall
 * back to text.
 */
export async function sendManychatVoice(
  token: string,
  subscriberId: string,
  wavUrl: string
): Promise<ManychatSendResult> {
  if (!token || !subscriberId || !wavUrl) {
    return { success: false, error: "missing token/subscriber/url" };
  }
  const res = await mc(token, `/fb/sending/sendContent`, {
    method: "POST",
    body: JSON.stringify({
      subscriber_id: subscriberId,
      data: {
        version: "v2",
        content: { type: "instagram", messages: [{ type: "audio", url: wavUrl }] },
      },
    }),
  });
  writeDiag("manychat_voice_send", { subscriberId, status: res.status, ok: res.ok, body: res.body });
  const confirmed = manychatConfirmed(res);
  return {
    success: confirmed,
    status: res.status,
    error: confirmed ? undefined : JSON.stringify(res.body).slice(0, 300),
  };
}
