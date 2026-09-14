/**
 * IS MY SETTER ACTUALLY SET UP? — one page that answers it.
 *
 * Ten students must end up with the SAME product (the owner, 2026-08-21). The way
 * that fails is not a dramatic error; it is a student who thinks they finished
 * while one thing is quietly missing — no API key, an untrained client row, a
 * webhook that was never connected — and finds out days later when a real lead
 * gets silence.
 *
 * So the deployment can check itself. Every step of the setup, in order, with
 * a plain-English fix for whatever is not done. Both the setup guide and
 * Claude Code point here, so "am I done?" has ONE answer that comes from the
 * live system rather than from the student's memory of what they clicked.
 *
 * GET /api/setup-check?k=ACCESS_KEY
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getAccessKey } from "@/lib/prompter/access";
import { ownerSlug } from "@/lib/tenant";

export const dynamic = "force-dynamic";

type Step = {
  step: string;
  done: boolean;
  detail: string;
  /** Only present when it is NOT done: exactly what to do about it. */
  fix?: string;
};

export async function GET(req: NextRequest) {
  const k = req.nextUrl.searchParams.get("k") ?? "";
  const accessKey = await getAccessKey().catch(() => null);

  // A wrong key is itself a diagnosis worth giving plainly: it is either the
  // wrong key, or schema.sql was run without replacing the placeholder.
  if (!accessKey) {
    return NextResponse.json(
      {
        ready: false,
        summary: "Your database has no access key yet, so nothing can talk to this app.",
        fix: "In Supabase → SQL Editor, re-run db/schema.sql with YOUR-ACCESS-KEY replaced by your own long random string.",
      },
      { status: 503 }
    );
  }
  if (k !== accessKey) {
    return NextResponse.json(
      { error: "unauthorized", hint: "Add ?k=YOUR-ACCESS-KEY to this URL - the same one you put in db/schema.sql." },
      { status: 401 }
    );
  }

  const steps: Step[] = [];
  const env = (n: string) => (process.env[n] || "").trim();

  steps.push({
    step: "Database connected",
    done: true,
    detail: "This app can read your Supabase database (it just read your access key).",
  });

  // DOES THE KEY WORK, not merely exist. Found in the 2026-08-21 dry run: a
  // typo'd or out-of-credit key produced total silence - the reply failed, the
  // event landed in a table no beginner opens, and (before Telegram is
  // connected) nothing told them at all. Their setter just stopped. Asking
  // Anthropic to list models is free, instant, and definitive.
  const brainKey = env("ANTHROPIC_API_KEY");
  let brainOk = false;
  let brainDetail = "No Anthropic key, so the setter cannot think.";
  let brainFix = "Vercel → Settings → Environment Variables → add ANTHROPIC_API_KEY, then redeploy.";
  if (brainKey) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/models?limit=1", {
        headers: { "x-api-key": brainKey, "anthropic-version": "2023-06-01" },
      });
      if (r.ok) {
        brainOk = true;
        brainDetail = "Your Anthropic key works.";
      } else if (r.status === 401) {
        brainDetail = "Anthropic rejected your key. It is wrong, or it was deleted.";
        brainFix = "console.anthropic.com → API Keys → create a new key → replace ANTHROPIC_API_KEY in Vercel → redeploy.";
      } else if (r.status === 429) {
        brainDetail = "Your Anthropic account is out of credit or rate limited.";
        brainFix = "console.anthropic.com → Billing → add credit. Your setter cannot reply until you do.";
      } else {
        brainDetail = `Anthropic answered ${r.status}.`;
        brainFix = "Check console.anthropic.com for your key and your billing.";
      }
    } catch {
      // A network blip is not a verdict on the key; say so rather than
      // sending someone to regenerate a key that was fine.
      brainOk = true;
      brainDetail = "Key is set (could not reach Anthropic just now to double-check it).";
    }
  }
  steps.push({
    step: "AI brain key",
    done: brainOk,
    detail: brainDetail,
    ...(brainOk ? {} : { fix: brainFix }),
  });

  // Your own client row: the thing that makes the setter YOURS.
  const slug = ownerSlug();
  const { data: clientRow } = await supabase
    .from("clients")
    .select("id, name, slug, is_active, system_prompt, stages, manychat_api_token")
    .eq("slug", slug)
    .maybeSingle();
  const client = clientRow as
    | { id: string; name: string | null; is_active: boolean | null; system_prompt: string | null; stages: unknown; manychat_api_token: string | null }
    | null;

  steps.push({
    step: "Your setter exists",
    done: !!client,
    detail: client ? `Found your client row: ${client.name || slug}.` : `No client row with slug "${slug}".`,
    ...(client
      ? {}
      : { fix: `Run prompts/ONBOARD_CLIENT_PROMPT.md in Claude Code and tell it this is YOUR OWN setter (slug: ${slug}).` }),
  });

  const trained = !!(client?.system_prompt && client.system_prompt.trim().length > 100);
  const staged = Array.isArray(client?.stages) && (client!.stages as unknown[]).length > 0;
  steps.push({
    step: "Setter is trained",
    done: trained && staged,
    detail:
      trained && staged
        ? "Your script and funnel stages are written."
        : !client
          ? "Cannot check until your setter exists."
          : `Missing: ${[!trained ? "the script (system_prompt)" : null, !staged ? "the funnel stages" : null].filter(Boolean).join(" and ")}.`,
    ...(trained && staged
      ? {}
      : { fix: "Run prompts/RESKIN_PROMPT.md in Claude Code. Do NOT skip this - an untrained setter texts like a robot, under your name." }),
  });

  const hasManychat = !!client?.manychat_api_token;
  steps.push({
    step: "Instagram connected",
    done: hasManychat,
    detail: hasManychat
      ? "A ManyChat token is saved on your client row."
      : "No ManyChat token, so the setter cannot send Instagram DMs.",
    ...(hasManychat
      ? {}
      : { fix: "ManyChat → Settings → API → copy the token, and add it to your client row (the onboard prompt does this for you)." }),
  });

  // Telegram: token + owner id + secret + an actually-registered webhook.
  const tgMissing = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_WEBHOOK_SECRET"].filter(
    (n) => !env(n) && !(n === "TELEGRAM_CHAT_ID" && env("TELEGRAM_AUTHORIZED_USER_ID"))
  );
  let tgConnected = false;
  let tgDetail = `Missing: ${tgMissing.join(", ")}.`;
  if (!tgMissing.length) {
    try {
      const info = (await (await fetch(`https://api.telegram.org/bot${env("TELEGRAM_BOT_TOKEN")}/getWebhookInfo`)).json()) as {
        result?: { url?: string; last_error_message?: string };
      };
      const expected = `${req.nextUrl.origin}/api/telegram/webhook`;
      tgConnected = info?.result?.url === expected;
      tgDetail = tgConnected
        ? "Your bot is connected to this app."
        : info?.result?.url
          ? `Your bot points at a different address (${info.result.url}).`
          : "Your bot is not connected yet.";
      if (info?.result?.last_error_message) tgDetail += ` Telegram's last error: ${info.result.last_error_message}`;
    } catch {
      tgDetail = "Could not reach Telegram to check.";
    }
  }
  steps.push({
    step: "Telegram control",
    done: tgConnected,
    detail: tgDetail,
    ...(tgConnected
      ? {}
      : {
          fix: tgMissing.length
            ? `Vercel → Settings → Environment Variables → add ${tgMissing.join(", ")}, redeploy, then open /api/telegram/connect?k=YOUR-ACCESS-KEY`
            : "Open /api/telegram/connect?k=YOUR-ACCESS-KEY in your browser and it will connect itself.",
        }),
  });

  // The heartbeat: pg_cron waking this app. Proven by the sweep having run.
  const { count: recentSweeps } = await supabase
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("event_type", "sweep_reply_attempt")
    .gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString());
  const { data: anyLead } = await supabase.from("leads").select("id").limit(1);
  const hasTraffic = (anyLead?.length ?? 0) > 0;
  // With no leads at all the sweep has nothing to do, so silence is correct
  // and must not be reported as a fault.
  const heartbeatOk = !hasTraffic || (recentSweeps ?? 0) > 0;
  steps.push({
    step: "Heartbeat running",
    done: heartbeatOk,
    detail: !hasTraffic
      ? "No leads yet, so there is nothing for the heartbeat to do. This turns real once you get your first DM."
      : heartbeatOk
        ? "Your database is waking this app on schedule."
        : "Your database does not seem to be waking this app.",
    ...(heartbeatOk
      ? {}
      : {
          fix: "In Supabase → SQL Editor, re-run the schedule section at the bottom of db/schema.sql with YOUR-APP-URL replaced by this app's real URL.",
        }),
  });

  // RECENT FAILURES, SURFACED. The engine records why it could not reply, but
  // those rows live in a table a beginner will never open - so a silent setter
  // stays a mystery. Anything here means leads are being missed RIGHT NOW.
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: failures } = await supabase
    .from("events")
    .select("event_type, created_at")
    .in("event_type", ["llm_account_down", "ai_generate_failed", "ai_reply_failed"])
    .gte("created_at", dayAgo)
    .order("created_at", { ascending: false })
    .limit(50);
  const failRows = (failures ?? []) as { event_type: string; created_at: string }[];
  if (failRows.length) {
    const kinds = [...new Set(failRows.map((f) => f.event_type))];
    steps.push({
      step: "Replies are going out",
      done: false,
      detail: `${failRows.length} failed repl${failRows.length === 1 ? "y" : "ies"} in the last 24 hours (${kinds.join(", ")}). Leads are messaging and not being answered.`,
      fix: kinds.includes("llm_account_down")
        ? "Your Anthropic key was rejected or is out of credit. Check console.anthropic.com → Billing, then send yourself a test DM."
        : "Open your dashboard and check the most recent conversations. If this keeps happening, paste this page into Claude Code.",
    });
  }

  const blocking = steps.filter((s) => !s.done);
  return NextResponse.json({
    ready: blocking.length === 0,
    summary: blocking.length === 0
      ? "Everything is set up. Your setter is live."
      : `${blocking.length} thing${blocking.length === 1 ? "" : "s"} left: ${blocking.map((s) => s.step).join(", ")}.`,
    next_step: blocking[0]?.fix ?? null,
    steps,
  });
}
