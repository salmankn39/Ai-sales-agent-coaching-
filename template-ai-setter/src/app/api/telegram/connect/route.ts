/**
 * CONNECT TELEGRAM — one click, no curl, no Telegram API docs.
 *
 * Registering a webhook normally means hand-running a setWebhook URL with a
 * token and a secret in it. For a beginner that is a copy-paste minefield and
 * the single most likely place for ten students to end up in ten different
 * states. So the app does it to itself: visit this route with the access key
 * and it registers, verifies, and reports back in plain English.
 *
 * GET  ?k=KEY          → what Telegram currently thinks (diagnosis)
 * POST ?k=KEY          → register this deployment's webhook, then verify
 *
 * Everything it needs it already has: the bot token and the owner chat id from
 * env, the secret from env, and its own public URL from the request.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAccessKey } from "@/lib/prompter/access";

export const dynamic = "force-dynamic";

const api = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

/** Human-readable state, deliberately phrased for someone who has never seen
 *  a webhook before. */
function diagnose(missing: string[]): string {
  return missing.length
    ? `Not ready yet. Add these in Vercel (Settings → Environment Variables), redeploy, then try again: ${missing.join(", ")}.`
    : "Ready.";
}

function envCheck() {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_AUTHORIZED_USER_ID || "").trim();
  const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  const missing: string[] = [];
  if (!token) missing.push("TELEGRAM_BOT_TOKEN");
  if (!chatId) missing.push("TELEGRAM_CHAT_ID");
  if (!secret) missing.push("TELEGRAM_WEBHOOK_SECRET");
  return { token, chatId, secret, missing };
}

async function authorized(req: NextRequest): Promise<boolean> {
  const k = req.nextUrl.searchParams.get("k") ?? "";
  const accessKey = await getAccessKey();
  return !!accessKey && k === accessKey;
}

export async function GET(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { token, missing } = envCheck();
  if (missing.length) return NextResponse.json({ ready: false, status: diagnose(missing), missing });

  try {
    const res = await fetch(api(token, "getWebhookInfo"));
    const info = (await res.json()) as {
      ok?: boolean;
      result?: { url?: string; last_error_message?: string; pending_update_count?: number };
    };
    const url = info?.result?.url || "";
    const expected = `${req.nextUrl.origin}/api/telegram/webhook`;
    return NextResponse.json({
      ready: url === expected,
      status:
        url === expected
          ? "Connected. Text your bot and it will answer."
          : url
            ? "Connected to a DIFFERENT address. POST to this same URL to point it here."
            : "Not connected yet. POST to this same URL to connect it.",
      registered_url: url || null,
      expected_url: expected,
      // Telegram reports the last delivery failure here; it is the single most
      // useful line when something is wrong.
      last_error: info?.result?.last_error_message || null,
      waiting_messages: info?.result?.pending_update_count ?? 0,
    });
  } catch (e) {
    return NextResponse.json({ ready: false, status: `Could not reach Telegram: ${String(e)}` }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { token, chatId, secret, missing } = envCheck();
  if (missing.length) {
    return NextResponse.json({ ok: false, status: diagnose(missing), missing }, { status: 400 });
  }

  const webhookUrl = `${req.nextUrl.origin}/api/telegram/webhook`;
  try {
    const res = await fetch(api(token, "setWebhook"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secret,
        // Only what we act on. Fewer update types = less noise and no
        // surprises from features we do not handle.
        allowed_updates: ["message"],
        // A queue built up while the app was down is dropped rather than
        // replayed. The webhook refuses stale commands anyway; this stops
        // Telegram from delivering hundreds of them at once on first connect.
        drop_pending_updates: true,
      }),
    });
    const data = (await res.json()) as { ok?: boolean; description?: string };
    if (!data?.ok) {
      return NextResponse.json(
        {
          ok: false,
          status: `Telegram refused: ${data?.description || "unknown error"}. Check TELEGRAM_BOT_TOKEN is the exact token from @BotFather.`,
        },
        { status: 400 }
      );
    }

    // Say hello so the student SEES it working, and so we learn immediately if
    // they never pressed Start (Telegram refuses messages to a bot the user
    // has not opened — the single most common beginner snag).
    const hello = await fetch(api(token, "sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "Your setter is connected. Text me anything, like: how many leads replied today?",
      }),
    });
    const helloData = (await hello.json()) as { ok?: boolean; description?: string };

    return NextResponse.json({
      ok: true,
      status: helloData?.ok
        ? "Connected. Check Telegram - you should have a message from your bot. Reply to it to give commands."
        : `Webhook connected, but I could not message you: ${helloData?.description || "unknown"}. Open Telegram, find your bot, press START, then load this URL again.`,
      webhook_url: webhookUrl,
      messaged_you: helloData?.ok === true,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, status: `Could not reach Telegram: ${String(e)}` }, { status: 502 });
  }
}
