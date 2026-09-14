/**
 * Supabase client wrapper.
 *
 * We use the SERVICE_ROLE_KEY here because this code only runs server-side
 * (in API routes). Service role bypasses RLS, which is what we want for
 * the backend — RLS protects future public dashboards, not our own backend.
 *
 * NEVER expose the service role key to the browser. It's in .env.local
 * and Vercel env vars only.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { scrubOutboundText } from "./outbound";
import { ownerSlug } from "./tenant";
import { normalizeForCompare } from "./dedup"; // dependency-free, no import cycle

// Lazy singleton. We must NOT construct the client (or throw on missing env) at
// module import time: Next.js loads every route module during `next build` page-
// data collection, even force-dynamic ones, where build env may lack secrets.
// Throwing there fails the whole build. Instead we build the client on first real
// use (a request), when the env is present in production. Preview/build = no throw.
let _client: SupabaseClient | null = null;
function getSupabase(): SupabaseClient {
  if (_client) return _client;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      "Missing Supabase env vars. Check .env.local for SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
  }
  _client = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });
  return _client;
}

// Proxy keeps the existing `supabase.from(...)` call sites unchanged while
// deferring construction to first property access (i.e. first query at runtime).
export const supabase = new Proxy({} as SupabaseClient, {
  get(_t, prop) {
    const client = getSupabase() as unknown as Record<string | symbol, unknown>;
    const value = client[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(client) : value;
  },
});

// --- Typed table helpers ---

export type Client = {
  id: string;
  name: string;
  slug: string;
  ghl_location_id: string | null;
  ghl_api_key: string | null;
  ghl_calendar_id: string | null;
  system_prompt: string;
  voice_samples: string;
  active_rules: string;
  business_context: string;
  is_active: boolean;
  timezone: string;
  // Owner-configured reply delay range (seconds) set from Jarvis ("wait 20s
  // before replying"). When null, the default fixed debounce applies.
  reply_delay_min_seconds: number | null;
  reply_delay_max_seconds: number | null;
  // Ordered funnel definition (see lib/stages.ts). null/empty => legacy
  // full-script behaviour (no stage tracking).
  stages: unknown[] | null;
  // "Dig deeper into pain" overlay (see lib/paindig.ts). When true, the setter
  // pauses the funnel to explore an emotionally heavy disclosure before
  // resuming. Ships false. pain_protocol optionally overrides the default
  // trigger words + dig style; null => the built-in default protocol.
  pain_dig_enabled?: boolean;
  pain_protocol?: string | null;
  // Voice notes in the operator's cloned voice (see lib/voice.ts). Ships false.
  // setter_voice_id is the ElevenLabs cloned-voice id; null => text only.
  // voice_enabled = ENGLISH voice switch. voice_enabled_sv = SWEDISH voice
  // switch, which ships OFF: the owner's rule is that Swedish conversations stay
  // TEXT (the Swedish clone isn't good enough), so Swedish voice only fires if
  // it's explicitly switched on.
  voice_enabled?: boolean;
  voice_enabled_sv?: boolean | null;
  setter_voice_id?: string | null;
  setter_voice_id_sv?: string | null;
  // Optional per-client overrides for the ElevenLabs voice delivery settings
  // (stability/speed/etc + the length-adaptive stability knobs) so the voice
  // can be tuned WITHOUT a deploy. null = code defaults. Invalid keys/values
  // are ignored at read time — see lib/voice.ts effectiveVoiceSettings.
  voice_settings?: Record<string, unknown> | null;
  // Whale radar (see lib/stages.ts whale score). When true the setter pings the
  // owner the first time a lead scores as a high-value whale.
  whale_radar_enabled?: boolean;
  // Setter activity notifications (audit mode). When true the owner gets a
  // Telegram ping for everything the setter does on a live lead: started a
  // conversation, replied, chose to stay silent, or a reply that failed to
  // deliver. Excludes follow-ups. Ships false; meant to be turned on for a week
  // or two of watching, then off.
  setter_notify_enabled?: boolean | null;
  // Per-kind notification mutes — a list of notification kinds turned OFF while
  // the master switch is on: 'started' | 'replied' | 'silent' | 'failed' |
  // 'followup'. A ping fires only when the master is on AND its kind isn't here.
  setter_notify_off?: string[] | null;
  // ManyChat (see lib/manychat.ts) — the channel that can deliver a REAL
  // Instagram voice note (GHL can't). When manychat_api_token is set, the setter
  // routes its cloned-voice notes through ManyChat (WAV) instead of GHL (mp3).
  // Text bubbles still go through GHL. null => no ManyChat, voice falls back.
  manychat_api_token?: string | null;
  manychat_page_id?: string | null;
  created_at: string;
  updated_at: string;
};

export type Lead = {
  id: string;
  client_id: string;
  ghl_contact_id: string | null;
  // Durable Instagram sender id (igSid). Stable identity for one Instagram
  // person even as GHL spawns/merges multiple contact ids for them. Resolved
  // via findLeadByIdentity/resolveLead. null on non-IG / legacy leads.
  ig_sender_id: string | null;
  ig_username: string | null;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  status: "new" | "engaged" | "booked" | "done";
  ai_paused: boolean;
  // Per-lead nurture switch (toggled from HQ or Telegram). When true the
  // proactive nurture engine skips this lead even while the system is enabled.
  nurture_paused?: boolean;
  // Per-lead follow-up switch. When true the follow-up engine skips this lead.
  followup_paused?: boolean;
  // Per-lead voice switch. When true the setter never sends this lead voice
  // notes (text only), even while the voice system is on.
  voice_paused?: boolean;
  // Per-lead whale switch. When true the whale radar never pings about this
  // lead, even while the radar is on system-wide.
  whale_paused?: boolean;
  screened: boolean;
  // GHL OPPORTUNITY pipeline stage NAME ("New Lead", "Lead Lost", "Appointment
  // Booked", ...). Owned EXCLUSIVELY by the Jarvis pipeline watcher
  // (intelligence/ghl/pipeline_watcher.py) and read by Jarvis reporting. The
  // setter must NOT read or write this — it uses `funnel_stage` instead.
  stage: string | null;
  // The setter's own conversation state machine (see lib/stages.ts).
  // `funnel_stage` is the funnel stage id the lead is on; `stage_data` holds
  // facts learned so far so the setter never re-asks. Both are owned solely by
  // the setter and are never touched by the pipeline watcher. null/empty for
  // legacy / pre-staging leads. (Was previously stored in `stage`, which
  // collided with the watcher and wiped the setter's memory every sync.)
  funnel_stage: string | null;
  stage_data: Record<string, unknown> | null;
  // Locked conversation language (see lib/language.ts). null/'en' => English
  // (default); 'sv_pending' => asked "snackar du svenska?"; 'sv' => locked
  // Swedish; 'en_declined' => declined Swedish, stay English.
  conversation_language: string | null;
  // Cached ManyChat subscriber id (resolved by IG name via findByName). Lets the
  // setter send this lead a cloned-voice note through ManyChat without re-looking
  // it up every reply. null until first resolved.
  manychat_subscriber_id?: string | null;
  // Single-flight lock for the instant-ack send (mirror of reply_lock_at). Set
  // while an ack is being composed/sent; cleared right after. null = free.
  ack_lock_at?: string | null;
  // Single-flight lock for the considered reply (see acquireReplyLock). Set
  // while a reply is being generated/sent; freed in the engine's finally. A
  // platform-killed invocation skips that finally, so a fresh-looking lock can
  // be ORPHANED - /api/setter/reply-now reclaims it when the locked generation
  // demonstrably already delivered (an AI row newer than the lock stamp).
  reply_lock_at?: string | null;
  first_contact_at: string;
  last_message_at: string;
  created_at: string;
  updated_at: string;
  // Lead-magnet flow state (see lib/lead-magnet.ts): "reply BDP for the free
  // book" and future keyword-triggered freebies. null = never triggered.
  magnet_state?: "awaiting_email" | "awaiting_handoff" | "handed_off" | null;
  magnet_keyword?: string | null;
  magnet_email?: string | null;
  magnet_link_sent_at?: string | null;
  magnet_handoff_at?: string | null;
};

export type DbMessage = {
  id: string;
  lead_id: string;
  client_id: string;
  role: "lead" | "ai" | "human";
  content: string;
  channel: string;
  ghl_message_id: string | null;
  model_used: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
  // 'manychat' when this row was saved by the fast /api/manychat/inbound path
  // (true-instant ack trigger); null = saved by the GHL webhook (the default).
  source?: string | null;
  // 'voice' when this AI bubble actually went out as a voice note; null = text.
  // Powers the hard voice quota + voice-vs-text reporting. Deliberately NOT
  // stored in `channel` (which the HQ chat display reads).
  delivery?: string | null;
  // When this AI bubble's send sequence actually COMPLETED (the words reached
  // the lead), stamped post-send. created_at is the save time, which precedes
  // the paced sends by up to ~30s on a multi-bubble reply - the crossed-messages
  // check needs the real delivery moment. null on lead rows and legacy rows.
  delivered_at?: string | null;
  // Stamped the instant this bubble's transport call is ABOUT TO FIRE (before
  // the fetch, not after). It splits "never tried" from "tried, answer
  // unknown": a run killed mid-flight leaves send_attempted_at set and
  // delivered_at null, and the resend backstop must treat that as PROBABLY
  // DELIVERED (the request had left; Instagram usually got it - live incident
  // 2026-08-13, Cody Brown got the same bubble twice) rather than blindly
  // re-sending the exact words. null on lead rows and legacy rows.
  send_attempted_at?: string | null;
  // When this AI bubble was SEEN in the real Instagram conversation (read back
  // from the GHL mirror of the thread — lib/delivery-verify.ts). delivered_at
  // is the transmitter's receipt; this is the inbox's. null = not yet
  // confirmed by read-back (which is normal for the first ~2 minutes, and
  // permanent for rows older than the verifier's lookback).
  inbox_verified_at?: string | null;
};

/**
 * Run a Supabase query with retries on transient errors.
 *
 * Supabase calls resolve to `{ data, error }` and never reject, so a transient
 * DB/network blip surfaces as a truthy `error`. Callers that simply did
 * `if (error) return null` could not tell "the row doesn't exist" from "the
 * query failed" — which silently dropped lead messages. This helper retries
 * the failing query a few times and THROWS if it never succeeds, so callers
 * can surface a retryable failure instead of masking it as an empty result.
 *
 * On success it returns `data` (which may be null for a genuine no-match).
 */
async function withRetry<T>(
  label: string,
  op: () => PromiseLike<{ data: T | null; error: unknown | null }>,
  attempts = 3
): Promise<T | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { data, error } = await op();
    if (!error) return data;

    lastError = error;
    console.error(`[supabase] ${label} attempt ${attempt}/${attempts} failed:`, error);
    // Brief linear backoff before retrying a transient failure.
    await new Promise((r) => setTimeout(r, 150 * attempt));
  }

  throw new Error(
    `${label} failed after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : JSON.stringify(lastError)
    }`
  );
}

/**
 * Get a client by slug. Used for testing / direct lookup.
 */
export async function getClient(slug?: string): Promise<Client | null> {
  const resolved = slug || ownerSlug();
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("slug", resolved)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    console.error("[supabase] getClient failed:", error);
    return null;
  }
  return data as Client | null;
}

/**
 * Get a client by their GHL location ID.
 * This is THE function the webhook uses to route incoming messages
 * to the right client/training in a multi-tenant world.
 *
 * NOTE: this deliberately does NOT filter on is_active. The webhook must
 * find the client even when the setter is globally OFF so the inbound lead +
 * message + events are still recorded — only the REPLY is withheld (the
 * is_active gate lives in route.ts AFTER recording). Filtering here used to
 * silently drop every DM that arrived while paused.
 *
 * Retries transient DB errors and THROWS if the query keeps failing, so the
 * caller can return a retryable status instead of silently treating a
 * database blip as "no client found" and dropping the lead's message.
 * Returns null ONLY when the query succeeds and genuinely matches no client.
 */
export async function getClientByGHLLocation(
  ghl_location_id: string
): Promise<Client | null> {
  return withRetry<Client | null>("getClientByGHLLocation", () =>
    supabase
      .from("clients")
      .select("*")
      .eq("ghl_location_id", ghl_location_id)
      .maybeSingle()
  );
}

/**
 * Find a lead by GHL contact ID, or create one if it doesn't exist.
 * Retries transient DB errors and throws on persistent failure so the caller
 * can return a retryable status instead of dropping the lead's message.
 */
export async function findOrCreateLead(params: {
  client_id: string;
  ghl_contact_id: string;
  ig_username?: string;
  full_name?: string;
}): Promise<Lead | null> {
  const existing = await withRetry<Lead | null>("findOrCreateLead.select", () =>
    supabase
      .from("leads")
      .select("*")
      .eq("client_id", params.client_id)
      .eq("ghl_contact_id", params.ghl_contact_id)
      .maybeSingle()
  );

  if (existing) return existing;

  return withRetry<Lead>("findOrCreateLead.insert", () =>
    supabase
      .from("leads")
      .insert({
        client_id: params.client_id,
        ghl_contact_id: params.ghl_contact_id,
        ig_username: params.ig_username ?? null,
        full_name: params.full_name ?? null,
        status: "new",
      })
      .select("*")
      .single()
  );
}

/**
 * IDENTITY RESOLUTION — one Instagram person = one lead.
 *
 * GHL spawns and merges multiple contact ids for the SAME Instagram person
 * (observed live: one igSid across three contact ids, seconds/days apart), so
 * keying a lead on the GHL contact id split one human's conversation — and any
 * in-flight lead-magnet flow — across duplicate lead rows. The Instagram sender
 * id (igSid) is stable where the contact id is not, so it is the identity; the
 * contact id is demoted to "the contact to send THIS reply through".
 *
 * findLeadByIdentity resolves WITHOUT creating (returns null if unknown):
 *   1. If we have an igSid, match on it. Among duplicates, pick the canonical
 *      lead (an in-flight lead-magnet flow wins so a duplicate contact spawned
 *      mid-flow can never abandon it; else the most recently active). Then
 *      repoint that lead's ghl_contact_id to THIS inbound's contact so replies
 *      reach the contact GHL currently routes — freeing the id from any other
 *      duplicate row first, since (client_id, ghl_contact_id) is UNIQUE.
 *   2. Otherwise fall back to the contact id, and backfill the igSid onto that
 *      row so the person unifies on their durable id from here on.
 */
function pickCanonicalLead(leads: Lead[]): Lead {
  const inFlightMagnet = leads.find(
    (l) => l.magnet_state === "awaiting_email" || l.magnet_state === "awaiting_handoff"
  );
  // `leads` is ordered last_message_at desc by the caller, so leads[0] is the
  // most recently active when no magnet flow is in flight.
  return inFlightMagnet ?? leads[0];
}

/**
 * Fold a ManyChat-first TWIN of this person into their real (GHL-keyed) lead.
 * The twin exists because ManyChat knows the @handle + subscriber id while the
 * GHL lead was keyed only on igSid/contact — no shared key, so the ManyChat
 * inbound minted a contactless duplicate the engine could neither unify nor
 * send on (live: LD Williams + Love Ohlquist, overnight alarm storm 2026-07-10).
 * The ManyChat ids move onto the real lead, the twin's thread rows move too
 * (rows that are just GHL-duplicates of what the real thread already has are
 * dropped, not doubled), and the husk is paused so the sweep stops working a
 * dead-end. Best-effort: any failure leaves both leads exactly as they were.
 */
async function absorbManychatTwin(client_id: string, canon: Lead): Promise<void> {
  const name = (canon.full_name || "").trim();
  if (!name) return;
  try {
    const { data } = await supabase
      .from("leads")
      .select("*")
      .eq("client_id", client_id)
      .is("ghl_contact_id", null)
      .not("manychat_subscriber_id", "is", null)
      .ilike("full_name", name)
      .neq("id", canon.id)
      .order("last_message_at", { ascending: false })
      .limit(1);
    const twin = ((data ?? []) as Lead[])[0];
    if (!twin) return;
    // Move the ManyChat identity (clear the twin's first — the column may be
    // uniquely indexed) and neutralize the husk.
    const subId = twin.manychat_subscriber_id;
    const twinHandle = twin.ig_username;
    await supabase
      .from("leads")
      .update({ manychat_subscriber_id: null, ai_paused: true, magnet_state: null })
      .eq("id", twin.id);
    const upd: Record<string, unknown> = { manychat_subscriber_id: subId };
    if (twinHandle && !canon.ig_username) upd.ig_username = twinHandle;
    await supabase.from("leads").update(upd).eq("id", canon.id);
    Object.assign(canon, upd);
    // Merge the twin's thread: drop rows the real thread already has (GHL and
    // ManyChat both deliver the same DM), move anything genuinely new.
    const [{ data: twinMsgs }, { data: canonMsgs }] = await Promise.all([
      supabase.from("messages").select("id,content,created_at").eq("lead_id", twin.id),
      supabase.from("messages").select("content,created_at").eq("lead_id", canon.id)
        .order("created_at", { ascending: false }).limit(100),
    ]);
    const canonKeys = ((canonMsgs ?? []) as { content: string; created_at: string }[]).map((m) => ({
      key: echoKey(m.content),
      ms: new Date(m.created_at).getTime(),
    }));
    for (const m of (twinMsgs ?? []) as { id: string; content: string; created_at: string }[]) {
      const ms = new Date(m.created_at).getTime();
      const dupe = canonKeys.some((c) => c.key === echoKey(m.content) && Math.abs(c.ms - ms) < 120_000);
      if (dupe) await supabase.from("messages").delete().eq("id", m.id);
      else await supabase.from("messages").update({ lead_id: canon.id }).eq("id", m.id);
    }
    await logEvent({
      client_id,
      lead_id: canon.id,
      event_type: "duplicate_contact_absorbed",
      metadata: { via: "manychat_twin_absorb", twin_lead_id: twin.id, subscriber_id: subId },
    });
  } catch (e) {
    console.error("[supabase] manychat twin absorb failed:", e);
  }
}

export async function findLeadByIdentity(params: {
  client_id: string;
  ghl_contact_id: string;
  ig_sender_id?: string | null;
  ig_username?: string | null;
  full_name?: string | null;
}): Promise<Lead | null> {
  const { client_id, ghl_contact_id, ig_sender_id, ig_username, full_name } = params;

  // 1. Durable Instagram-identity path.
  if (ig_sender_id) {
    const matches = await withRetry<Lead[]>("findLeadByIdentity.byIgSender", () =>
      supabase
        .from("leads")
        .select("*")
        .eq("client_id", client_id)
        .eq("ig_sender_id", ig_sender_id)
        .order("last_message_at", { ascending: false })
    );
    if (matches && matches.length) {
      const canon = pickCanonicalLead(matches);
      if (canon.ghl_contact_id !== ghl_contact_id) {
        // TRIPWIRE: GHL is routing this person through a DIFFERENT contact id
        // than last time — a duplicate/merge just happened upstream. Log it
        // with exact timing so the churn can be correlated with what else
        // happened in the account at that moment (bookings, workflows, forms).
        await logEvent({
          client_id,
          lead_id: canon.id,
          event_type: "duplicate_contact_absorbed",
          metadata: {
            via: "ig_sender_id",
            old_contact_id: canon.ghl_contact_id,
            new_contact_id: ghl_contact_id,
            ig_sender_id,
          },
        });
        // Free this contact id from any OTHER duplicate row (same person) so the
        // UNIQUE (client_id, ghl_contact_id) constraint doesn't reject the
        // repoint. The freed row keeps its history; it just loses the pointer.
        await supabase
          .from("leads")
          .update({ ghl_contact_id: null })
          .eq("client_id", client_id)
          .eq("ghl_contact_id", ghl_contact_id)
          .neq("id", canon.id)
          .then(undefined, (e) => console.error("[supabase] identity repoint-free failed:", e));
        const upd: Record<string, unknown> = { ghl_contact_id };
        if (ig_username && !canon.ig_username) upd.ig_username = ig_username;
        if (full_name && !canon.full_name) upd.full_name = full_name;
        await supabase
          .from("leads")
          .update(upd)
          .eq("id", canon.id)
          .then(undefined, (e) => console.error("[supabase] identity repoint failed:", e));
        canon.ghl_contact_id = ghl_contact_id;
      }
      // Fold in any ManyChat-first twin of this person. Guarded so it costs a
      // query only while the real lead has no subscriber id — after one absorb
      // (or one ManyChat message matched by name) the guard is false forever.
      if (!canon.manychat_subscriber_id) await absorbManychatTwin(client_id, canon);
      return canon;
    }
  }

  // 2. Contact-id fallback (no igSid, or first sighting of this person).
  const existing = await withRetry<Lead | null>("findLeadByIdentity.byContact", () =>
    supabase
      .from("leads")
      .select("*")
      .eq("client_id", client_id)
      .eq("ghl_contact_id", ghl_contact_id)
      .maybeSingle()
  );
  if (existing) {
    if (ig_sender_id && !existing.ig_sender_id) {
      await supabase
        .from("leads")
        .update({ ig_sender_id })
        .eq("id", existing.id)
        .then(undefined, (e) => console.error("[supabase] ig_sender_id backfill failed:", e));
      existing.ig_sender_id = ig_sender_id;
    }
    if (!existing.manychat_subscriber_id) await absorbManychatTwin(client_id, existing);
    return existing;
  }

  // 2.5 Instagram-HANDLE match: a lead created by the ManyChat-first inbound
  //     (which knows the @handle but no GHL contact) must unify with the GHL
  //     contact the moment GHL's webhook shows up carrying that handle.
  if (ig_username && ig_username.trim()) {
    const handle = ig_username.trim().replace(/^@/, "");
    if (handle && !handle.includes(",") && !handle.includes("(") && !handle.includes(")")) {
      const { data: byHandle } = await supabase
        .from("leads")
        .select("*")
        .eq("client_id", client_id)
        .or(`ig_username.ilike.${handle},ig_username.ilike.@${handle}`)
        .order("last_message_at", { ascending: false });
      const rows = (byHandle ?? []) as Lead[];
      if (rows.length) {
        const canon = pickCanonicalLead(rows);
        if (canon.ghl_contact_id !== ghl_contact_id) {
          await logEvent({
            client_id,
            lead_id: canon.id,
            event_type: "duplicate_contact_absorbed",
            metadata: { via: "ig_username", old_contact_id: canon.ghl_contact_id, new_contact_id: ghl_contact_id, ig_username: handle },
          });
          await supabase
            .from("leads")
            .update({ ghl_contact_id: null })
            .eq("client_id", client_id)
            .eq("ghl_contact_id", ghl_contact_id)
            .neq("id", canon.id)
            .then(undefined, (e) => console.error("[supabase] handle repoint-free failed:", e));
          const upd: Record<string, unknown> = { ghl_contact_id };
          if (ig_sender_id && !canon.ig_sender_id) upd.ig_sender_id = ig_sender_id;
          await supabase
            .from("leads")
            .update(upd)
            .eq("id", canon.id)
            .then(undefined, (e) => console.error("[supabase] handle repoint failed:", e));
          canon.ghl_contact_id = ghl_contact_id;
        }
        return canon;
      }
    }
  }

  // 3. LAST-RESORT name fallback — ONLY when no Instagram id exists anywhere
  //    (not in the payload, not on GHL's contact record). Observed live: GHL
  //    merged a lead's contact away and minted a replacement whose own record
  //    carried NO igSid, so steps 1-2 both missed and the person's in-flight
  //    conversation forked onto a fresh lead. Exact (case-insensitive) full-name
  //    match, restricted to leads active in the last 7 days, newest first,
  //    canonical pick as in step 1. Deliberately narrow: identical names on two
  //    RECENTLY ACTIVE leads are rare, and a fork of the same human is certain
  //    in this situation — the lesser risk wins. Skipped entirely whenever an
  //    igSid was available (then a no-match genuinely means a new person).
  if (!ig_sender_id && full_name && full_name.trim()) {
    const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const { data: byName } = await supabase
      .from("leads")
      .select("*")
      .eq("client_id", client_id)
      .ilike("full_name", full_name.trim())
      .gte("last_message_at", since)
      .order("last_message_at", { ascending: false });
    const rows = (byName ?? []) as Lead[];
    if (rows.length) {
      const canon = pickCanonicalLead(rows);
      // TRIPWIRE (see step 1): a duplicate with NO igSid anywhere just got
      // absorbed by the name fallback — the worst-case GHL churn variant.
      await logEvent({
        client_id,
        lead_id: canon.id,
        event_type: "duplicate_contact_absorbed",
        metadata: {
          via: "name_fallback",
          old_contact_id: canon.ghl_contact_id,
          new_contact_id: ghl_contact_id,
          full_name: full_name.trim(),
        },
      });
      // Repoint like step 1: sends must target the contact GHL currently routes.
      await supabase
        .from("leads")
        .update({ ghl_contact_id: null })
        .eq("client_id", client_id)
        .eq("ghl_contact_id", ghl_contact_id)
        .neq("id", canon.id)
        .then(undefined, (e) => console.error("[supabase] name-fallback repoint-free failed:", e));
      await supabase
        .from("leads")
        .update({ ghl_contact_id })
        .eq("id", canon.id)
        .then(undefined, (e) => console.error("[supabase] name-fallback repoint failed:", e));
      canon.ghl_contact_id = ghl_contact_id;
      return canon;
    }
  }

  // 4. ManyChat-first twin adoption for a person NEW to GHL: they messaged
  //    first through ManyChat (a contactless lead is already mid-conversation
  //    or waiting on a reply) and GHL only now minted their contact. Step 3
  //    deliberately skips when an igSid exists — but a contactless lead with a
  //    ManyChat subscriber id and the same recently-active name is the same
  //    human (live: joana, 2026-07-10). The contact + igSid attach to THAT
  //    lead, so their existing thread finally gets a working send channel.
  if (full_name && full_name.trim()) {
    const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const { data } = await supabase
      .from("leads")
      .select("*")
      .eq("client_id", client_id)
      .is("ghl_contact_id", null)
      .not("manychat_subscriber_id", "is", null)
      .ilike("full_name", full_name.trim())
      .gte("last_message_at", since)
      .order("last_message_at", { ascending: false })
      .limit(1);
    const twin = ((data ?? []) as Lead[])[0];
    if (twin) {
      await logEvent({
        client_id,
        lead_id: twin.id,
        event_type: "duplicate_contact_absorbed",
        metadata: { via: "manychat_twin_adopt", new_contact_id: ghl_contact_id, ig_sender_id: ig_sender_id ?? null },
      });
      // Free the contact id from any other row first (UNIQUE constraint), then
      // attach it — same pattern as the repoints above.
      await supabase
        .from("leads")
        .update({ ghl_contact_id: null })
        .eq("client_id", client_id)
        .eq("ghl_contact_id", ghl_contact_id)
        .neq("id", twin.id)
        .then(undefined, (e) => console.error("[supabase] twin-adopt repoint-free failed:", e));
      const upd: Record<string, unknown> = { ghl_contact_id };
      if (ig_sender_id && !twin.ig_sender_id) upd.ig_sender_id = ig_sender_id;
      await supabase
        .from("leads")
        .update(upd)
        .eq("id", twin.id)
        .then(undefined, (e) => console.error("[supabase] twin adopt failed:", e));
      Object.assign(twin, upd);
      return twin;
    }
  }

  return null;
}

/**
 * Resolve a lead by durable Instagram identity, creating one if this person is
 * genuinely new. The identity-aware replacement for findOrCreateLead on the
 * inbound paths (live webhook + GHL-gap ingest). Throws on a persistent insert
 * failure (like findOrCreateLead) so callers can return a retryable status.
 */
export async function resolveLead(params: {
  client_id: string;
  ghl_contact_id: string;
  ig_sender_id?: string | null;
  ig_username?: string | null;
  full_name?: string | null;
}): Promise<Lead | null> {
  const found = await findLeadByIdentity(params);
  if (found) return found;

  return withRetry<Lead>("resolveLead.insert", () =>
    supabase
      .from("leads")
      .insert({
        client_id: params.client_id,
        ghl_contact_id: params.ghl_contact_id,
        ig_sender_id: params.ig_sender_id ?? null,
        ig_username: params.ig_username ?? null,
        full_name: params.full_name ?? null,
        status: "new",
      })
      .select("*")
      .single()
  );
}

export async function getRecentMessages(
  lead_id: string,
  limit = 50
): Promise<DbMessage[]> {
  const data = await withRetry<DbMessage[]>("getRecentMessages", () =>
    supabase
      .from("messages")
      .select("*")
      .eq("lead_id", lead_id)
      .order("created_at", { ascending: false })
      .limit(limit)
  );
  return (data ?? []).reverse();
}

/**
 * Fetch the single most recent role='lead' message for a lead. Used by the
 * reply debouncer to tell whether a newer inbound arrived during its wait
 * window (in which case the later invocation owns the reply).
 */
export async function getLatestLeadMessage(
  lead_id: string
): Promise<DbMessage | null> {
  const data = await withRetry<DbMessage[]>("getLatestLeadMessage", () =>
    supabase
      .from("messages")
      .select("*")
      .eq("lead_id", lead_id)
      .eq("role", "lead")
      .order("created_at", { ascending: false })
      .limit(1)
  );
  return data && data.length > 0 ? data[0] : null;
}

export async function saveMessage(params: {
  lead_id: string;
  client_id: string;
  role: "lead" | "ai" | "human";
  content: string;
  channel?: string;
  ghl_message_id?: string;
  model_used?: string;
  input_tokens?: number;
  output_tokens?: number;
  // 'manychat' when saved by the fast ManyChat inbound trigger; omitted/null
  // for the normal GHL-webhook path.
  source?: string;
  // 'voice' when this AI bubble goes out as a voice note; omitted/null = text.
  delivery?: string;
  // TRUE when the caller only reaches saveMessage AFTER a confirmed successful
  // send (follow-ups, nurture drips, the lead magnet). The reply engine stamps
  // delivered_at per bubble in its onSent, but those engines save once, after
  // the fact, and used to leave delivered_at null forever. That null is not
  // cosmetic: resendUndeliveredTail reads "trailing AI bubble, delivered_at
  // null, 1-30 min old" as a guillotined send and RE-SENDS it. Live damage:
  // 7 real people received the same follow-up twice, ~5 min apart.
  delivered?: boolean;
}): Promise<DbMessage | null> {
  // Store the CLEAN text for our own outbound (role 'ai') — the same scrub the
  // send path uses — so internal tokens ([[SPLIT]] etc.) never pollute the brain's
  // memory / history of "what we said to the lead". A lead's own words ('lead') and
  // human notes ('human') are stored verbatim. Fall back to the original if a scrub
  // somehow empties a non-empty message (so we never drop the record).
  const storedContent =
    params.role === "ai"
      ? (scrubOutboundText(params.content).trim() || params.content)
      : params.content;
  const data = await withRetry<DbMessage>("saveMessage", () =>
    supabase
      .from("messages")
      .insert({
        lead_id: params.lead_id,
        client_id: params.client_id,
        role: params.role,
        content: storedContent,
        channel: params.channel ?? "instagram",
        ghl_message_id: params.ghl_message_id ?? null,
        model_used: params.model_used ?? null,
        input_tokens: params.input_tokens ?? null,
        output_tokens: params.output_tokens ?? null,
        source: params.source ?? null,
        delivery: params.delivery ?? null,
        delivered_at: params.delivered ? new Date().toISOString() : null,
      })
      .select("*")
      .single()
  );

  // Best-effort touch of last_message_at; never fail the save over this.
  await supabase
    .from("leads")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", params.lead_id)
    .then(undefined, (err) =>
      console.error("[supabase] last_message_at update failed:", err)
    );

  // ── OUTCOME LEDGER (audit 2026-07-24) ──────────────────────────────────────
  // saveMessage is the single choke point every engine's persistence flows
  // through, so the ledger's bookkeeping lives HERE — no code path can forget:
  //  - every lead message OPENS a row that must reach a terminal state;
  //  - any delivered non-ack ai/human message CLOSES the lead's open (or
  //    escalated) rows as replied — one shared definition of "we replied"
  //    across the reply engine, nurture, magnet, handoff, and human sends.
  // The sweep's monitor closes rows as 'silent' from deliberate-skip events,
  // and escalates anything still open after its grace window. Best-effort:
  // ledger bookkeeping must never fail the save itself.
  try {
    if (params.role === "lead" && data?.id) {
      await supabase.from("inbound_outcomes").insert({
        client_id: params.client_id,
        lead_id: params.lead_id,
        message_id: data.id,
      });
    } else if (
      (params.role === "human" ||
        (params.role === "ai" &&
          // Instant acks are filler, not replies. Time-TRIGGERED sends
          // (nurture drips, follow-up touches) are excluded too (review
          // 2026-07-24, P2): a scheduled drip landing minutes after an
          // inbound the engine never answered must not mark that inbound
          // 'replied' and mask exactly the dropped lead the ledger exists
          // to catch. Reply-engine, magnet, and handoff sends respond to
          // the lead's message; those close it.
          !["instant_ack", "nurture_engine", "followup_engine", "followup_engine_voice"].includes(
            params.model_used ?? ""
          ))) &&
      data?.id
    ) {
      await supabase
        .from("inbound_outcomes")
        .update({ status: "replied", closed_at: new Date().toISOString() })
        .eq("lead_id", params.lead_id)
        .in("status", ["open", "escalated"]);
    }
  } catch (err) {
    console.error("[supabase] outcome ledger bookkeeping failed:", err);
  }

  return data;
}

/**
 * Persist the lead's current funnel stage + accumulated facts. Best-effort:
 * a failure here must never block or break the reply, so we log and move on.
 *
 * Writes the setter's OWN `funnel_stage` column — NOT `stage` (which the Jarvis
 * pipeline watcher owns as the GHL pipeline stage). Keeping these separate is
 * what stops the watcher from wiping the setter's funnel memory on every sync.
 */
export async function updateLeadStage(params: {
  lead_id: string;
  stage: string;
  stage_data: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabase
    .from("leads")
    .update({ funnel_stage: params.stage, stage_data: params.stage_data })
    .eq("id", params.lead_id);
  if (error) console.error("[supabase] updateLeadStage failed:", error);
}

/**
 * Single-flight reply lock (duplicate-reply guard).
 *
 * Each inbound DM spawns its own background webhook invocation, so a lead who
 * fires several messages can have several invocations racing to reply. This
 * lock guarantees only ONE of them generates+sends a reply at a time.
 *
 * Atomic acquire: a single conditional UPDATE that succeeds only if the lock is
 * free OR has gone stale (older than ttlMs). Postgres row-locking serializes
 * concurrent invocations, so exactly one wins. A returned row == lock acquired.
 * The stale-after-ttl clause means a crashed invocation can never deadlock a
 * lead — the lock self-heals after ttlMs (kept > the function's maxDuration).
 */
export async function acquireReplyLock(
  lead_id: string,
  ttlMs: number
): Promise<string | null> {
  const nowIso = new Date().toISOString();
  const staleCutoffIso = new Date(Date.now() - ttlMs).toISOString();
  const { data, error } = await supabase
    .from("leads")
    .update({ reply_lock_at: nowIso })
    .eq("id", lead_id)
    .or(`reply_lock_at.is.null,reply_lock_at.lt.${staleCutoffIso}`)
    .select("id");
  if (error) {
    // Fail-safe: if the lock can't be evaluated, DON'T grant it. A missed reply
    // is recoverable (the lead messages again); a double reply is what we're
    // preventing here.
    console.error("[supabase] acquireReplyLock failed:", error);
    return null;
  }
  // The winner gets its own lock STAMP back so its release can be conditional
  // (see releaseReplyLock): if this lock is ever reclaimed out from under a
  // long-sending invocation and re-taken by another, the original's finally
  // must not free the NEW owner's lock.
  return (data?.length ?? 0) > 0 ? nowIso : null;
}

/**
 * Release the reply lock so the next inbound for this lead can reply. When a
 * stamp is passed (the value acquireReplyLock returned), the release is a
 * compare-and-swap: it only frees the lock if it still carries THAT stamp, so
 * an invocation whose lock was legitimately reclaimed and re-taken by another
 * can never free the new owner's lock. No stamp = unconditional (legacy).
 */
export async function releaseReplyLock(lead_id: string, stamp?: string): Promise<void> {
  let q = supabase
    .from("leads")
    .update({ reply_lock_at: null })
    .eq("id", lead_id);
  if (stamp) q = q.eq("reply_lock_at", stamp);
  await q.then(undefined, (err) =>
    console.error("[supabase] releaseReplyLock failed:", err)
  );
}

/**
 * Single-flight lock for the INSTANT ACK send — a byte-level mirror of
 * acquireReplyLock/releaseReplyLock above, but on the separate ack_lock_at
 * column so it can never collide with the considered-reply lock.
 *
 * Needed because the fast ManyChat inbound trigger can fire two invocations
 * for messages sent <2s apart; both would pass the "did we already ack"
 * history check in maybeSendInstantAck before either has saved its ack row —
 * only an atomic conditional UPDATE closes that race.
 */
export async function acquireAckLock(
  lead_id: string,
  ttlMs: number
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const staleCutoffIso = new Date(Date.now() - ttlMs).toISOString();
  const { data, error } = await supabase
    .from("leads")
    .update({ ack_lock_at: nowIso })
    .eq("id", lead_id)
    .or(`ack_lock_at.is.null,ack_lock_at.lt.${staleCutoffIso}`)
    .select("id");
  if (error) {
    // Fail-safe: a missed ack is fine (the considered reply still lands); a
    // double ack is what we're preventing, so on doubt we do NOT grant it.
    console.error("[supabase] acquireAckLock failed:", error);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/** Release the ack lock so the lead's NEXT message can get its own ack. */
export async function releaseAckLock(lead_id: string): Promise<void> {
  await supabase
    .from("leads")
    .update({ ack_lock_at: null })
    .eq("id", lead_id)
    .then(undefined, (err) =>
      console.error("[supabase] releaseAckLock failed:", err)
    );
}

/**
 * Persist the lead's locked conversation language (see lib/language.ts).
 * Best-effort: a failure here must never block or break the reply, so we log
 * and move on — the language just won't stick until the next successful write.
 */
export async function updateLeadLanguage(
  lead_id: string,
  language: string
): Promise<void> {
  const { error } = await supabase
    .from("leads")
    .update({ conversation_language: language })
    .eq("id", lead_id);
  if (error) console.error("[supabase] updateLeadLanguage failed:", error);
}

/**
 * Cache the lead's resolved ManyChat subscriber id so we don't re-look it up by
 * name on every voice reply. Best-effort: a failure just means we resolve again
 * next time, so it must never block or break the reply.
 */
export async function setLeadManychatSubscriberId(
  lead_id: string,
  subscriber_id: string
): Promise<void> {
  if (!subscriber_id) return;
  await supabase
    .from("leads")
    .update({ manychat_subscriber_id: subscriber_id })
    .eq("id", lead_id)
    .then(undefined, (err) =>
      console.error("[supabase] setLeadManychatSubscriberId failed:", err)
    );
}

/**
 * Permanently DELETE a lead and ALL of its child rows from the database.
 *
 * Used to erase unsolicited service-pitch spammers caught at first contact:
 * The owner wants them to "not exist", so we remove the messages, AI decisions,
 * and the lead row itself (child rows first to satisfy FK constraints even if
 * no ON DELETE CASCADE is configured). Best-effort — each delete is logged on
 * failure but never throws, so a partial DB hiccup can't crash the background
 * webhook task. Returns true only if the lead row itself was removed.
 *
 * We also delete the lead's existing `events` rows — they carry a FK to
 * leads.id, so leaving them would block the lead delete on a RESTRICT
 * constraint. The caller writes ONE fresh audit event AFTER the purge (with
 * lead_id = null) recording it, so there is a minimal forensic trail if a real
 * lead is ever wrongly erased — without that the deletion would be silent.
 */
export async function purgeLead(lead_id: string): Promise<boolean> {
  // Children first (messages, ai_decisions, events, ledger), then the lead row.
  // inbound_outcomes must go too: an orphaned open ledger row for a purged
  // spammer would otherwise escalate as a "silent lead" to the owner forever.
  const childTables = ["messages", "ai_decisions", "events", "inbound_outcomes"] as const;
  for (const table of childTables) {
    const { error } = await supabase.from(table).delete().eq("lead_id", lead_id);
    if (error) {
      console.error(`[supabase] purgeLead: delete from ${table} failed:`, error);
    }
  }

  const { error } = await supabase.from("leads").delete().eq("id", lead_id);
  if (error) {
    console.error("[supabase] purgeLead: delete lead failed:", error);
    return false;
  }
  return true;
}

export async function logEvent(params: {
  client_id: string;
  lead_id?: string;
  event_type: string;
  metadata?: Record<string, unknown>;
}) {
  await supabase.from("events").insert({
    client_id: params.client_id,
    lead_id: params.lead_id ?? null,
    event_type: params.event_type,
    metadata: params.metadata ?? {},
  });
}

/**
 * Has an event of this type already been logged for this lead?
 *
 * Used by the ongoing tagging pass to stay idempotent: we only add the
 * `qualified` tag (and log `tag_qualified`) the FIRST time a lead qualifies,
 * not on every subsequent inbound message. Best-effort: on a query error we
 * return false so the caller can proceed (adding a GHL tag is itself
 * idempotent — re-adding an existing tag is harmless).
 */
export async function eventExists(
  lead_id: string,
  event_type: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("events")
    .select("id")
    .eq("lead_id", lead_id)
    .eq("event_type", event_type)
    .limit(1);

  if (error) {
    console.error("[supabase] eventExists failed:", error);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/**
 * Count AI messages sent to one lead since the given ISO timestamp. Used by
 * the outbound circuit breaker (anti-marathon guard). Returns null on a query
 * error — never 0 — so the caller can tell "no sends" apart from "couldn't
 * check" and choose to fail open.
 */
export async function countAiMessagesSince(
  lead_id: string,
  since_iso: string
): Promise<number | null> {
  const { count, error } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", lead_id)
    .eq("role", "ai")
    .gte("created_at", since_iso);
  if (error) {
    console.error("[supabase] countAiMessagesSince failed:", error);
    return null;
  }
  return count ?? 0;
}

/** Count AI messages sent across a whole client since the given ISO timestamp. */
export async function countClientAiMessagesSince(
  client_id: string,
  since_iso: string
): Promise<number | null> {
  const { count, error } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("client_id", client_id)
    .eq("role", "ai")
    .gte("created_at", since_iso);
  if (error) {
    console.error("[supabase] countClientAiMessagesSince failed:", error);
    return null;
  }
  return count ?? 0;
}

/**
 * Has an event of this type been logged since the given time? Scoped to the
 * lead when lead_id is passed, otherwise to the whole client. Lets the rate
 * limiter ping the owner ONCE per episode instead of on every held reply.
 */
export async function recentEventExists(params: {
  client_id: string;
  lead_id?: string;
  event_type: string;
  since_iso: string;
}): Promise<boolean> {
  let q = supabase
    .from("events")
    .select("id")
    .eq("client_id", params.client_id)
    .eq("event_type", params.event_type)
    .gte("created_at", params.since_iso)
    .limit(1);
  if (params.lead_id) q = q.eq("lead_id", params.lead_id);
  const { data, error } = await q;
  if (error) {
    console.error("[supabase] recentEventExists failed:", error);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/**
 * Look up a lead by GHL contact id WITHOUT creating one. Used by the outbound
 * (human-message) path, which must never create a lead.
 */
export async function getLeadByContact(
  client_id: string,
  ghl_contact_id: string
): Promise<Lead | null> {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("client_id", client_id)
    .eq("ghl_contact_id", ghl_contact_id)
    .maybeSingle();
  if (error) {
    console.error("[supabase] getLeadByContact failed:", error);
    return null;
  }
  return (data as Lead) ?? null;
}

/** True if we already stored a message with this GHL message id (echo dedupe). */
export async function messageExistsByGhlId(ghl_message_id: string): Promise<boolean> {
  if (!ghl_message_id) return false;
  const { data, error } = await supabase
    .from("messages")
    .select("id")
    .eq("ghl_message_id", ghl_message_id)
    .limit(1);
  if (error) {
    console.error("[supabase] messageExistsByGhlId failed:", error);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/** Stamp the GHL message id onto a saved message row (links AI sends to echoes). */
export async function setMessageGhlId(message_id: string, ghl_message_id: string): Promise<void> {
  if (!ghl_message_id) return;
  await supabase
    .from("messages")
    .update({ ghl_message_id })
    .eq("id", message_id)
    .then(undefined, (err) =>
      console.error("[supabase] setMessageGhlId failed:", err)
    );
}

/**
 * Stamp the moment a saved AI bubble actually finished sending to the lead
 * (delivered_at). The row's created_at is the SAVE time, which precedes the
 * paced sends by up to ~30s on a multi-bubble reply; the crossed-messages
 * check in the reply engine needs the real delivery moment to judge whether
 * the lead could have read a bubble before writing their next message.
 * Best-effort: a failed stamp only makes that check more conservative.
 */
/**
 * Stamp that a bubble's transport call is about to fire. First stamp wins.
 * See DbMessage.send_attempted_at for why this exists (the mid-flight kill).
 */
export async function markMessageAttempted(message_id: string): Promise<void> {
  await supabase
    .from("messages")
    .update({ send_attempted_at: new Date().toISOString() })
    .eq("id", message_id)
    .is("send_attempted_at", null)
    .then(undefined, (err) =>
      console.error("[supabase] markMessageAttempted failed:", err)
    );
}

/**
 * The attempt RESOLVED as a known failure (ManyChat answered and said no), so
 * the ambiguity the attempt stamp exists for is gone: the bubble is genuinely
 * undelivered and safe for the exact-words resend. Clearing the stamp is what
 * keeps the self-heal alive for real failures while the mid-flight-kill case
 * stays protected from double-sends.
 */
export async function clearMessageAttempt(message_id: string): Promise<void> {
  await supabase
    .from("messages")
    .update({ send_attempted_at: null })
    .eq("id", message_id)
    .is("delivered_at", null)
    .then(undefined, (err) =>
      console.error("[supabase] clearMessageAttempt failed:", err)
    );
}

export async function markMessageDelivered(message_id: string): Promise<void> {
  await supabase
    .from("messages")
    .update({ delivered_at: new Date().toISOString() })
    .eq("id", message_id)
    // FIRST STAMP WINS (fix 2026-07-25). The send path stamps each bubble the
    // instant it lands (onSent), then a redundant sweep re-stamps every
    // delivered row AFTER the whole sequence finishes. Without this guard that
    // sweep overwrote bubble 1's true delivery time (say T+5s) with the
    // sweep's own clock (T+20s), so every bubble in a volley ended up looking
    // like it landed at the same late moment. That corrupted both the
    // crossed-messages check and any reply-speed measurement built on
    // delivered_at.
    .is("delivered_at", null)
    .then(undefined, (err) =>
      console.error("[supabase] markMessageDelivered failed:", err)
    );
}

// How long a ManyChat-saved lead message stays "claimable" by the GHL copy of
// the same inbound before we give up and let the GHL webhook insert its own
// row. GHL's own delivery lag is p50 ~10s / p90 ~11s (measured), so 3 minutes
// is generous headroom without letting a claim match something unrelated.
const MANYCHAT_ECHO_WINDOW_MS = 180_000;

/** Normalize a message for echo-matching between the ManyChat and GHL copies
 *  of the SAME inbound. Falls back to a raw trim when normalization empties
 *  the string (e.g. an emoji-only message), so distinct emoji messages never
 *  collide on an empty key. */
export function echoKey(t: string): string {
  return normalizeForCompare(t || "") || (t || "").trim();
}

/**
 * Claim the OLDEST unclaimed ManyChat-saved message for this lead that
 * matches `content` (by echoKey) within the echo window — used by the GHL
 * webhook so it never inserts a second row for a message ManyChat already
 * saved a few seconds earlier. Claiming means atomically stamping
 * ghl_message_id onto that row, which makes it unclaimable again — so this is
 * a one-to-one, FIFO match: a lead who legitimately sends the same text twice
 * still produces two distinct rows (the 2nd GHL copy claims the 2nd ManyChat
 * row, not the 1st again).
 *
 * Returns the claimed row (so the caller can reuse its id as inboundMessageId)
 * or null when there's nothing to claim (ManyChat never saved it, the window
 * passed, or a concurrent claimer already won it) — in which case the caller
 * should insert normally, exactly as before this feature existed.
 */
export async function claimManychatLeadEcho(params: {
  lead_id: string;
  content: string;
  ghl_message_id?: string;
}): Promise<DbMessage | null> {
  const sinceIso = new Date(Date.now() - MANYCHAT_ECHO_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("lead_id", params.lead_id)
    .eq("role", "lead")
    .eq("source", "manychat")
    .is("ghl_message_id", null)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true })
    .limit(10);
  if (error || !data?.length) return null;

  const key = echoKey(params.content);
  for (const row of data as DbMessage[]) {
    if (echoKey(row.content) !== key) continue;
    const stamp = params.ghl_message_id || `mc-claimed-${row.id}`;
    // Atomic: the .is("ghl_message_id", null) guard means a concurrent
    // claimer racing on the same row loses and this update affects 0 rows.
    const upd = await supabase
      .from("messages")
      .update({ ghl_message_id: stamp })
      .eq("id", row.id)
      .is("ghl_message_id", null)
      .select("id");
    if (!upd.error && upd.data?.length) return row;
  }
  return null;
}

/**
 * Phase 1 — persist a lead's first-touch source. Writes only the fields we
 * actually derived, and ONLY when src_channel isn't already set (first touch
 * wins; never overwritten by later messages). Best-effort.
 */
export async function captureLeadSource(
  lead: Lead,
  src: {
    src_channel: string | null;
    src_placement: string | null;
    src_campaign: string | null;
    src_content: string | null;
    opted_in: boolean;
  },
  attributionRaw?: Record<string, unknown> | null
): Promise<void> {
  // First touch wins: if we already captured a channel, don't clobber it.
  if ((lead as unknown as { src_channel?: string | null }).src_channel) {
    // Still allow flipping opted_in true if a later opt-in form arrives.
    if (src.opted_in && !(lead as unknown as { opted_in?: boolean }).opted_in) {
      await supabase.from("leads").update({ opted_in: true }).eq("id", lead.id)
        .then(undefined, (e) => console.error("[supabase] opted_in update failed:", e));
    }
    return;
  }

  const update: Record<string, unknown> = {};
  if (src.src_channel) update.src_channel = src.src_channel;
  if (src.src_placement) update.src_placement = src.src_placement;
  if (src.src_campaign) update.src_campaign = src.src_campaign;
  if (src.src_content) update.src_content = src.src_content;
  if (src.opted_in) update.opted_in = true;
  if (attributionRaw) update.attribution_raw = attributionRaw;
  if (Object.keys(update).length === 0) return;

  await supabase.from("leads").update(update).eq("id", lead.id)
    .then(undefined, (e) => console.error("[supabase] captureLeadSource failed:", e));
}

/**
 * Phase 3 — set booking_method (idempotent-ish). Never overwrites an existing
 * 'dialing' (the bot owns that) and never re-writes once set.
 */
export async function setBookingMethod(lead_id: string, method: string): Promise<void> {
  const { data } = await supabase
    .from("leads")
    .select("booking_method")
    .eq("id", lead_id)
    .maybeSingle();
  const existing = (data as { booking_method?: string | null } | null)?.booking_method ?? null;
  if (existing === "dialing") return; // never overwrite a dial booking
  if (existing) return; // already set
  await supabase.from("leads").update({ booking_method: method }).eq("id", lead_id)
    .then(undefined, (e) => console.error("[supabase] setBookingMethod failed:", e));
}

/**
 * Phase 6 — record why a lead was disqualified ('financial' | 'no_intent' |
 * 'friend_family'). First write wins; never overwritten.
 */
export async function setDisqualifyReason(lead_id: string, reason: string): Promise<void> {
  const { data } = await supabase
    .from("leads")
    .select("disqualify_reason")
    .eq("id", lead_id)
    .maybeSingle();
  if ((data as { disqualify_reason?: string | null } | null)?.disqualify_reason) return;
  await supabase.from("leads").update({ disqualify_reason: reason }).eq("id", lead_id)
    .then(undefined, (e) => console.error("[supabase] setDisqualifyReason failed:", e));
}

export async function logAIDecision(params: {
  lead_id: string;
  client_id: string;
  message_id?: string;
  system_prompt_used: string;
  conversation_context: unknown;
  raw_response: string;
  final_reply?: string;
  duration_ms?: number;
  error?: string;
}) {
  await supabase.from("ai_decisions").insert({
    lead_id: params.lead_id,
    client_id: params.client_id,
    message_id: params.message_id ?? null,
    system_prompt_used: params.system_prompt_used,
    conversation_context: params.conversation_context,
    raw_response: params.raw_response,
    final_reply: params.final_reply ?? null,
    duration_ms: params.duration_ms ?? null,
    error: params.error ?? null,
  });
}
