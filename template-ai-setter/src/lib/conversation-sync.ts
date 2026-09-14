/**
 * CONVERSATION SYNC — pull the REAL two-sided Instagram thread out of GHL and
 * land it in our own messages table, with the operator's own hand-typed
 * replies stored as role='human'.
 *
 * WHY THIS FILE EXISTS (incident 2026-08-08)
 * ------------------------------------------
 * Nothing had ever recorded a message the operator typed by hand in the
 * Instagram app. role='human' had zero rows, ever: the only writers were HQ
 * chat and Jarvis, both of which require him to compose INSIDE our tooling.
 * So a lead he was personally mid-conversation with looked, to us, like
 * someone who had sent exactly one message and never been answered. The
 * screener read that as "brand new lead", took its ENGAGE branch, and never
 * ran the skip_friend / skip_owner classifier that lives only in the
 * has-prior-history branch. His friends got cold-opened with "tell me a bit
 * about yourself" in the middle of a real conversation.
 *
 * GHL holds the complete thread. This module reads it and reconstructs the
 * missing half so every downstream reader (screener, reply engine, sweep) is
 * finally looking at what actually happened.
 *
 * Everything here is BEST-EFFORT and NON-THROWING. A sync failure returns a
 * skipped reason; it must never be able to break a reply.
 */

import {
  supabase,
  saveMessage,
  messageExistsByGhlId,
  echoKey,
  logEvent,
  type Client,
  type Lead,
} from "./supabase";
import {
  fetchContactThread,
  getContactDetail,
  searchContactByName,
  searchContactByIgHandle,
  type ThreadMessage,
} from "./ghl";
import { INSTANT_ACK_TAG } from "./instant-ack";
import { stampVerifiedFromThread } from "./delivery-verify";

/** Cap on how much of the thread one call will import. Kept small enough to
 *  finish comfortably inside a 60s serverless budget alongside everything else
 *  a reply invocation does. */
const DEFAULT_MAX_MESSAGES = 60;

/** Two messages with the same normalised text this close together are the same
 *  physical message surfaced twice (mirrors the ManyChat/GHL echo window used
 *  elsewhere). Used only for rows that carry no GHL id to match on. */
const DUPE_WINDOW_MS = 120_000;

/** A media message has no text, so it cannot be matched by content. If one of
 *  OUR ai rows exists within this window of an outbound media message, we treat
 *  the media as ours (our own voice notes go out through ManyChat and come back
 *  in the GHL thread as bodyless audio). With no ai activity anywhere near it,
 *  an outbound voice note is the operator talking - which is exactly the
 *  incident signature, so that case must resolve to 'human'. */
const MEDIA_OWNERSHIP_WINDOW_MS = 10 * 60_000;

/** How many of our own rows to load for dedupe/authorship matching. */
const OUR_HISTORY_LIMIT = 400;

/** How many sibling lead rows of one human we will consider. GHL spawns a
 *  handful of contact ids per Instagram person, never dozens. */
const PERSON_LEAD_LIMIT = 25;

export type ConversationSyncResult = {
  imported: number;
  humanMessages: number;
  totalThread: number;
  skipped?: string;
};

type OurRow = {
  id: string;
  content: string;
  created_at: string;
  ghl_message_id: string | null;
};

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function msOf(iso: string): number {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

type ContactCandidate = {
  id: string;
  /** true  = this contact is provably this lead's (already attached, or GHL's
   *          own record of it carries the same Instagram identity we hold).
   *  false = a bare name match. Nothing may be written, and the id must not be
   *          persisted, until the thread itself corroborates it. */
  corroborated: boolean;
};

/**
 * Is this name specific enough to be worth testing at all?
 *
 * A mononym or an initial ("Mo", "J") matches a large slice of any inbox, so
 * it never even reaches the corroboration stage below.
 */
function isDistinctiveName(name: string): boolean {
  const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");
  const parts = name.split(/\s+/).filter((p) => letters(p).length >= 2);
  return parts.length >= 2 && letters(name).length >= 6;
}

/**
 * Find the GHL contact this lead corresponds to.
 *
 * ManyChat-first leads are created with ghl_contact_id = NULL, and a NULL
 * contact id is precisely what made the screener skip the GHL thread fetch in
 * the incident. We never INVENT a contact.
 *
 * WHY THE GUARD (adversarial review, 2026-08-09): this used to persist a bare
 * exact-name hit straight onto leads.ghl_contact_id. An exact name is not an
 * identity. Any stranger in GHL called the same thing as a lead would have had
 * their entire private thread imported into this lead, their contact tagged,
 * and - because the screener's purge branch DELETES the contact it is pointed
 * at - potentially deleted outright. One wrong attach costs far more than a
 * hundred skipped syncs, so a name alone now buys nothing: either GHL's own
 * contact record agrees with what we know about this person, or the caller has
 * to corroborate the candidate against the thread before a single row moves.
 */
async function resolveContactCandidate(
  apiKey: string,
  locationId: string,
  lead: Lead
): Promise<ContactCandidate | null> {
  if (lead.ghl_contact_id) return { id: lead.ghl_contact_id, corroborated: true };

  // THE HANDLE IS AN IDENTITY, AND IT IS THE ONE GHL ACTUALLY STORES (live
  // audit 2026-08-14). GHL's Instagram integration names the contact with the
  // handle, and ManyChat-first leads carry no full_name - so a name-only
  // lookup found nothing for 9 of 9 active leads and left every one of them
  // with no readable thread at all. An exact handle match is CORROBORATED on
  // the spot: Instagram handles are globally unique, so unlike a shared human
  // name it cannot be a same-name stranger.
  //
  // AND WHEN WE KNOW THE PERMANENT ID, THE HANDLE MATCH IS CONFIRMED BY IT
  // (2026-08-14). ManyChat's ig_id and GHL's attributionSource.igSid are the
  // same Instagram number, proven byte-identical across 10 live contacts. A
  // handle can be renamed and re-registered by a stranger; the id cannot. So
  // when both sides carry one, the id is the verdict in BOTH directions: a
  // match is certainty, a mismatch means this contact is somebody else and is
  // dropped rather than attached.
  const handle = (lead.ig_username || "").trim().replace(/^@/, "");
  if (handle) {
    const byHandle = await searchContactByIgHandle(apiKey, locationId, handle);
    if (byHandle?.id) {
      if (lead.ig_sender_id) {
        const detail = await getContactDetail(apiKey, byHandle.id);
        // Only a real disagreement rejects. A contact with no igSid on it
        // (older records) still attaches on the exact handle, which is the
        // behaviour that fixed the empty-CRM-card incident.
        if (detail?.igSenderId && detail.igSenderId !== lead.ig_sender_id) return null;
      }
      return { id: byHandle.id, corroborated: true };
    }
  }

  const name = (lead.full_name || "").trim();
  if (!name) return null;

  const hit = await searchContactByName(apiKey, locationId, name);
  if (!hit?.id) return null;

  // igSid is the one durable id for an Instagram human (see findLeadByIdentity):
  // when both sides carry one it settles the question in BOTH directions - a
  // match attaches, a mismatch is the same-name stranger and is dropped here.
  const detail = await getContactDetail(apiKey, hit.id);
  if (lead.ig_sender_id && detail?.igSenderId) {
    return detail.igSenderId === lead.ig_sender_id ? { id: hit.id, corroborated: true } : null;
  }

  if (!isDistinctiveName(name)) return null;
  return { id: hit.id, corroborated: false };
}

/**
 * GHL's messageType strings look like "TYPE_INSTAGRAM". A thread that is
 * explicitly some OTHER channel belongs to a namesake we reached by SMS or
 * email, not to the Instagram person we are syncing. A thread GHL gave no
 * types for is merely unknown, so it still has to pass the recency test.
 */
function threadLooksInstagram(thread: ThreadMessage[]): boolean {
  let typed = false;
  for (const m of thread) {
    if (!m.message_type) continue;
    typed = true;
    if (/instagram/i.test(m.message_type)) return true;
  }
  return !typed;
}

/** The normalised text of every message THIS LEAD has sent us. null on a read
 *  failure, which must fail the match rather than pass it by default. */
async function ourInboundKeys(lead: Lead): Promise<Set<string> | null> {
  const { data, error } = await supabase
    .from("messages")
    .select("content")
    .eq("lead_id", lead.id)
    .eq("role", "lead")
    .order("created_at", { ascending: false })
    .limit(OUR_HISTORY_LIMIT);
  if (error) {
    console.error("[conversation-sync] lead history read failed:", error.message);
    return null;
  }
  const keys = new Set<string>();
  for (const r of (data ?? []) as Array<{ content: string }>) {
    const key = echoKey(r.content);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Second gate for a name-only candidate: is this GHL thread demonstrably the
 * same conversation we already hold rows for?
 *
 * WHY CONTENT, NOT TIMING (adversarial review, 2026-08-09): this used to
 * require GHL's newest inbound to sit within half an hour of ours. On the live
 * path our messages table ALREADY holds the bubble that just arrived over
 * ManyChat, while GHL lags 10-105s behind it and sometimes drops bubbles
 * outright. So for a ManyChat-first friend whose previous message was days
 * ago, "ours" was seconds old and "theirs" was days old: the gate rejected the
 * real thread, nothing was imported, and the screener cold-opened the friend -
 * the exact incident this module exists to prevent. Text overlap is timing
 * independent and far stronger evidence: a stranger who happens to share a
 * name does not also send us the same words.
 *
 * Returns null when the candidate is corroborated, or a short reason when it
 * is not. A brand-new lead with a single message we have only just received
 * has nothing to overlap yet and is rejected here - correctly, since it has no
 * history to protect and skipping the sync costs it nothing.
 */
async function nameMatchFailure(thread: ThreadMessage[], lead: Lead): Promise<string | null> {
  if (!threadLooksInstagram(thread)) return "not_an_instagram_thread";
  const ourKeys = await ourInboundKeys(lead);
  if (!ourKeys) return "lead_history_read_failed";
  if (!ourKeys.size) return "lead_has_no_inbound";
  // Media rows carry a generic placeholder ("[voice note]") instead of words,
  // so they would match any two threads and prove nothing.
  const overlaps = thread.some(
    (m) => m.direction === "inbound" && !m.is_media && ourKeys.has(echoKey(m.content))
  );
  return overlaps ? null : "no_content_overlap";
}

/** Cache a corroborated contact id so the search above is a one-time cost. */
async function attachContactId(lead: Lead, contactId: string): Promise<void> {
  const { error } = await supabase
    .from("leads")
    .update({ ghl_contact_id: contactId })
    .eq("id", lead.id);
  if (error) {
    // A unique-constraint clash means another lead row already owns this
    // contact. We still read the thread; only the caching failed.
    console.error("[conversation-sync] ghl_contact_id persist failed:", error.message);
    return;
  }
  lead.ghl_contact_id = contactId;
}

/** Every message WE have sent this human, across all of their lead rows. */
type OurSends = { keys: Set<string>; stampsMs: number[] };

/**
 * The lead rows that are the SAME HUMAN as this one.
 *
 * WHY (adversarial review, 2026-08-09): GHL routinely spawns several contact
 * ids for one Instagram person, so our own sends can sit on a twin row. Asking
 * only about lead_id === this lead made the setter's OWN replies look
 * unattributable on the twin, import as role='human', and trip a PERMANENT
 * takeover stand-down on a thread the setter itself was holding.
 *
 * Linked on the same hard identity keys used elsewhere (findLeadByIdentity,
 * findActiveBan): igSid, ManyChat subscriber id, GHL contact id. Deliberately
 * NOT on name - name is the signal that caused the sibling defect above.
 * Returns null on a read failure; the caller must then import nothing rather
 * than guess authorship with a half-built picture.
 */
async function personLeadIds(lead: Lead, contactId: string): Promise<string[] | null> {
  // PostgREST .or() takes a comma/paren delimited string, so a value carrying
  // those characters would change the filter's meaning (mirrors lib/bans.ts).
  const usable = (v: string | null | undefined): v is string =>
    !!v && !v.includes(",") && !v.includes("(") && !v.includes(")");

  const conditions: string[] = [];
  if (usable(lead.ig_sender_id)) conditions.push(`ig_sender_id.eq.${lead.ig_sender_id}`);
  if (usable(lead.manychat_subscriber_id)) {
    conditions.push(`manychat_subscriber_id.eq.${lead.manychat_subscriber_id}`);
  }
  if (usable(contactId)) conditions.push(`ghl_contact_id.eq.${contactId}`);
  if (!conditions.length) return [lead.id];

  const { data, error } = await supabase
    .from("leads")
    .select("id")
    .eq("client_id", lead.client_id)
    .or(conditions.join(","))
    .limit(PERSON_LEAD_LIMIT);
  if (error) {
    console.error("[conversation-sync] sibling lead read failed:", error.message);
    return null;
  }
  const ids = new Set<string>([lead.id]);
  for (const r of (data ?? []) as Array<{ id: string }>) ids.add(r.id);
  return [...ids];
}

/** Load our sent bubbles for the whole person. null on a read failure. */
async function loadOurSends(leadIds: string[]): Promise<OurSends | null> {
  const { data, error } = await supabase
    .from("messages")
    .select("content, created_at")
    .in("lead_id", leadIds)
    .eq("role", "ai")
    .order("created_at", { ascending: false })
    .limit(OUR_HISTORY_LIMIT);
  if (error) {
    console.error("[conversation-sync] ai history read failed:", error.message);
    return null;
  }
  const keys = new Set<string>();
  const stampsMs: number[] = [];
  for (const r of (data ?? []) as Array<{ content: string; created_at: string }>) {
    const key = echoKey(r.content);
    if (key) keys.add(key);
    const ms = msOf(r.created_at);
    if (Number.isFinite(ms)) stampsMs.push(ms);
  }
  return { keys, stampsMs };
}

/**
 * Did WE send this outbound message, or did the operator type it by hand?
 *
 * Our sends are all persisted as role='ai' rows, one row per bubble, so an
 * outbound whose normalised text matches no ai row of ours is the operator's.
 *
 * WHICH WAY THIS FAILS: an outbound we cannot claim is imported as role='human',
 * and a role='human' row stands the setter down PERMANENTLY on that thread. So
 * failing to recognise our own message does not cost a mislabelled row, it
 * costs a frozen lead nobody is working. That is why the match is generous
 * about what counts as ours: `ours` spans every lead row of this same human,
 * not just this one, because our bubbles carry no ghl_message_id and the twin
 * row they landed on is invisible to a lead_id lookup.
 *
 * The remaining asymmetry is still deliberate. Mislabelling HIS message as
 * ours re-creates the incident (we go on talking over him), so the only things
 * that count are an exact normalised text match and, for a bodyless media
 * message, our own activity minutes either side of it.
 */
function weSentIt(m: ThreadMessage, key: string, ours: OurSends): boolean {
  if (key && ours.keys.has(key)) return true;
  if (m.is_media) {
    const ms = msOf(m.created_at);
    if (!Number.isFinite(ms)) return false;
    return ours.stampsMs.some((t) => Math.abs(t - ms) <= MEDIA_OWNERSHIP_WINDOW_MS);
  }
  return false;
}

export async function syncConversationFromGHL(params: {
  client: Client;
  lead: Lead;
  maxMessages?: number;
}): Promise<ConversationSyncResult> {
  const { client, lead } = params;
  const max = Math.max(1, params.maxMessages ?? DEFAULT_MAX_MESSAGES);
  const nothing = { imported: 0, humanMessages: 0, totalThread: 0 };

  try {
    const apiKey = client.ghl_api_key;
    const locationId = client.ghl_location_id;
    if (!apiKey || !locationId) return { ...nothing, skipped: "no_credentials" };

    const candidate = await resolveContactCandidate(apiKey, locationId, lead);
    if (!candidate) return { ...nothing, skipped: "no_contact" };
    const contactId = candidate.id;

    let thread: ThreadMessage[];
    try {
      thread = await fetchContactThread(apiKey, locationId, contactId);
    } catch (e) {
      return { ...nothing, skipped: `fetch_failed:${errText(e)}` };
    }
    if (!thread.length) return { ...nothing, skipped: "empty_thread" };

    // A name-only candidate is still a guess at this point. Nothing has been
    // written and nothing has been persisted; if the thread does not back the
    // guess up we walk away with the lead untouched, which is the only safe
    // outcome when the alternative is importing a stranger's private thread.
    if (!candidate.corroborated) {
      const failure = await nameMatchFailure(thread, lead);
      if (failure) {
        console.log(`[conversation-sync] name match rejected (${failure}) for lead ${lead.id}`);
        return { ...nothing, skipped: "no_contact" };
      }
    }

    // Cache the id for EVERY corroborated match, however it was corroborated
    // (review 2026-08-09). Persisting only the name-plus-overlap match threw
    // the STRONGER igSid-verified one away, so every single reply re-ran the
    // contact search and the detail fetch - two GHL round trips per message,
    // forever, on precisely the leads we were surest about.
    if (!lead.ghl_contact_id) await attachContactId(lead, contactId);

    // FREE INBOX VERIFICATION (lib/delivery-verify.ts): the thread in hand is
    // the readable mirror of the real Instagram inbox, already fetched for
    // this turn — stamp any of our recent bubbles that are visibly IN it, at
    // zero extra API cost. Stamps only; never blocks or breaks the sync.
    await stampVerifiedFromThread(lead.id, thread);

    const totalThread = thread.length;
    const window = thread.slice(-max);

    // --- What we already hold for this lead (dedupe only; authorship below) ---
    const { data: ourData, error: ourErr } = await supabase
      .from("messages")
      .select("id, content, created_at, ghl_message_id")
      .eq("lead_id", lead.id)
      .order("created_at", { ascending: false })
      .limit(OUR_HISTORY_LIMIT);
    if (ourErr) return { ...nothing, totalThread, skipped: `history_read_failed:${ourErr.message}` };

    const ourRows = (ourData ?? []) as OurRow[];
    const knownGhlIds = new Set(
      ourRows.map((r) => r.ghl_message_id).filter((v): v is string => !!v)
    );
    const seen: Array<{ key: string; ms: number }> = [];
    for (const r of ourRows) {
      seen.push({ key: echoKey(r.content), ms: msOf(r.created_at) });
    }

    // Authorship is judged against everything WE have sent this HUMAN, not
    // just this lead row. Both reads bail out rather than degrade: with a
    // partial picture of our own sends we would label our replies 'human' and
    // freeze the setter on this thread permanently. Skipping just means the
    // next invocation tries again.
    const personIds = await personLeadIds(lead, contactId);
    if (!personIds) return { ...nothing, totalThread, skipped: "identity_read_failed" };
    const ourSends = await loadOurSends(personIds);
    if (!ourSends) return { ...nothing, totalThread, skipped: "ai_history_read_failed" };

    // --- Ledger + recency snapshot, taken BEFORE we write anything ----------
    // saveMessage has two side effects that are correct for LIVE traffic and
    // wrong for a backfill of old messages: every role='lead' insert opens an
    // inbound_outcomes row (which the sweep would escalate as "nobody ever
    // answered this"), and every role='human' insert closes the lead's open
    // rows as replied (which would silence a genuine alarm about the message
    // we are replying to right now). We undo both below.
    const syncStartIso = new Date().toISOString();
    const { data: ledgerBefore } = await supabase
      .from("inbound_outcomes")
      .select("id, status")
      .eq("lead_id", lead.id)
      .in("status", ["open", "escalated"])
      .limit(50);

    let imported = 0;
    let humanMessages = 0;
    const importedLeadMessageIds: string[] = [];
    let newestImportedMs = 0;

    for (const m of window) {
      const ms = msOf(m.created_at);
      const key = echoKey(m.content);

      // Dedupe, hardest signal first.
      if (m.ghl_message_id && knownGhlIds.has(m.ghl_message_id)) continue;
      if (
        Number.isFinite(ms) &&
        seen.some((s) => s.key === key && Number.isFinite(s.ms) && Math.abs(s.ms - ms) < DUPE_WINDOW_MS)
      ) {
        continue;
      }
      if (m.ghl_message_id && (await messageExistsByGhlId(m.ghl_message_id))) {
        // The same physical message can already be stored under a merged twin
        // lead row; the id is global, so this catches what the per-lead read
        // above cannot.
        knownGhlIds.add(m.ghl_message_id);
        continue;
      }

      let role: "lead" | "human";
      if (m.direction === "inbound") {
        role = "lead";
      } else {
        if (weSentIt(m, key, ourSends)) continue;
        role = "human";
      }

      const row = await saveMessage({
        lead_id: lead.id,
        client_id: client.id,
        role,
        content: m.content,
        channel: "instagram",
        ghl_message_id: m.ghl_message_id,
        source: "ghl_backfill",
      });
      if (!row) continue;

      // saveMessage cannot be given a created_at, and the ORDER of this thread
      // is load-bearing for every downstream reader, so restore the real GHL
      // timestamp immediately after the insert.
      //
      // CLAMPED TO NOW. This is GHL'S clock, not ours, and a row stamped in
      // the FUTURE eats a turn: the reply engine decides whose turn it is by
      // "is the newest message theirs?", so an imported echo of our own reply
      // stamped a few seconds ahead makes the thread look already-answered and
      // the engine skips - silently, with nothing for the sweep to rescue
      // (caught by the stress rig, 2026-08-12). Past timestamps keep their
      // real value (order is what matters); the future is simply not a place
      // a message can have come from.
      if (Number.isFinite(ms)) {
        const clampedMs = Math.min(ms, Date.now());
        const { error: tsErr } = await supabase
          .from("messages")
          .update({ created_at: new Date(clampedMs).toISOString() })
          .eq("id", row.id);
        if (tsErr) console.error("[conversation-sync] created_at restore failed:", tsErr.message);
        newestImportedMs = Math.max(newestImportedMs, clampedMs);
      }

      if (m.ghl_message_id) knownGhlIds.add(m.ghl_message_id);
      seen.push({ key, ms });
      imported++;
      if (role === "human") humanMessages++;
      else importedLeadMessageIds.push(row.id);
    }

    if (imported > 0) {
      await settleSideEffects({
        lead,
        importedLeadMessageIds,
        humanMessages,
        ledgerBefore: (ledgerBefore ?? []) as Array<{ id: string; status: string }>,
        syncStartIso,
        newestImportedMs,
      });

      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "ghl_conversation_backfill",
        metadata: { imported, human_messages: humanMessages, thread_length: totalThread },
      }).catch(() => { /* observability only */ });
    }

    return { imported, humanMessages, totalThread };
  } catch (e) {
    console.error("[conversation-sync] sync failed:", e);
    return { ...nothing, skipped: `sync_failed:${errText(e)}` };
  }
}

/**
 * Undo the two saveMessage side effects that only make sense for live traffic,
 * and stop a backfill from making a dormant lead look freshly active.
 * Every step is best-effort; a miss is self-healing (the sweep's ledger
 * monitor reconciles any row it finds with a real reply after it).
 */
async function settleSideEffects(p: {
  lead: Lead;
  importedLeadMessageIds: string[];
  humanMessages: number;
  ledgerBefore: Array<{ id: string; status: string }>;
  syncStartIso: string;
  newestImportedMs: number;
}): Promise<void> {
  try {
    // 1. Close the ledger rows our own backfill opened. These are historical
    //    messages whose outcome already happened; left open, the sweep pages
    //    The owner about every one of them.
    if (p.importedLeadMessageIds.length) {
      await supabase
        .from("inbound_outcomes")
        .update({
          status: "silent",
          reason: "ghl_backfill",
          closed_at: new Date().toISOString(),
        })
        .in("message_id", p.importedLeadMessageIds);
    }

    // 2. Re-open the rows that existed before this sync and were closed as
    //    'replied' by our imported role='human' inserts. The operator's reply
    //    happened in the PAST; it is not an answer to the message that is
    //    currently waiting on us, and letting it close that row would hide
    //    exactly the dropped-lead alarm the ledger exists to raise.
    if (p.humanMessages > 0 && p.ledgerBefore.length) {
      for (const status of ["open", "escalated"] as const) {
        const ids = p.ledgerBefore.filter((r) => r.status === status).map((r) => r.id);
        if (!ids.length) continue;
        await supabase
          .from("inbound_outcomes")
          .update({ status, closed_at: null })
          .in("id", ids)
          .eq("status", "replied")
          .gte("closed_at", p.syncStartIso);
      }
    }

    // 3. saveMessage stamps last_message_at = now on every insert. For old
    //    messages that is a lie that wakes a dormant lead up into the nurture
    //    and follow-up windows. Put it back to the true latest moment.
    const prior = msOf(p.lead.last_message_at || "");
    const truest = Math.max(Number.isFinite(prior) ? prior : 0, p.newestImportedMs);
    if (truest > 0) {
      await supabase
        .from("leads")
        .update({ last_message_at: new Date(truest).toISOString() })
        .eq("id", p.lead.id);
    }
  } catch (e) {
    console.error("[conversation-sync] side-effect settle failed:", e);
  }
}

/**
 * True when the operator has replied by hand in this thread (optionally only
 * counting replies after `sinceIso`).
 *
 * Read this AFTER syncConversationFromGHL has had a chance to run, otherwise
 * it answers from a table that historically never held a single role='human'
 * row. Returns false on a read error rather than throwing: callers treat a
 * true as "stand down and ping the owner", and a database blip must not be
 * able to freeze the setter on every lead at once.
 */
/**
 * IS THE OWNER HOLDING THIS THREAD RIGHT NOW?
 *
 * "Has a human ever spoken here" (threadHasHumanTakeover, below) is the right
 * question at FIRST CONTACT and the wrong one afterwards: one DM he fired off
 * weeks ago would freeze a lead the setter is legitimately working. On an
 * ongoing thread the signal is whose message is the LAST one from our side.
 *
 * A trailing instant ack does not count as the setter taking the thread back —
 * an ack is filler, the same as everywhere else in this codebase.
 *
 * Returns false on any read error. A stand-down freezes a lead, and a database
 * blip must never be able to freeze every lead at once.
 */
export async function humanIsHoldingThread(leadId: string): Promise<boolean> {
  if (!leadId) return false;
  try {
    const { data: humanRows, error: humanErr } = await supabase
      .from("messages")
      .select("created_at")
      .eq("lead_id", leadId)
      .eq("role", "human")
      .order("created_at", { ascending: false })
      .limit(1);
    if (humanErr) {
      console.error("[conversation-sync] humanIsHoldingThread failed:", humanErr.message);
      return false;
    }
    const newestHumanAt = humanRows?.[0]?.created_at;
    if (!newestHumanAt) return false;

    // AN EXPLICIT RESUME OUTRANKS EVERY HUMAN MESSAGE BEFORE IT. Without this,
    // takeover and resume deadlock: the owner types by hand -> this guard
    // auto-pauses -> he says "turn him back on" -> the lead replies -> his OLD
    // manual message is still the newest human row -> re-paused. Once he had
    // ever typed in a thread, the AI could never actually come back ("it was
    // refusing to turn on", live). ai_resumed_at is stamped by every resume
    // path; a human message only means he is holding the thread if he sent it
    // AFTER the last time he said the opposite.
    const { data: leadRow } = await supabase
      .from("leads")
      .select("ai_resumed_at")
      .eq("id", leadId)
      .maybeSingle();
    const resumedAt = (leadRow as { ai_resumed_at?: string | null } | null)?.ai_resumed_at;
    if (resumedAt && new Date(newestHumanAt).getTime() <= new Date(resumedAt).getTime()) {
      return false;
    }

    // AN OPENER IS NOT A TAKEOVER (2026-08-21, the.ch4in #b44e72). Meta's
    // rules forbid automating cold outreach, so the owner opens EVERY conversation
    // by hand - the lead's reply is precisely the AI's cue to take the thread.
    // A human message only means he is HOLDING the thread when he sent it
    // after the lead had already spoken: a reply by hand to a real inbound.
    // Without this, whether a fresh outreach lead got the AI was a race
    // between the GHL backfill (importing the opener) and this check - Scott
    // Hall got the AI, the.ch4in got a stand-down, same flow one day apart.
    const { data: leadBefore, error: leadMsgErr } = await supabase
      .from("messages")
      .select("id")
      .eq("lead_id", leadId)
      .eq("role", "lead")
      .lt("created_at", newestHumanAt)
      .limit(1);
    if (leadMsgErr) {
      console.error("[conversation-sync] humanIsHoldingThread lead-before check failed:", leadMsgErr.message);
      return false;
    }
    if ((leadBefore?.length ?? 0) === 0) return false;

    // Acks are excluded IN THE QUERY, not afterwards: with a run of acks
    // trailing his message, an unordered page could come back all-acks and the
    // setter would wrongly conclude it had already taken the thread back. The
    // null arm is load-bearing — a real setter message may carry no model_used,
    // and SQL's `model_used <> 'instant_ack'` drops NULL rows.
    const { data: aiAfter, error: aiErr } = await supabase
      .from("messages")
      .select("id")
      .eq("lead_id", leadId)
      .eq("role", "ai")
      .gt("created_at", newestHumanAt)
      .or(`model_used.is.null,model_used.neq.${INSTANT_ACK_TAG}`)
      .limit(1);
    if (aiErr) {
      console.error("[conversation-sync] humanIsHoldingThread ai-since check failed:", aiErr.message);
      return false;
    }
    return (aiAfter?.length ?? 0) === 0;
  } catch (e) {
    console.error("[conversation-sync] humanIsHoldingThread threw:", e);
    return false;
  }
}

export async function threadHasHumanTakeover(
  leadId: string,
  sinceIso?: string
): Promise<boolean> {
  if (!leadId) return false;
  try {
    // AN OPENER IS NOT A TAKEOVER (2026-08-21, the.ch4in #b44e72): every
    // conversation starts with the owner's hand-typed outreach (Meta forbids
    // automating it), so a human message counts as a takeover only when it
    // was sent AFTER the lead had already spoken - a reply by hand to a real
    // inbound. Counting ANY human row made the first-contact screener stand
    // down on an outreach lead's very first "Hello!" whenever the GHL
    // backfill imported the opener before this check ran.
    const { data: firstLead, error: firstLeadErr } = await supabase
      .from("messages")
      .select("created_at")
      .eq("lead_id", leadId)
      .eq("role", "lead")
      .order("created_at", { ascending: true })
      .limit(1);
    if (firstLeadErr) {
      console.error("[conversation-sync] threadHasHumanTakeover first-lead check failed:", firstLeadErr.message);
      return false;
    }
    const firstLeadAt = firstLead?.[0]?.created_at;
    if (!firstLeadAt) return false; // nothing but our own outreach in the thread

    let q = supabase
      .from("messages")
      .select("id")
      .eq("lead_id", leadId)
      .eq("role", "human")
      .gt("created_at", firstLeadAt)
      .limit(1);
    if (sinceIso) q = q.gt("created_at", sinceIso);
    const { data, error } = await q;
    if (error) {
      console.error("[conversation-sync] threadHasHumanTakeover failed:", error.message);
      return false;
    }
    return (data?.length ?? 0) > 0;
  } catch (e) {
    console.error("[conversation-sync] threadHasHumanTakeover threw:", e);
    return false;
  }
}
