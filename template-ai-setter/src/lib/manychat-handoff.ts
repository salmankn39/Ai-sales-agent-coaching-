/**
 * ============================================================================
 * MANYCHAT ↔ AI SETTER — lead resolution for the fast inbound trigger
 * ============================================================================
 * ManyChat sees a DM in ~1s (long before GHL mints a contact), so the fast
 * inbound trigger (/api/manychat/inbound) starts a lead's life here. This
 * module resolves — or, for a brand-new Instagram person, CREATES — the lead
 * for that path, unifying on ManyChat identity (subscriber id / @handle / name)
 * so no duplicate is ever forked and sends switch to GHL automatically once the
 * GHL webhook attaches a contact.
 *
 * NOTE (2026-07-24): the old "Say hi to new followers" funnel handoff
 * (start/end signals, standdown gate, proactive opener) was removed — the
 * owner dropped that ManyChat funnel and its state table never carried a single
 * row. HANDOFF_OPENER survives only as the lead-magnet flow's post-book opener.
 * ============================================================================
 */
import { supabase, logEvent, findLeadByIdentity, type Lead } from "./supabase";
import { searchContactByName, searchContactByIgHandle } from "./ghl";

// The proactive first touch used by the lead-magnet flow after the free book
// link is sent (see lib/lead-magnet.ts): no re-introduction, straight to the
// operator's first qualification step. NO EMOJIS — operator rule (2026-07-09).
export const HANDOFF_OPENER = "yo bro, so tell me a bit about yourself, where you based?";

/**
 * Resolve an EXISTING lead for the fast ManyChat inbound trigger (true-instant
 * ack). Strict on purpose — a wrong match here would save a MESSAGE and fire an
 * ACK on the wrong person's thread. So:
 *
 *   1) subscriber_id EXACT match on leads.manychat_subscriber_id, if we have
 *      one cached for a lead (most reliable — a ManyChat id is unique).
 *   2) else the IG @handle (two-pattern match, with/without a leading '@').
 *   3) NEVER a display-name fallback — two different leads can share a full
 *      name ("John Smith"), and a bad match here corrupts a real thread.
 *
 * NEVER creates a lead: a lead ManyChat reaches who isn't in our DB yet gets
 * created + screened by the normal GHL path on their first real inbound.
 */
export async function getLeadForManychatInbound(
  clientId: string,
  subscriberId: string | null,
  igUsername: string | null
): Promise<Lead | null> {
  if (subscriberId) {
    const { data, error } = await supabase
      .from("leads")
      .select("*")
      .eq("client_id", clientId)
      .eq("manychat_subscriber_id", subscriberId)
      .order("last_message_at", { ascending: false })
      .limit(1);
    if (!error && data && data.length) return data[0] as Lead;
  }

  const handle = (igUsername || "").replace(/^@/, "").trim().toLowerCase();
  // PostgREST .or() is comma-separated; a value containing one of these chars
  // would break the filter, so we simply skip the handle lookup rather than
  // risk a malformed query (same guard pattern as lib/bans.ts `safe()`).
  if (!handle || handle.includes(",") || handle.includes("(") || handle.includes(")")) {
    return null;
  }
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("client_id", clientId)
    .or(`ig_username.ilike.${handle},ig_username.ilike.@${handle}`)
    .order("last_message_at", { ascending: false })
    .limit(1);
  if (!error && data && data.length) return data[0] as Lead;
  return null;
}

/**
 * MANYCHAT-FIRST lead resolution: find the lead by ManyChat identity, or
 * CREATE one when this Instagram person has never been seen before. ManyChat
 * sees a DM in ~1s — long before GHL mints a contact — so the freshest leads
 * (story-CTA repliers!) start life here with ghl_contact_id = null. The
 * identity layer (findLeadByIdentity: igSid → contact → @handle → name)
 * attaches the GHL contact to THIS SAME lead the moment GHL's webhook shows
 * up, so no duplicate is ever created and sends switch to GHL automatically.
 */
export async function resolveOrCreateManychatLead(
  client: { id: string; ghl_api_key?: string | null; ghl_location_id?: string | null },
  subscriberId: string | null,
  igUsername: string | null,
  fullName: string | null
): Promise<Lead | null> {
  const clientId = client.id;
  const existing = await getLeadForManychatInbound(clientId, subscriberId, igUsername);
  if (existing) return existing;

  // NAME ADOPTION before creating: this person may already exist as a GHL-side
  // lead that carries NEITHER a subscriber id NOR a handle (created before
  // ManyChat-first, or by the GHL webhook — whose payload has no @handle).
  // Without this, their next ManyChat message minted a contactless TWIN and the
  // engine worked a dead-end thread it couldn't even send on, alarming the
  // owner every sweep (live: LD Williams + Love Ohlquist, overnight 2026-07-10).
  // Name matching is deliberately a LAST resort and narrow: exact
  // case-insensitive full name, active in the last 14 days, prefer the lead
  // that can actually be replied to (has a GHL contact). A same-name-different-
  // person mismatch in that window is far rarer than the twin fork is certain.
  // Adopting stamps the ManyChat ids on, so every later message matches by
  // subscriber id directly and this path never runs again for them.
  if (fullName && fullName.trim()) {
    const since = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
    const { data: byName } = await supabase
      .from("leads")
      .select("*")
      .eq("client_id", clientId)
      .ilike("full_name", fullName.trim())
      .gte("last_message_at", since)
      .order("last_message_at", { ascending: false });
    let rows = (byName ?? []) as Lead[];

    // NEVER adopt a row with no conversation (2026-07-31). The GHL pipeline
    // watcher keeps zero-message TRACKER rows for opportunities (form opt-ins,
    // second GHL contacts of one person). Their last_message_at is just their
    // creation time, so they slip inside the 14-day window and — carrying a
    // ghl_contact_id — used to WIN this adopt. Two live failure modes:
    //   - a brand-new "John" DMs, adopts a paused tracker, and the AI goes
    //     silent on a real lead with no ping to the owner;
    //   - a person the owner PAUSED DMs again, adopts an unpaused tracker,
    //     and the AI re-engages someone who was explicitly turned off — the
    //     exact incident class (Oliver/Asyah/Oskar) this week was spent
    //     killing.
    // A same-name row that has never exchanged a message is not "them" for
    // conversation purposes. If no candidate has real history, mint a fresh
    // row; the watcher's own name-adopt bridges the CRM side separately.
    if (rows.length) {
      const { data: talked } = await supabase
        .from("messages")
        .select("lead_id")
        .in("lead_id", rows.map((r) => r.id))
        .limit(1000);
      const talkedIds = new Set((talked ?? []).map((m) => (m as { lead_id: string }).lead_id));
      rows = rows.filter((r) => talkedIds.has(r.id));
    }
    const adopted = rows.find((l) => l.ghl_contact_id) ?? rows[0];
    if (adopted) {
      const upd: Record<string, unknown> = {};
      if (subscriberId && !adopted.manychat_subscriber_id) upd.manychat_subscriber_id = subscriberId;
      if (igUsername && !adopted.ig_username) upd.ig_username = igUsername.replace(/^@/, "");
      if (Object.keys(upd).length) {
        await supabase.from("leads").update(upd).eq("id", adopted.id)
          .then(undefined, (e) => console.error("[manychat-handoff] adopt stamp failed:", e));
        Object.assign(adopted, upd);
      }
      await logEvent({
        client_id: clientId,
        lead_id: adopted.id,
        event_type: "duplicate_contact_absorbed",
        metadata: { via: "manychat_name_adopt", full_name: fullName.trim(), subscriber_id: subscriberId },
      });
      return adopted;
    }
  }

  // A person ManyChat can identify but we can't must have SOME identity to
  // unify on later — require at least a subscriber id or a handle.
  if (!subscriberId && !igUsername) return null;

  // ASK GHL BEFORE MINTING (the once-and-for-all duplicate killer): GHL may
  // already KNOW this person even though our leads table doesn't — a contact
  // whose workflow never webhooks us (e.g. tagged "ai off" months ago, so the
  // owner's own automation deliberately ENDs before the webhook — live: joana,
  // opted out since May, nearly re-engaged through this path 2026-07-10).
  // Attaching GHL's contact at creation means (a) no twin can ever exist and
  // (b) the contact's live tags — including the "ai off" opt-out — stand in
  // front of every gate from the very first message. Best-effort: on any GHL
  // hiccup the lead is simply created contactless, exactly as before.
  //
  // BY NAME **OR BY HANDLE** (audit 2026-08-14). This block was gated on
  // fullName, and a ManyChat-first lead has none - so for the system's most
  // common lead the whole duplicate-killer was skipped and the row was minted
  // contactless, which is precisely how a person ends up with an empty CRM
  // card. GHL's Instagram integration names the contact with the HANDLE, so
  // the handle is the key that actually matches here. Both lookups demand an
  // EXACT contactName match, so neither can attach a stranger.
  let ghlContactId: string | null = null;
  const handleForSearch = (igUsername || "").trim().replace(/^@/, "");
  if (client.ghl_api_key && client.ghl_location_id && (fullName?.trim() || handleForSearch)) {
    const found =
      (fullName?.trim()
        ? await searchContactByName(client.ghl_api_key, client.ghl_location_id, fullName)
        : null) ||
      (handleForSearch
        ? await searchContactByIgHandle(client.ghl_api_key, client.ghl_location_id, handleForSearch)
        : null);
    if (found) {
      ghlContactId = found.id;
      // The contact may already be attached to a lead our name-scan above
      // missed (renamed, >14 days idle) — the identity layer owns that case.
      const adopted = await findLeadByIdentity({
        client_id: clientId,
        ghl_contact_id: found.id,
        ig_username: igUsername,
        full_name: fullName,
      });
      if (adopted) {
        const upd: Record<string, unknown> = {};
        if (subscriberId && !adopted.manychat_subscriber_id) upd.manychat_subscriber_id = subscriberId;
        if (igUsername && !adopted.ig_username) upd.ig_username = igUsername.replace(/^@/, "");
        if (Object.keys(upd).length) {
          await supabase.from("leads").update(upd).eq("id", adopted.id)
            .then(undefined, (e) => console.error("[manychat-handoff] ghl-adopt stamp failed:", e));
          Object.assign(adopted, upd);
        }
        return adopted;
      }
    }
  }

  // NOTE (2026-07-26): we deliberately do NOT create the GHL contact here.
  // GoHighLevel's own Instagram integration has created a contact automatically
  // for years, the moment someone replies — that is native to GHL and entirely
  // independent of the setter or of the retired inbound webhook. Creating one
  // ourselves would just mint a DUPLICATE contact, which is the exact class of
  // mess this whole change exists to end.
  //
  // What DOES need creating is the opportunity: the card in the AI Sales
  // Pipeline. See ensurePipelineCard() in lib/pipeline-sync.ts, called after
  // the reply is on its way so the CRM can never delay a message.
  const { data, error } = await supabase
    .from("leads")
    .insert({
      client_id: clientId,
      ghl_contact_id: ghlContactId,
      manychat_subscriber_id: subscriberId,
      ig_username: igUsername ? igUsername.replace(/^@/, "") : null,
      full_name: fullName || null,
      status: "new",
      // First touch is known by construction: the first time we ever see this
      // person is an Instagram DM. Stamping it here (the retired GHL webhook
      // used to) keeps the dashboard's source/funnel split honest; the
      // pipeline watcher never overwrites an existing src_channel.
      src_channel: "instagram",
      src_placement: "dm",
    })
    .select("*")
    .single();
  if (error) {
    // LOST THE RACE, NOT FAILED (2026-08-09). Everything above is read-then-
    // insert, and two invocations of the ManyChat webhook can be inside that gap
    // at the same moment — which is how one person became two lead rows, two
    // AIs, and a pause that only covered half of them. A unique index on
    // (client_id, manychat_subscriber_id) now settles it in the one place that
    // can: whoever gets there second is told 23505, and the right answer is to
    // pick up the row the winner just wrote, not to give up on the message.
    if (String((error as { code?: string }).code) === "23505" && subscriberId) {
      const winner = await getLeadForManychatInbound(clientId, subscriberId, igUsername);
      if (winner) return winner;
    }
    console.error("[manychat-handoff] lead create failed:", error.message);
    return null;
  }
  return data as Lead;
}
