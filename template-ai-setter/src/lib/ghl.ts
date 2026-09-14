/**
 * GoHighLevel API client.
 *
 * Used for OUTBOUND only — sending replies back to leads via GHL,
 * which forwards them to Instagram DMs.
 *
 * INBOUND messages come in via webhooks (see /app/api/webhook/ghl/route.ts).
 *
 * Auth: Uses a Private Integration Token (PIT) per location. Stored in
 * the clients.ghl_api_key column in Supabase, encrypted in production.
 *
 * For V1, we keep it unencrypted since there's only one client (you).
 * When we onboard real clients we'll add proper encryption with libsodium.
 */

const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-04-15"; // Required header version (messaging + conversations)
// Tag add/remove endpoints expect the contacts API version.
const GHL_TAGS_API_VERSION = "2021-07-28";

import { supabase } from "./supabase";
import { sendManychatVoice, sendManychatText } from "./manychat";
import { scrubOutboundText } from "./outbound";

// Re-exported for callers that import it from here (and the regression test).
export { scrubOutboundText } from "./outbound";

/**
 * Fire-and-forget diagnostic write to a table we can read back from Supabase.
 * Vercel's runtime log tooling doesn't surface our console output, so for hard
 * cases (e.g. why an IG voice note's attachment can't be found) we record the
 * raw API shape here and inspect it directly. Never throws.
 */
function writeDiag(kind: string, data: unknown): void {
  supabase
    .from("webhook_debug_logs")
    .insert({ parse_result: kind, extracted_data: data as never })
    .then(undefined, () => {});
}

export interface SendMessageParams {
  ghl_api_key: string;        // Per-location PIT
  ghl_location_id: string;    // The GHL sub-account ID
  ghl_contact_id: string;     // Who to send to
  message: string;            // The text to send (may be "" when sending audio only)
  type?: "IG" | "SMS" | "Email" | "WhatsApp" | "FB";  // Channel
  attachments?: string[];     // Public file URLs (e.g. an mp3 voice note). Optional.
}

export interface SendMessageResult {
  success: boolean;
  ghl_message_id?: string;
  error?: string;
  // 'manychat' when the bubble was delivered through the ManyChat channel —
  // the PRIMARY text/voice channel since 2026-07-10 (see sendGHLMixedSequence).
  via?: "manychat";
  // true ONLY when the bubble went out via ManyChat because GHL rejected the
  // send with contact-not-found — the "GHL deleted this contact" alarm keys on
  // this, NOT on via (which is now the normal case, not an outage signal).
  ghl_gone?: boolean;
}

/**
 * GHL rejects every send to a contact that no longer exists with
 * CONVERSATIONS_CONTACT_NOT_FOUND. This happens MID-CONVERSATION when a
 * contact gets merged or cleaned up inside GHL (observed live 2026-07-01 on an
 * active lead at the booking step: contact deleted between two messages, GHL
 * went silent on her inbound AND rejected all sends). It is a permanent
 * failure for that contact id — never a transient blip.
 */
export function isGhlContactGone(error?: string): boolean {
  return /CONTACT_NOT_FOUND|contact not found/i.test(error || "");
}

/**
 * Send a single message via GHL → Instagram DM.
 *
 * A reply must NEVER silently fail (the owner's rule: "our msgs should never fail,
 * voice or text"). A transient network blip or a GHL 5xx/429 is retried a few
 * times with a short backoff before we give up; permanent 4xx errors return
 * immediately (retrying won't help). Voice notes never come through here for a
 * client on ManyChat — they go via sendManychatVoice; this is the text path
 * (and the text fallback when a voice send can't land).
 */
const GHL_SEND_MAX_ATTEMPTS = 3;

/**
 * ============================================================================
 * NO SEND SURFACE LIVES HERE ANYMORE (2026-07-26, operator's instruction)
 * ============================================================================
 * The owner: "NO NO GHL AT ALL!!!! just pretend as if ghl cant send msgs or
 * anything!!! imagine if we were only using manychat!!!! and ghl happens to be
 * our crm like hubspot or monday."
 *
 * sendGHLMessage, sendGHLMessageSequence and sendGHLMixedSequence used to live
 * at this spot. They are GONE, not disabled. Every message to a lead now leaves
 * through lib/send.ts, which talks to ManyChat and nothing else.
 *
 * The GHL fallback they contained was protecting against nothing: of 37 failed
 * ManyChat sends in the system's history, 36 were the free-plan 401 (the
 * account has been Pro since 2026-07-10) and the 1 remaining was Instagram's
 * 24-hour messaging window — a META rule that binds GoHighLevel identically,
 * so GHL could not have delivered it either.
 *
 * What remains in this file is CRM only: contacts, tags, calendar slots,
 * opportunities, pipeline stages. If you are here to add a way to message a
 * lead, you are in the wrong file — use lib/send.ts.
 * ============================================================================
 */

/** Standard auth headers for GHL v2 API calls. */
function ghlHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: GHL_API_VERSION,
    Accept: "application/json",
  };
}

// ===========================================================================
// CONTACT TAGS (used by the ICP screener + ongoing tagging)
// ---------------------------------------------------------------------------
// GHL lowercases all tags. Tags we use: icp, qualified, biz owner, friend,
// needs review (plus the pause tag "ai off").
//   Add:    POST   /contacts/{id}/tags  body {"tags":[...]}
//   Remove: DELETE /contacts/{id}/tags  body {"tags":[...]}
// Headers: Authorization: Bearer {key}, Version: 2021-07-28, Content-Type: json
// ===========================================================================

export interface TagResult {
  success: boolean;
  status?: number;
  error?: string;
}

/** Headers for the contacts/tags endpoints. */
function ghlTagHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: GHL_TAGS_API_VERSION,
    "Content-Type": "application/json",
  };
}

/**
 * Fetch a contact's CURRENT tags directly from GHL (a live read, not our own
 * cached/logged state). Used by the fast ManyChat inbound trigger to check for
 * a stop tag before firing an ack: that path has no GHL webhook payload to read
 * body.tags from (the only signal the normal inbound path uses), and a locally
 * logged "we've seen a stop tag before" event can lag a tag the owner JUST added.
 * Best-effort: returns null on ANY failure. The caller treats null the same as
 * "no stop tag found" (fails OPEN, matching lib/bans.ts's own precedent — a
 * missed check here is recoverable on the very next message via the normal GHL
 * path's own live tag read, so a transient GHL hiccup must never silently make
 * every ack in the system fragile).
 */
export async function getContactTags(
  apiKey: string,
  contactId: string
): Promise<string[] | null> {
  const url = `${GHL_API_BASE}/contacts/${contactId}`;
  try {
    const response = await fetch(url, { method: "GET", headers: ghlTagHeaders(apiKey) });
    if (!response.ok) {
      console.error("[ghl] getContactTags failed:", response.status);
      return null;
    }
    const data = await response.json();
    const tags = (data as { contact?: { tags?: unknown } })?.contact?.tags;
    return Array.isArray(tags) ? tags.map((t) => String(t)) : null;
  } catch (err) {
    console.error("[ghl] getContactTags threw:", err);
    return null;
  }
}

/**
 * Search GHL's contact list for a person by display name and return the best
 * EXACT (case-insensitive) match, newest-updated first. This is the ManyChat-
 * first inbound's "does GHL already know this person?" check before it mints a
 * lead: attaching GHL's existing contact at creation kills duplicate leads at
 * the root AND puts the contact's tags (e.g. the "ai off" opt-out) in front of
 * every gate — a person the operator turned the AI off for months ago must
 * stay off no matter which pipe their message arrives through (live: joana,
 * tagged "ai off" since May, nearly re-engaged via ManyChat 2026-07-10).
 * Best-effort: null on any failure or no exact match.
 */
export async function searchContactByName(
  apiKey: string,
  locationId: string,
  name: string
): Promise<{ id: string; tags: string[] } | null> {
  const q = (name || "").trim();
  if (!q) return null;
  try {
    const url = `${GHL_API_BASE}/contacts/?locationId=${encodeURIComponent(locationId)}&query=${encodeURIComponent(q)}`;
    const response = await fetch(url, { method: "GET", headers: ghlTagHeaders(apiKey) });
    if (!response.ok) {
      console.error("[ghl] searchContactByName failed:", response.status);
      return null;
    }
    const data = (await response.json()) as {
      contacts?: { id: string; contactName?: string | null; tags?: unknown; dateUpdated?: string | null }[];
    };
    const exact = (data.contacts ?? []).filter(
      (c) => (c.contactName || "").trim().toLowerCase() === q.toLowerCase()
    );
    exact.sort(
      (a, b) => new Date(b.dateUpdated ?? 0).getTime() - new Date(a.dateUpdated ?? 0).getTime()
    );
    const hit = exact[0];
    if (!hit?.id) return null;
    return { id: hit.id, tags: Array.isArray(hit.tags) ? hit.tags.map((t) => String(t)) : [] };
  } catch (err) {
    console.error("[ghl] searchContactByName threw:", err);
    return null;
  }
}

/**
 * FIND A CONTACT BY INSTAGRAM HANDLE — the identity GHL actually stores.
 *
 * WHY (live audit 2026-08-14): GoHighLevel's Instagram integration creates the
 * contact with the HANDLE as its contactName ("codybrown____"), because that is
 * all Instagram gives it. Our lookups only ever searched `full_name`, which is
 * NULL for every ManyChat-first lead - so nothing ever attached. Measured on
 * the live database: 9 of 9 contact-less active leads had an exact
 * handle-named contact sitting in GHL, unattached. The cost was silent and
 * total: no CRM card, no CRM notes (the owner's "zero notes" complaint), and
 * the inbox read-back had no thread to read (10/10 verdicts "unreadable").
 *
 * A handle is STRONGER evidence than a display name, not weaker: Instagram
 * handles are globally unique, so an exact match is the same person, whereas
 * two humans share "John Smith" all the time. Exactness is enforced by
 * searchContactByName, which only ever returns an exact contactName match.
 */
export async function searchContactByIgHandle(
  apiKey: string,
  locationId: string,
  handle: string
): Promise<{ id: string; tags: string[] } | null> {
  const h = (handle || "").trim().replace(/^@/, "");
  if (!h) return null;
  return searchContactByName(apiKey, locationId, h);
}

/**
 * Find a contact by email. GHL dedupes on email/phone, so this is the right
 * lookup before minting a contact for someone who gave us their email
 * directly (the Founder Profile's public link), as opposed to the name/handle
 * lookups above, which exist for Instagram threads with no email at all.
 */
export async function searchContactByEmail(
  apiKey: string,
  locationId: string,
  email: string
): Promise<{ id: string; tags: string[] } | null> {
  const q = (email || "").trim().toLowerCase();
  if (!q) return null;
  try {
    const url = `${GHL_API_BASE}/contacts/?locationId=${encodeURIComponent(locationId)}&query=${encodeURIComponent(q)}`;
    const response = await fetch(url, { method: "GET", headers: ghlTagHeaders(apiKey) });
    if (!response.ok) {
      console.error("[ghl] searchContactByEmail failed:", response.status);
      return null;
    }
    const data = (await response.json()) as {
      contacts?: { id: string; email?: string | null; tags?: unknown }[];
    };
    const hit = (data.contacts ?? []).find((c) => (c.email || "").trim().toLowerCase() === q);
    if (!hit?.id) return null;
    return { id: hit.id, tags: Array.isArray(hit.tags) ? hit.tags.map((t) => String(t)) : [] };
  } catch (err) {
    console.error("[ghl] searchContactByEmail threw:", err);
    return null;
  }
}

/**
 * Create a new GHL contact from a name and email. Used only after
 * searchContactByEmail found nothing, so this never mints a duplicate for
 * someone who already exists. Best-effort: null on any failure, the caller
 * decides what "no contact" means for its own flow.
 */
export async function createContact(
  apiKey: string,
  locationId: string,
  params: { name: string; email: string; source?: string; tags?: string[] }
): Promise<{ id: string } | null> {
  try {
    const response = await fetch(`${GHL_API_BASE}/contacts/`, {
      method: "POST",
      headers: ghlTagHeaders(apiKey),
      body: JSON.stringify({
        locationId,
        name: params.name || undefined,
        email: params.email || undefined,
        source: params.source || "Founder Profile",
        tags: params.tags || [],
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ghl] createContact failed:", response.status, errorText);
      return null;
    }
    const data = (await response.json()) as { contact?: { id?: string } };
    const id = data.contact?.id;
    return id ? { id } : null;
  } catch (err) {
    console.error("[ghl] createContact threw:", err);
    return null;
  }
}

/**
 * CREATE an opportunity (a CARD in a sales pipeline) for a contact.
 *
 * WHY THIS EXISTS (2026-07-26): GHL's inbound webhook used to be the thing that
 * put a new DM lead on the board. It's retired — it was a second ear and a
 * second brain on the same Instagram inbox and it forked people into twin lead
 * rows with two AIs.
 *
 * The CONTACT does not need creating: GoHighLevel's own Instagram integration
 * has made one automatically the moment someone replies, for years, entirely
 * independently of the setter. Creating another would just duplicate it. What
 * is missing is the OPPORTUNITY — the operator works his AI Sales Pipeline by
 * card, and wants a new DM to land at "New Lead" and then advance through the
 * stages as the setter works them.
 *
 * Best-effort by design: a lead is NEVER blocked on the CRM. On any failure we
 * return null; the conversation runs over ManyChat regardless.
 */
export async function createOpportunity(params: {
  apiKey: string;
  locationId: string;
  contactId: string;
  pipelineId: string;
  pipelineStageId: string;
  name: string;
}): Promise<string | null> {
  const body = {
    pipelineId: params.pipelineId,
    pipelineStageId: params.pipelineStageId,
    locationId: params.locationId,
    contactId: params.contactId,
    name: params.name || "Instagram lead",
    status: "open",
  };
  try {
    const res = await fetch(`${GHL_API_BASE}/opportunities/`, {
      method: "POST",
      headers: ghlTagHeaders(params.apiKey),
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let parsed: unknown = raw;
    try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
    if (!res.ok) {
      writeDiag("ghl_create_opportunity_failed", { status: res.status, body: parsed, params: body });
      return null;
    }
    const id = (parsed as { opportunity?: { id?: unknown } })?.opportunity?.id;
    return typeof id === "string" && id ? id : null;
  } catch (err) {
    writeDiag("ghl_create_opportunity_threw", {
      error: err instanceof Error ? err.message : String(err),
      params: body,
    });
    return null;
  }
}

export interface ContactDetail {
  tags: string[];
  /** Durable Instagram sender id (igSid), if this contact came from Instagram. */
  igSenderId: string | null;
  name: string | null;
}

/**
 * Fetch a contact's tags + durable Instagram sender id (igSid) in ONE call.
 * Used by the GHL-gap ingest sweep, which has no webhook payload to read igSid
 * from: it must ask GHL who this conversation's contact really is so a message
 * landing on a duplicate/merged contact resolves to the SAME lead as the live
 * webhook path (see lib/supabase.ts findLeadByIdentity). Best-effort: returns
 * null on any failure (the caller falls back to contact-id keying).
 */
export async function getContactDetail(
  apiKey: string,
  contactId: string
): Promise<ContactDetail | null> {
  const url = `${GHL_API_BASE}/contacts/${contactId}`;
  try {
    const response = await fetch(url, { method: "GET", headers: ghlTagHeaders(apiKey) });
    if (!response.ok) {
      console.error("[ghl] getContactDetail failed:", response.status);
      return null;
    }
    const data = await response.json();
    const contact = (data as { contact?: Record<string, unknown> })?.contact ?? {};
    const tags = Array.isArray(contact.tags) ? contact.tags.map((t) => String(t)) : [];
    const attr = (contact.attributionSource ?? {}) as { igSid?: unknown };
    const lastAttr = (contact.lastAttributionSource ?? {}) as { igSid?: unknown };
    const igSenderId =
      (typeof attr.igSid === "string" && attr.igSid) ||
      (typeof lastAttr.igSid === "string" && lastAttr.igSid) ||
      null;
    const name =
      (typeof contact.contactName === "string" && contact.contactName) ||
      [contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
      null;
    return { tags, igSenderId, name };
  } catch (err) {
    console.error("[ghl] getContactDetail threw:", err);
    return null;
  }
}

/** Add one or more tags to a GHL contact. Tags are lowercased by GHL. */
export async function addContactTags(
  apiKey: string,
  contactId: string,
  tags: string[]
): Promise<TagResult> {
  const url = `${GHL_API_BASE}/contacts/${contactId}/tags`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: ghlTagHeaders(apiKey),
      body: JSON.stringify({ tags }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ghl] addContactTags failed:", response.status, errorText);
      return { success: false, status: response.status, error: errorText };
    }
    return { success: true, status: response.status };
  } catch (err) {
    console.error("[ghl] addContactTags threw:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Remove one or more tags from a GHL contact.
 * DELETE with a JSON body — fetch() supports a body on DELETE.
 */
export async function removeContactTags(
  apiKey: string,
  contactId: string,
  tags: string[]
): Promise<TagResult> {
  const url = `${GHL_API_BASE}/contacts/${contactId}/tags`;
  try {
    const response = await fetch(url, {
      method: "DELETE",
      headers: ghlTagHeaders(apiKey),
      body: JSON.stringify({ tags }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ghl] removeContactTags failed:", response.status, errorText);
      return { success: false, status: response.status, error: errorText };
    }
    return { success: true, status: response.status };
  } catch (err) {
    console.error("[ghl] removeContactTags threw:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Set the email on a GHL contact. GHL dedupes contacts by email/phone, so
 * writing the lead's email onto the existing Instagram contact BEFORE they book
 * makes the calendar booking attach to that SAME contact instead of spawning a
 * duplicate (the IG contact otherwise has no email to match on). Best-effort.
 */
export async function updateContactEmail(
  apiKey: string,
  contactId: string,
  email: string
): Promise<TagResult> {
  const url = `${GHL_API_BASE}/contacts/${contactId}`;
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: ghlTagHeaders(apiKey),
      body: JSON.stringify({ email }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ghl] updateContactEmail failed:", response.status, errorText);
      return { success: false, status: response.status, error: errorText };
    }
    return { success: true, status: response.status };
  } catch (err) {
    console.error("[ghl] updateContactEmail threw:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Add a note to a GHL contact. Used for the closer's pre-call summary, written
 * onto the contact the moment a lead books a call (see lib/closer-brief.ts),
 * so the human closer has real context instead of a cold contact card.
 * Best-effort: a failed write here must never affect the booking itself.
 *
 *   POST /contacts/{id}/notes   body {"body": "..."}
 *   Headers: Authorization, Version 2021-07-28, Content-Type
 */
export async function addContactNote(
  apiKey: string,
  contactId: string,
  body: string
): Promise<TagResult> {
  const url = `${GHL_API_BASE}/contacts/${contactId}/notes`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: ghlTagHeaders(apiKey),
      body: JSON.stringify({ body }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ghl] addContactNote failed:", response.status, errorText);
      return { success: false, status: response.status, error: errorText };
    }
    return { success: true, status: response.status };
  } catch (err) {
    console.error("[ghl] addContactNote threw:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Permanently DELETE a contact from GHL.
 *
 * Used by the first-contact screener to erase unsolicited service-pitch
 * spammers (people who DM us cold trying to sell us services) so they vanish
 * from the CRM entirely — no contact, no conversation, no trace. This is
 * irreversible in GHL, so the screener only calls it on a CLEAR pitch with
 * zero prior history. Best-effort: returns success:false on failure (the
 * caller logs it) rather than throwing into the webhook background task.
 *
 *   DELETE /contacts/{id}   Headers: Authorization, Version 2021-07-28
 */
export async function deleteContact(
  apiKey: string,
  contactId: string
): Promise<TagResult> {
  const url = `${GHL_API_BASE}/contacts/${contactId}`;
  try {
    const response = await fetch(url, {
      method: "DELETE",
      headers: ghlTagHeaders(apiKey),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ghl] deleteContact failed:", response.status, errorText);
      return { success: false, status: response.status, error: errorText };
    }
    return { success: true, status: response.status };
  } catch (err) {
    console.error("[ghl] deleteContact threw:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ===========================================================================
// CONTACT NOTES (the CRM paper trail — owner ask 2026-08-13)
// ---------------------------------------------------------------------------
// "We agreed that the AI would be taking notes... as the conversation goes on
// consistently." A note is a CRM write, which is exactly what GHL still IS in
// this architecture. Best-effort: a failed note must never affect a reply.
// ===========================================================================

export async function createContactNote(
  apiKey: string,
  contactId: string,
  body: string
): Promise<boolean> {
  if (!apiKey || !contactId || !body.trim()) return false;
  try {
    const res = await fetch(`${GHL_API_BASE}/contacts/${encodeURIComponent(contactId)}/notes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: GHL_TAGS_API_VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ body: body.slice(0, 5000) }),
    });
    if (!res.ok) {
      console.error("[ghl] createContactNote failed:", res.status, (await res.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error("[ghl] createContactNote threw:", e instanceof Error ? e.message : e);
    return false;
  }
}

// ===========================================================================
// CONVERSATION HISTORY (used by the first-contact screener)
// ---------------------------------------------------------------------------
//   GET /conversations/search?locationId={loc}&contactId={id} -> conversationId
//   GET /conversations/{conversationId}/messages              -> messages
// ===========================================================================

export interface ThreadMessage {
  /**
   * BACKWARDS-COMPATIBLE authorship label. fetchContactThread still emits only
   * "lead" (inbound) and "ai" (outbound), exactly as it always has, so the
   * existing readers keep working unchanged.
   *
   * "human" is in the union for callers that RESOLVE authorship afterwards
   * (lib/conversation-sync.ts). WHY that matters: GHL cannot tell us who typed
   * an outbound message, so mapping every outbound to "ai" LAUNDERS the
   * operator's own hand-typed Instagram replies into the setter's. That
   * laundering is a direct ingredient of the 2026-08-08 incident, where the
   * setter cold-opened people the operator was personally mid-conversation
   * with. Read `direction` and decide; do not trust `role` for outbound.
   */
  role: "lead" | "ai" | "human";
  /** The raw, un-laundered fact GHL actually gives us: which way it travelled. */
  direction: "inbound" | "outbound";
  content: string;
  created_at: string;
  /** GHL's own id for this message. Used by the gap-ingest sweep for exact
   *  dedupe (the same physical message keeps one id even when GHL surfaces
   *  the thread under two merged/duplicated contacts). */
  ghl_message_id?: string;
  /** GHL's message type string when present ("TYPE_INSTAGRAM", ...). */
  message_type?: string;
  /** True when `content` is a placeholder we synthesised for a media message
   *  (see mediaPlaceholder) rather than words anyone actually wrote. */
  is_media?: boolean;
}

// A media message carries no body, so we cannot compare its TEXT with anything.
// These extension/mime hints are only used to pick a readable placeholder.
const AUDIO_HINT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|amr)(\?|$)|audio/i;
const IMAGE_HINT = /\.(jpe?g|png|gif|webp|heic|heif|bmp)(\?|$)|image|photo/i;
const VIDEO_HINT = /\.(mp4|mov|m4v|webm|avi|mkv)(\?|$)|video/i;

/**
 * Build a short stand-in for a message that has no text body.
 *
 * WHY (incident 2026-08-08): this function used to not exist — the thread
 * builder simply `continue`d past every bodyless message. A friend thread made
 * of voice notes and photos therefore read back as EMPTY history, the screener
 * concluded "no prior history, so this is a brand new lead", and the setter
 * opened cold on someone the operator was already talking to. A voice note IS
 * history. Representing it keeps thread LENGTH and RECENCY truthful even
 * though we cannot read the words.
 *
 * Returns null for genuinely contentless events (reactions, read receipts,
 * activity records), which stay skipped.
 */
function mediaPlaceholder(msg: Record<string, unknown>): string | null {
  const rawAttachments = Array.isArray(msg.attachments) ? (msg.attachments as unknown[]) : [];
  const attachments = rawAttachments
    .map((a) =>
      typeof a === "string" ? a : String((a as { url?: unknown } | null)?.url ?? "")
    )
    .filter((a) => a.length > 0);
  const contentType = String(msg.contentType ?? msg.mimeType ?? "");
  const hint = [...attachments, contentType].join(" ");

  if (!attachments.length && !/audio|image|photo|video/i.test(contentType)) return null;
  if (AUDIO_HINT.test(hint)) return "[voice note]";
  if (IMAGE_HINT.test(hint)) return "[image]";
  if (VIDEO_HINT.test(hint)) return "[video]";
  return "[attachment]";
}

/**
 * Fetch the full DM thread for a contact from GHL, oldest message first.
 *
 * Inbound messages map to role "lead"; outbound to role "ai" (so the thread
 * can be fed straight into the reply generator) AND carry direction
 * "outbound" so a caller that cares WHO typed it can resolve that itself.
 * Bodyless media messages come back as a placeholder rather than being
 * dropped. THROWS on a hard API failure
 * so the screener can fail-closed (treat a lead with history as "hold" rather
 * than risk engaging on an error). Returns [] when the contact genuinely has
 * no conversation yet.
 */
export async function fetchContactThread(
  apiKey: string,
  locationId: string,
  contactId: string
): Promise<ThreadMessage[]> {
  // 1. Find the conversation for this contact.
  const searchUrl =
    `${GHL_API_BASE}/conversations/search` +
    `?locationId=${encodeURIComponent(locationId)}` +
    `&contactId=${encodeURIComponent(contactId)}`;
  const sres = await fetch(searchUrl, { headers: ghlHeaders(apiKey) });
  if (!sres.ok) {
    const t = await sres.text();
    throw new Error(`conversation search failed: ${sres.status} ${t}`);
  }
  const sdata = await sres.json();
  const convId = sdata?.conversations?.[0]?.id;
  if (!convId) {
    // No conversation on record => no prior history.
    return [];
  }

  // 2. Pull the messages for that conversation.
  const mUrl = `${GHL_API_BASE}/conversations/${convId}/messages?limit=100`;
  const mres = await fetch(mUrl, { headers: ghlHeaders(apiKey) });
  if (!mres.ok) {
    const t = await mres.text();
    throw new Error(`get messages failed: ${mres.status} ${t}`);
  }
  const mdata = await mres.json();
  const list: Array<Record<string, unknown>> =
    mdata?.messages?.messages ?? mdata?.messages ?? [];

  // Oldest first (GHL returns newest first).
  list.sort((a, b) => {
    const da = new Date((a.dateAdded as string) || 0).getTime();
    const db = new Date((b.dateAdded as string) || 0).getTime();
    return da - db;
  });

  const thread: ThreadMessage[] = [];
  for (const msg of list) {
    const inbound = String(msg.direction || "").toLowerCase() === "inbound";
    const body = (msg.body as string) || (msg.message as string) || "";
    let content = body.trim();
    let isMedia = false;
    if (!content) {
      const placeholder = mediaPlaceholder(msg);
      if (!placeholder) continue; // genuinely contentless (reaction, receipt)
      content = placeholder;
      isMedia = true;
    }
    thread.push({
      // Outbound stays "ai" for the existing readers; conversation-sync uses
      // `direction` to work out whether it was really the operator typing.
      role: inbound ? "lead" : "ai",
      direction: inbound ? "inbound" : "outbound",
      content,
      created_at: (msg.dateAdded as string) || new Date().toISOString(),
      ghl_message_id: typeof msg.id === "string" ? msg.id : undefined,
      message_type: typeof msg.messageType === "string" ? msg.messageType : undefined,
      is_media: isMedia || undefined,
    });
  }
  return thread;
}

// ===========================================================================
// RECENT CONVERSATIONS (used by the GHL-gap ingest sweep + /api/setter/diag)
//   GET /conversations/search?locationId={loc}&limit=N&sortBy=last_message_date
// Returns the location's most recent conversations, newest first. Best-effort:
// [] on any failure — the sweep just skips this tick.
// ===========================================================================

export interface RecentConversation {
  conversationId: string;
  contactId: string;
  contactName: string | null;
  lastMessageAt: number | null; // epoch ms
  lastMessageDirection: string | null;
  lastMessageType: string | null;
  lastMessageBody: string | null;
}

export async function listRecentConversations(
  apiKey: string,
  locationId: string,
  limit = 20
): Promise<RecentConversation[]> {
  const url =
    `${GHL_API_BASE}/conversations/search` +
    `?locationId=${encodeURIComponent(locationId)}&limit=${limit}` +
    `&sortBy=last_message_date&sort=desc`;
  try {
    const res = await fetch(url, { headers: ghlHeaders(apiKey) });
    if (!res.ok) {
      console.error("[ghl] listRecentConversations failed:", res.status, await res.text());
      return [];
    }
    const data = await res.json();
    const list = (data?.conversations ?? []) as Array<Record<string, unknown>>;
    return list
      .filter((c) => typeof c.id === "string" && typeof c.contactId === "string")
      .map((c) => ({
        conversationId: c.id as string,
        contactId: c.contactId as string,
        contactName: (c.contactName as string) ?? (c.fullName as string) ?? null,
        lastMessageAt: typeof c.lastMessageDate === "number" ? c.lastMessageDate : null,
        lastMessageDirection: (c.lastMessageDirection as string) ?? null,
        lastMessageType: (c.lastMessageType as string) ?? (c.type as string) ?? null,
        lastMessageBody: typeof c.lastMessageBody === "string" ? c.lastMessageBody : null,
      }));
  } catch (err) {
    console.error("[ghl] listRecentConversations threw:", err);
    return [];
  }
}

/**
 * Return the `dateAdded` (ISO string) of the most recent INBOUND message GHL has
 * on record for this contact — i.e. WHEN GoHighLevel recorded the lead's latest
 * message. Used purely for delivery-lag observability (compare against when our
 * webhook actually fired). Returns null on any miss/failure — never throws into
 * the caller, so it can't affect the reply path.
 */
export async function getLatestInboundTimestamp(
  apiKey: string,
  locationId: string,
  contactId: string
): Promise<string | null> {
  try {
    const searchUrl =
      `${GHL_API_BASE}/conversations/search` +
      `?locationId=${encodeURIComponent(locationId)}` +
      `&contactId=${encodeURIComponent(contactId)}`;
    const sres = await fetch(searchUrl, { headers: ghlHeaders(apiKey) });
    if (!sres.ok) return null;
    const sdata = await sres.json();
    const convId = sdata?.conversations?.[0]?.id;
    if (!convId) return null;

    const mUrl = `${GHL_API_BASE}/conversations/${convId}/messages?limit=20`;
    const mres = await fetch(mUrl, { headers: ghlHeaders(apiKey) });
    if (!mres.ok) return null;
    const mdata = await mres.json();
    const list: Array<Record<string, unknown>> =
      mdata?.messages?.messages ?? mdata?.messages ?? [];

    const latestInbound = list
      .filter((m) => String(m.direction || "").toLowerCase() === "inbound")
      .sort(
        (a, b) =>
          new Date((b.dateAdded as string) || 0).getTime() -
          new Date((a.dateAdded as string) || 0).getTime()
      )[0];

    return (latestInbound?.dateAdded as string) || null;
  } catch (err) {
    console.error("[ghl] getLatestInboundTimestamp threw:", err);
    return null;
  }
}

export interface InboundMedia {
  url: string;
  messageId?: string;
}

/**
 * Pull an attachment URL out of a GHL message object, tolerating the shapes IG
 * media comes back in: `attachments` as an array of URL strings OR of objects
 * ({ url }), and the occasional `meta.attachments`.
 */
function extractAttachmentUrl(msg: Record<string, unknown> | null | undefined): string | null {
  if (!msg) return null;
  const buckets: unknown[] = [
    msg.attachments,
    (msg.meta as Record<string, unknown> | undefined)?.attachments,
  ];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const item of bucket) {
      if (typeof item === "string" && item.trim()) return item;
      if (item && typeof item === "object") {
        const url = (item as { url?: unknown }).url;
        if (typeof url === "string" && url.trim()) return url;
      }
    }
  }
  return null;
}

/** Fetch a single message by id (its attachments are sometimes only here). */
async function fetchMessageById(
  apiKey: string,
  messageId: string
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${GHL_API_BASE}/conversations/messages/${messageId}`, {
      headers: ghlHeaders(apiKey),
    });
    if (!res.ok) {
      console.error("[ghl] fetchMessageById failed:", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return (data?.message as Record<string, unknown>) ?? (data as Record<string, unknown>);
  } catch (err) {
    console.error("[ghl] fetchMessageById threw:", err);
    return null;
  }
}

/**
 * Fetch the URL of the most recent INBOUND message attachment for a contact.
 *
 * IG voice notes and images arrive in the webhook as "type 18" events with an
 * empty body and NO media URL, so the only way to get the actual file is to ask
 * the GHL conversations API for it after the fact. The attachment URL is
 * sometimes absent from the messages LIST response and only present on the
 * single-message detail, so we fall back to fetching that. Returns null if the
 * latest inbound message genuinely has no attachment (e.g. a reaction, story
 * reply, or plain text), or if the API call fails.
 */
export async function getLatestInboundAttachment(
  apiKey: string,
  locationId: string,
  contactId: string
): Promise<InboundMedia | null> {
  try {
    // 1. Find the conversation for this contact.
    const searchUrl =
      `${GHL_API_BASE}/conversations/search` +
      `?locationId=${encodeURIComponent(locationId)}` +
      `&contactId=${encodeURIComponent(contactId)}`;
    const sres = await fetch(searchUrl, { headers: ghlHeaders(apiKey) });
    if (!sres.ok) {
      console.error("[ghl] conversation search failed:", sres.status, await sres.text());
      return null;
    }
    const sdata = await sres.json();
    const convId = sdata?.conversations?.[0]?.id;
    if (!convId) {
      console.log("[ghl] no conversation found for contact");
      return null;
    }

    // 2. Pull recent messages, newest first.
    const mUrl = `${GHL_API_BASE}/conversations/${convId}/messages?limit=20`;
    const mres = await fetch(mUrl, { headers: ghlHeaders(apiKey) });
    if (!mres.ok) {
      console.error("[ghl] get messages failed:", mres.status, await mres.text());
      return null;
    }
    const mdata = await mres.json();
    const list: Array<Record<string, unknown>> =
      mdata?.messages?.messages ?? mdata?.messages ?? [];

    list.sort((a, b) => {
      const da = new Date((a.dateAdded as string) || 0).getTime();
      const db = new Date((b.dateAdded as string) || 0).getTime();
      return db - da;
    });

    // DIAGNOSTIC: record what GHL returned so we can see the real attachment
    // shape for IG voice notes (Vercel logs don't surface our console output).
    writeDiag("media_diag", {
      convId,
      count: list.length,
      latestTwoInbound: list
        .filter((m) => String(m.direction || "").toLowerCase() === "inbound")
        .slice(0, 2),
    });

    // 3. Find the latest inbound message and resolve its attachment, falling
    //    back to the single-message detail when the list omits the URL.
    for (const msg of list) {
      const dir = String(msg.direction || "").toLowerCase();
      if (dir !== "inbound") continue;

      let url = extractAttachmentUrl(msg);
      if (!url && msg.id) {
        const detail = await fetchMessageById(apiKey, msg.id as string);
        url = extractAttachmentUrl(detail);
      }
      if (url) return { url, messageId: msg.id as string | undefined };

      // Latest inbound has no attachment at all — log its shape (once) so we can
      // see exactly what GHL sent, then stop (older messages aren't this event).
      console.log(
        "[ghl] latest inbound has no attachment; keys:",
        Object.keys(msg).join(","),
        "| messageType:",
        msg.messageType ?? msg.type ?? "?"
      );
      break;
    }

    return null;
  } catch (err) {
    console.error("[ghl] getLatestInboundAttachment threw:", err);
    return null;
  }
}

// ===========================================================================
// OPPORTUNITIES (used by Jarvis HQ voice actions — "move him in the pipeline")
// ---------------------------------------------------------------------------
//   GET /opportunities/search?location_id={loc}&contact_id={id}
//   GET /opportunities/pipelines?locationId={loc}
//   PUT /opportunities/{id}  body { pipelineId, pipelineStageId }
// All use the contacts API version (2021-07-28). Best-effort: errors are
// returned, never thrown.
// ===========================================================================

export interface GhlOpportunity {
  id: string;
  name?: string;
  pipelineId?: string;
  pipelineStageId?: string;
  status?: string;
}

export interface GhlPipeline {
  id: string;
  name: string;
  stages: Array<{ id: string; name: string }>;
}

/** Find the (first) opportunity attached to a contact, if any. */
export async function findContactOpportunity(
  apiKey: string,
  locationId: string,
  contactId: string
): Promise<GhlOpportunity | null> {
  const url =
    `${GHL_API_BASE}/opportunities/search` +
    `?location_id=${encodeURIComponent(locationId)}` +
    `&contact_id=${encodeURIComponent(contactId)}`;
  try {
    const res = await fetch(url, { headers: ghlTagHeaders(apiKey) });
    if (!res.ok) {
      console.error("[ghl] opportunity search failed:", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const opp = data?.opportunities?.[0];
    if (!opp?.id) return null;
    return {
      id: opp.id,
      name: opp.name,
      pipelineId: opp.pipelineId,
      pipelineStageId: opp.pipelineStageId,
      status: opp.status,
    };
  } catch (err) {
    console.error("[ghl] opportunity search threw:", err);
    return null;
  }
}

/** List the location's pipelines with their stages (for name → id matching). */
export async function listPipelines(
  apiKey: string,
  locationId: string
): Promise<GhlPipeline[]> {
  const url = `${GHL_API_BASE}/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`;
  try {
    const res = await fetch(url, { headers: ghlTagHeaders(apiKey) });
    if (!res.ok) {
      console.error("[ghl] listPipelines failed:", res.status, await res.text());
      return [];
    }
    const data = await res.json();
    const pipelines = Array.isArray(data?.pipelines) ? data.pipelines : [];
    return pipelines.map((p: Record<string, unknown>) => ({
      id: String(p.id ?? ""),
      name: String(p.name ?? ""),
      stages: Array.isArray(p.stages)
        ? (p.stages as Array<Record<string, unknown>>).map((s) => ({
            id: String(s.id ?? ""),
            name: String(s.name ?? ""),
          }))
        : [],
    }));
  } catch (err) {
    console.error("[ghl] listPipelines threw:", err);
    return [];
  }
}

/** Move an opportunity to a different pipeline stage. */
export async function moveOpportunityStage(
  apiKey: string,
  opportunityId: string,
  pipelineId: string,
  pipelineStageId: string
): Promise<TagResult> {
  const url = `${GHL_API_BASE}/opportunities/${encodeURIComponent(opportunityId)}`;
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: ghlTagHeaders(apiKey),
      body: JSON.stringify({ pipelineId, pipelineStageId }),
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error("[ghl] moveOpportunityStage failed:", res.status, errorText);
      return { success: false, status: res.status, error: errorText };
    }
    return { success: true, status: res.status };
  } catch (err) {
    console.error("[ghl] moveOpportunityStage threw:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ===========================================================================
// CALENDAR AVAILABILITY (used by the Book stage to offer REAL open slots)
// ---------------------------------------------------------------------------
//   GET /calendars/{calendarId}/free-slots?startDate={ms}&endDate={ms}&timezone={tz}
//   Headers: Authorization: Bearer {key}, Version: 2021-04-15
// GHL returns an object keyed by date (YYYY-MM-DD), each with a `slots` array of
// ISO timestamps already expressed in the requested timezone, e.g.:
//   { "2026-06-09": { "slots": ["2026-06-09T09:00:00+02:00", ...] }, "traceId": "..." }
// We flatten, sort, and return the next N. Best-effort: on ANY failure (bad
// scope, network, unexpected shape) we return [] so the Book stage falls back
// to loose times instead of inventing — never throws into the reply path.
// ===========================================================================

export interface FreeSlots {
  /** ISO timestamps (with timezone offset) of upcoming open slots, soonest first. */
  slots: string[];
  /** The timezone the slots are expressed in. */
  timezone: string;
}

export async function getFreeSlots(
  apiKey: string,
  calendarId: string,
  opts: { timezone: string; days?: number; limit?: number }
): Promise<FreeSlots> {
  const { timezone, days = 7, limit = 8 } = opts;
  const empty: FreeSlots = { slots: [], timezone };
  if (!apiKey || !calendarId) return empty;

  const start = Date.now();
  const end = start + days * 24 * 60 * 60 * 1000;
  const url =
    `${GHL_API_BASE}/calendars/${encodeURIComponent(calendarId)}/free-slots` +
    `?startDate=${start}&endDate=${end}&timezone=${encodeURIComponent(timezone)}`;

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: GHL_API_VERSION,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("[ghl] getFreeSlots failed:", res.status, errText);
      writeDiag("freeslots_diag", { calendarId, status: res.status, error: errText.slice(0, 300) });
      return empty;
    }
    const data = (await res.json()) as Record<string, unknown>;

    // Collect every `slots` array found under date keys (ignore traceId etc).
    const collected: string[] = [];
    for (const value of Object.values(data)) {
      if (value && typeof value === "object" && Array.isArray((value as { slots?: unknown }).slots)) {
        for (const s of (value as { slots: unknown[] }).slots) {
          if (typeof s === "string") collected.push(s);
        }
      }
    }

    // Sort chronologically and keep only future slots, capped at `limit`.
    const now = Date.now();
    const slots = collected
      .filter((s) => {
        const t = new Date(s).getTime();
        return !Number.isNaN(t) && t > now;
      })
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
      .slice(0, limit);

    writeDiag("freeslots_diag", {
      calendarId,
      status: res.status,
      rawKeys: Object.keys(data).slice(0, 12),
      collected: collected.length,
      returned: slots.length,
      sample: slots.slice(0, 3),
    });

    return { slots, timezone };
  } catch (err) {
    console.error("[ghl] getFreeSlots threw:", err);
    return empty;
  }
}

// ===========================================================================
// UPCOMING APPOINTMENT (used by the nurture engine to time the pre-call check)
//   GET /contacts/{contactId}/appointments  (LeadConnector contacts API)
// Returns { events: [{ startTime, status, ... }] }. We pick the soonest FUTURE,
// non-cancelled event's startTime. Best-effort: ANY failure → null (the
// pre-call reminder is simply skipped, never throws into a caller).
// ===========================================================================
export async function getContactUpcomingAppointment(
  apiKey: string,
  contactId: string
): Promise<string | null> {
  if (!apiKey || !contactId) return null;
  try {
    const res = await fetch(
      `${GHL_API_BASE}/contacts/${encodeURIComponent(contactId)}/appointments`,
      { headers: { Authorization: `Bearer ${apiKey}`, Version: GHL_TAGS_API_VERSION, Accept: "application/json" } }
    );
    if (!res.ok) {
      writeDiag("appt_diag", { contactId, status: res.status, error: (await res.text()).slice(0, 300) });
      return null;
    }
    const data = (await res.json()) as Record<string, unknown>;
    // Shape tolerance: events | appointments | a bare array.
    const list = (Array.isArray(data) ? data
      : (data.events as unknown[]) || (data.appointments as unknown[]) || []) as Record<string, unknown>[];
    const now = Date.now();
    const future = list
      .map((e) => {
        const start = (e.startTime || e.start_time || e.selectedSlot || e.startAt) as string | undefined;
        const status = String(e.appointmentStatus || e.status || "").toLowerCase();
        return { start, status, t: start ? new Date(start).getTime() : NaN };
      })
      .filter((e) => e.start && !Number.isNaN(e.t) && e.t > now && !/cancel|noshow|no_show|invalid/.test(e.status))
      .sort((a, b) => a.t - b.t);
    writeDiag("appt_diag", { contactId, status: res.status, found: list.length, future: future.length, soonest: future[0]?.start ?? null });
    return future[0]?.start ?? null;
  } catch (err) {
    console.error("[ghl] getContactUpcomingAppointment threw:", err);
    return null;
  }
}
