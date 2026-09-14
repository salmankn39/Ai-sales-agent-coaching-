/**
 * TELEGRAM CONTROL — text your setter, it does the thing.
 *
 * "they should all have it connected to the Telegram so they can speak to it
 * and control it from Telegram like I am right now" (the owner, 2026-08-21).
 *
 * The old student kit shipped this as a separate Python service on Railway:
 * another account, another ~$5/mo, another deploy to get wrong, and a
 * hand-trimmed fork of the owner's own bot that was already ~1200 lines behind the
 * real one and covered by no test anywhere. Ten students would have produced
 * ten different outcomes, which is exactly what he does not want.
 *
 * So Telegram is now a webhook into the brain this app ALREADY has: HQ chat,
 * the same 64 tools the dashboard talks to. One deployment, no Python, nothing
 * to keep in sync — a student's Telegram gets smarter every time the engine
 * does.
 *
 * SECURITY. This is the only PUBLIC route that can switch the setter off, DM
 * real leads and log money — Telegram must be able to reach it, so it cannot
 * sit behind the access key like every other route. Three locks, all decided
 * in lib/telegram-webhook.ts (pure, exhaustively tested):
 *   1. Telegram's own secret_token header, set when the webhook is registered.
 *   2. The update must come from the owner's own chat AND their own user id.
 *   3. It must be a fresh, human, text message — a stale queue is never
 *      replayed, because acting on an hour-old "turn the ai off" is damage.
 * Anything unrecognised is refused. We always answer Telegram 200 so it stops
 * retrying; the refusal reason is logged, never sent back to a stranger.
 */
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { decideWebhook, splitForTelegram, type TelegramUpdate } from "@/lib/telegram-webhook";
import { sendTelegramPing } from "@/lib/telegram";
import { getAccessKey } from "@/lib/prompter/access";

export const dynamic = "force-dynamic";
// A brain turn can run several tool rounds. Telegram itself gets its 200
// immediately (below); this ceiling is for the background answer.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  // ALWAYS 200. Telegram retries a non-2xx for hours, and a retry storm on a
  // route that can act is worse than a dropped command the owner can retype.
  const ok = () => NextResponse.json({ ok: true });

  try {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
    const headerSecret = req.headers.get("x-telegram-bot-api-secret-token") || "";
    const update = (await req.json().catch(() => null)) as TelegramUpdate | null;

    const verdict = decideWebhook({
      update,
      // An unset secret means the webhook was registered without one, which we
      // never do — refuse rather than run open.
      secretOk: secret.length > 0 && headerSecret === secret,
      ownerChatId: process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_AUTHORIZED_USER_ID,
      nowMs: Date.now(),
    });

    if (!verdict.act) {
      console.log("[telegram/webhook] ignored:", verdict.reason);
      return ok();
    }

    // The brain runs in the background so Telegram's 200 is instant; its
    // answer arrives as a normal message a moment later, which is also what a
    // person texting expects.
    waitUntil(
      answer(req.nextUrl.origin, verdict.text, verdict.replyToMessageId).catch((e) =>
        console.error("[telegram/webhook] answer failed:", e)
      )
    );
    return ok();
  } catch (e) {
    console.error("[telegram/webhook] error:", e);
    return ok();
  }
}

/**
 * Hand the command to HQ chat and text the answer back.
 *
 * Going through the HTTP route rather than importing its internals is
 * deliberate: that route is the one place the brain, its tools and its
 * conversation memory are wired together, and Telegram must get the SAME brain
 * the dashboard gets — not a second copy that can drift from it.
 */
async function answer(origin: string, text: string, replyToMessageId: number | null): Promise<void> {
  const key = await getAccessKey();
  if (!key) {
    await sendTelegramPing(
      "I can't reach my own brain: no access key is set up in the database yet. Re-run db/schema.sql with your access key filled in.",
      false
    );
    return;
  }

  // A reply to one of my pings means "this person" without naming them. The
  // ping's message id maps to the lead in telegram_ping_refs, so tell the
  // brain which message was replied to and let its own lead tools resolve it.
  const message = replyToMessageId
    ? `${text}\n\n(This is a reply to your Telegram message id ${replyToMessageId}. If it is about a specific lead, look that message id up in telegram_ping_refs to find exactly who I mean.)`
    : text;

  let reply = "";
  try {
    const res = await fetch(`${origin}/api/hq/chat?k=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    // HQ chat answers in `speech` (its voice/UI contract), not `reply`.
    const data = (await res.json().catch(() => null)) as { speech?: string; error?: string } | null;
    if (!res.ok || data?.error) {
      reply =
        data?.error === "brain_not_configured"
          ? "My brain has no Anthropic API key. Add ANTHROPIC_API_KEY in Vercel and redeploy."
          : `Something went wrong reaching my brain (${data?.error || res.status}). Try again in a moment.`;
    } else {
      reply = (data?.speech || "").trim();
    }
  } catch (e) {
    console.error("[telegram/webhook] hq chat call failed:", e);
    reply = "I couldn't reach my brain just then. Try again in a moment.";
  }

  // Silence reads as broken. Say something, always.
  const chunks = splitForTelegram(reply || "Done.");
  for (const chunk of chunks) {
    // record:false — these are answers in a conversation, not owner alerts
    // that the ping de-duplicator should collapse.
    await sendTelegramPing(chunk, false);
  }
}
