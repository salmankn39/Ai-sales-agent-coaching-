/**
 * TELEGRAM CONTROL, DECIDED HERE — the pure half.
 *
 * Every student must end up with the SAME product, including the ability to
 * text their setter and control it ("turn the ai off for john", "how many did
 * we book this week"). The old kit shipped that as a separate Python service
 * on Railway: another account, another $5/mo, another thing to break, and a
 * hand-trimmed fork of the owner's bot that was already 1200 lines behind the real
 * one and answered to nobody's tests.
 *
 * The app already owns that brain — HQ chat, 64 tools, the same one the
 * dashboard talks to. So Telegram becomes one webhook into it. No Railway, no
 * Python, no fork, and a student's Telegram gets smarter every time the engine
 * does.
 *
 * This file holds the DECISION (who is allowed to speak, and what did they
 * say), separated from the I/O so it can be tested exhaustively. The route is
 * the shell around it.
 */

/** Telegram's update envelope, only the parts we act on. */
export interface TelegramUpdate {
  message?: {
    message_id?: number;
    date?: number;
    text?: string;
    chat?: { id?: number | string };
    from?: { id?: number | string; is_bot?: boolean };
    reply_to_message?: { message_id?: number };
  };
  edited_message?: unknown;
  callback_query?: unknown;
}

export type WebhookVerdict =
  | { act: false; reason: string }
  | {
      act: true;
      text: string;
      chatId: string;
      /** Set when this message is a REPLY to one of our pings — that ping's
       *  message id resolves exactly which lead they mean. */
      replyToMessageId: number | null;
    };

/** Telegram delivers updates at most this stale before we ignore them. A queue
 *  that backs up (app down for an hour) must not replay an hour of commands
 *  the moment it returns — "turn the ai off for john" acted on at 3am is a
 *  surprise, and re-running old commands is how a backlog becomes damage. */
export const MAX_UPDATE_AGE_S = 10 * 60;

/** Longest command we will act on. Anything past this is a paste, not an
 *  instruction, and the brain's own input cap would truncate it anyway. */
export const MAX_COMMAND_CHARS = 2000;

/**
 * Decide whether an incoming Telegram update is a command from the ONE person
 * allowed to give commands.
 *
 * Everything is fail-CLOSED. This endpoint can switch the setter off, send DMs
 * to real leads and log money, so anything unrecognised is refused rather than
 * guessed at. The three locks, in order of strength:
 *   1. secretOk   — Telegram's own secret_token header, set at registration.
 *                   A stranger who finds the URL has neither.
 *   2. ownerChatId— the update must come from the owner's own chat.
 *   3. shape      — a human's fresh text message, not a bot, not an edit.
 */
export function decideWebhook(params: {
  update: TelegramUpdate | null | undefined;
  secretOk: boolean;
  ownerChatId: string | null | undefined;
  nowMs: number;
}): WebhookVerdict {
  const { update, secretOk, ownerChatId, nowMs } = params;

  if (!secretOk) return { act: false, reason: "bad_secret" };
  // No configured owner = nobody is authorised. Never fall back to "whoever
  // messaged first": that would hand control to a stranger who guessed the URL.
  if (!ownerChatId) return { act: false, reason: "no_owner_configured" };

  const msg = update?.message;
  if (!msg) return { act: false, reason: "unsupported_update" };
  if (msg.from?.is_bot === true) return { act: false, reason: "from_bot" };

  const chatId = msg.chat?.id;
  if (chatId === undefined || chatId === null) return { act: false, reason: "no_chat" };
  if (String(chatId) !== String(ownerChatId)) return { act: false, reason: "not_owner" };
  // A group can contain the owner AND other people; commands are only ever
  // accepted from the owner's own one-to-one chat, whose id equals their user
  // id. (In Telegram, group ids are negative and never match a user id.)
  if (msg.from?.id !== undefined && String(msg.from.id) !== String(ownerChatId)) {
    return { act: false, reason: "not_owner" };
  }

  const text = (msg.text ?? "").trim();
  if (!text) return { act: false, reason: "no_text" };
  if (text.length > MAX_COMMAND_CHARS) return { act: false, reason: "too_long" };

  if (typeof msg.date === "number") {
    const ageS = nowMs / 1000 - msg.date;
    if (ageS > MAX_UPDATE_AGE_S) return { act: false, reason: "stale" };
  }

  const replyTo = msg.reply_to_message?.message_id;
  return {
    act: true,
    text,
    chatId: String(chatId),
    replyToMessageId: typeof replyTo === "number" ? replyTo : null,
  };
}

/**
 * Telegram messages cap at 4096 characters. The brain occasionally answers
 * with a long report, and a silently truncated answer is worse than two
 * messages. Split on paragraph, then line, then hard — never mid-word if it
 * can be helped.
 */
export const TELEGRAM_MAX_CHARS = 4000;

export function splitForTelegram(text: string, max = TELEGRAM_MAX_CHARS): string[] {
  const body = (text ?? "").trim();
  if (!body) return [];
  if (body.length <= max) return [body];

  const out: string[] = [];
  let rest = body;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max * 0.5) cut = window.lastIndexOf("\n");
    if (cut < max * 0.5) cut = window.lastIndexOf(" ");
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}
