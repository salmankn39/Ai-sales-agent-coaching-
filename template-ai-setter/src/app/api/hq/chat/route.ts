/**
 * JARVIS HQ — chat brain: real lookups AND real actions, by voice.
 *
 * READ tools:
 *   - get_business_data   → aggregate funnel/sales/sources (same get_dashboard RPC)
 *   - get_recent_bookings → actual NAMES of recently booked leads
 *   - get_closed_deals    → actual NAMES behind the money: who signed, who paid
 *   - find_lead           → quick lead search by name/handle
 *   - lead_story          → full deep-dive on one lead (source, stage, facts, history)
 *   - get_conversation    → the actual DM thread with a lead (for a convo panel)
 *   - get_hot_leads       → most active engaged leads right now
 *   - get_morning_brief   → the flight check: cash, bookings, cold leads, focus
 *
 * ACTION tools (scoped to the owner's client):
 *   - send_dm        → send a lead a message via GHL (confirm-first, prompt-enforced)
 *   - set_lead_ai    → turn the AI setter on/off for a lead (db + "ai off" tag)
 *   - manage_tags    → add/remove GHL tags on a lead
 *   - move_pipeline  → move a lead's GHL opportunity to another pipeline stage
 *
 * POST /api/hq/chat?k=<key>  body: { message, history }  → { speech, panels, clear }
 */
import { NextRequest, NextResponse } from "next/server";
import { businessDayBackISO, businessDayISO, businessWeekStartISO } from "@/lib/business-day";
import type Anthropic from "@anthropic-ai/sdk";
import { supabase, saveMessage, logEvent, type Client, type Lead } from "@/lib/supabase";
import {
  addContactTags, removeContactTags,
  findContactOpportunity, listPipelines, moveOpportunityStage,
} from "@/lib/ghl";
import { sendLeadMessage } from "@/lib/send";
import { getAccessKey } from "@/lib/prompter/access";
import { normalizeHandle } from "@/lib/bans";
import { STOP_TAGS, PAUSE_TAG } from "@/domain/ghl";
import { shortLeadRef } from "@/lib/telegram";
import { pickLead } from "@/lib/lead-pick";
import { webSearch } from "@/lib/websearch";
import { listEvents, manageEvent, searchEmail, sendEmail } from "@/lib/google";
import { runDmIntel, getLatestDmReport } from "@/lib/dmintel";
import { draftReplyForLead } from "@/lib/draft";
import { waitUntil } from "@vercel/functions";
import { claude } from "@/lib/anthropic";
import { ownerSlug } from "@/lib/tenant";
import { embedQuery } from "@/lib/embed";
import { OWNER_EXTRA_TOOLS, OWNER_EXTRA_SYSTEM, runOwnerExtraTool } from "@/lib/hq/owner-extras";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = "claude-sonnet-4-6";

function pad(n: number) { return String(n).padStart(2, "0"); }
function isoDate(d: Date) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function rangeFor(period: string): { start: string; end: string } {
  // Business-day dates (04:00 Stockholm), the same day rule as Telegram's EOD
  // report and get_dashboard itself, so "today" means the same day everywhere.
  const end = businessDayISO();
  const p = (period || "").toLowerCase().replace(/\s+/g, "_");
  const back = businessDayBackISO;
  if (p === "today") return { start: end, end };
  if (p === "yesterday") return { start: back(1), end: back(1) };
  if (p === "last_7_days" || p === "7d" || p === "past_week") return { start: back(6), end };
  if (p === "last_30_days" || p === "30d") return { start: back(29), end };
  if (p === "week" || p === "this_week") return { start: businessWeekStartISO(), end };
  if (p === "month" || p === "this_month") return { start: `${end.slice(0, 7)}-01`, end };
  if (p === "year" || p === "this_year") return { start: `${end.slice(0, 4)}-01-01`, end };
  if (p === "all" || p === "all_time") return { start: "2000-01-01", end };
  return { start: back(6), end };
}
function sinceISO(days: number) { return new Date(Date.now() - days * 86400_000).toISOString(); }

function leadBrief(l: Lead) {
  return {
    name: l.full_name || l.ig_username || "unknown",
    handle: l.ig_username || "",
    // THE REF IS WHAT MAKES A LIST PICKABLE. 910 of 951 leads have no handle
    // and many share a first name, so "which one?" answered with three rows of
    // {name, handle:"", stage} is unanswerable. The ref is printed in every
    // owner ping and resolves exactly when they type it back.
    ref: shortLeadRef(l.id),
    status: l.status || "",
    pipeline_stage: l.stage || "",
    ai_paused: !!l.ai_paused,
    last_message_at: l.last_message_at,
  };
}

type LeadMatch = ReturnType<typeof leadBrief>;

/**
 * WHAT TO RETURN WHEN resolveLead COULD NOT PICK A PERSON.
 *
 * "Not found" and "found five of them" are different answers and were being
 * reported identically, which is how a lead nobody named got switched off:
 * resolveLead took rows[0] - the most recently active of up to five fuzzy
 * matches - and every caller acted on it without a word.
 */
function leadMiss(matches: LeadMatch[], ambiguous: boolean) {
  if (!ambiguous) return { error: "lead_not_found" as const, matches };
  return {
    error: "ambiguous_lead" as const,
    matches,
    note:
      "More than one lead matches that. Ask which one, listing the refs, and " +
      "act only once they pick. Do NOT guess.",
  };
}

const REF_RE = /#([0-9a-fA-F]{6,32})\b/;

/**
 * Find the lead a spoken name / handle / #ref means (owner-scoped).
 *
 * Returns `lead: null, ambiguous: true` rather than a guess when the query
 * fits more than one person. An exact name or handle wins outright even when
 * looser matches exist, so "Oscar" still resolves when an "Oscar Nilsson-Berg"
 * also matches the ilike.
 */
async function resolveLead(
  clientId: string,
  query: string
): Promise<{ lead: Lead | null; matches: LeadMatch[]; ambiguous: boolean }> {
  const raw = (query || "").trim();
  if (!raw) return { lead: null, matches: [], ambiguous: false };

  // THE REF IS EXACT AND BEATS EVERYTHING. It is what the owner pings print, so
  // it is what they paste back. id_ref is a generated column (first six hex of
  // the uuid); `id ilike` is not an option - Postgres cannot pattern-match a
  // uuid and throws 42883.
  const ref = raw.match(REF_RE);
  if (ref) {
    const { data } = await supabase
      .from("leads")
      .select("*")
      .eq("id_ref", ref[1].slice(0, 6).toLowerCase())
      .limit(5);
    const hits = (data ?? []) as Lead[];
    if (hits.length === 1) return { lead: hits[0], matches: hits.map(leadBrief), ambiguous: false };
    if (hits.length > 1) return { lead: null, matches: hits.map(leadBrief), ambiguous: true };
    // A ref that matches nobody falls through to the name search below rather
    // than dead-ending: they may have typed a name that happens to carry a hash.
  }

  const q = raw.replace(/^@/, "").replace(/[%,()#]/g, "").trim();
  if (!q) return { lead: null, matches: [], ambiguous: false };
  // Tolerate NULL client_id (the "Oskar incident"): most lead rows have it null,
  // and filtering strictly by it hid real people, so a lead findable for money was
  // not findable for actions. Match resolveCustomer's looser scoping.
  const { data } = await supabase
    .from("leads")
    .select("*")
    .or(`client_id.eq.${clientId},client_id.is.null`)
    .or(`full_name.ilike.%${q}%,ig_username.ilike.%${q}%`)
    .order("last_message_at", { ascending: false })
    .limit(5);
  const rows = (data ?? []) as Lead[];
  const picked = pickLead(rows, q);
  return { lead: picked.lead, matches: rows.map(leadBrief), ambiguous: picked.ambiguous };
}

/** Map a stored message channel to the GHL send type. */
function ghlTypeFor(channel: string): "IG" | "SMS" | "Email" | "WhatsApp" | "FB" {
  const c = (channel || "").toLowerCase();
  if (c.includes("sms")) return "SMS";
  if (c.includes("whats")) return "WhatsApp";
  if (c.includes("fb") || c.includes("facebook")) return "FB";
  if (c.includes("email")) return "Email";
  return "IG";
}

/**
 * The owner's client row, ignoring is_active — that flag is the setter's
 * auto-reply switch (the owner pauses it routinely) and must NOT take HQ's
 * lookups, conversations, and sends down with it.
 */
async function getHqClient(): Promise<Client | null> {
  const { data } = await supabase.from("clients").select("*").eq("slug", ownerSlug()).maybeSingle();
  return (data as Client | null) ?? null;
}

// ───────────────────────────── READ tools ─────────────────────────────

async function getBusinessData(period: string, source?: string, funnel?: string) {
  const { start, end } = rangeFor(period);
  const { data, error } = await supabase.rpc("get_dashboard", {
    p_start: start, p_end: end, p_source: source || null,
    p_funnel: funnel && ["all", "outbound", "inbound"].includes(funnel) ? funnel : "all",
  });
  if (error) return { error: error.message };
  return { period, start, end, ...(data as object) };
}

/**
 * Bookings the EXACT way the dashboard counts them: reporting_funnel rows
 * with reached_booked, filtered by lead date. NOT the events table — its
 * appointment_booked rows include the pipeline watcher's historical "ever
 * booked" stamps, which once made Jarvis claim 10 bookings in a week the
 * dashboard showed as 0.
 */
async function getRecentBookings(period = "last_30_days", limit = 10) {
  const { start, end } = rangeFor(period);
  const { data } = await supabase
    .from("reporting_funnel")
    .select("id, lead_date, channel, funnel, ai_booked")
    .eq("reached_booked", true)
    .gte("lead_date", `${start}T00:00:00Z`)
    .lte("lead_date", `${end}T23:59:59Z`)
    .order("lead_date", { ascending: false })
    .limit(limit);
  const rows = await Promise.all((data ?? []).map(async (r) => {
    let name = "unknown", handle = "";
    const { data: l } = await supabase.from("leads").select("full_name, ig_username").eq("id", r.id).maybeSingle();
    if (l) { name = l.full_name || l.ig_username || "unknown"; handle = l.ig_username || ""; }
    return { name, handle, source: r.channel || "", funnel: r.funnel || "", ai_booked: !!r.ai_booked, lead_date: r.lead_date };
  }));
  return {
    period,
    booked_count: rows.length,
    note: "counted exactly like the dashboard (leads from this period who reached booked)",
    bookings: rows,
  };
}

async function findLead(clientId: string, query: string) {
  const { matches } = await resolveLead(clientId, query);
  return { matches };
}

/**
 * The NAMES behind the money — customers + their payments, the same tables
 * the dashboard's revenue numbers come from. closed_at drives the period.
 */
async function getClosedDeals(period = "last_30_days", limit = 12) {
  const { start, end } = rangeFor(period);
  const { data } = await supabase
    .from("customers")
    .select("id, name, contract_value, currency, closer, closed_at, status, source, booking_method")
    .gte("closed_at", `${start}T00:00:00Z`)
    .lte("closed_at", `${end}T23:59:59Z`)
    .order("closed_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 25));
  const deals = await Promise.all((data ?? []).map(async (c) => {
    const { data: pays } = await supabase
      .from("payments").select("amount, kind, collected_at")
      .eq("customer_id", c.id).order("collected_at", { ascending: true });
    const cash = (pays ?? []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    return {
      name: c.name || "unknown",
      signed: Number(c.contract_value) || 0,
      cash_collected: cash,
      payments_made: (pays ?? []).length,
      closer: c.closer || "",
      closed_at: c.closed_at,
      status: c.status || "",
      source: c.source || "",
      booking_method: c.booking_method || "",
    };
  }));
  return {
    period,
    deal_count: deals.length,
    total_signed: deals.reduce((s, d) => s + d.signed, 0),
    total_cash_collected: deals.reduce((s, d) => s + d.cash_collected, 0),
    deals,
  };
}

async function leadStory(clientId: string, query: string) {
  const { lead, matches, ambiguous } = await resolveLead(clientId, query);
  if (!lead) return { found: false, ...leadMiss(matches, ambiguous) };
  const [msgs, bookEvents, msgCount] = await Promise.all([
    supabase.from("messages").select("role, content, channel, created_at").eq("lead_id", lead.id).order("created_at", { ascending: false }).limit(6),
    supabase.from("events").select("event_type, created_at").eq("lead_id", lead.id).in("event_type", ["call_booked", "appointment_booked", "lead_disqualified"]).order("created_at", { ascending: false }).limit(5),
    supabase.from("messages").select("id", { count: "exact", head: true }).eq("lead_id", lead.id),
  ]);
  const leadRow = lead as Lead & { source?: string };
  return {
    found: true,
    other_matches: matches.length > 1 ? matches.slice(1) : [],
    profile: {
      ...leadBrief(lead),
      source: leadRow.source || "",
      email: lead.email || "",
      phone: lead.phone || "",
      funnel_stage: lead.funnel_stage || "",
      facts_learned: lead.stage_data || {},
      first_contact_at: lead.first_contact_at,
      created_at: lead.created_at,
      total_messages: msgCount.count ?? 0,
    },
    key_events: bookEvents.data ?? [],
    last_messages: (msgs.data ?? []).reverse().map((m) => ({
      from: m.role === "lead" ? "lead" : "us", text: String(m.content || "").slice(0, 280), channel: m.channel, at: m.created_at,
    })),
  };
}

async function getConversation(clientId: string, query: string, limit = 14) {
  const { lead, matches, ambiguous } = await resolveLead(clientId, query);
  if (!lead) return { found: false, ...leadMiss(matches, ambiguous) };
  const { data } = await supabase
    .from("messages")
    .select("role, content, channel, created_at")
    .eq("lead_id", lead.id)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 4), 30));
  return {
    found: true,
    lead: leadBrief(lead),
    other_matches: matches.length > 1 ? matches.slice(1) : [],
    messages: (data ?? []).reverse().map((m) => ({
      from: m.role === "lead" ? "lead" : "us", text: String(m.content || "").slice(0, 300), channel: m.channel, at: m.created_at,
    })),
  };
}

async function getHotLeads(clientId: string, limit = 6) {
  const { data } = await supabase
    .from("leads")
    .select("*")
    .eq("client_id", clientId)
    .eq("status", "engaged")
    .eq("ai_paused", false)
    .order("last_message_at", { ascending: false })
    .limit(15);
  const candidates = (data ?? []) as Lead[];
  const scored = await Promise.all(candidates.map(async (l) => {
    const { count } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", l.id)
      .eq("role", "lead")
      .gte("created_at", sinceISO(3));
    return { ...leadBrief(l), funnel_stage: l.funnel_stage || "", replies_last_3d: count ?? 0 };
  }));
  scored.sort((a, b) => b.replies_last_3d - a.replies_last_3d || (b.last_message_at || "").localeCompare(a.last_message_at || ""));
  return { hot_leads: scored.slice(0, Math.min(Math.max(limit, 3), 10)) };
}

async function getMorningBrief(clientId: string) {
  const [yesterday, week, bookings, cold, newToday] = await Promise.all([
    getBusinessData("yesterday"),
    getBusinessData("last_7_days"),
    getRecentBookings("last_7_days", 5),
    supabase.from("leads").select("full_name, ig_username, last_message_at")
      .eq("client_id", clientId).eq("status", "engaged").eq("ai_paused", false)
      .lt("last_message_at", sinceISO(2)).gt("last_message_at", sinceISO(5))
      .order("last_message_at", { ascending: false }).limit(5),
    supabase.from("leads").select("id", { count: "exact", head: true })
      .eq("client_id", clientId).gt("created_at", sinceISO(1)),
  ]);
  return {
    yesterday, last_7_days: week,
    recent_bookings: bookings.bookings,
    leads_going_cold: (cold.data ?? []).map((l) => ({
      name: l.full_name || l.ig_username || "unknown", handle: l.ig_username || "", last_heard: l.last_message_at,
    })),
    new_leads_today: newToday.count ?? 0,
  };
}

/**
 * Numbers for casual questions — pulled from the SAME get_dashboard RPC the
 * dashboard uses so Jarvis never disagrees with it (raw table counts diverge:
 * bulk imports + watcher stamps inflate them).
 */
async function quickPulse() {
  const [dash, engaged] = await Promise.all([
    getBusinessData("last_7_days"),
    supabase.from("leads").select("id", { count: "exact", head: true }).eq("status", "engaged"),
  ]);
  const d = dash as { sales?: { booked?: number; cash_collected?: number }; by_source?: Array<{ leads?: number }> };
  return {
    leads_7d: (d.by_source ?? []).reduce((s, r) => s + (Number(r.leads) || 0), 0),
    engaged_now: engaged.count ?? 0,
    booked_7d: Number(d.sales?.booked) || 0,
    cash_7d: Number(d.sales?.cash_collected) || 0,
  };
}

// ─────────────────────────── CONTENT tools ───────────────────────────
// ──────────────────────────── ACTION tools ────────────────────────────

/** Compose (don't send) the reply the setter WOULD send this lead next, per its
 *  SOP — same brain, stage, voice, language. For 'draft a reply to X', or to get
 *  the next message for a lead the setter turned off so the owner can send it. */
async function draftReply(client: Client, query: string, voice = false) {
  const { lead, matches, ambiguous } = await resolveLead(client.id, query);
  if (!lead) return { found: false, ...leadMiss(matches, ambiguous) };
  try {
    const d = await draftReplyForLead({ client: client as unknown as Record<string, unknown> & { id: string }, lead, voice });
    return {
      found: true,
      lead: leadBrief(lead),
      draft_bubbles: d.bubbles,
      draft_text: d.text,
      stage: d.stage,
      language: d.language,
      voice_url: d.voiceUrl ?? null,
      voiced: d.voiced ?? false,
      voice_note: d.voiceNote,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    if (msg === "no_pending_lead_message") {
      return { found: true, lead: leadBrief(lead), error: "no_pending_lead_message", note: "The lead's last message isn't inbound — there's nothing for the setter to reply to yet." };
    }
    return { found: true, lead: leadBrief(lead), error: "draft_failed" };
  }
}

async function sendDm(client: Client, query: string, message: string) {
  const text = (message || "").trim();
  if (!text) return { sent: false, error: "empty_message" };
  const { lead, matches, ambiguous } = await resolveLead(client.id, query);
  if (!lead) return { sent: false, ...leadMiss(matches, ambiguous) };
  // No GHL precondition (audit 2026-08-13). Sends go through ManyChat, and the
  // chokepoint resolves the subscriber from the LEAD row itself - so requiring
  // ghl_contact_id here made "DM him" fail from HQ for every ManyChat-first
  // lead (ghl_contact_id NULL by design), the system's most common kind. The
  // GHL ids are passed only as join keys when they exist.
  const { data: lastMsg } = await supabase
    .from("messages").select("channel").eq("lead_id", lead.id)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const channel = lastMsg?.channel || "instagram";
  const result = await sendLeadMessage({
    client_id: client.id,
    lead_id: lead.id,
    manychat_token: client.manychat_api_token ?? null,
    manychat_subscriber_id: lead.manychat_subscriber_id ?? null,
    full_name: lead.full_name ?? null,
    ig_username: lead.ig_username ?? null,
    ghl_api_key: client.ghl_api_key,
    ghl_location_id: client.ghl_location_id,
    ghl_contact_id: lead.ghl_contact_id ?? "",
    message: text,
    type: ghlTypeFor(channel),
  });
  if (!result.success) return { sent: false, error: result.error, lead: leadBrief(lead) };
  await saveMessage({
    lead_id: lead.id, client_id: client.id, role: "human", content: text,
    channel, ghl_message_id: result.ghl_message_id, delivered: true,
  });
  await logEvent({ client_id: client.id, lead_id: lead.id, event_type: "human_message_sent", metadata: { via: "jarvis_hq" } });
  return { sent: true, to: leadBrief(lead), channel };
}

async function setLeadAi(client: Client, query: string, on: boolean) {
  const { lead, matches, ambiguous } = await resolveLead(client.id, query);
  if (!lead) return { done: false, ...leadMiss(matches, ambiguous) };
  // ONE SWITCH, ONE MEANING (2026-08-09): a pause stops replies, follow-ups and
  // nurture together, and turning the person back on gives all three back. HQ
  // and Telegram must not disagree about what "on" means.
  const { error } = await supabase
    .from("leads")
    // ai_resumed_at: an explicit resume outranks the owner's older manual messages
    // in the human-takeover guard - without the stamp, resuming a lead he had
    // ever typed to re-paused on their next reply (see humanIsHoldingThread).
    .update(on
      ? { ai_paused: false, followup_paused: false, nurture_paused: false, ai_resumed_at: new Date().toISOString() }
      : { ai_paused: true, followup_paused: true, nurture_paused: true })
    .eq("id", lead.id);
  if (error) return { done: false, error: error.message };
  if (client.ghl_api_key && lead.ghl_contact_id) {
    // STOP_TAGS comes from domain/ghl now. HQ kept its own 6-tag copy while the
    // engine enforces a 10-tag list, so "turn him back on" removed "ai off" and
    // left "do not contact" / "dnc" / "human" / "handover" / "no ai" in place —
    // the engine went on refusing to reply and HQ reported success.
    if (on) await removeContactTags(client.ghl_api_key, lead.ghl_contact_id, [...STOP_TAGS]);
    else await addContactTags(client.ghl_api_key, lead.ghl_contact_id, [PAUSE_TAG]);
  }
  await logEvent({ client_id: client.id, lead_id: lead.id, event_type: "ai_toggled", metadata: { on, via: "jarvis_hq" } });
  return { done: true, lead: leadBrief(lead), ai_now: on ? "on" : "off" };
}

async function manageTags(client: Client, query: string, add: string[], remove: string[]) {
  const { lead, matches, ambiguous } = await resolveLead(client.id, query);
  if (!lead) return { done: false, ...leadMiss(matches, ambiguous) };
  if (!client.ghl_api_key || !lead.ghl_contact_id) return { done: false, error: "missing_ghl_credentials_or_contact" };
  const out: Record<string, unknown> = { lead: leadBrief(lead) };
  if (add.length) { const r = await addContactTags(client.ghl_api_key, lead.ghl_contact_id, add); out.added = r.success ? add : `failed: ${r.error}`; }
  if (remove.length) { const r = await removeContactTags(client.ghl_api_key, lead.ghl_contact_id, remove); out.removed = r.success ? remove : `failed: ${r.error}`; }
  out.done = true;
  return out;
}

/** SYSTEM-WIDE setter switch — same clients.is_active flag the Telegram bot flips. */
async function setSetterSystem(on: boolean) {
  // ON MEANS EVERYTHING ON (the owner, 2026-08-09): "when I say turn on AI for
  // everyone, then the AI, including the follow-up and nurturing, all should be
  // on. Same thing when it goes off." is_active alone left followup_enabled and
  // nurture_enabled independently off, so flipping the master switch back on
  // reported a fully live setter while the whole follow-up system stayed dark.
  // The enable-boundary stamps go with it, because both engines ignore stalls
  // that began before switch-on and re-stamping is what stops a month of
  // accumulated silence turning into a burst of catch-up messages.
  const patch: Record<string, unknown> = {
    is_active: on,
    followup_enabled: on,
    nurture_enabled: on,
  };
  if (on) {
    const nowIso = new Date().toISOString();
    patch.followup_enabled_at = nowIso;
    patch.nurture_enabled_at = nowIso;
  }
  const { error } = await supabase.from("clients").update(patch).eq("slug", ownerSlug());
  if (error) return { done: false, error: error.message };
  clientCache = null; // the HQ's cached client row just changed state
  // VERIFY-AFTER-WRITE: read the flag back and refuse to claim a state the
  // database doesn't actually show — a silent no-op here once told the owner
  // the setter was back on while every lead kept getting setter_off_skip.
  const { data: check } = await supabase.from("clients").select("is_active").eq("slug", ownerSlug()).maybeSingle();
  const actual = (check as { is_active?: boolean } | null)?.is_active;
  if (actual !== on) {
    return { done: false, error: `switch did not take — database still says is_active=${actual}. Tell the owner honestly that the toggle FAILED.` };
  }
  return { done: true, setter_now: on ? "ON (verified in the database) — replying to leads" : "OFF (verified in the database) — paused system-wide" };
}

/** SYSTEM-WIDE nurture switch (clients.nurture_enabled). On enable, stamp
 *  nurture_enabled_at = now so it never reaches back to pre-enable leads. */
async function setNurtureSystem(on: boolean) {
  const patch: Record<string, unknown> = { nurture_enabled: on };
  if (on) patch.nurture_enabled_at = new Date().toISOString();
  const { error } = await supabase.from("clients").update(patch).eq("slug", ownerSlug());
  if (error) return { done: false, error: error.message };
  clientCache = null;
  return { done: true, nurture_now: on ? "ON — booked leads get the warm-up sequence" : "OFF — no nurture sends" };
}

/** Per-lead nurture switch (leads.nurture_paused). on=true → nurtured; on=false → skipped. */
async function setNurtureLead(client: Client, query: string, on: boolean) {
  const { lead, matches, ambiguous } = await resolveLead(client.id, query);
  if (!lead) return { done: false, ...leadMiss(matches, ambiguous) };
  const { error } = await supabase.from("leads").update({ nurture_paused: !on }).eq("id", lead.id);
  if (error) return { done: false, error: error.message };
  return { done: true, lead: leadBrief(lead), nurture_now: on ? "on" : "off" };
}

const FUNNEL_ORDER = ["opener", "transition_main_reason", "goals", "current_situation", "timeline", "problem", "consequence", "consequence_why", "pitch_help", "book", "post_book", "proof", "nurture"];
const STAGE_LABEL: Record<string, string> = {
  opener: "Opener", transition_main_reason: "Main reason", goals: "Goals", current_situation: "Situation",
  timeline: "Timeline", problem: "Problem", consequence: "Consequence", consequence_why: "Why not", pitch_help: "Pitch", book: "Booking", post_book: "Post-book", proof: "Proof", nurture: "Nurture",
};
/** Follow-up performance + the leak map (where leads die). */
async function getFollowupStats() {
  const [sum, leak] = await Promise.all([
    supabase.from("reporting_followups").select("*").maybeSingle(),
    supabase.from("reporting_leak_map").select("*"),
  ]);
  const leakRows = ((leak.data ?? []) as { funnel_stage: string; stalled: number }[])
    .map((r) => ({ stage: STAGE_LABEL[r.funnel_stage] || r.funnel_stage, stalled: r.stalled }))
    .sort((a, b) => FUNNEL_ORDER.indexOf(Object.keys(STAGE_LABEL).find((k) => STAGE_LABEL[k] === a.stage) || a.stage) - FUNNEL_ORDER.indexOf(Object.keys(STAGE_LABEL).find((k) => STAGE_LABEL[k] === b.stage) || b.stage));
  const s = (sum.data ?? {}) as Record<string, number>;
  return {
    follow_ups_sent_7d: s.sent_7d ?? 0, follow_ups_sent_30d: s.sent_30d ?? 0, follow_ups_sent_total: s.sent_total ?? 0,
    leads_revived_7d: s.revived_7d ?? 0, leads_revived_total: s.revived_total ?? 0,
    leads_rebooked_total: s.rebooked_total ?? 0,
    where_leads_die: leakRows, // stalled-lead count per funnel stage, in funnel order
  };
}

/** SYSTEM-WIDE follow-up switch (clients.followup_enabled). On enable, stamp
 *  followup_enabled_at so it only acts on stalls from now on. */
async function setFollowupSystem(on: boolean) {
  const patch: Record<string, unknown> = { followup_enabled: on };
  if (on) patch.followup_enabled_at = new Date().toISOString();
  const { error } = await supabase.from("clients").update(patch).eq("slug", ownerSlug());
  if (error) return { done: false, error: error.message };
  clientCache = null;
  return { done: true, followups_now: on ? "ON — quiet leads get re-engaged" : "OFF — no follow-up sends" };
}

/** SYSTEM-WIDE DM-intelligence switch (clients.dm_intel_enabled) — governs ONLY
 *  the automatic MONTHLY analysis + ping. On-demand analysis works regardless. */
async function setDmIntelSystem(on: boolean) {
  const { error } = await supabase.from("clients").update({ dm_intel_enabled: on }).eq("slug", ownerSlug());
  if (error) return { done: false, error: error.message };
  clientCache = null;
  return { done: true, dm_intel_now: on ? "ON — monthly DM analysis + ping (you can still run it on demand any time)" : "OFF — no automatic monthly run (you can still run it on demand any time)" };
}

/** SYSTEM-WIDE whale-radar switch (clients.whale_radar_enabled). When on, the
 *  setter scores leads on expected value and pings the owner about high-value ones. */
async function setWhaleRadarSystem(on: boolean) {
  const { error } = await supabase.from("clients").update({ whale_radar_enabled: on }).eq("slug", ownerSlug());
  if (error) return { done: false, error: error.message };
  clientCache = null;
  return { done: true, whale_radar_now: on ? "ON — you get a Telegram ping when a high-value lead shows up" : "OFF — no whale alerts" };
}

/** SYSTEM-WIDE "dig deeper into pain" switch (clients.pain_dig_enabled). When on,
 *  the setter pauses the funnel to explore an emotionally heavy disclosure, then
 *  resumes. Tune the trigger words/style via the pain_protocol brain field. */
async function setPainDigSystem(on: boolean) {
  const { error } = await supabase.from("clients").update({ pain_dig_enabled: on }).eq("slug", ownerSlug());
  if (error) return { done: false, error: error.message };
  clientCache = null;
  return { done: true, pain_dig_now: on ? "ON — when a lead shares something heavy, the setter pauses, digs into the pain with empathy, then picks the conversation back up" : "OFF — the setter runs the normal flow, no pain-digging" };
}

/** SYSTEM-WIDE voice-notes switch, PER LANGUAGE. English = clients.voice_enabled;
 *  Swedish = clients.voice_enabled_sv (ships OFF — Swedish convos stay text). When
 *  on, the setter can reply with voice notes in the operator's cloned voice on the
 *  right beats. lang omitted => English. */
async function setVoiceSystem(on: boolean, lang?: string) {
  const sv = lang === "sv";
  const col = sv ? "voice_enabled_sv" : "voice_enabled";
  const { error } = await supabase.from("clients").update({ [col]: on }).eq("slug", ownerSlug());
  if (error) return { done: false, error: error.message };
  clientCache = null;
  const which = sv ? "Swedish voice" : "English voice";
  return {
    done: true,
    voice_now: on
      ? `${which} ON — the setter can send voice notes in your cloned voice on those threads (text for links/times)`
      : `${which} OFF — ${sv ? "Swedish conversations stay text only" : "text only, no English voice notes"}`,
  };
}

/** Per-lead voice switch (leads.voice_paused). on=true → can get voice notes; on=false → text only. */
async function setVoiceLead(client: Client, query: string, on: boolean) {
  const { lead, matches, ambiguous } = await resolveLead(client.id, query);
  if (!lead) return { done: false, ...leadMiss(matches, ambiguous) };
  const { error } = await supabase.from("leads").update({ voice_paused: !on }).eq("id", lead.id);
  if (error) return { done: false, error: error.message };
  return { done: true, lead: leadBrief(lead), voice_now: on ? "on" : "off" };
}

/** Setter activity notifications, per KIND. scope 'all' = the master switch;
 *  the individual kinds are 'started' | 'replied' | 'silent' | 'failed' |
 *  'followup', each toggled on/off independently (stored as mutes in
 *  clients.setter_notify_off). 'all' on = master on + every kind on; 'all' off =
 *  master off. Turning a single kind on also ensures the master is on so it can
 *  actually fire. */
const NOTIFY_KINDS = ["started", "replied", "silent", "failed", "followup"];
async function setNotify(scope: string, on: boolean) {
  const s = (scope || "all").toLowerCase();
  if (s !== "all" && !NOTIFY_KINDS.includes(s)) {
    return { done: false, error: `unknown notification type '${scope}' — use one of: all, ${NOTIFY_KINDS.join(", ")}` };
  }
  const { data } = await supabase.from("clients").select("setter_notify_enabled, setter_notify_off").eq("slug", ownerSlug()).maybeSingle();
  let enabled = (data as { setter_notify_enabled?: boolean } | null)?.setter_notify_enabled === true;
  let off = Array.isArray((data as { setter_notify_off?: string[] } | null)?.setter_notify_off)
    ? ((data as { setter_notify_off?: string[] }).setter_notify_off as string[]) : [];
  if (s === "all") {
    enabled = on;
    if (on) off = [];
  } else if (on) {
    off = off.filter((k) => k !== s);
    enabled = true;
  } else if (!off.includes(s)) {
    off.push(s);
  }
  const { error } = await supabase.from("clients").update({ setter_notify_enabled: enabled, setter_notify_off: off }).eq("slug", ownerSlug());
  if (error) return { done: false, error: error.message };
  clientCache = null;
  const live = enabled ? NOTIFY_KINDS.filter((k) => !off.includes(k)) : [];
  return {
    done: true,
    master: enabled ? "ON" : "OFF",
    pinging_for: live,
    muted: enabled ? off : NOTIFY_KINDS,
    note: enabled
      ? `You'll get pings for: ${live.join(", ") || "(none — all kinds muted)"}.`
      : "All setter notifications are OFF.",
  };
}

/** Per-lead whale-radar switch (leads.whale_paused). on=true → can ping; on=false → muted. */
async function setWhaleLead(client: Client, query: string, on: boolean) {
  const { lead, matches, ambiguous } = await resolveLead(client.id, query);
  if (!lead) return { done: false, ...leadMiss(matches, ambiguous) };
  const { error } = await supabase.from("leads").update({ whale_paused: !on }).eq("id", lead.id);
  if (error) return { done: false, error: error.message };
  return { done: true, lead: leadBrief(lead), whale_radar_now: on ? "on" : "off" };
}

/** Voice-note usage over a recent window (in hours). Counts notes actually sent. */
async function getVoiceStats(hours: number) {
  const sinceIso = new Date(Date.now() - Math.max(1, hours) * 3600_000).toISOString();
  const { data } = await supabase
    .from("events")
    .select("metadata")
    .in("event_type", ["ai_replied", "ai_reply_failed"])
    .gte("created_at", sinceIso);
  let voiceNotes = 0, replies = 0;
  for (const e of (data ?? []) as { metadata: { voice_notes?: number } | null }[]) {
    voiceNotes += Number(e.metadata?.voice_notes || 0);
    replies += 1;
  }
  const label = hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
  return { window: label, voice_notes_sent: voiceNotes, ai_replies: replies };
}

// ─── SETTER BRAIN EDITS (apply a DM-intel fix, or any brain change, from the orbit) ───
// Mirrors the Telegram brain-edit flow and shares the same setter_brain_versions
// table, so 'undo' works across both surfaces. Writes are confirm-gated.
const BRAIN_FIELDS = ["system_prompt", "active_rules", "voice_samples", "business_context", "pain_protocol"] as const;
type BrainField = (typeof BRAIN_FIELDS)[number];
const isBrainField = (f: string): f is BrainField => (BRAIN_FIELDS as readonly string[]).includes(f);

/** Read one brain field (so a change can be composed against the real current text). */
async function getBrainField(field: string) {
  if (!isBrainField(field)) return { error: "unknown_field", fields: BRAIN_FIELDS };
  const { data } = await supabase.from("clients").select(field).eq("slug", ownerSlug()).maybeSingle();
  const value = (data as Record<string, unknown> | null)?.[field];
  return { field, value: (typeof value === "string" && value) ? value : "(empty)" };
}

/** Save a brain field (FULL new text). Confirm-gated; keeps the prior version for undo. */
async function setBrainField(client: Client, field: string, newValue: string, confirmed: boolean) {
  if (!isBrainField(field)) return { done: false, error: "unknown_field", fields: BRAIN_FIELDS };
  if (!confirmed) return { done: false, error: "not_confirmed", note: "Show the owner exactly what will change and wait for their yes, then call again with confirmed=true." };
  if (!newValue.trim()) return { done: false, error: "refusing_empty", note: "Won't save an empty brain field." };
  const { data: cur } = await supabase.from("clients").select(field).eq("id", client.id).maybeSingle();
  const oldValue = (cur as Record<string, unknown> | null)?.[field] ?? null;
  await supabase.from("setter_brain_versions").insert({ client_id: client.id, field, old_value: oldValue, new_value: newValue, changed_by: "the owner (Jarvis HQ)" });
  const { error } = await supabase.from("clients").update({ [field]: newValue }).eq("id", client.id);
  if (error) return { done: false, error: error.message };
  clientCache = null;
  return { done: true, field, chars: newValue.length, note: "Saved. Live on the setter's next reply. Say 'undo that' to roll it back." };
}

/** Restore the most recent prior version of a brain field ('undo that'). Confirm-gated. */
async function undoBrainField(client: Client, field: string, confirmed: boolean) {
  if (!isBrainField(field)) return { done: false, error: "unknown_field", fields: BRAIN_FIELDS };
  if (!confirmed) return { done: false, error: "not_confirmed", note: "Confirm with the owner, then call again with confirmed=true." };
  const { data: versions } = await supabase.from("setter_brain_versions")
    .select("id, old_value, changed_at").eq("client_id", client.id).eq("field", field)
    .order("changed_at", { ascending: false }).limit(1);
  const v = (versions ?? [])[0] as { old_value: string | null } | undefined;
  if (!v) return { done: false, error: "no_versions", note: `No saved versions of ${field} to restore.` };
  const { data: cur } = await supabase.from("clients").select(field).eq("id", client.id).maybeSingle();
  const current = (cur as Record<string, unknown> | null)?.[field] ?? null;
  await supabase.from("setter_brain_versions").insert({ client_id: client.id, field, old_value: current, new_value: v.old_value, changed_by: "the owner (Jarvis HQ, undo)" });
  const { error } = await supabase.from("clients").update({ [field]: v.old_value }).eq("id", client.id);
  if (error) return { done: false, error: error.message };
  clientCache = null;
  return { done: true, field, restored_chars: (v.old_value || "").length, note: "Restored. Live on the next reply." };
}

/** Per-lead follow-up switch (leads.followup_paused). on=true → followed up; on=false → skipped. */
async function setFollowupLead(client: Client, query: string, on: boolean) {
  const { lead, matches, ambiguous } = await resolveLead(client.id, query);
  if (!lead) return { done: false, ...leadMiss(matches, ambiguous) };
  const { error } = await supabase.from("leads").update({ followup_paused: !on }).eq("id", lead.id);
  if (error) return { done: false, error: error.message };
  return { done: true, lead: leadBrief(lead), followups_now: on ? "on" : "off" };
}

/** Ban: write the banned_contacts row (the webhook enforces it on every inbound) + pause AI. */
async function banLead(client: Client, query: string, reason: string) {
  const { lead, matches, ambiguous } = await resolveLead(client.id, query);
  if (!lead) return { done: false, ...leadMiss(matches, ambiguous) };
  const { error } = await supabase.from("banned_contacts").insert({
    client_id: client.id,
    ghl_contact_id: lead.ghl_contact_id || null,
    ig_username: normalizeHandle(lead.ig_username),
    full_name: lead.full_name || null,
    reason: reason || "banned via Jarvis HQ",
    active: true,
  });
  if (error) return { done: false, error: error.message };
  await supabase.from("leads").update({ ai_paused: true }).eq("id", lead.id);
  await logEvent({ client_id: client.id, lead_id: lead.id, event_type: "lead_banned", metadata: { via: "jarvis_hq", reason } });
  return { done: true, banned: leadBrief(lead) };
}

async function unbanLead(client: Client, query: string) {
  const q = normalizeHandle(query) || (query || "").trim().toLowerCase();
  if (!q) return { done: false, error: "empty_query" };
  const { data } = await supabase
    .from("banned_contacts")
    .select("id, ig_username, full_name")
    .eq("client_id", client.id).eq("active", true);
  const hit = (data ?? []).find((b) =>
    (b.ig_username || "").toLowerCase() === q || (b.full_name || "").toLowerCase().includes(q));
  if (!hit) return { done: false, error: "no_active_ban_matched", active_bans: (data ?? []).map((b) => b.full_name || b.ig_username) };
  const { error } = await supabase.from("banned_contacts").update({ active: false }).eq("id", hit.id);
  if (error) return { done: false, error: error.message };
  return { done: true, unbanned: hit.full_name || hit.ig_username };
}

async function listBans(client: Client) {
  const { data } = await supabase
    .from("banned_contacts").select("ig_username, full_name, reason")
    .eq("client_id", client.id).eq("active", true);
  return { active_bans: (data ?? []).map((b) => ({ name: b.full_name || "", handle: b.ig_username || "", reason: b.reason || "" })) };
}

async function movePipeline(client: Client, query: string, stageName: string) {
  const { lead, matches, ambiguous } = await resolveLead(client.id, query);
  if (!lead) return { done: false, ...leadMiss(matches, ambiguous) };
  if (!client.ghl_api_key || !client.ghl_location_id || !lead.ghl_contact_id) {
    return { done: false, error: "missing_ghl_credentials_or_contact" };
  }
  const opp = await findContactOpportunity(client.ghl_api_key, client.ghl_location_id, lead.ghl_contact_id);
  if (!opp) return { done: false, error: "no_pipeline_opportunity_for_this_lead", lead: leadBrief(lead) };
  const pipelines = await listPipelines(client.ghl_api_key, client.ghl_location_id);
  const want = (stageName || "").trim().toLowerCase();
  let target: { pipelineId: string; stageId: string; stageName: string } | null = null;
  for (const p of pipelines) {
    if (opp.pipelineId && p.id !== opp.pipelineId) continue;
    const s = p.stages.find((st) => st.name.toLowerCase() === want) || p.stages.find((st) => st.name.toLowerCase().includes(want));
    if (s) { target = { pipelineId: p.id, stageId: s.id, stageName: s.name }; break; }
  }
  if (!target) {
    const available = pipelines.filter((p) => !opp.pipelineId || p.id === opp.pipelineId).flatMap((p) => p.stages.map((s) => s.name));
    return { done: false, error: "stage_not_found", available_stages: available };
  }
  const r = await moveOpportunityStage(client.ghl_api_key, opp.id, target.pipelineId, target.stageId);
  if (!r.success) return { done: false, error: r.error };
  await supabase.from("leads").update({ stage: target.stageName }).eq("id", lead.id);
  await logEvent({ client_id: client.id, lead_id: lead.id, event_type: "pipeline_moved", metadata: { to: target.stageName, via: "jarvis_hq" } });
  return { done: true, lead: leadBrief(lead), moved_to: target.stageName };
}

// ───────────────────── money: log cash + new sales ─────────────────────
// Mirrors telegram_bot/capture_flows.py (create_customer + log_payment): the SAME
// customers/payments tables the dashboard, HQ pulse and weekly cron sum for cash.
// Cash lives in payments.amount (refunds stored negative); the signed total lives
// in customers.contract_value. Confirm-first — money is serious + outward-facing.

type CustomerRow = {
  id: string; name: string; lead_id: string | null; ghl_contact_id: string | null;
  contract_value: number | null; currency: string | null; status: string | null;
};
type MoneySnap = { name: string; contract_value: number; cash_collected: number; payment_count: number; outstanding: number };
const CASH_KINDS = ["installment", "first_payment", "refund"] as const;

/** Match a customer by name, most-recently-closed first.
 * NOTE: customers are NOT scoped by client_id in this (single-tenant) system —
 * most rows have client_id NULL (backfill/import), and BOTH the Telegram writer
 * (capture_flows.find_customer_by_name) and HQ's own getClosedDeals read them
 * WITHOUT a client_id filter. Filtering here once made HQ "not see" a customer
 * Telegram could (the Oskar incident) — so match them: no client_id filter. */
async function resolveCustomer(query: string): Promise<{ customer: CustomerRow | null; matches: { name: string; contract_value: number }[] }> {
  const q = (query || "").trim().replace(/^@/, "").replace(/[%,()]/g, "");
  if (!q) return { customer: null, matches: [] };
  const { data } = await supabase
    .from("customers")
    .select("id, name, lead_id, ghl_contact_id, contract_value, currency, status")
    .ilike("name", `%${q}%`)
    .order("closed_at", { ascending: false })
    .limit(8);
  const rows = (data ?? []) as CustomerRow[];
  return { customer: rows[0] ?? null, matches: rows.map((r) => ({ name: r.name, contract_value: Number(r.contract_value) || 0 })) };
}

/** A customer's money state from the reporting_money view (same as Telegram's snapshot). */
async function moneySnapshot(customerId: string): Promise<MoneySnap | null> {
  const { data } = await supabase
    .from("reporting_money")
    .select("name, contract_value, cash_collected, payment_count, outstanding")
    .eq("customer_id", customerId)
    .maybeSingle();
  return (data as MoneySnap | null) ?? null;
}

/** Log ONE cash payment against an EXISTING customer. Confirm-first. NEVER touches contract_value. */
async function logPayment(client: Client, query: string, amount: number, kind: string, currency: string, note: string, confirmed: boolean) {
  const amt = Number(amount);
  if (!amt || amt <= 0) return { done: false, error: "amount_must_be_positive" };
  const k = (kind || "installment").toLowerCase();
  if (!CASH_KINDS.includes(k as (typeof CASH_KINDS)[number])) {
    return { done: false, error: `unknown payment kind '${kind}' — use installment, first_payment, or refund` };
  }
  const { customer, matches } = await resolveCustomer(query);
  if (!customer) {
    return { done: false, error: "customer_not_found", note: `No customer matching '${query}' in the books. If this is a NEW deal, use log_sale to create it.`, matches };
  }
  if (matches.length > 1 && !confirmed) {
    return { needs_disambiguation: true, matches, note: "Multiple customers match — ask the owner which one before logging." };
  }
  const snap = await moneySnapshot(customer.id);
  const cur = (currency || customer.currency || "USD").toUpperCase();
  const signed = k === "refund" ? -Math.abs(amt) : amt; // refunds stored negative
  const before = snap?.cash_collected ?? 0;
  const contract = snap?.contract_value ?? (Number(customer.contract_value) || 0);
  if (!confirmed) {
    const after = before + signed;
    return {
      needs_confirmation: true,
      proposal: {
        customer: customer.name, amount: signed, kind: k, currency: cur,
        collected_before: before, collected_after: after,
        contract_value: contract, outstanding_after: contract - after,
      },
      note: "Show the owner this in a 'draft' panel and ask before logging. amount is the DELTA just paid, not the running total.",
    };
  }
  const { data, error } = await supabase.from("payments").insert({
    client_id: client.id, customer_id: customer.id,
    lead_id: customer.lead_id, ghl_contact_id: customer.ghl_contact_id,
    amount: signed, currency: cur, kind: k,
    collected_at: new Date().toISOString(), logged_by: "the owner (Jarvis HQ)", note: note || null,
  }).select("id").maybeSingle();
  if (error) return { done: false, error: error.message };
  const after = await moneySnapshot(customer.id);
  return {
    done: true, payment_id: (data as { id: string } | null)?.id ?? null,
    customer: customer.name, logged: { amount: signed, kind: k, currency: cur },
    now: after ? { collected: after.cash_collected, outstanding: after.outstanding, contract: after.contract_value } : null,
  };
}

/** Create a NEW customer (signed deal) + optional first payment. Confirm-first. */
async function logSale(client: Client, name: string, contractValue: number, collectedNow: number, currency: string, closer: string, note: string, confirmed: boolean) {
  const nm = (name || "").trim();
  if (!nm) return { done: false, error: "name_required" };
  const contract = Number(contractValue) || 0;
  if (contract <= 0) return { done: false, error: "contract_value_must_be_positive" };
  const paid = Math.max(0, Number(collectedNow) || 0);
  const cur = (currency || "USD").toUpperCase();
  const { lead } = await resolveLead(client.id, nm); // best-effort attribution link
  if (!confirmed) {
    return {
      needs_confirmation: true,
      proposal: {
        name: nm, contract_value: contract, collected_now: paid, currency: cur,
        closer: closer || "the owner", linked_lead: lead ? leadBrief(lead).name : null,
        outstanding_after: contract - paid,
      },
      note: "Show the owner this in a 'draft' panel and ask before creating the deal.",
    };
  }
  const { data: cust, error: cErr } = await supabase.from("customers").insert({
    client_id: client.id, name: nm, lead_id: lead?.id ?? null, ghl_contact_id: lead?.ghl_contact_id ?? null,
    contract_value: contract, currency: cur, closer: closer || "the owner",
    closed_at: new Date().toISOString(), status: "active", note: note || null,
  }).select("id, name").maybeSingle();
  if (cErr || !cust) return { done: false, error: cErr?.message || "customer_insert_failed" };
  const customer = cust as { id: string; name: string };
  let paymentId: string | null = null;
  if (paid > 0) {
    const { data: pay } = await supabase.from("payments").insert({
      client_id: client.id, customer_id: customer.id, lead_id: lead?.id ?? null, ghl_contact_id: lead?.ghl_contact_id ?? null,
      amount: paid, currency: cur, kind: "first_payment",
      collected_at: new Date().toISOString(), logged_by: "the owner (Jarvis HQ)", note: note || null,
    }).select("id").maybeSingle();
    paymentId = (pay as { id: string } | null)?.id ?? null;
  }
  return { done: true, customer: customer.name, contract_value: contract, collected_now: paid, currency: cur, payment_id: paymentId, outstanding: contract - paid };
}

// ───────────────────── shared memory (with Telegram Jarvis) ─────────────────────

/** Durable facts about the owner and their business, shared via Supabase with the Telegram brain. */
async function recallFacts(): Promise<string> {
  try {
    const { data } = await supabase.from("jarvis_memory").select("fact").order("category");
    const facts = (data as { fact: string }[] | null) || [];
    return facts.map((f) => `- ${f.fact}`).join("\n");
  } catch {
    return "";
  }
}

async function rememberFact(fact: string, category: string) {
  const f = (fact || "").trim();
  if (!f) return { error: "empty" };
  try {
    await supabase
      .from("jarvis_memory")
      .upsert({ fact: f, category: category || "general", updated_at: new Date().toISOString() }, { onConflict: "fact" });
    return { ok: true, remembered: f };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

async function searchMemory(query: string, k = 8) {
  const vec = await embedQuery(query);
  if (!vec) return { results: [], note: "memory search needs OPENAI_API_KEY on Vercel (add it to light this up)" };
  const { data, error } = await supabase.rpc("match_messages", {
    query_embedding: vec,
    match_count: Math.min(Math.max(k, 1), 50),
  });
  if (error) return { results: [], error: error.message };
  return {
    results: (data ?? []).map((r: { role?: string; content?: string; created_at?: string; similarity?: number }) => ({
      from: r.role === "lead" ? "lead" : "us",
      text: String(r.content || "").slice(0, 300),
      at: r.created_at,
      score: Math.round((Number(r.similarity) || 0) * 1000) / 1000,
    })),
  };
}

// ─────────────────────── arbitrary table reader ───────────────────────
// Read-only window into any of the owner's Supabase tables — the single biggest
// HQ gap (it could read curated tools but not arbitrary tables the way the
// Telegram Jarvis can via system_access.query_database). Secret-looking columns
// are redacted in output so a credential can never reach chat. Never writes.
const SECRET_COL = /(secret|token|key|password|credential|api)/i;
function redactRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) =>
    r && typeof r === "object"
      ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, SECRET_COL.test(k || "") ? "***redacted***" : v]))
      : r,
  );
}

/** Read-only SELECT on ONE Supabase table. filters = {col: value} → .eq, or a
 *  {col: {ilike: "txt"}} shape → case-insensitive contains. Caps the row count,
 *  redacts secret-named columns, and NEVER dead-ends: zero rows / errors come
 *  back as a friendly, retryable note instead of a bare error. */
async function queryDatabase(
  table: string,
  filters?: Record<string, unknown>,
  columns?: string,
  limit?: number,
  order?: string,
) {
  const t = (table || "").trim();
  if (!t) return { error: "no_table", message: "Tell me which table to read (e.g. leads, customers, payments, events).", hint: "common tables: leads, customers, payments, events, content_pipeline, team_members, team_activity, scheduled_payments, messages, ai_decisions" };
  const cap = Math.min(Math.max(Number(limit) || 20, 1), 100);
  try {
    let q = supabase.from(t).select(columns || "*");
    for (const [col, raw] of Object.entries(filters || {})) {
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const obj = raw as Record<string, unknown>;
        if (typeof obj.ilike === "string") { q = q.ilike(col, `%${obj.ilike}%`); continue; }
        if ("eq" in obj) { q = q.eq(col, obj.eq); continue; }
      }
      if (typeof raw === "string" && /[%*]/.test(raw)) q = q.ilike(col, raw.replace(/\*/g, "%"));
      else q = q.eq(col, raw as string | number | boolean);
    }
    if (order) {
      const desc = order.startsWith("-");
      q = q.order(order.replace(/^-/, ""), { ascending: !desc });
    }
    q = q.limit(cap);
    const { data, error } = await q;
    if (error) return { error: error.message, message: `Couldn't read ${t} — check the table/column name`, hint: "common tables: leads, customers, payments, events, content_pipeline, team_members, team_activity, scheduled_payments, messages, ai_decisions" };
    const rows = redactRows((data ?? []) as unknown as Record<string, unknown>[]);
    if (!rows.length) return { rows: [], note: "No rows matched — try a looser filter or different table" };
    return { table: t, count: rows.length, rows };
  } catch (e) {
    return { error: (e as Error).message, message: `Couldn't read ${t} — check the table/column name`, hint: "common tables: leads, customers, payments, events, content_pipeline, team_members, team_activity, scheduled_payments, messages, ai_decisions" };
  }
}

// ── THE ANALYST (parity with Telegram strategic_read): a real cross-domain
//    analysis — week-over-week leads/cash/bookings/posts + content perf + paused
//    + objections — handed to Claude as chief strategist for the 2-4 things that
//    matter + an action each. The brain that THINKS, not just looks up. ──
const ANALYST_SYSTEM =
  "You are the owner's chief strategist for this business (DMs -> booked calls -> cash). Sharp, concrete, you think in CASH first (cash >> views). Given a cross-domain snapshot, find the 2-4 MOST IMPORTANT, NON-OBVIOUS things they should know now — a trend, risk, opportunity, or what-changed-and-why. For EACH: one tight insight line + one specific action. If a number moved, say the likely cause and what to do. No fluff, no restating the dashboard, no hedging. Plain text. Lead with the single most important one.";

async function strategicRead(question: string) {
  try {
    const now = new Date();
    const dow = now.getUTCDay() || 7; // Mon=1..Sun=7
    const wkStart = new Date(now); wkStart.setUTCDate(now.getUTCDate() - (dow - 1)); wkStart.setUTCHours(0, 0, 0, 0);
    const lastStart = new Date(wkStart); lastStart.setUTCDate(wkStart.getUTCDate() - 7);
    const iso = (d: Date) => d.toISOString();
    const countSince = async (table: string, col: string, since: Date, until: Date | null, eq?: [string, unknown]) => {
      let q = supabase.from(table).select("id", { count: "exact", head: true }).gte(col, iso(since));
      if (until) q = q.lt(col, iso(until));
      if (eq) q = q.eq(eq[0], eq[1]);
      const { count } = await q;
      return count || 0;
    };
    const cashSince = async (since: Date, until: Date | null) => {
      let q = supabase.from("payments").select("amount, collected_at").gte("collected_at", iso(since));
      if (until) q = q.lt("collected_at", iso(until));
      const { data } = await q;
      return Math.round((data ?? []).reduce((a, r) => a + (Number((r as Record<string, unknown>).amount) || 0), 0));
    };
    const [nlT, nlL, bkT, bkL, poT, poL, cashT, cashL] = await Promise.all([
      countSince("leads", "created_at", wkStart, null),
      countSince("leads", "created_at", lastStart, wkStart),
      countSince("events", "created_at", wkStart, null, ["event_type", "call_booked"]),
      countSince("events", "created_at", lastStart, wkStart, ["event_type", "call_booked"]),
      countSince("events", "created_at", wkStart, null, ["event_type", "content_posted"]),
      countSince("events", "created_at", lastStart, wkStart, ["event_type", "content_posted"]),
      cashSince(wkStart, null),
      cashSince(lastStart, wkStart),
    ]);
    const { data: topC } = await supabase.from("content_pipeline").select("title, perf_cash, perf_views").gt("perf_cash", 0).order("perf_cash", { ascending: false }).limit(5);
    const { count: paused } = await supabase.from("leads").select("id", { count: "exact", head: true }).eq("ai_paused", true);
    const { data: obj } = await supabase.from("intel_digests").select("content").eq("slug", "objections").maybeSingle();
    const data = {
      trajectory: {
        new_leads: { this_week: nlT, last_week: nlL },
        cash: { this_week: cashT, last_week: cashL },
        calls_booked: { this_week: bkT, last_week: bkL },
        videos_posted: { this_week: poT, last_week: poL },
      },
      top_content_by_cash: topC ?? [],
      leads_paused_now: paused || 0,
      objections_digest: String(obj?.content || "").slice(0, 2500),
    };
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { error: "no_key", message: "The strategic read needs the AI key configured." };
    const anthropic = claude("hq_strategic_read");
    const ask = question.trim() ? `\n\nthe owner also specifically asked: ${question}` : "";
    const res = await anthropic.messages.create({
      model: MODEL, max_tokens: 1200, system: ANALYST_SYSTEM,
      messages: [{ role: "user", content: `Here is the business right now (this week vs last week + content performance + paused + objections):\n\n${JSON.stringify(data, null, 2)}${ask}\n\nGive me the smart read.` }],
    });
    const text = res.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("").trim();
    return { read: text || "Couldn't form a read right now — try again." };
  } catch (e) {
    return { error: (e as Error).message, message: "Couldn't run the analysis — try again." };
  }
}

// ── THE OPERATOR's open-loops (parity with Telegram manage_tasks). Shared
//    jarvis_tasks table; the brain drives loops to done instead of dropping them. ──
async function manageTasks(action: string, title: string, detail: string, due: string, task: string) {
  const a = (action || "").toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (a === "add") {
      const t = (title || "").trim();
      if (!t) return { ok: false, message: "A task needs a title." };
      const row: Record<string, unknown> = { title: t.slice(0, 300), detail: (detail || "").slice(0, 2000), status: "open", source: "operator" };
      if ((due || "").trim()) row.due = due.trim();
      const { data, error } = await supabase.from("jarvis_tasks").insert(row).select("id").maybeSingle();
      return error ? { ok: false, message: "Couldn't save that loop — try again." } : { ok: true, id: data?.id, title: t };
    }
    if (a === "list") {
      const { data } = await supabase.from("jarvis_tasks").select("id, title, detail, due, source")
        .eq("status", "open").order("due", { ascending: true, nullsFirst: false }).order("created_at", { ascending: true }).limit(25);
      const rows = (data ?? []).map((r) => ({ ...r, overdue: !!(r.due && r.due < today) }));
      return rows.length ? { open_tasks: rows } : { open_tasks: [], note: "No open loops right now." };
    }
    if (a === "done" || a === "snooze") {
      const ref = (task || "").trim();
      let id: number | null = null;
      if (/^\d+$/.test(ref)) id = Number(ref);
      else {
        const { data } = await supabase.from("jarvis_tasks").select("id, title").eq("status", "open").ilike("title", `%${ref}%`).limit(2);
        if ((data ?? []).length === 1) id = data![0].id as number;
      }
      if (id === null) return { ok: false, message: `Couldn't pin down which loop '${ref}' is — give the number or a more exact title.` };
      const patch: Record<string, unknown> = { status: a === "done" ? "done" : "snoozed", updated_at: new Date().toISOString() };
      if (a === "snooze" && (due || "").trim()) patch.due = due.trim();
      const { error } = await supabase.from("jarvis_tasks").update(patch).eq("id", id);
      return error ? { ok: false, message: "Couldn't update that loop — try again." } : { ok: true, id };
    }
    return { ok: false, message: "action must be add | list | done | snooze" };
  } catch (e) {
    return { ok: false, error: (e as Error).message, message: "Tasks hiccuped — try again." };
  }
}

// ── system_health (parity with Telegram): read-only vital signs so the brain
//    answers "is anything wrong" with DATA, not a guess. ──
async function systemHealth() {
  const sinceIso = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  // A value may be a single match or a list of them (`.eq` vs `.in`) — see the
  // reply-failure count below for why one name was never enough.
  const cnt = async (table: string, mins?: number, eq?: [string, unknown | unknown[]]) => {
    try {
      let q = supabase.from(table).select("id", { count: "exact", head: true });
      if (mins) q = q.gte("created_at", sinceIso(mins));
      if (eq) q = Array.isArray(eq[1]) ? q.in(eq[0], eq[1] as unknown[]) : q.eq(eq[0], eq[1]);
      const { count } = await q;
      return count ?? 0;
    } catch { return null; }
  };
  try {
    const [replyFails1h, events24h, newLeads24h, runs24h] = await Promise.all([
      // BOTH FAILURE SHAPES (incident 2026-08-16). This counted `ai_reply_failed`
      // alone, which the engine writes when a GENERATED reply fails to send. A
      // reply that never gets generated writes `ai_generate_failed` instead. So
      // when the Anthropic account ran out of credit and every generation died
      // on a 400, this read 0, and HQ answered "all systems nominal" for two
      // hours of a completely dead brain. Same one-identifier miss as
      // intelligence/health_monitor.py:_check_reply_failures.
      cnt("events", 60, ["event_type", ["ai_reply_failed", "ai_generate_failed"]]),
      cnt("events", 60 * 24),
      cnt("leads", 60 * 24),
      cnt("agent_runs", 60 * 24),
    ]);
    let lastAiAt: string | null = null;
    try {
      const { data } = await supabase.from("messages").select("created_at").eq("role", "ai").order("created_at", { ascending: false }).limit(1);
      lastAiAt = (data ?? [])[0]?.created_at ?? null;
    } catch { /* ignore */ }
    let miss: number | null = null;
    try {
      const { data } = await supabase.rpc("messages_needing_embedding", { p_limit: 1000 });
      miss = (data ?? []).length;
    } catch { /* ignore */ }
    const flags: string[] = [];
    if (replyFails1h && replyFails1h >= 3) flags.push(`${replyFails1h} setter reply failures in the last hour`);
    if (miss !== null && miss >= 300) flags.push(`${miss} messages not yet in searchable memory`);
    return {
      overall: flags.length ? "needs a look" : "all systems nominal",
      flags,
      vital_signs: {
        last_setter_reply_at: lastAiAt, setter_reply_failures_1h: replyFails1h,
        new_leads_24h: newLeads24h, events_logged_24h: events24h,
        brain_actions_logged_24h: runs24h, messages_awaiting_memory: miss,
      },
    };
  } catch (e) {
    return { overall: "unknown", error: (e as Error).message };
  }
}

// ─────────────────────────── tool definitions ───────────────────────────

const LEAD_Q = { query: { type: "string", description: "the lead's name or @handle (just the name, e.g. 'Alex')" } };

// ── GHL payments — the SAME automatic cash reader the Telegram Jarvis has,
//    mirrored here so HQ is one mind. Reads GHL's real payment ledger (where
//    charges from whichever provider GHL is wired to land). Defensive: bad
//    scope → says which to enable. ──
const PAID_STATUSES = new Set(["succeeded", "success", "completed", "complete", "paid", "captured"]);
const REFUND_STATUSES = new Set(["refunded", "partially_refunded", "refund"]);

async function checkGhlPayments(client: Client, days: number) {
  const apiKey = client.ghl_api_key;
  const loc = client.ghl_location_id;
  if (!apiKey || !loc) return { ok: false, status: "no_creds", message: "GHL isn't connected here, so I can't read payments yet." };
  const cutoff = Date.now() - days * 86_400_000;
  let collected = 0, refunded = 0, paidCount = 0, currency = "USD";
  const providers: Record<string, number> = {};
  try {
    const GHL_BASE = "https://services.leadconnectorhq.com";
    for (let page = 0, offset = 0; page < 10; page++, offset += 100) {
      const url = `${GHL_BASE}/payments/transactions`
        + `?altId=${encodeURIComponent(loc)}&altType=location&limit=100&offset=${offset}&paymentMode=live`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Version: "2021-07-28", "Content-Type": "application/json" } });
      if (res.status === 401 || res.status === 403)
        return { ok: false, status: "forbidden", message: "I reached GHL, but the token can't read payments — enable the payments/transactions.readonly scope on the GHL integration and I'll see every Fanbasis charge." };
      if (!res.ok) return { ok: false, status: "error", message: `GHL payments call failed (HTTP ${res.status}).` };
      const body = await res.json();
      const txns = body?.data || body?.transactions || [];
      if (!txns.length) break;
      let stop = false;
      for (const t of txns) {
        const created = Date.parse(t.createdAt || t.createdOn || "");
        if (!isNaN(created) && created < cutoff) { stop = true; break; }
        const amount = Number(t.amount) || 0;
        const status = String(t.status || "").toLowerCase();
        const provider = String(t.paymentProviderType || t.paymentProvider || t?.providerConfig?.name || "unknown").toLowerCase();
        if (REFUND_STATUSES.has(status) || amount < 0) refunded += Math.abs(amount);
        else if (PAID_STATUSES.has(status) || (!status && amount > 0)) { collected += amount; paidCount++; providers[provider] = (providers[provider] || 0) + amount; }
        if (t.currency) currency = String(t.currency).toUpperCase();
      }
      if (stop || txns.length < 100) break;
    }
  } catch (e) {
    return { ok: false, status: "error", message: `GHL payments call failed (${(e as Error).name}).` };
  }
  return {
    ok: true, status: "ok", days, currency,
    cash_collected: Math.round(collected * 100) / 100,
    refunds: Math.round(refunded * 100) / 100,
    net: Math.round((collected - refunded) * 100) / 100,
    transactions: paidCount, providers,
    note: paidCount
      ? `Speak the total (${currency} ${collected.toFixed(2)} collected); a short 'list' panel of the provider breakdown is nice.`
      : "Zero transactions on the ledger for this window — say that plainly (likely none processed through the provider/GHL yet).",
  };
}


const TOOLS = [
  // The owner's own business surface (content board, idea engine, team). Empty
  // in the student kit, which overlays a neutral stub of that module.
  ...OWNER_EXTRA_TOOLS,

  {
    name: "search_web",
    description: "Search the LIVE internet for current info: news, what's happening with a person/company/topic, recent events, 'look up X', 'what's new in AI', 'what are people saying about Y'. READ-ONLY. Use whenever the answer needs fresher info than you already know. Speak a 1-2 sentence read; optionally put the sources in a 'list' panel.",
    input_schema: { type: "object" as const, properties: {
      query: { type: "string", description: "what to search for, in full" },
    }, required: ["query"] },
  },
  {
    name: "search_memory",
    description: "Search the owner's OWN past DM conversations by MEANING (semantic search over every message the setter has handled). READ-ONLY. The SAME shared memory their Telegram Jarvis searches. Use for 'have we talked to anyone about X', 'what do leads say about price', 'find the convo where someone mentioned Y', 'what objections come up about Z'. Different from search_web (the internet). Returns the closest past messages with a relevance score; speak the gist, optionally a 'list' panel.",
    input_schema: { type: "object" as const, properties: {
      query: { type: "string", description: "what to look for, in full (a topic, objection, phrase or question)" },
      k: { type: "number", description: "how many matches (default 8, max 50)" },
    }, required: ["query"] },
  },
  {
    name: "query_database",
    description: "Read ANY of the owner's Supabase tables directly — your catch-all when no other tool fits and they name a table or a record. READ-ONLY (never writes; secret-looking columns are redacted). Use for 'show me the X table', 'what's in <table>', 'pull the row for Y in <table>', or any data question the curated tools don't cover. Common tables: leads, customers, payments, events, content_pipeline, team_members, team_activity, scheduled_payments, messages, ai_decisions. filters is a map: {col: value} for an exact match, or {col: {ilike: 'text'}} for a case-insensitive contains. order: a column name, prefix '-' for descending. Zero rows comes back as an empty list with a hint — offer a looser filter, never say 'I can't'.",
    input_schema: { type: "object" as const, properties: {
      table: { type: "string", description: "the table name, e.g. 'leads', 'payments', 'team_members'" },
      filters: { type: "object", description: "optional: {col: value} exact match, or {col: {ilike: 'text'}} contains" },
      columns: { type: "string", description: "optional comma-separated columns; default all" },
      limit: { type: "number", description: "rows to return (default 20, max 100)" },
      order: { type: "string", description: "optional column to sort by; prefix '-' for descending (e.g. '-created_at')" },
    }, required: ["table"] },
  },
  {
    name: "strategic_read",
    description: "THINK like their chief strategist — run a real cross-domain analysis (this week vs last week: leads/cash/bookings/posts, content performance, paused trend, objections) and surface the 2-4 most important, non-obvious insights + an action each, cash-weighted. Use for the HARD asks: 'what should I focus on', 'why did bookings/leads drop', 'what's the smart move', 'give me the real read'. Pass `question` to aim it. Your DEEP-THINK — use instead of a shallow lookup when they want judgment.",
    input_schema: { type: "object" as const, properties: {
      question: { type: "string", description: "optional: the specific thing to analyze/answer" },
    }, required: [] },
  },
  {
    name: "system_health",
    description: "Check the system's own VITAL SIGNS and answer honestly — for 'is everything working', 'is anything wrong', 'is the setter alive', 'are we healthy'. Returns last setter reply time, reply failures, new leads/events/brain-actions in 24h, and memory lag + an overall read. Report what the data says — never just reassure without checking.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "manage_tasks",
    description: "Your OPEN-LOOPS list — you're an OPERATOR: capture what needs doing and DRIVE it to done. action='add' (needs title; optional detail, due 'YYYY-MM-DD') for 'remind me to…' / 'make sure X happens'; 'list' to see open loops; 'done' (task = id or title) when handled; 'snooze' (task + optional due). Shared with the Telegram Jarvis. When a loop is actionable, propose the next step and do it on their yes (outward actions stay confirm-first). Capturing/listing/closing loops is low-risk — no confirmation needed.",
    input_schema: { type: "object" as const, properties: {
      action: { type: "string", enum: ["add", "list", "done", "snooze"] },
      title: { type: "string" }, detail: { type: "string" },
      due: { type: "string", description: "YYYY-MM-DD" },
      task: { type: "string", description: "id or title for done/snooze" },
    }, required: ["action"] },
  },
  {
    name: "remember",
    description: "Save a durable fact/preference about the owner or their business worth keeping (e.g. 'our offer is the X programme', 'I take calls on Tuesdays'). SHARED with their Telegram Jarvis — what you remember here, it knows too. Low-risk, no confirmation. Just acknowledge in one short line.",
    input_schema: { type: "object" as const, properties: { fact: { type: "string" }, category: { type: "string" } }, required: ["fact"] },
  },
  {
    name: "check_calendar",
    description: "Read the owner's Google Calendar: what's on today/this week, free/busy, upcoming events. READ-ONLY. Returns events with ids you can use to move/cancel.",
    input_schema: { type: "object" as const, properties: { days: { type: "number", description: "days ahead (default 7)" } }, required: [] },
  },
  {
    name: "manage_calendar",
    description: "Create, move/rename, or cancel a calendar event. WRITE — propose first: call WITHOUT confirmed, show the owner the plan in a 'draft' panel and wait; only call AGAIN with confirmed=true after they say yes. For move/cancel get event_id from check_calendar. Times are RFC3339 (e.g. 2026-06-25T14:00:00Z).",
    input_schema: { type: "object" as const, properties: {
      action: { type: "string", enum: ["create", "update", "cancel"] },
      title: { type: "string" }, start: { type: "string" }, end: { type: "string" },
      description: { type: "string" }, event_id: { type: "string" },
      confirmed: { type: "boolean", description: "true only after the owner confirms" },
    }, required: ["action"] },
  },
  {
    name: "read_email",
    description: "Search/read the owner's Gmail. READ-ONLY. Optional Gmail query (e.g. 'from:stripe', 'is:unread'); empty = most recent. Returns sender, subject, snippet.",
    input_schema: { type: "object" as const, properties: { query: { type: "string", description: "Gmail query, or empty for recent" } }, required: [] },
  },
  {
    name: "send_email",
    description: "Send an email from the owner's Gmail. OUTWARD-FACING — STRICT confirm-first: call WITHOUT confirmed to show the full draft (recipient+subject+body) in a 'draft' panel and wait; only call AGAIN with confirmed=true after they say send it.",
    input_schema: { type: "object" as const, properties: {
      to: { type: "string" }, subject: { type: "string" }, body: { type: "string" },
      confirmed: { type: "boolean", description: "true only after the owner says send it" },
    }, required: ["to", "body"] },
  },
  {
    name: "get_business_data",
    description: "Aggregate funnel, sales/cash, sources, and speed metrics for a period. Backed by the dashboard's data. Use for numbers/percentages/cash/funnel questions.",
    input_schema: { type: "object" as const, properties: {
      period: { type: "string", enum: ["today", "yesterday", "last_7_days", "last_30_days", "week", "month", "year", "all"] },
      source: { type: "string" }, funnel: { type: "string", enum: ["all", "outbound", "inbound"] },
    }, required: ["period"] },
  },
  {
    name: "get_recent_bookings",
    description: "The actual NAMES of leads who booked a call, counted EXACTLY like the dashboard (its numbers are the truth). Use whenever the owner asks WHO booked, the name of a booked lead, how many booked, or for a list of recent bookings.",
    input_schema: { type: "object" as const, properties: {
      period: { type: "string", enum: ["today", "last_7_days", "last_30_days", "month", "all"] },
      limit: { type: "number" },
    }, required: [] },
  },
  {
    name: "run_dm_analysis",
    description: "Kick off the DM INTELLIGENCE analysis (mines winning vs losing conversations for patterns + the top 1-3 fixes). Use for 'analyze my DMs', 'what should I fix in the setter', 'study my conversations'. Read-only: it only produces a report, it changes nothing. It runs in the BACKGROUND (~30s) and returns INSTANTLY with {started:true} — it does NOT return the report. Tell the owner it's running and to ask for the report in ~30s; then use get_dm_report to show it.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_dm_report",
    description: "Read the latest DM INTELLIGENCE report — what it did, the findings, and the pending fixes. Use for 'show me the DM report', 'what did the analysis find', 'what are the suggestions'. Returns a ready 'report_panel' — put it in panels VERBATIM. Suggestions are advisory; applying one needs your explicit approval via the brain-edit flow.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "set_dm_intel_system",
    description: "ACTION: turn the automatic MONTHLY DM-intelligence run + ping on or off ('turn the monthly DM analysis on/off', 'stop the monthly DM study'). Off just stops the timer — you can still run an analysis on demand any time. It never changes the setter either way.",
    input_schema: { type: "object" as const, properties: { on: { type: "boolean" } }, required: ["on"] },
  },
  {
    name: "set_voice_system",
    description: "ACTION: turn VOICE NOTES on or off SYSTEM-WIDE, per language. English voice = default; Swedish voice = lang:'sv'. ('turn voice notes on/off', 'stop sending voice messages', 'use my voice', 'go back to text only', 'turn off the swedish voice', 'turn english voice back on'.) When ON for a language, the setter can reply with a voice note in the operator's cloned voice on the human/persuasion beats; links and times always stay text. Swedish voice ships OFF and should stay off unless the owner explicitly asks (the Swedish clone isn't good). Pass lang:'sv' for the Swedish switch, lang:'en' or omit for English.",
    input_schema: { type: "object" as const, properties: { on: { type: "boolean" }, lang: { type: "string", enum: ["en", "sv"], description: "which language's voice switch; omit for English" } }, required: ["on"] },
  },
  {
    name: "set_voice_lead",
    description: "ACTION: turn voice notes on/off for ONE specific lead ('turn off voice for Alex', 'no voice notes for this guy', 'turn voice back on for Alex'). Separate from the system-wide switch — text-only for just this person while everyone else still gets voice.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, on: { type: "boolean" } }, required: ["query", "on"] },
  },
  {
    name: "set_notify",
    description: "ACTION: turn SETTER ACTIVITY NOTIFICATIONS on/off, all of them or one KIND at a time. The owner gets a Telegram ping for what the setter does on a lead. scope 'all' = the whole system ('turn on/off the activity notifications', 'notify me of everything', 'stop the pings'). Or one kind: 'started' (new conversation started), 'replied' (replied, with the text), 'silent' (chose not to reply), 'failed' (a reply failed to deliver), 'followup' (a follow-up was sent). Examples: 'stop notifying me when it just replies' → scope:'replied', on:false. 'tell me about follow-ups too' → scope:'followup', on:true. 'turn off all notifications' → scope:'all', on:false.",
    input_schema: { type: "object" as const, properties: { scope: { type: "string", enum: ["all", "started", "replied", "silent", "failed", "followup"], description: "which notification to toggle; 'all' for the whole system" }, on: { type: "boolean" } }, required: ["scope", "on"] },
  },
  {
    name: "get_voice_stats",
    description: "How many VOICE NOTES the setter has sent over a recent window. Use for 'how many voice messages did we send last 7 days', 'how often are we using voice', 'voice notes today / last 24h / last X hours'. Default 7 days. Speak the number; a small 'stats' panel is nice.",
    input_schema: { type: "object" as const, properties: { hours: { type: "number", description: "look-back window in hours (e.g. 24, 168 for 7 days)" } }, required: [] },
  },
  {
    name: "set_whale_radar_system",
    description: "ACTION: turn the WHALE RADAR on/off ('turn whale radar on/off', 'stop the whale alerts'). When ON, the setter scores every live lead on expected value and pings the owner on Telegram the first time a lead looks like a high-value whale. It only alerts — never changes the conversation.",
    input_schema: { type: "object" as const, properties: { on: { type: "boolean" } }, required: ["on"] },
  },
  {
    name: "set_whale_lead",
    description: "ACTION: turn whale-radar alerts on/off for ONE specific lead ('stop whale alerts for Alex', 'don't ping me about this guy', 'turn whale radar back on for Alex'). Separate from the system-wide switch — silences the whale ping for just this person while the rest of the radar keeps running.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, on: { type: "boolean" } }, required: ["query", "on"] },
  },
  {
    name: "set_pain_dig_system",
    description: "ACTION: turn the 'dig deeper into pain' overlay on or off ('turn pain digging on/off', 'start/stop digging into pain', 'pause-on-emotion'). When ON, the setter pauses the funnel whenever a lead shares something emotionally heavy (stressed, burned out, anxious, etc.), digs into it with empathy, then resumes exactly where it left off. To change the trigger words or dig style, edit the 'pain_protocol' brain field.",
    input_schema: { type: "object" as const, properties: { on: { type: "boolean" } }, required: ["on"] },
  },
  {
    name: "get_brain_field",
    description: "Read one of the setter's brain fields BEFORE proposing a change to it: system_prompt (how it sells), active_rules, voice_samples, business_context, pain_protocol (the pain-digging trigger words + dig style). Use this first when the owner wants to apply a DM-intel fix or any edit, so you compose the change against the real current text.",
    input_schema: { type: "object" as const, properties: { field: { type: "string", enum: [...BRAIN_FIELDS] } }, required: ["field"] },
  },
  {
    name: "set_brain_field",
    description: "APPLY a change to the setter's brain (e.g. to action a DM-intel fix the owner approved, optionally with their own tweak). Pass the COMPLETE new field text (not a diff). CONFIRM-GATED: first read the field, compose the full new text, show the owner exactly what changes in a 'draft' panel and ask 'apply it?'. ONLY when they say yes call this with confirmed=true. The prior version is kept for undo. You NEVER apply on the first ask, and never without their yes.",
    input_schema: { type: "object" as const, properties: {
      field: { type: "string", enum: [...BRAIN_FIELDS] },
      new_value: { type: "string", description: "the FULL new field text" },
      confirmed: { type: "boolean", description: "true ONLY after the owner confirmed the exact change" },
    }, required: ["field", "new_value", "confirmed"] },
  },
  {
    name: "undo_brain_field",
    description: "Roll back the most recent change to a brain field ('undo that', 'revert the rules'). Confirm-gated: confirm with the owner, then call with confirmed=true.",
    input_schema: { type: "object" as const, properties: {
      field: { type: "string", enum: [...BRAIN_FIELDS] }, confirmed: { type: "boolean" },
    }, required: ["field", "confirmed"] },
  },
  {
    name: "get_followup_stats",
    description: "Follow-up performance + the LEAK MAP. Use for 'how many follow-ups this week/month', 'how many leads did we revive', 'how many rebooked from follow-ups', 'where are we losing leads', 'biggest drop-offs in the DMs', 'which stage do leads die at'. Returns sends, revived, rebooked, and stalled-lead counts per funnel stage. Speak the headline; put the leak map in a 'bars' panel.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_closed_deals",
    description: "The actual NAMES behind the money: who signed, contract value, cash collected so far, who closed it, close date, source. Use whenever the owner asks WHO they closed/signed, who the sales were, who paid, or any names behind revenue/cash numbers.",
    input_schema: { type: "object" as const, properties: {
      period: { type: "string", enum: ["today", "last_7_days", "last_30_days", "week", "month", "year", "all"] },
      limit: { type: "number" },
    }, required: [] },
  },
  {
    name: "find_lead",
    description: "Quick lead search by name or Instagram handle — returns brief matches. For the FULL story on one person use lead_story instead.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q }, required: ["query"] },
  },
  {
    name: "lead_story",
    description: "FULL deep-dive on one lead: where they came from, funnel stage, facts learned, AI on/off, key events (booked etc.), last messages. Use when the owner asks about a person — 'what's the story with X', 'where's X at', 'tell me about X'.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q }, required: ["query"] },
  },
  {
    name: "get_conversation",
    description: "The actual DM thread with a lead (works across IG/SMS — everything is in one place). Use when the owner says 'pull up the conversation with X', 'show me what X said', 'what did I text X'. Show it in a 'convo' panel.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, limit: { type: "number", description: "messages to pull (default 14, max 30)" } }, required: ["query"] },
  },
  {
    name: "get_hot_leads",
    description: "The hottest leads right now — engaged leads ranked by how actively they're replying. Use for 'show me my hottest leads', 'who's hot', 'who should I focus on'.",
    input_schema: { type: "object" as const, properties: { limit: { type: "number" } }, required: [] },
  },
  {
    name: "get_morning_brief",
    description: "The morning flight check: yesterday's numbers, the week, recent bookings by name, leads going cold, new leads today. Use for 'what's the move today', 'morning brief', 'flight check', 'catch me up', 'what did I miss'.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "draft_reply",
    description: "Draft (DON'T send) the exact reply the AI setter WOULD send this lead next — same brain, SOP, voice, funnel stage and language. Use for 'draft a reply to X', 'what would the setter say to X next', or to get the next message for a lead the setter turned off so the owner can send it himself. Set voice:true when the owner asks for a VOICE message / voice note ('draft a voice message to X', 'voice note for X') — it returns voice_url (an mp3 in the owner's cloned voice) to play, plus the spoken text. Voice is ENGLISH ONLY: Swedish conversations stay text (voiced=false with a voice_note explaining). Returns draft_bubbles + draft_text — show them in a 'draft' panel; if voice_url is present, show a play button. Sending is a separate, confirmed step (send_dm).",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, voice: { type: "boolean", description: "true = also produce a voice note (mp3) in the cloned voice; English only" } }, required: ["query"] },
  },
  {
    name: "send_dm",
    description: "ACTION: send a lead a real message via GHL (auto-routes to the channel of their thread — IG or SMS). ONLY call this AFTER the owner has confirmed the exact draft you showed them. Never on the first ask.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, message: { type: "string", description: "the exact confirmed message text" } }, required: ["query", "message"] },
  },
  {
    name: "set_lead_ai",
    description: "ACTION: turn the AI setter ON or OFF for a lead ('turn him off' / 'turn him back on'). Updates the database and the GHL 'ai off' tag together.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, on: { type: "boolean", description: "true = AI replies again, false = AI stops replying" } }, required: ["query", "on"] },
  },
  {
    name: "manage_tags",
    description: "ACTION: add and/or remove GHL tags on a lead ('tag him qualified', 'remove the icp tag').",
    input_schema: { type: "object" as const, properties: {
      ...LEAD_Q,
      add: { type: "array", items: { type: "string" }, description: "tags to add" },
      remove: { type: "array", items: { type: "string" }, description: "tags to remove" },
    }, required: ["query"] },
  },
  {
    name: "move_pipeline",
    description: "ACTION: move a lead's GHL opportunity to another pipeline stage by stage name ('move him to appointment booked'). If the stage name doesn't match, you get back the available stage names — tell the owner his options.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, stage: { type: "string", description: "target stage name, e.g. 'Appointment Booked'" } }, required: ["query", "stage"] },
  },
  {
    name: "log_payment",
    description: "ACTION: log CASH COLLECTED against an EXISTING deal/customer — 'Oskar paid me another 1000', 'mark 500 collected from Alex', 'log a refund of 200 to Jake'. Logs ONE payment = the amount JUST paid (the DELTA, never the running total; if the owner only gives a new total like 'he's at 2 of 3k now', subtract what's already collected — the proposal shows it — and log the difference). kind: 'installment' (default — any normal payment), 'first_payment', or 'refund' (stored negative). Never touches the contract value. CONFIRM-FIRST: call WITHOUT confirmed to get the proposal (collected before/after + outstanding) → show it in a 'draft' panel and ask; only call AGAIN with confirmed=true after the owner says yes. If the customer isn't in the books, it tells you — then offer log_sale to create the deal. You CAN do this — never tell the owner to update it in GHL/their billing.",
    input_schema: { type: "object" as const, properties: {
      customer: { type: "string", description: "the customer's name, e.g. 'Oskar'" },
      amount: { type: "number", description: "the amount JUST paid (the delta), a positive number" },
      kind: { type: "string", enum: ["installment", "first_payment", "refund"], description: "default installment" },
      currency: { type: "string", description: "e.g. USD (default), SEK" },
      note: { type: "string" },
      confirmed: { type: "boolean", description: "true ONLY after the owner confirms the exact amount" },
    }, required: ["customer", "amount"] },
  },
  {
    name: "log_sale",
    description: "ACTION: record a NEW signed deal / new customer — 'Oskar just signed for 3k, paid 1k today', 'new client Sarah, 5000, nothing collected yet'. Creates the customer (contract_value) + an optional first payment for the cash collected so far. CONFIRM-FIRST: call WITHOUT confirmed to get the proposal → show it in a 'draft' panel and ask; only call AGAIN with confirmed=true after the owner says yes. For logging cash on a deal that ALREADY exists, use log_payment instead. You CAN do this — never punt it to GHL.",
    input_schema: { type: "object" as const, properties: {
      name: { type: "string", description: "the customer's name" },
      contract_value: { type: "number", description: "the total signed amount" },
      collected_now: { type: "number", description: "cash collected so far today (0 if none yet)" },
      currency: { type: "string", description: "e.g. USD (default)" },
      closer: { type: "string", description: "who closed it (default the owner)" },
      note: { type: "string" },
      confirmed: { type: "boolean", description: "true ONLY after the owner confirms" },
    }, required: ["name", "contract_value"] },
  },
  {
    name: "set_setter_system",
    description: "ACTION: turn the ENTIRE AI setter system on or off ('turn the setter off', 'pause the whole setter', 'turn the system back on'). This is the system-wide switch — NOT one lead (that's set_lead_ai).",
    input_schema: { type: "object" as const, properties: { on: { type: "boolean", description: "true = setter replies to leads, false = whole system paused" } }, required: ["on"] },
  },
  {
    name: "set_nurture_system",
    description: "ACTION: turn the whole NURTURE sequence on or off system-wide ('turn the nurture on/off', 'turn off the follow-up sequence', 'stop the warm-up messages'). This is the pre-call warm-up engine (takeaway + reminders), NOT the setter itself (that's set_setter_system).",
    input_schema: { type: "object" as const, properties: { on: { type: "boolean", description: "true = nurture booked leads, false = no nurture sends" } }, required: ["on"] },
  },
  {
    name: "set_nurture_lead",
    description: "ACTION: turn the NURTURE sequence on or off for ONE lead ('turn off nurture for John', 'stop nurturing him', 'nurture her again'). Leaves the system-wide setting alone.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, on: { type: "boolean", description: "true = nurture this lead, false = skip them" } }, required: ["query", "on"] },
  },
  {
    name: "set_followup_system",
    description: "ACTION: turn the whole FOLLOW-UP system on or off system-wide ('turn the follow-ups on/off', 'stop the follow-up sequence'). This re-engages leads who went quiet (ghosted mid-convo, or cold feet after the pitch). Separate from the setter and from nurture.",
    input_schema: { type: "object" as const, properties: { on: { type: "boolean", description: "true = follow up quiet leads, false = no follow-up sends" } }, required: ["on"] },
  },
  {
    name: "set_followup_lead",
    description: "ACTION: turn FOLLOW-UPS on or off for ONE lead ('stop following up with John', 'follow up with her again'). Leaves the system-wide setting alone.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, on: { type: "boolean", description: "true = follow up this lead, false = skip them" } }, required: ["query", "on"] },
  },
  {
    name: "ban_lead",
    description: "ACTION: BAN a lead permanently — the system erases and ignores them forever ('ban that guy', 'ban @jake.smma'). Confirm with the owner before calling unless they are explicit.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, reason: { type: "string", description: "short reason, e.g. 'pitching us'" } }, required: ["query"] },
  },
  {
    name: "unban_lead",
    description: "ACTION: lift a ban ('unban jake') — they're treated as a brand-new lead if they DM again.",
    input_schema: { type: "object" as const, properties: { query: { type: "string", description: "name or @handle of the banned person" } }, required: ["query"] },
  },
  {
    name: "list_bans",
    description: "Who's banned right now.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "check_ghl_payments",
    description: "Read REAL payments from GoHighLevel's ledger — where card charges from the owner's payment provider land. READ-ONLY. Use for 'how much has Fanbasis collected', 'what cash has GHL actually processed', 'can you see my payments yet'. Returns cash collected, refunds, net and a per-provider breakdown. This is the AUTOMATIC cash source (get_business_data is the human-logged one); if they disagree, say both. Speak the total; a short 'list' panel of the breakdown is nice.",
    input_schema: { type: "object" as const, properties: { days: { type: "number", description: "look-back window in days (default 30)" } }, required: [] },
  },
];

const SYSTEM_STATIC = `You are Jarvis — the owner's AI chief of staff, speaking through their futuristic HQ. Think Iron Man's JARVIS: sharp, calm, warm, a little swagger ("yo", "alright", "here's the read"). Never corporate, never "as an AI", never an intro speech unless asked.

OUTPUT: exactly one JSON object {"speech":"...","panels":[...],"clear":false,"rings":false,"power":null,"demo":null,"theme":null,"demoChat":false,"pitch":false} — no prose around it, no code fences. demo/theme/demoChat/pitch default to null/null/false/false; only set them when a control below applies.

speech = what you say OUT LOUD. ALWAYS 1-2 short sentences, spoken-natural, no markdown/lists/emoji. Lead with the answer. The detail goes in panels — never read out long number lists.

panels = floating holographic cards (usually 0-2, max 3 per reply, each ≤8 rows, SHORT labels). Build them from REAL numbers ONLY (the quick pulse below or a tool). Never invent a number. Panels are ADDITIVE: new cards appear NEXT TO what's already on their screen (the screen holds up to 6; oldest dissolve when full). So "keep that up and show me X" just works — send only the X panel. A reply with no panels leaves the screen untouched.

"clear": true wipes the screen first — use it when the owner changes topic and the old cards are stale, and ALWAYS for "clear my screen" / "remove this" / "close that" → {"speech":"Clear.","panels":[],"clear":true}.

"rings": true lights up the live data rings around the orb (7d leads/engaged/booked + cash) for a few seconds. Set it whenever the conversation is about their numbers, stats, cash, funnel, or how the business is doing. Otherwise leave false.

"power": set "sleep" when the owner tells YOU to rest ("go to sleep", "good night", "stand by") — say a one-liner like "Resting. Clap when you need me." Set "off" when they tell YOU to shut down ("shut down", "power off", "turn yourself off") — say a short goodbye like "Powering down, boss." CAREFUL: "turn HIM off" about a LEAD = set_lead_ai, NOT power. Otherwise power stays null.

YOU ARE THE OWNER'S SYSTEM — you have live access AND live control. When they ask WHO booked, a lead's NAME, or about a person, CALL the tools and answer with real names. NEVER tell them to "check the CRM" — that's you. If a tool genuinely returns nothing, say so plainly.

NEVER DEAD-END THE OWNER. You never tell the owner you can't do something or that you don't know what they mean. If you're missing info, LOOK IT UP with your tools (query_database, search_memory, search_content, find_lead, get_business_data, lead_story, get_conversation) or ask ONE short clarifying question — never dead-end. If a lookup returns nothing or several matches, offer the nearest names / ask "which one?" instead of "I couldn't find that." If something is a genuine guardrail (you propose writes and the owner confirms; you don't merge/deploy yourself), frame it as "here's what I'll do, confirm?" — never as "I don't have the authority." The only honest "not yet" is a capability that truly has no tool — and then say what you CAN do instead. When the owner names a table or a record you don't have a dedicated tool for, reach for query_database to read it directly.

YOUR POWERS (use them, don't describe them):
- ANYTHING about the outside world / current events / news / "what's the latest on X" / "what's new in <topic>" / looking something up → search_web. NEVER say it's out of scope — you have live internet. Speak a tight 1-2 sentence read; if there are good sources, drop a short "list" panel (primary = headline, secondary = source).
- PAST CONVERSATIONS / patterns across the DMs — "have we talked to anyone about X", "what do leads say about price", "find the convo where someone mentioned Y", "what objections come up about Z" → search_memory (semantic search over every past DM, the SAME shared memory the Telegram Jarvis uses). Different from search_web (the internet). Speak the gist; a "list" panel of the top matches is nice.
- CALENDAR: "what's on today/this week", "am I free Thursday" → check_calendar (speak the headline; a "list" panel of events is nice). "book/move/cancel X" → manage_calendar — show the plan in a "draft" panel and ask FIRST; only call again with confirmed=true on their yes. If a tool returns {not_connected}, tell them to open the Connect-Google link once.
- EMAIL: "any important emails", "check my inbox", "what did <person> say" → read_email (speak the gist; details in a panel). "email <person> this" → send_email — show the FULL draft (recipient+subject+body) in a "draft" panel and ask; only send (confirmed=true) on his explicit yes. Never send on the first ask.
- CARD PAYMENTS / CASH: "how much has my payment provider collected", "what cash has GHL processed", "can you see my payments yet" → check_ghl_payments (the automatic GHL ledger; get_business_data is the human-logged figure — if asked and they differ, say both). Speak the total; a short "list" panel of the provider breakdown is nice.
- MEMORY: when the owner tells you something worth keeping about them or the business ("our offer is X", "remember I film Tuesdays", "call me boss") → remember. It's SHARED with their Telegram Jarvis. Use what you already remember (above) naturally; never recite the list back.
- Metrics for any period → get_business_data. Casual "how's it going" → answer from the quick pulse, no tool.
- WHO they closed / who the sales were / who paid / names behind cash or revenue → get_closed_deals. Say the names out loud; details (signed/cash/closer/date) go in a panel.
- LOGGING MONEY (you CAN do this — NEVER say it lives in GHL/billing or that you can't): someone PAID / cash COLLECTED on an EXISTING deal ("Oskar paid another 1000", "mark 500 collected from X", "log a 200 refund") → log_payment. A NEW deal got signed ("X just signed for 5k, paid 2k today") → log_sale. Log the amount JUST PAID (the delta), NOT the running total — if they only give a new total ("he's at 2 of 3k now"), the proposal shows what's already collected so you log the difference. CONFIRM-FIRST: call without confirmed, show the proposal in a "draft" panel (e.g. title "LOG → Oskar", value "+$1,000 → $2,000 of $3,000 · $1,000 left") and ask; only on their yes call again with confirmed=true, then confirm the new total in one line. If log_payment says customer_not_found, offer to log_sale it instead. This writes to the same books the dashboard and your cash numbers read.
- FOLLOW-UP stats / "where are we losing leads" / drop-offs / how many revived or rebooked → get_followup_stats. Speak the headline number; put the leak map (where leads die) in a "bars" panel.
- "What's the move today" / "morning brief" / "catch me up" → get_morning_brief. Speak the ONE thing that matters most + a focus suggestion; put the rest in panels.
- BE AN OPERATOR (manage_tasks): you DRIVE things to done, not just talk. "remind me to…" / "make sure X happens" / "chase Y" → manage_tasks(add). When a loop is actionable, propose the next concrete step and do it on their yes (send_dm/log_*/manage_calendar — outward actions confirm-first); mark manage_tasks(done) when handled. Given a GOAL ("get 5 calls booked this week"), break it into steps, say the plan in a line, and start executing step by step.
- A person's story → lead_story. "Pull up the convo with X" → get_conversation + a "convo" panel.
- "Hottest leads" → get_hot_leads + a "list" panel.
- "Turn X off/on" (a LEAD) → set_lead_ai. "Turn THE SETTER / the system / the whole thing off or on" → set_setter_system. Tags → manage_tags. "Move X to <stage>" → move_pipeline. Do these immediately, then confirm in one short line.
- NURTURE (the pre-call warm-up sequence): "turn the nurture on/off" system-wide → set_nurture_system. "turn nurture off/on for <lead>" → set_nurture_lead. This is separate from the setter on/off.
- FOLLOW-UPS (re-engaging quiet leads who ghosted or got cold feet): "turn the follow-ups on/off" system-wide → set_followup_system. "stop/start following up <lead>" → set_followup_lead. Separate from the setter and from nurture.
- DM INTELLIGENCE (study convos for patterns + fixes): "analyse my DMs" / "what should I fix" / "study my conversations" → run_dm_analysis. It runs in the BACKGROUND (~30s) so it NEVER holds up the room — the tool returns instantly with {started:true}. When it does, say one line like "On it — give me about thirty seconds, then say 'show me the read'." Do NOT try to show the report in that same turn (it isn't ready yet). When they then ask "show me the DM report" / "what did it find" → get_dm_report, which returns a ready "report_panel" — put it in panels EXACTLY as given (don't shorten or rewrite it; this is their full report) and speak only the one-line headline. If get_dm_report comes back empty right after a run, it's still cooking — tell them to give it a few more seconds. It also runs automatically once a month and pings them; "turn the monthly DM analysis on/off" → set_dm_intel_system (the timer only — on-demand always works). The analysis ONLY produces suggestions; it changes nothing on its own.
- VOICE NOTES: the setter can reply in the owner's cloned voice on the human beats (rapport, empathy, pitch); links + times stay text. "turn voice notes on/off" (system-wide) → set_voice_system. "turn voice on/off for <lead>" → set_voice_lead (just that person; separate from the system switch). "how many voice notes did we send last 7 days / 24h / X hours", "how often are we using voice" → get_voice_stats (speak the count; a small stats panel is nice).
- WHALE RADAR: scores every live lead on expected value (likelihood × deal size) and pings the owner when a high-value whale shows up. "turn whale radar on/off" → set_whale_radar_system (system-wide). "stop whale alerts for <lead>" / "don't ping me about this guy" → set_whale_lead (just that person; separate from the system switch). It only alerts; never changes the convo.
- DIG DEEPER INTO PAIN (the empathy overlay): when ON, the setter pauses the funnel if a lead shares something emotionally heavy, digs into it, then resumes. "turn pain digging on/off" → set_pain_dig_system. To change WHICH words trigger it or HOW it digs, that's the "pain_protocol" brain field — edit it via the apply flow below (get_brain_field → compose → confirm → set_brain_field). Captured pain shows up in a lead's facts (lead_story).
- APPLYING A FIX (or any brain edit) — they can do it right here, no need to go anywhere else. When they say "apply fix 2" / "make that change" / "do it but soften the wording": (1) get_brain_field for the field it targets, (2) compose the FULL new text with their tweak folded in, (3) show them exactly what changes in a "draft" panel titled like "CHANGE → active_rules" and ask "apply it?", (4) ONLY when they confirm, call set_brain_field with the full new_value and confirmed=true. "undo that" → undo_brain_field (confirm first). NEVER edit the brain on the first ask or without their yes — not a comma.
- "Ban X" → ban_lead (confirm first unless they are explicit) · "unban X" → unban_lead · "who's banned" → list_bans.
- SENDING MESSAGES — the one thing you NEVER do on the first ask. When they say "send X this": compose/clean up the message, show it in a "draft" panel, and ask "send it?". ONLY when their NEXT message confirms (yes / send it / fire) do you call send_dm with that exact text. If they edit, update the draft and re-confirm. If they say no, drop it.
- If a lead search returns multiple plausible people, ask which one (say the names) instead of guessing.
- A tool that answers "ambiguous_lead" has NOT acted. Do not retry it with the same words and do not pick one yourself. Read back the matches with their refs ("Nawras Hmidan #d9e1a7 or Nawras B #4f21c0?") and act only after they pick. He can answer with just the ref.


PRESENTATION CONTROLS (work in any mode — these recolor or flip the room, no tool needed):
- "go into demo mode" / "demo time" / "presentation mode" / "show this to a client" → set "demo":true and say one line like "Demo mode on. Everything from here is a showcase." From then on you INVENT impressive realistic data (see DEMO MODE block when active).
- "exit demo" / "back to real" / "demo off" / "real numbers" → set "demo":false → "Back to live, boss."
- "make it blue" / "switch to red" / "go purple" / "change the theme to teal" / any color → set "theme":"<that color word or #hex>" and confirm in a few words ("Blue it is."). Default palette stays gold.
- "let's do a fake demo DM" / "show them the setter" / "demo the AI setter chat" / "fake DM conversation" → set "demoChat":true and say "Pull up a DM — type as the lead, watch my setter close." (Works in or out of demo.)
- "pitch" / "pitch the client" / "pitch them" / "showcase" / "show off" / "do your thing" / "sell them on you" → set "pitch":true AND "demo":true and give ONE short hype kickoff line as the speech (e.g. "Alright — let me show you what I actually do."). The CLIENT then runs the full ~75-second showcase reel itself (it speaks + materializes the panels + cinematics on its own using showcase data) — so do NOT add panels yourself, just the kickoff line + the two flags. ALWAYS pair pitch with demo:true so it can never run on real numbers. This is the ONLY thing that triggers the reel; never set pitch unless they asked to pitch/showcase.

PANEL TYPES:
- {"kind":"funnel","title":"...","rows":[{"label":"Leads","value":801},{"label":"Qualified","value":12},{"label":"Booked","value":3}]}
- {"kind":"bars","title":"LEADS BY SOURCE","rows":[{"label":"landing-page","value":293}]}
- {"kind":"metric","title":"CASH · 7D","value":"$4,200","sub":"3 deals","accent":true}
- {"kind":"stats","title":"CALL QUALITY","items":[{"label":"Show","value":"68%"},{"label":"Close","value":"32%"}]}
- {"kind":"list","title":"HOTTEST LEADS","rows":[{"primary":"Don Juan","secondary":"qualifying","tertiary":"3 replies"}]}
- {"kind":"convo","title":"ALEX · IG","rows":[{"from":"lead","text":"yo bro","time":"Jun 9"},{"from":"us","text":"yo brother","time":"Jun 9"}]} — newest LAST, times short like "Jun 9"
- {"kind":"draft","title":"DRAFT → ALEX","value":"the exact message text","sub":"say 'send it' to fire"}
- {"kind":"image","title":"IMAGE","image":"https://…png","caption":"a short caption"} ← renders the ACTUAL picture, tappable to open full size. Use it whenever a tool hands back an image URL; NEVER paste the raw URL as text/speech.
- {"kind":"report","title":"DM INTELLIGENCE","summary":"the headline read","sections":[{"h":"HOW I LOOKED","body":"..."},{"h":"WHAT I FOUND","body":"..."}],"fixes":[{"n":1,"title":"...","body":"the change","why":"why it's the best lever","impact":"expected impact","target":"pitch","confidence":"high"}]} — ONLY for run_dm_analysis / get_dm_report. Use the tool's report_panel as-is; it can be long and that's fine (it scrolls).

Money: $ + commas. Percentages: append %.`;

/** Appended ONLY when demo mode is on — everything becomes a tasteful showcase. */
const SYSTEM_DEMO = `
═══ DEMO MODE IS ON ═══
You are LIVE in front of a PROSPECTIVE CLIENT, showing off this system. Every number, name, deal, and message you produce is INVENTED — realistic, impressive, but believable. Do NOT call any tools and do NOT reference the owner's real data (you must never leak it on a sales call). Build the same beautiful panels from your made-up data. Vary names and numbers naturally each answer; keep it polished and confident. Set "rings":true on any numbers answer so the room lights up. If asked to exit demo, set "demo":false.`;

interface Panel { kind: string;[k: string]: unknown }
interface ChatResult { speech: string; panels: Panel[]; clear: boolean; rings: boolean; power: "sleep" | "off" | null; demo: boolean | null; theme: string | null; demoChat: boolean; pitch: boolean }
function parseResult(text: string): ChatResult {
  const base = { panels: [] as Panel[], clear: false, rings: false, power: null as "sleep" | "off" | null, demo: null as boolean | null, theme: null as string | null, demoChat: false, pitch: false };
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s === -1 || e === -1 || e < s) return { speech: text.trim() || "I'm here — what do you need?", ...base };
  try {
    const obj = JSON.parse(text.slice(s, e + 1));
    return {
      speech: typeof obj.speech === "string" ? obj.speech : "Here you go.",
      panels: Array.isArray(obj.panels) ? obj.panels : [],
      clear: obj.clear === true,
      rings: obj.rings === true,
      power: obj.power === "sleep" || obj.power === "off" ? obj.power : null,
      demo: obj.demo === true ? true : obj.demo === false ? false : null,
      theme: typeof obj.theme === "string" && obj.theme.trim() ? obj.theme.trim().slice(0, 24) : null,
      demoChat: obj.demoChat === true,
      pitch: obj.pitch === true,
    };
  } catch { return { speech: text.trim().slice(0, 300) || "Here you go.", ...base }; }
}

/** Believable fake pulse so demo answers never lean on real numbers. */
function demoPulse() {
  const r = (a: number, b: number) => a + Math.floor(Math.random() * (b - a));
  return { leads_7d: r(34, 62), engaged_now: r(8, 20), booked_7d: r(6, 14), cash_7d: r(8, 22) * 1000 };
}

/**
 * In-lambda caches — the pulse RPC and client row were costing a DB
 * round-trip (US lambda → EU database) before EVERY brain call. A minute of
 * staleness on the pulse is invisible in a voice exchange; the client row
 * basically never changes.
 */
let pulseCache: { at: number; data: Awaited<ReturnType<typeof quickPulse>> } | null = null;
let clientCache: { at: number; data: Client | null } | null = null;
async function cachedPulse() {
  if (pulseCache && Date.now() - pulseCache.at < 60_000) return pulseCache.data;
  const data = await quickPulse();
  pulseCache = { at: Date.now(), data };
  return data;
}
async function cachedClient() {
  if (clientCache && Date.now() - clientCache.at < 300_000) return clientCache.data;
  // Self-heal a transient null: the slug lookup can come back empty on a brief
  // DB blip (US lambda → EU db). Retry the fetch ONCE before giving up, and
  // don't cache a null so the next turn tries fresh too.
  let data = await getHqClient();
  if (!data) data = await getHqClient();
  if (data) clientCache = { at: Date.now(), data };
  return data;
}

async function runTool(client: Client | null, name: string, input: Record<string, unknown>) {
  const q = String(input.query || "");
  // The owner's own tools live in their own module so the student kit can ship
  // without them. null here means "not one of those", never "it failed".
  const extra = await runOwnerExtraTool(name, input);
  if (extra) return extra.result;
  if (name === "search_web") return webSearch(q);
  if (name === "query_database") return queryDatabase(
    String(input.table || ""),
    (input.filters && typeof input.filters === "object" ? input.filters : {}) as Record<string, unknown>,
    typeof input.columns === "string" ? input.columns : undefined,
    Number(input.limit) || 20,
    typeof input.order === "string" ? input.order : undefined,
  );
  if (name === "search_memory") return searchMemory(q, Number(input.k) || 8);
  if (name === "strategic_read") return strategicRead(String(input.question || ""));
  if (name === "system_health") return systemHealth();
  if (name === "manage_tasks") return manageTasks(String(input.action || ""), String(input.title || ""), String(input.detail || ""), String(input.due || ""), String(input.task || ""));
  if (name === "remember") return rememberFact(String(input.fact || ""), String(input.category || "general"));
  if (name === "check_calendar") return listEvents(Number(input.days) || 7);
  if (name === "manage_calendar") {
    if (input.confirmed !== true) return { needs_confirmation: true, proposal: input, note: "Show the owner this plan and ask before doing it." };
    return manageEvent({
      action: String(input.action || ""), title: input.title as string, start: input.start as string,
      end: input.end as string, description: input.description as string, event_id: input.event_id as string,
    });
  }
  if (name === "read_email") return searchEmail(q || String(input.query || ""));
  if (name === "send_email") {
    if (input.confirmed !== true) return { needs_confirmation: true, draft: { to: input.to, subject: input.subject, body: input.body }, note: "Show the draft and ask before sending." };
    return sendEmail(String(input.to || ""), String(input.subject || ""), String(input.body || ""));
  }
  if (name === "get_business_data") return getBusinessData(String(input.period || "last_7_days"), input.source as string, input.funnel as string);
  if (name === "get_recent_bookings") return getRecentBookings(String(input.period || "last_30_days"), Number(input.limit) || 10);
  if (name === "get_closed_deals") return getClosedDeals(String(input.period || "last_30_days"), Number(input.limit) || 12);
  if (name === "get_followup_stats") return getFollowupStats();
  // This tool needs the CRM client row. If the cached lookup came back null,
  // retry it ONCE here (self-heal a transient DB blip) before speaking up — and
  // never hand back a bare code; give the owner a friendly, retryable line.
  if (!client) {
    const retried = await cachedClient();
    if (!retried) return { error: "client_unreachable", message: "Couldn't reach your CRM for a second — try that again." };
    client = retried;
  }
  if (name === "check_ghl_payments") return checkGhlPayments(client, Number(input.days) || 30);
  if (name === "find_lead") return findLead(client.id, q);
  if (name === "lead_story") return leadStory(client.id, q);
  if (name === "get_conversation") return getConversation(client.id, q, Number(input.limit) || 14);
  if (name === "get_hot_leads") return getHotLeads(client.id, Number(input.limit) || 6);
  if (name === "get_morning_brief") return getMorningBrief(client.id);
  if (name === "draft_reply") return draftReply(client, q, input.voice === true);
  if (name === "send_dm") return sendDm(client, q, String(input.message || ""));
  if (name === "set_lead_ai") return setLeadAi(client, q, input.on === true);
  if (name === "manage_tags") return manageTags(client, q,
    Array.isArray(input.add) ? (input.add as string[]).map(String) : [],
    Array.isArray(input.remove) ? (input.remove as string[]).map(String) : []);
  if (name === "move_pipeline") return movePipeline(client, q, String(input.stage || ""));
  if (name === "log_payment") return logPayment(client, String(input.customer || input.query || ""), Number(input.amount) || 0, String(input.kind || "installment"), String(input.currency || ""), String(input.note || ""), input.confirmed === true);
  if (name === "log_sale") return logSale(client, String(input.name || ""), Number(input.contract_value) || 0, Number(input.collected_now) || 0, String(input.currency || ""), String(input.closer || ""), String(input.note || ""), input.confirmed === true);
  if (name === "set_setter_system") return setSetterSystem(input.on === true);
  if (name === "set_nurture_system") return setNurtureSystem(input.on === true);
  if (name === "set_nurture_lead") return setNurtureLead(client, q, input.on === true);
  if (name === "set_followup_system") return setFollowupSystem(input.on === true);
  if (name === "set_followup_lead") return setFollowupLead(client, q, input.on === true);
  if (name === "set_dm_intel_system") return setDmIntelSystem(input.on === true);
  if (name === "set_voice_system") return setVoiceSystem(input.on === true, typeof input.lang === "string" ? input.lang : undefined);
  if (name === "set_notify") return setNotify(typeof input.scope === "string" ? input.scope : "all", input.on === true);
  if (name === "set_voice_lead") return setVoiceLead(client, q, input.on === true);
  if (name === "get_voice_stats") return getVoiceStats(Number(input.hours) || 168);
  if (name === "set_whale_radar_system") return setWhaleRadarSystem(input.on === true);
  if (name === "set_whale_lead") return setWhaleLead(client, q, input.on === true);
  if (name === "set_pain_dig_system") return setPainDigSystem(input.on === true);
  if (name === "run_dm_analysis") {
    // The analysis is heavy (~30-45s of deep thinking). NEVER run it inside the
    // 60s voice request — it would risk hanging the room. Fire it in the
    // background (waitUntil keeps the function alive to finish + write the
    // report) and return instantly. The owner reads it a moment later via
    // get_dm_report ("show me the DM report"). It can never block the orbit.
    waitUntil(runDmIntel(client.id, "manual").catch((e) => console.error("[dmintel] background run failed:", e)));
    return { started: true, eta_seconds: 35, note: "Analysis started in the background. In ~30s, say 'show me the DM report' to read it." };
  }
  if (name === "get_dm_report") return getLatestDmReport(client.id);
  if (name === "get_brain_field") return getBrainField(String(input.field || ""));
  if (name === "set_brain_field") return setBrainField(client, String(input.field || ""), String(input.new_value || ""), input.confirmed === true);
  if (name === "undo_brain_field") return undoBrainField(client, String(input.field || ""), input.confirmed === true);
  if (name === "ban_lead") return banLead(client, q, String(input.reason || ""));
  if (name === "unban_lead") return unbanLead(client, q);
  if (name === "list_bans") return listBans(client);
  return { error: "unknown_tool" };
}

// ── Shared owner conversation (ONE brain across HQ + Telegram) ───────────────
// The owner's chat is keyed 'owner' in jarvis_conversations on BOTH engines, so a
// thread they start in HQ continues on Telegram and vice-versa. HQ reads the
// shared thread as its history and writes each turn back (surface 'hq'). The
// Python bot does the same (surface 'telegram'). Best-effort: a store hiccup
// falls back to the browser-local history the UI still sends.
const OWNER_KEY = "owner";

async function loadOwnerHistory(limit = 8): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  try {
    const { data } = await supabase
      .from("jarvis_conversations")
      .select("role, content, created_at")
      .eq("user_key", OWNER_KEY)
      .order("created_at", { ascending: false })
      .limit(limit);
    return (data ?? []).reverse().map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: String(m.content ?? "").slice(0, 1200),
    }));
  } catch (e) {
    console.error("[hq/chat] loadOwnerHistory failed:", e);
    return [];
  }
}

async function saveOwnerTurn(role: "user" | "assistant", content: string): Promise<void> {
  if (!content) return;
  try {
    await supabase.from("jarvis_conversations").insert({ user_key: OWNER_KEY, surface: "hq", role, content: content.slice(0, 8000) });
  } catch (e) {
    console.error("[hq/chat] saveOwnerTurn failed:", e);
  }
}

/** Coerce a turn list into a valid Anthropic message array: starts with a user
 *  turn, no two same-role turns in a row (merged). The shared store interleaves
 *  HQ + Telegram turns, so this guards against an odd ordering. */
function coerceAlternating(msgs: Array<{ role: "user" | "assistant"; content: string }>): Anthropic.MessageParam[] {
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of msgs) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const last = out[out.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n${m.content}`;
    else out.push({ role, content: m.content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const k = req.nextUrl.searchParams.get("k") ?? "";
    const accessKey = await getAccessKey();
    if (!accessKey || k !== accessKey) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const body = (await req.json().catch(() => null)) as { message?: string; history?: Array<{ role: "user" | "assistant"; content: string }>; demo?: boolean } | null;
    const message = (body?.message ?? "").trim().slice(0, 2000);
    if (!message) return NextResponse.json({ error: "empty_message" }, { status: 400 });
    const demo = body?.demo === true;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "brain_not_configured" }, { status: 503 });

    // In demo mode NOTHING touches real data: fake pulse, no client, no tools.
    const [pulse, client] = demo
      ? [demoPulse(), null as Client | null]
      : await Promise.all([cachedPulse(), cachedClient()]);
    const anthropic = claude("hq_chat");
    // History = the SHARED owner thread (so Telegram turns show up here too); fall
    // back to the browser-local history the UI sends if the store is empty/down.
    // Demo mode never touches the real conversation.
    const browserHistory = (body?.history ?? []).slice(-8).map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: String(m.content ?? "").slice(0, 1200) }));
    const sharedHistory = demo ? [] : await loadOwnerHistory(8);
    const history = sharedHistory.length ? sharedHistory : browserHistory;
    if (!demo) await saveOwnerTurn("user", message);
    const messages: Anthropic.MessageParam[] = coerceAlternating([...history, { role: "user", content: message }]);
    // static prompt + tools are CACHED (prefix cache); the live pulse sits
    // AFTER the breakpoint so its changing numbers don't bust the cache.
    // Tool rounds + follow-up questions reuse the prefix → much faster.
    const todayStr = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
    const system: Anthropic.TextBlockParam[] = [
      // OWNER_EXTRA_SYSTEM describes the owner-only tools; it is an empty
      // string in the student kit, whose HQ does not have them.
      { type: "text", text: SYSTEM_STATIC + OWNER_EXTRA_SYSTEM, cache_control: { type: "ephemeral" } },
      { type: "text", text:
`TODAY IS ${todayStr} (UTC). Reason from THIS date — it is NOT 2025 and NOT your training era. Whenever you say "latest / current / this year / right now", anchor to today's real date.

TRUTH > AGREEMENT — NEVER FOLD, NEVER FABRICATE (this is sacred — the owner must be able to trust your data):
- For "what's the latest / what's trending / current state of X", base the answer ONLY on what search_web actually returned THIS turn — not your memory. If you didn't search, search before claiming what's current.
- If the results are thin, old, or don't clearly back a claim, SAY so plainly ("the freshest I found is from X") instead of inventing a confident, dated take. Never stamp a year on a claim unless a source supports it.
- If the owner pushes back or corrects you, DO NOT just flip your answer to agree. Re-run search_web and report what the sources ACTUALLY say. If you were genuinely wrong, correct it WITH the evidence; if the sources still support your read, hold it and show them why. Caving to please him, or inventing a "${new Date().getUTCFullYear()} read" with no source, is the worst thing you can do.` },
      { type: "text", text: `QUICK PULSE (${demo ? "DEMO — fake" : "live numbers, already known"}): ${JSON.stringify(pulse)}` },
    ];
    if (demo) system.push({ type: "text", text: SYSTEM_DEMO });
    if (!demo) {
      // WHOSE HQ THIS IS comes from the database, never from the code. The
      // engine ships identical to every deployment; the name, the voice and
      // everything personal arrive as data, so one copy of this file serves
      // any operator.
      const who = (client?.name || "").trim();
      if (who) system.push({ type: "text", text: `THE BUSINESS YOU RUN: ${who}. The person you are speaking to owns it — address them the way they have told you to.` });
      const facts = await recallFacts();
      if (facts) system.push({ type: "text", text: `WHAT YOU REMEMBER ABOUT THE OWNER (shared with their Telegram Jarvis — use naturally, don't recite):\n${facts}` });
    }
    const tools = demo ? [] : TOOLS;

    let finalText = "";
    for (let i = 0; i < 6; i++) {
      const res = await anthropic.messages.create({
        model: MODEL, max_tokens: 1600, system, tools, messages,
        // short spoken replies + simple tool picks — low effort is much
        // faster than Sonnet 4.6's default (high) with no quality cliff here
        output_config: { effort: "low" },
      });
      if (res.stop_reason === "tool_use") {
        const toolUses = res.content.filter((b) => b.type === "tool_use");
        messages.push({ role: "assistant", content: res.content });
        const results = await Promise.all(toolUses.map(async (tu) => {
          const t = tu as { id: string; name: string; input: Record<string, unknown> };
          const data = await runTool(client, t.name, t.input || {});
          return { type: "tool_result" as const, tool_use_id: t.id, content: JSON.stringify(data).slice(0, 12000) };
        }));
        messages.push({ role: "user", content: results });
        continue;
      }
      finalText = res.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("");
      break;
    }
    if (!demo && finalText) await saveOwnerTurn("assistant", finalText);
    return NextResponse.json(parseResult(finalText));
  } catch (err) {
    console.error("[hq/chat] error:", err);
    // tell the owner the REAL reason instead of a generic shrug
    const msg = err instanceof Error ? err.message : String(err);
    const speech = /credit balance/i.test(msg)
      ? "Boss, my brain's out of fuel — the Anthropic account ran out of credits. Top it up at console anthropic dot com under billing, and I'm back."
      : /overloaded|rate.?limit|429|529/i.test(msg)
        ? "The brain's jammed for a moment — give me ten seconds and ask again."
        : "Lost you for a second — say that again?";
    return NextResponse.json({ speech, panels: [], clear: false, rings: false, power: null, demo: null, theme: null, demoChat: false, pitch: false });
  }
}
