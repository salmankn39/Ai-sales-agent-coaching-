/**
 * TELEGRAM PING
 * -------------
 * Pings the owner on the EXISTING Jarvis Telegram bot when the setter hands a lead
 * off to a human (business owner, friend, or unclear/needs-review).
 *
 * We do NOT create a new bot — we reuse the same bot token. Token + chat id come
 * from environment variables (set in Vercel in production):
 *   TELEGRAM_BOT_TOKEN  — the existing Jarvis bot token
 *   TELEGRAM_CHAT_ID    — the owner's chat id (falls back to TELEGRAM_AUTHORIZED_USER_ID)
 *
 * Send: POST https://api.telegram.org/bot{TOKEN}/sendMessage
 *       body {"chat_id": <id>, "text": "<msg>"}
 */

import { supabase } from "@/lib/supabase";

export interface TelegramResult {
  success: boolean;
  status?: number;
  error?: string;
}

/** FNV-1a, enough to identify "the exact same text" without a crypto import. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + "_" + s.length;
}

function getChatId(): string | undefined {
  return process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_AUTHORIZED_USER_ID;
}

/**
 * WHICH PERSON A PING IS ABOUT. Passing this makes the ping ANSWERABLE: the
 * Telegram message id Telegram hands back on send is stored against the lead,
 * so when the owner replies "turn him off" the bot resolves the person exactly
 * instead of regexing a name out of the prose and fuzzy-searching for it.
 */
export interface PingSubject {
  leadId?: string | null;
  clientId?: string | null;
  /** Free-form label for what kind of ping this was, for debugging. */
  kind?: string;
}

/** Record the sent message id against the lead it was about. Best-effort and
 *  silent: a ping that fails to register is still a ping that was delivered. */
async function rememberPingSubject(
  chatId: string,
  messageId: unknown,
  about: PingSubject
): Promise<void> {
  const mid = Number(messageId);
  if (!about.leadId || !Number.isFinite(mid)) return;
  try {
    await supabase.from("telegram_ping_refs").upsert(
      {
        chat_id: String(chatId),
        message_id: mid,
        lead_id: about.leadId,
        client_id: about.clientId ?? null,
        kind: about.kind ?? null,
      },
      { onConflict: "chat_id,message_id" }
    );
  } catch (e) {
    console.error("[telegram] ping subject record failed:", e);
  }
}

/**
 * Send a plain-text message to the owner. Best-effort: never throws — on any
 * failure (missing env, network, API error) it logs and returns success:false
 * so the caller's handoff still completes (tag + pause already happened).
 *
 * Pass `about` for any ping concerning a specific lead — see PingSubject.
 */
export async function sendTelegramPing(
  text: string,
  record = true,
  about?: PingSubject
): Promise<TelegramResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = getChatId();

  if (!token || !chatId) {
    console.error(
      "[telegram] missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID — ping skipped"
    );
    return { success: false, error: "missing_telegram_env" };
  }

  // THE SAME MESSAGE NEVER LANDS TWICE (the owner, 2026-08-06: "I'm definitely
  // getting double notifications of everything... no one should be getting the
  // same message twice"). A request that dies at the serverless time limit has
  // already mirrored to Telegram but never answers the client, so the client
  // retries and the mirror runs again. Instances share no memory, so the guard is
  // a DB row: hash of the text, unique. Insert first - the second identical send
  // inside ten minutes hits the conflict and stops. If the dedupe table is ever
  // unreachable the message still sends: a rare double beats a silent never.
  try {
    const hash = fnv(text);
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await supabase.from("ping_dedupe").delete().lt("sent_at", cutoff);
    const { error: dupErr } = await supabase.from("ping_dedupe").insert({ hash });
    if (dupErr && String(dupErr.code) === "23505") {
      return { success: true };   // already sent moments ago - swallow the twin
    }
  } catch { /* dedupe is best-effort, never a reason not to send */ }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("[telegram] sendMessage failed:", response.status, errorText);
      return { success: false, status: response.status, error: errorText };
    }
    if (about?.leadId) {
      const payload = (await response.clone().json().catch(() => null)) as
        | { result?: { message_id?: number } }
        | null;
      await rememberPingSubject(chatId, payload?.result?.message_id, about);
    }
    // Every proactive ping is recorded (record defaults to true) into the SHARED
    // owner-conversation log, so when the owner REPLIES to one the chat brain (Telegram
    // + HQ) has the antecedent instead of asking "who?". Pass record=false only for
    // a ping that should NOT become reply-context. Best-effort: a recording failure
    // never affects the ping.
    if (record) {
      try {
        await supabase.from("jarvis_owner_messages").insert({ role: "assistant", content: text, surface: "setter" });
      } catch (e) {
        console.error("[telegram] owner-message record failed:", e);
      }
    }
    return { success: true, status: response.status };
  } catch (err) {
    console.error("[telegram] sendMessage threw:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

function htmlEscape(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Send the owner a message whose body sits in a monospace <pre> block — Telegram
 * renders those with one-tap copy on mobile, so a drafted follow-up can be
 * pasted straight into the Instagram app. `header` (optional) is plain context
 * text above the block. Recorded to the shared owner conversation like
 * sendTelegramPing. Best-effort: never throws.
 */
export async function sendTelegramCopyBlock(
  header: string,
  copyText: string,
  about?: PingSubject
): Promise<TelegramResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = getChatId();
  if (!token || !chatId) {
    console.error("[telegram] missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID — copy block skipped");
    return { success: false, error: "missing_telegram_env" };
  }
  const head = htmlEscape((header || "").trim());
  const text = `${head ? `${head}\n\n` : ""}<pre>${htmlEscape(copyText)}</pre>`;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("[telegram] copy block failed:", response.status, errorText);
      return { success: false, status: response.status, error: errorText };
    }
    // A COPY BLOCK IS THE MESSAGE HE REPLIES TO. It is the last one sent and it
    // holds the words he is about to paste, so it is the natural thing to tap
    // reply on - and it had no `about`, so it was the one ping shape the
    // message-id resolver could never answer.
    if (about?.leadId) {
      const payload = (await response.clone().json().catch(() => null)) as
        | { result?: { message_id?: number } }
        | null;
      await rememberPingSubject(chatId, payload?.result?.message_id, about);
    }
    try {
      await supabase.from("jarvis_owner_messages").insert({
        role: "assistant",
        content: `${(header || "").trim() ? `${(header || "").trim()}\n\n` : ""}${copyText}`,
        surface: "setter",
      });
    } catch (e) {
      console.error("[telegram] owner-message record failed:", e);
    }
    return { success: true, status: response.status };
  } catch (err) {
    console.error("[telegram] copy block threw:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Send a plain-text message to ANY Telegram chat id (a teammate, not just the owner).
 * Lets HQ message the team the same way the Telegram bot can. Best-effort.
 */
export async function sendTelegramTo(chatId: string, text: string): Promise<TelegramResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return { success: false, error: "missing_token_or_chat" };
  // Same double-send guard as sendTelegramPing, keyed per chat so the same words
  // to two different people still send to both.
  try {
    const hash = fnv(`${chatId}|${text}`);
    const { error: dupErr } = await supabase.from("ping_dedupe").insert({ hash });
    if (dupErr && String(dupErr.code) === "23505") return { success: true };
  } catch { /* best-effort */ }
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, status: response.status, error: errorText };
    }
    return { success: true, status: response.status };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/** GHL contact deep-link used in every handoff ping.
 *
 * EMPTY WHEN THERE IS NOTHING TO LINK TO (incident 2026-08-16). Every call site
 * guards with `link ? "\n" + link : ""`, which reads as "append it only if we
 * have one" — but this always returned a truthy string, so a lead with no GHL
 * contact still got a URL ending in `/contacts/detail/`, pointing at nothing.
 * On the credit-outage ping that dead link landed immediately after an error
 * text truncated at the words "Please go", so the message read as though
 * Anthropic were telling the owner to go to GoHighLevel. Returning "" for a missing
 * id makes every one of those existing guards mean what it already says.
 */
export function ghlContactLink(locationId: string, contactId: string): string {
  if (!locationId?.trim() || !contactId?.trim()) return "";
  return `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${contactId}`;
}

/**
 * HOW A LEAD IS NAMED IN EVERY OWNER PING.
 *
 * A ping the owner cannot act on is worse than no ping. When the owner REPLIES to
 * one ("turn off ai for him"), the bot injects the quoted text and Jarvis
 * resolves the person from whatever identity that text carries — so the text
 * MUST carry one. ManyChat-first leads have full_name = NULL, and the old
 * `full_name || "this lead"` fallback printed the literal words "this lead",
 * which Jarvis then searched for as a name and failed on (live 2026-08-08:
 * "No lead found matching 'this lead'").
 *
 * The @handle is always present on a ManyChat lead, so it is both the fallback
 * AND appended alongside a real name — a reply-to then always contains
 * something find_lead can resolve.
 */
export function leadLabel(
  lead:
    | { id?: string | null; full_name?: string | null; ig_username?: string | null }
    | null
    | undefined,
  fallback = "this lead"
): string {
  const name = (lead?.full_name || "").trim();
  const raw = (lead?.ig_username || "").trim().replace(/^@/, "");
  const handle = raw ? `@${raw}` : "";
  const named = name && handle ? `${name} (${handle})` : name || handle || fallback;
  const ref = shortLeadRef(lead?.id);
  return ref ? `${named} ${ref}` : named;
}

/**
 * A SHORT, TYPEABLE HANDLE ON A PERSON, printed in every ping about them.
 *
 * The Telegram message-id mapping (telegram_ping_refs) is the primary way a
 * reply resolves who the owner means, and it is exact. This is the backup for the
 * cases the mapping cannot cover: a ping he forwards, quotes by hand, or comes
 * back to after the row is cleaned up — and for the times he types the person
 * from memory. Six hex characters of the lead's uuid is short enough to read
 * out loud and long enough that two live leads colliding is not a real risk.
 *
 * Deliberately not the handle: 910 of 951 leads have no Instagram handle
 * stored, which is precisely why "this lead" was being printed and searched for.
 */
export function shortLeadRef(leadId?: string | null): string {
  const hex = String(leadId || "").replace(/-/g, "");
  return hex.length >= 6 ? `#${hex.slice(0, 6)}` : "";
}
