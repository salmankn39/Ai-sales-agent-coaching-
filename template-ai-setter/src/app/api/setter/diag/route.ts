/**
 * SETTER DIAGNOSTIC — GHL-vs-us delivery check for one contact.
 *
 * Answers the question "did GoHighLevel even RECEIVE this lead's messages?"
 * without needing GHL dashboard access: returns the tail of the contact's
 * conversation as GHL has it recorded, side by side with what our own
 * messages table has, plus the contact's live tags. If a message shows in
 * GHL but never reached webhook_debug_logs, the GHL->us workflow is broken;
 * if GHL doesn't have it either, the Instagram->GHL feed is down.
 *
 * Auth: the same shared access key as the other key-gated setter routes.
 *
 *   GET /api/setter/diag?k=KEY&contactId=GHL_CONTACT_ID
 *   GET /api/setter/diag?k=KEY&latest=1          — the location's most recent
 *       conversations as GHL has them (is ANYTHING arriving from Instagram?)
 */
import { NextRequest, NextResponse } from "next/server";
import { getAccessKey } from "@/lib/prompter/access";
import { fetchContactThread, getContactTags, removeContactTags } from "@/lib/ghl";
import { manualTriggerMagnet } from "@/lib/lead-magnet";
import { STOP_TAGS } from "@/domain/ghl";
import { supabase, getClient, type Client, type Lead } from "@/lib/supabase";
import { ownerSlug } from "@/lib/tenant";

export const dynamic = "force-dynamic";
// 60 (not 30): a manual trigger_magnet send_link schedules the ~50s in-process
// handoff timer via waitUntil — the function must live long enough to fire it.
export const maxDuration = 60;

/** Most recent conversations in the location, straight from GHL. */
async function latestConversations(apiKey: string, locationId: string) {
  const url =
    "https://services.leadconnectorhq.com/conversations/search" +
    `?locationId=${encodeURIComponent(locationId)}&limit=15&sortBy=last_message_date&sort=desc`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Version: "2021-04-15", Accept: "application/json" },
  });
  if (!res.ok) return { error: `${res.status}: ${(await res.text()).slice(0, 300)}` };
  const data = await res.json();
  const list = (data?.conversations ?? []) as Array<Record<string, unknown>>;
  return {
    conversations: list.map((c) => ({
      contactId: c.contactId,
      name: c.contactName ?? c.fullName,
      lastMessageAt: c.lastMessageDate,
      direction: c.lastMessageDirection,
      lastMessage: typeof c.lastMessageBody === "string" ? c.lastMessageBody.slice(0, 80) : null,
    })),
  };
}

export async function GET(req: NextRequest) {
  const k = req.nextUrl.searchParams.get("k");
  const accessKey = await getAccessKey();
  if (!accessKey || k !== accessKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Admin action: PERSON-WIDE resume — set ai_paused=false on every lead row
  // of this person (via ig_sender_id) and strip every stop tag from every one
  // of their GHL contacts. The recovery lever for a wrongful auto-pause (live:
  // the screener paused our own magnet leads mid-flow, twice).
  if (req.nextUrl.searchParams.get("action") === "resume_lead") {
    const contactId = req.nextUrl.searchParams.get("contactId");
    if (!contactId) return NextResponse.json({ error: "contactId required" }, { status: 400 });
    const { data: rows } = await supabase.from("leads").select("*").eq("ghl_contact_id", contactId).limit(1);
    const lead = (rows ?? [])[0] as Lead | undefined;
    if (!lead) return NextResponse.json({ error: "no lead for contactId" }, { status: 404 });
    const { data: clientRow } = await supabase.from("clients").select("*").eq("id", lead.client_id).maybeSingle();
    const client = clientRow as Client | null;
    if (!client?.ghl_api_key) return NextResponse.json({ error: "client creds missing" }, { status: 404 });

    const family = lead.ig_sender_id
      ? (((await supabase.from("leads").select("id, ghl_contact_id").eq("client_id", lead.client_id).eq("ig_sender_id", lead.ig_sender_id)).data ?? []) as { id: string; ghl_contact_id: string | null }[])
      : [{ id: lead.id, ghl_contact_id: lead.ghl_contact_id }];
    await supabase.from("leads").update({ ai_paused: false }).in("id", family.map((f) => f.id));
    const untagged: string[] = [];
    for (const f of family) {
      if (!f.ghl_contact_id) continue;
      const r = await removeContactTags(client.ghl_api_key, f.ghl_contact_id, [...STOP_TAGS, "needs review"]);
      if (r.success) untagged.push(f.ghl_contact_id);
    }
    return NextResponse.json({ ok: true, resumed_rows: family.length, untagged });
  }

  // GET variant of the trigger_magnet admin action (see POST below) — kept on
  // GET too because the operator tooling that reaches this deployment can only
  // issue GETs. Same key gate; identical behaviour.
  if (req.nextUrl.searchParams.get("action") === "trigger_magnet") {
    const contactId = req.nextUrl.searchParams.get("contactId");
    if (!contactId) return NextResponse.json({ error: "contactId required" }, { status: 400 });
    return runTriggerMagnet({
      contactId,
      mode: req.nextUrl.searchParams.get("mode") === "send_link" ? "send_link" : "ask_email",
      keyword: req.nextUrl.searchParams.get("keyword") ?? undefined,
      text: req.nextUrl.searchParams.get("text") ?? undefined,
    });
  }

  if (req.nextUrl.searchParams.get("latest")) {
    const client = await getClient(req.nextUrl.searchParams.get("client_slug") || ownerSlug());
    if (!client?.ghl_api_key || !client.ghl_location_id) {
      return NextResponse.json({ error: "client creds missing" }, { status: 404 });
    }
    const latest = await latestConversations(client.ghl_api_key, client.ghl_location_id);
    return NextResponse.json({ ok: true, ...latest });
  }

  const contactId = req.nextUrl.searchParams.get("contactId");
  if (!contactId) {
    return NextResponse.json({ error: "contactId required" }, { status: 400 });
  }

  const { data: leadRow } = await supabase
    .from("leads")
    .select("id, client_id, full_name, ig_username, status, ai_paused, screened, funnel_stage, magnet_state, magnet_keyword, magnet_handoff_at, last_message_at")
    .eq("ghl_contact_id", contactId)
    .maybeSingle();

  const lead = leadRow as {
    id: string;
    client_id: string;
    [key: string]: unknown;
  } | null;

  const { data: clientRow } = lead
    ? await supabase.from("clients").select("ghl_api_key, ghl_location_id").eq("id", lead.client_id).maybeSingle()
    : { data: null };
  const client = clientRow as { ghl_api_key: string | null; ghl_location_id: string | null } | null;
  if (!client?.ghl_api_key || !client.ghl_location_id) {
    return NextResponse.json({ error: "no lead/client for contactId", lead }, { status: 404 });
  }

  let ghlThread: unknown = null;
  let ghlError: string | null = null;
  try {
    const thread = await fetchContactThread(client.ghl_api_key, client.ghl_location_id, contactId);
    ghlThread = thread.slice(-12).map((m) => ({
      role: m.role,
      at: m.created_at,
      content: m.content.slice(0, 120),
    }));
  } catch (e) {
    ghlError = e instanceof Error ? e.message : String(e);
  }

  const tags = await getContactTags(client.ghl_api_key, contactId);

  const { data: ourMsgs } = lead
    ? await supabase
        .from("messages")
        .select("role, content, created_at, source")
        .eq("lead_id", lead.id)
        .order("created_at", { ascending: false })
        .limit(12)
    : { data: null };

  return NextResponse.json({
    ok: true,
    lead,
    ghl_thread_tail: ghlThread,
    ghl_error: ghlError,
    ghl_tags: tags,
    our_messages_tail: ourMsgs ?? null,
  });
}

/**
 * Admin actions (same key gate).
 *
 *   POST /api/setter/diag
 *   { "k": KEY, "action": "trigger_magnet", "contactId": "...",
 *     "mode": "ask_email" | "send_link", "keyword"?: "bdp", "text"?: "their reply" }
 *
 * Puts a lead into the lead-magnet flow manually — the recovery lever for a
 * keyword the automation missed (typo before typo-tolerance, screener misroute).
 */
export async function POST(req: NextRequest) {
  let body: { k?: string; action?: string; contactId?: string; mode?: string; keyword?: string; text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const accessKey = await getAccessKey();
  if (!accessKey || body.k !== accessKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (body.action !== "trigger_magnet" || !body.contactId) {
    return NextResponse.json({ error: "unknown action or missing contactId" }, { status: 400 });
  }

  return runTriggerMagnet({
    contactId: body.contactId,
    mode: body.mode === "send_link" ? "send_link" : "ask_email",
    keyword: body.keyword,
    text: body.text,
  });
}

/** Shared implementation for the GET and POST forms of trigger_magnet. */
async function runTriggerMagnet(params: {
  contactId: string;
  mode: "ask_email" | "send_link";
  keyword?: string;
  text?: string;
}): Promise<NextResponse> {
  const { data: leadRow } = await supabase
    .from("leads")
    .select("*")
    .eq("ghl_contact_id", params.contactId)
    .maybeSingle();
  const lead = leadRow as Lead | null;
  if (!lead) return NextResponse.json({ error: "no lead for contactId" }, { status: 404 });

  const { data: clientRow } = await supabase.from("clients").select("*").eq("id", lead.client_id).maybeSingle();
  const client = clientRow as Client | null;
  if (!client?.ghl_api_key || !client.ghl_location_id) {
    return NextResponse.json({ error: "client creds missing" }, { status: 404 });
  }

  const result = await manualTriggerMagnet({
    client,
    lead,
    mode: params.mode,
    keyword: params.keyword,
    text: params.text,
  });
  return NextResponse.json({ ok: result.ok, note: result.note, lead_id: lead.id });
}
