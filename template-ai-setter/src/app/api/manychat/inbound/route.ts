/**
 * MANYCHAT-FIRST INBOUND — the setter's PRIMARY ears (flipped 2026-07-09)
 * -------------------------------------------------------------------------
 * GHL's Instagram feed is measurably broken: p50 ~10s / worst 105s delivery
 * lag PER BUBBLE, mid-burst drops (a lead's "from sweden" vanished twice),
 * out-of-order arrival. ManyChat sees the SAME inbox in ~1s, in order, with
 * nothing missing — so this endpoint now OWNS inbound: it saves the message,
 * fires the instant reaction, creates the lead when the sender is brand new
 * (ghl_contact_id null; sends route via ManyChat until the identity layer
 * attaches GHL's contact), and kicks off the considered reply immediately
 * (reply-now, 8s burst debounce). The GHL webhook is demoted to backup ears
 * + CRM attach + send channel; the 5-min sweep remains the last net.
 *
 * Fail-safe: if ManyChat never calls this (automation off, Default Reply
 * suppressed for a message), the GHL path + sweep handle everything exactly
 * as before — slower, but nothing is lost.
 *
 * Auth: same shared access key as the rest of the setter's key-gated routes
 * (?k=<key>, checked against prompter_config.access_key).
 *
 * Body (JSON, all optional):
 *   { "subscriber_id": "{{contact_id}}",
 *     "ig_username":   "{{instagram_username}}",
 *     "full_name":     "{{full_name}}",
 *     "text":          "{{last_text_input}}" }
 */
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import {
  supabase,
  saveMessage,
  getLatestLeadMessage,
  setLeadManychatSubscriberId,
  logEvent,
  recentEventExists,
  echoKey,
  type Client,
} from "@/lib/supabase";
import { getAccessKey } from "@/lib/prompter/access";
import { getLeadForManychatInbound, resolveOrCreateManychatLead } from "@/lib/manychat-handoff";
import { fetchSubscriberInfo } from "@/lib/manychat";
import { findActiveBan } from "@/lib/bans";
import { resolveMediaFromUrl } from "@/lib/media";
import { ensurePipelineCard } from "@/lib/pipeline-sync";
import { trackStageForInbound } from "@/lib/stage-track";
import { maybeSendInstantAck } from "@/lib/instant-ack";
import { detectOptOut } from "@/lib/optout";
import { pauseLead } from "@/lib/screener";
import { getContactTags } from "@/lib/ghl";
import { hasStopTag, hasOptOutTag } from "@/domain/ghl"; // SSOT tag sets, same as the GHL webhook path
import { ownerSlug } from "@/lib/tenant";

export const dynamic = "force-dynamic";
// The considered reply runs in a FRESH invocation (a POST to
// /api/setter/reply-now) with its own budget — this route saves, acks, and
// kicks that off. 300, not 60 (live incident 2026-08-13): the ack + handoff
// must never die mid-transport on a slow turn.
export const maxDuration = 300;

// A ManyChat retry / accidental double-fire of the SAME message within this
// window is treated as a duplicate and skipped (nothing new to save/ack).
const DUPLICATE_WINDOW_MS = 20_000;

// Bare-URL messages (a shared link with no words) never warrant an ack and
// aren't useful thread content from this fast path; the GHL path still
// records + replies to them normally via its own media/text resolution.
const BARE_URL_RE = /^\s*https?:\/\/\S+\s*$/i;

// How long a "ManyChat has no identity for this subscriber" answer stands
// before we bother asking again. Some subscribers are permanently nameless, and
// without this the needName branch below re-ran the lookup (and wrote an event)
// on every message of their thread, forever. A week is short enough that a name
// the operator later fills in on the ManyChat side still gets picked up.
const IDENTITY_LOOKUP_COOLDOWN_MS = 7 * 86400_000;

export async function POST(req: NextRequest) {
  // Whether the inbound message has been written to the messages table yet.
  // It decides what an UNEXPECTED throw means: before persist, the request is
  // safe to redeliver (everything up to the save is idempotent - auth, dedupe,
  // ban check, identity), so ManyChat must be told to RETRY; after persist,
  // the row exists, the sweep can rescue an unanswered message, and a retry
  // would only knock on the duplicate gate.
  let messagePersisted = false;
  try {
    const k = req.nextUrl.searchParams.get("k") ?? "";
    const accessKey = await getAccessKey();
    if (!accessKey || k !== accessKey) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as
      | {
          subscriber_id?: string;
          ig_username?: string;
          full_name?: string;
          text?: string;
          // Voice note / photo. ManyChat flows name this field differently
          // depending on how it was mapped, so accept the plausible spellings
          // rather than making the operator match ours exactly.
          attachment_url?: string;
          attachment?: string;
          media_url?: string;
          file_url?: string;
        }
      | null;

    // Reject unrendered ManyChat merge fields. When a contact is missing a
    // variable, ManyChat posts the LITERAL template (e.g. full_name arrives as
    // "{{full_name}}"). Storing that garbage as an identity made one lead
    // (jacckk.i) miss every identity match and re-run the name-adopt path 38
    // times, spamming duplicate_contact_absorbed. Treat any "{{...}}" value as
    // absent so it can never key or name a lead.
    const clean = (v?: string): string | null => {
      const s = (v || "").trim();
      if (!s || s.includes("{{") || s.includes("}}")) return null;
      return s;
    };
    const subscriberId = clean(body?.subscriber_id);
    const igUsername = clean(body?.ig_username);
    let text = (body?.text || "").trim();

    // VOICE NOTES AND PHOTOS (2026-07-26). These used to be recovered by asking
    // GHL's conversations API for the attachment, because GHL's webhook
    // delivered media as an empty event with no URL on it. That webhook is
    // retired, so the URL has to come from ManyChat directly. Accept the field
    // under any of the names a ManyChat flow might reasonably map it to, so
    // whichever one the flow uses just works.
    const mediaUrl = text
      ? null
      : clean(body?.attachment_url) ||
        clean(body?.attachment) ||
        clean(body?.media_url) ||
        clean(body?.file_url);

    if (!text && !mediaUrl) {
      return NextResponse.json({ ok: true, skipped: "no_text" });
    }

    // WHICH client this message belongs to (students-kit, 2026-08-21): a copy
    // of this platform serves ONE owner but potentially MANY client businesses
    // (a student's agency). Each client's ManyChat flow carries its own
    // webhook URL with ?client_slug=...; a URL without one falls back to the
    // owner's default client, which keeps the owner's deploy (and every
    // single-client student) working with the URL they already have.
    const requestedSlug =
      (req.nextUrl.searchParams.get("client_slug") || "").trim() || ownerSlug();
    const { data: clientRow, error: clientErr } = await supabase
      .from("clients")
      .select("*")
      .eq("slug", requestedSlug)
      .maybeSingle();
    // "THE ROW ISN'T THERE" AND "THE DATABASE IS DOWN" ARE DIFFERENT ANSWERS.
    // Treating a query ERROR as no_client acked the webhook with a 200 during
    // an outage, and for a ManyChat-first lead this route is the only record -
    // a 200 here made the message exist nowhere, unrescuable by any sweep. A
    // retryable status hands it back to ManyChat's delivery semantics instead.
    if (clientErr) {
      console.error("[manychat/inbound] client lookup failed - asking ManyChat to retry:", clientErr);
      return NextResponse.json({ ok: false, error: "client_lookup_failed" }, { status: 503 });
    }
    const client = clientRow as Client | null;
    if (!client) return NextResponse.json({ ok: true, skipped: "no_client" });
    // SETTER OFF ≠ SYSTEM OFF (owner rule 2026-08-08): the kill switch stops
    // every OUTBOUND (ack, reply, follow-ups, nurture) but tracking must keep
    // working — the message is still saved, the lead still gets its CRM card,
    // tags and pipeline moves continue. The old early-return here meant DMs
    // received while off were never recorded anywhere.
    const setterOff = !client.is_active;

    if (mediaUrl) {
      const asText = await resolveMediaFromUrl(mediaUrl);
      if (asText) {
        text = asText;
        await logEvent({
          client_id: client.id,
          event_type: "manychat_media_resolved",
          metadata: { subscriber_id: subscriberId, url: mediaUrl.slice(0, 300) },
        }).catch(() => {});
      }
    }

    if (!text || BARE_URL_RE.test(text)) {
      // A REAL PERSON SENT SOMETHING AND NOTHING RECORDED IT. This return is
      // reached by an unsupported attachment, a media URL whose description
      // failed, and a bare shared link - all cases where a human did make
      // contact. Dropping them with no trace meant no message row, no CRM card,
      // no outcome-ledger row and nothing to escalate: invisible, which is the
      // one failure shape the ledger exists to make impossible. Tracking always
      // works, even when replying does not.
      await logEvent({
        client_id: client.id,
        event_type: "manychat_inbound_unreadable",
        metadata: {
          subscriber_id: subscriberId,
          ig_username: igUsername,
          had_media: !!mediaUrl,
          reason: text ? "bare_url" : "no_readable_text",
        },
      }).catch(() => { /* best-effort */ });
      return NextResponse.json({ ok: true, skipped: "no_text" });
    }

    // MANYCHAT-FIRST (2026-07-09): this path is now the PRIMARY ears — it sees
    // every DM in ~1s while GHL drops bubbles outright and delivers the rest
    // 10-105s late (measured live). Unknown senders get their lead created
    // HERE (ghl_contact_id null — sends route via ManyChat until GHL attaches
    // a contact through the identity layer), and the considered reply is fired
    // from here immediately instead of waiting 25s for GHL to maybe show up.
    // IDENTITY BACKFILL (2026-07-26) — the duplicate-lead killer.
    // When ManyChat's flow doesn't render its merge fields we get a subscriber
    // id and NOTHING else. Minting a lead from that is guaranteed to fork the
    // person: it carries no name, no handle and no Instagram id, so when GHL's
    // copy of the same message lands seconds later nothing can match them, and
    // the human ends up in TWO lead rows with TWO AIs replying in parallel.
    // Live: Oliver (oliverbutcherr) forked 4s apart and kept getting doubled
    // replies AFTER being paused, because the pause only reached one row.
    // So: ask ManyChat who this subscriber actually is before resolving.
    let resolvedName = clean(body?.full_name);
    let resolvedHandle = igUsername;
    // Instagram's own permanent user id, learned from ManyChat. It is the SAME
    // value GoHighLevel stores on its contact (attributionSource.igSid), which
    // makes it the one key that ties this person to their CRM record with
    // certainty - a handle can be renamed, this cannot. Without it, a
    // ManyChat-first lead had no durable identity at all and their CRM card
    // stayed empty (owner incident 2026-08-14).
    let resolvedIgSid: string | null = null;

    // Who this subscriber already is, if anything. Reading the lead FIRST is
    // what keeps the ManyChat round trip off the hot path (review 2026-08-09):
    // the previous condition (`!name || !handle`) fired the lookup plus an
    // event insert on EVERY message of an established thread, because
    // ManyChat's flow never sends the name. resolveOrCreateManychatLead runs
    // this same lookup, so an existing lead costs one query either way.
    const knownLead = await getLeadForManychatInbound(client.id, subscriberId, igUsername);

    // Pay for the lookup only when it can still help:
    //  - no name anywhere, and the lead row hasn't got one either. The name is
    //    not cosmetic — every owner ping about a nameless lead printed the
    //    literal words "this lead" ("Setter STARTED a conversation with this
    //    lead"), so replying "turn off ai for him" had nothing to resolve and
    //    failed with "No lead found matching 'this lead'".
    //  - no identity at all for a person we have never seen: minting a lead off
    //    a bare subscriber id forks them the moment anything else arrives
    //    (Oliver, 2026-07-26 — two rows, two AIs, one pause).
    const needName = !resolvedName && !knownLead?.full_name;
    // THE HANDLE COUNTS TOO (2026-08-09). This gate was name-only, so a lead
    // that had a name but no Instagram handle was never asked again — which is
    // most of them: 910 of 951 leads carry no handle at all. The handle is not
    // cosmetic either. It is the one identity a person can be found by when
    // their name is common or missing, and its absence is why owner pings had
    // nothing in them to act on. The week-long "ManyChat has nothing for this
    // subscriber" marker below is what keeps this off the hot path.
    const needHandle = !resolvedHandle && !knownLead?.ig_username;
    const needIdentity = !knownLead && !resolvedHandle;
    // THE PERMANENT ID COUNTS TOO (2026-08-14). ManyChat has always known it
    // and we never asked: 28 of 28 live subscribers returned one when probed.
    // It is what lets the CRM contact be confirmed rather than guessed.
    const needIgSid = !knownLead?.ig_sender_id;
    if (subscriberId && client.manychat_api_token && (needName || needHandle || needIdentity || needIgSid)) {
      // A subscriber ManyChat has no name for never grows one by being asked
      // twice (review 2026-08-09). needName stays true forever on such a
      // thread, so without this marker every message paid for a round trip on
      // the ack-timer hot path and left another event row behind.
      const askedRecently = knownLead
        ? await recentEventExists({
            client_id: client.id,
            lead_id: knownLead.id,
            event_type: "manychat_identity_unavailable",
            since_iso: new Date(Date.now() - IDENTITY_LOOKUP_COOLDOWN_MS).toISOString(),
          })
        : false;
      if (!askedRecently) {
        const info = await fetchSubscriberInfo(client.manychat_api_token, subscriberId);
        const learnedName = !resolvedName && info?.name ? info.name : null;
        const learnedHandle = !resolvedHandle && info?.igUsername ? info.igUsername : null;
        const learnedIgSid = info?.igSenderId ?? null;
        resolvedName = resolvedName || learnedName;
        resolvedHandle = resolvedHandle || learnedHandle;
        resolvedIgSid = learnedIgSid;
        if (learnedName || learnedHandle || learnedIgSid) {
          await logEvent({
            client_id: client.id,
            event_type: "manychat_identity_backfilled",
            metadata: {
              subscriber_id: subscriberId,
              name: learnedName,
              ig_username: learnedHandle,
              ig_sender_id: learnedIgSid,
            },
          }).catch(() => {});
        }
        // Asked and learned nothing: remember that against the lead so the next
        // message skips the lookup entirely. Keyed on "learned nothing" rather
        // than "still no name", so a subscriber ManyChat has no HANDLE for does
        // not pay for a round trip on every message forever either.
        if (knownLead && !learnedName && !learnedHandle && !learnedIgSid) {
          await logEvent({
            client_id: client.id,
            lead_id: knownLead.id,
            event_type: "manychat_identity_unavailable",
            metadata: { subscriber_id: subscriberId },
          }).catch(() => {});
        }
      }
    }

    // REPAIR THE EXISTING ROW. Fetching the name changed nothing for a lead
    // that already existed: resolveOrCreateManychatLead hands the row back
    // untouched, so every ManyChat-first lead created before this stayed
    // full_name NULL forever and kept getting pinged about as "this lead".
    // Write it once — from the next message on, needName is false and no
    // ManyChat lookup happens at all for this thread.
    // The HANDLE is repaired here too (2026-08-09). Only full_name was written
    // back, so a lead whose handle we learned from ManyChat kept ig_username
    // NULL forever — and the handle is what makes a person findable by search
    // and printable in a ping.
    const repair: Record<string, string> = {};
    if (knownLead && !knownLead.full_name && resolvedName) repair.full_name = resolvedName;
    if (knownLead && !knownLead.ig_username && resolvedHandle) {
      repair.ig_username = resolvedHandle.replace(/^@/, "");
    }
    // The permanent Instagram id, written once. Everything downstream that
    // has to be SURE this lead is that CRM contact keys on it.
    if (knownLead && !knownLead.ig_sender_id && resolvedIgSid) {
      repair.ig_sender_id = resolvedIgSid;
    }
    if (knownLead && Object.keys(repair).length) {
      const { error: repairErr } = await supabase
        .from("leads")
        .update(repair)
        .eq("id", knownLead.id);
      if (repairErr) {
        console.error("[manychat/inbound] identity backfill failed:", repairErr.message);
      } else {
        if (repair.full_name) knownLead.full_name = repair.full_name;
        if (repair.ig_username) knownLead.ig_username = repair.ig_username;
        if (repair.ig_sender_id) knownLead.ig_sender_id = repair.ig_sender_id;
      }
    }

    const lead =
      knownLead ??
      (await resolveOrCreateManychatLead(client, subscriberId, resolvedHandle, resolvedName));
    if (!lead) {
      // No identity to key on at all — not even a subscriber id or a handle
      // after the backfill above. There is no second ear to fall back to since
      // GHL's webhook was retired, so record it loudly rather than silently
      // dropping a real human on the floor.
      await logEvent({
        client_id: client.id,
        event_type: "manychat_inbound_no_identity",
        metadata: { subscriber_id: subscriberId, ig_username: igUsername, text: text.slice(0, 200) },
      }).catch(() => {});
      return NextResponse.json({ ok: true, skipped: "no_identity" });
    }

    // Bonus: caching the subscriber id here means the FIRST voice send later
    // this conversation resolves instantly instead of an extra ManyChat lookup.
    if (subscriberId && !lead.manychat_subscriber_id) {
      await setLeadManychatSubscriberId(lead.id, subscriberId);
      // Keep the in-memory lead current too — the ack below picks its delivery
      // channel from this object, and a contactless lead's ack goes out via
      // ManyChat, which needs the subscriber id.
      lead.manychat_subscriber_id = subscriberId;
    }

    // Gates — a BAN or a true OPT-OUT tag ("do not contact"/"dnc") is a full
    // no-op (nothing saved): those people opted out of everything, including
    // tracking. Everything else — ai_paused, setter-off, and the ai-off tag
    // family — is different: their messages ARE saved (tracking always works),
    // they just never get an ack or a reply; see the tracked-only branches.
    // NOTE: unscreened leads are not skipped — reply-now runs the
    // first-contact screener itself, so a brand-new sender (a story-CTA "bdp"
    // reply!) gets the full pipeline at ManyChat speed.

    // The remaining gates are independent reads — run them CONCURRENTLY. This
    // path's whole point is speed (the ack timer is running), and doing these
    // sequentially was ~0.5-1s of avoidable latency per message.
    const dayAgoIso = new Date(Date.now() - 24 * 3600_000).toISOString();
    const hourAgoIso = new Date(Date.now() - 3600_000).toISOString();
    const [ban, stopTagged, liveTags, rateLimited, latest, contactGone] = await Promise.all([
      findActiveBan(client.id, {
        ghl_contact_id: lead.ghl_contact_id,
        ig_username: igUsername || lead.ig_username,
      }),
      recentEventExists({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "skip_stop_tag",
        since_iso: dayAgoIso,
      }),
      // The GHL webhook path reads the stop tag straight from its inbound
      // payload, so it's always current. This path has no such payload, and
      // the event check above only catches a stop tag we've already SEEN on a
      // prior message — so also read the contact's LIVE tags. Fails open on
      // any fetch error (see getContactTags) so a transient GHL hiccup can
      // never make every ack in the system fragile.
      client.ghl_api_key && lead.ghl_contact_id
        ? getContactTags(client.ghl_api_key, lead.ghl_contact_id)
        : Promise.resolve(null),
      // An ack is an AI send — it must never leak past the runaway-loop
      // circuit breaker the GHL path already enforces on the considered reply.
      recentEventExists({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "rate_limit_lead_hold",
        since_iso: hourAgoIso,
      }),
      getLatestLeadMessage(lead.id),
      // Is this lead in DEAD-GHL-CONTACT mode? (GHL deleted their contact mid-
      // conversation; replies flow through the ManyChat backup channel.) When
      // true, GHL will never webhook this message, so THIS path must own the
      // considered reply too — otherwise the lead waits for the slow sweep.
      recentEventExists({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "ghl_contact_gone_fallback",
        since_iso: dayAgoIso,
      }),
    ]);
    if (ban) return NextResponse.json({ ok: true, skipped: "banned" });
    if (stopTagged) return NextResponse.json({ ok: true, skipped: "stop_tag_recent" });
    // A TRUE opt-out ("do not contact", "dnc") is a full no-op: that person
    // asked to be left alone entirely, including tracking.
    if (hasOptOutTag(liveTags)) return NextResponse.json({ ok: true, skipped: "opt_out_tag_live" });
    // Any OTHER stop tag is the ai-off family - OUR OWN pause vocabulary
    // (pauseLead writes 'ai off'). A pause stops sending, never tracking.
    // This gate used to full-drop on the whole stop set: 2026-08-20 the stuck
    // handover tagged Scott Hall 'ai off' and his next messages ("Id be open
    // to a call") vanished before saveMessage - no row, no event, no ping.
    // Self-heal the flag if the DB doesn't know yet, then fall through: the
    // message is SAVED and the ai_paused tracked-only branch below owns the
    // silence (and closes the ledger row).
    if (!lead.ai_paused && hasStopTag(liveTags)) {
      lead.ai_paused = true;
      await supabase
        .from("leads")
        .update({ ai_paused: true })
        .eq("id", lead.id)
        .then(undefined, (e) => console.error("[manychat/inbound] pause-flag sync failed:", e));
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "stop_tag_synced",
        metadata: { via: "live_tags" },
      }).catch(() => { /* best-effort */ });
    }
    if (rateLimited) return NextResponse.json({ ok: true, skipped: "rate_limited" });

    // Retry-dedupe: ManyChat re-firing the SAME message (its own retry, a
    // double External Request) must not create two rows or two acks.
    if (
      latest &&
      echoKey(latest.content) === echoKey(text) &&
      Date.now() - new Date(latest.created_at).getTime() < DUPLICATE_WINDOW_MS
    ) {
      return NextResponse.json({ ok: true, skipped: "duplicate" });
    }

    let saved;
    try {
      saved = await saveMessage({
        lead_id: lead.id,
        client_id: client.id,
        role: "lead",
        content: text,
        channel: "instagram",
        source: "manychat",
      });
    } catch (saveErr) {
      // 503, NOT 200: for a ManyChat-first CONTACTLESS lead, GHL never had
      // this message — if we ack the failure with a 200 it exists nowhere and
      // no sweep can ever rescue it. A retryable status gives ManyChat's
      // delivery semantics (and the duplicate gate above) a chance to land it.
      console.error("[manychat/inbound] saveMessage failed — asking ManyChat to retry:", saveErr);
      return NextResponse.json({ ok: false, error: "persist_failed" }, { status: 503 });
    }
    messagePersisted = true;
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "manychat_inbound_saved",
      metadata: { chars: text.length },
    });

    // ── TRACKED-ONLY BRANCHES: message saved + CRM card kept current, but no
    //    outbound of any kind. The logged skip events double as the outcome
    //    ledger's deliberate-silence closure, so the monitor never pages
    //    "engine dropped it" for a silence the owner chose. ──────────────────
    const trackOnly = (reason: string, logIt: boolean, stageTrack = false) => {
      if (logIt) {
        waitUntil(
          logEvent({
            client_id: client.id,
            lead_id: lead.id,
            event_type: reason,
            metadata: { text: text.slice(0, 120) },
          }).catch(() => { /* best-effort */ })
        );
      }
      waitUntil(
        ensurePipelineCard({ client, lead }).catch((err) =>
          console.error("[manychat/inbound] pipeline card (tracked-only) failed:", err)
        )
      );
      // ZERO DIFFERENCE BETWEEN ON AND OFF (owner rule 2026-08-13): off kills
      // the sending and nothing else. The funnel stage, the captured facts and
      // the CRM note keep moving on every message - see lib/stage-track.ts.
      if (stageTrack) {
        waitUntil(
          trackStageForInbound({ client, lead }).catch((err) =>
            console.error("[manychat/inbound] tracked-only stage pass failed:", err)
          )
        );
      }
      return NextResponse.json({ ok: true, mode: "tracked_only", reason });
    };
    // ── THE LEAD'S OWN OFF SWITCH ────────────────────────────────────────
    // "stop messaging me" / "unsubscribe" / "leave me alone" / "fuck off" used
    // to get a cheerful question back, and then the follow-ups and the nurture
    // sequence on top. Nothing in this path ever looked for it. Beyond being
    // rude, it is how the Instagram account this whole business runs on gets
    // reported and restricted.
    //
    // Deliberately BEFORE the ack: a reaction to "fuck off" is worse than no
    // reaction. The message is already saved above, so tracking is untouched -
    // this only stops the sending, which is the same rule as every other
    // switch. pauseLead does the rest: both pause flags, nurture, the 'ai off'
    // tag on the CRM contact, and the Telegram ping (which carries the ref, so
    // The owner can turn them back on in one reply if it read them wrong).
    //
    // And deliberately ABOVE the setter-off return: somebody asking us to stop
    // is a FACT ABOUT THEM, not an outbound action, so it is recorded whether
    // the setter is running or not. Otherwise an opt-out that arrived during a
    // pause would be forgotten, and switching back on would start chasing them
    // again - through the sweep, then the follow-ups.
    const optOut = detectOptOut(text);
    if (optOut.optOut) {
      waitUntil(
        (async () => {
          await logEvent({
            client_id: client.id,
            lead_id: lead.id,
            event_type: "lead_opted_out",
            metadata: { phrase: optOut.phrase, tier: optOut.tier, text: text.slice(0, 200) },
          }).catch(() => { /* best-effort */ });
          await pauseLead({
            client,
            lead,
            notify: {
              label: "Lead asked us to stop",
              reason: `they said "${text.slice(0, 120)}" - AI, follow-ups and nurture are all off for them now`,
            },
          }).catch((err) => console.error("[manychat/inbound] opt-out pause failed:", err));
          await ensurePipelineCard({ client, lead }).catch(() => { /* best-effort */ });
        })()
      );
      return NextResponse.json({ ok: true, mode: "tracked_only", reason: "lead_opted_out" });
    }

    if (setterOff) return trackOnly("setter_off_tracked", true, true);
    if (lead.ai_paused) return trackOnly("ai_paused_tracked", false, true); // ledger closes via ai_paused


    // A brand-new (unscreened) sender whose first message is emoji-only — a
    // story reaction (❤️ / 🌹), a like — is NOT an invitation to start
    // qualifying them (live: friends who reacted to a story got cold-DMed by
    // the setter). Track it, do nothing. If they ever send actual words, the
    // full first-contact pipeline runs then.
    if (lead.screened !== true && !/[\p{L}\p{N}]/u.test(text)) {
      return trackOnly("skip_emoji_first_contact", true);
    }

    // Fire the ack in the background so ManyChat gets an instant 200 — the ack
    // itself (Haiku + one GHL send) still lands in ~1-2s from here. Skipped in
    // dead-GHL-contact mode: the ack sends through GHL only, which can only
    // fail there — the considered reply (kicked off below) covers the beat.
    //
    // SCREENED FIRST, ALWAYS (incident 2026-08-08). The ack used to fire here
    // while the lead was still unscreened, which meant it beat the screener to
    // the person by several seconds: the owner's friends got a warm AI
    // reaction bubble before the screener had any chance to return skip_friend
    // or skip_owner. An unscreened lead gets NO outbound of any kind until a
    // verdict exists. Nothing is lost by waiting — reply-now (kicked off
    // below) runs the screener and then answers for real, and every later
    // message in the thread acks normally.
    if (!contactGone && lead.screened === true) {
      waitUntil(
        (async () => {
          try {
            const ack = await maybeSendInstantAck({ client, lead });
            if (ack) {
              await logEvent({
                client_id: client.id,
                lead_id: lead.id,
                event_type: "fast_ack_sent",
                metadata: { via: "manychat", ack, lead_msg_id: saved?.id ?? null },
              });
            }
          } catch (err) {
            console.error("[manychat/inbound] background ack failed:", err);
          }
        })()
      );
    }

    // PUT THEM ON THE BOARD (2026-07-26). The retired GHL webhook used to be
    // what got a new DM into the pipeline. GHL's own Instagram integration
    // still creates the CONTACT automatically, so what's missing is the CARD:
    // an opportunity in the AI Sales Pipeline at "New Lead", which the existing
    // forward-only sync then advances as the setter works them.
    //
    // Background + best-effort on purpose: the CRM must never be able to delay
    // or block a reply. After the first success this costs one indexed column
    // read (leads.ghl_opportunity_id), so it's cheap to run on every inbound —
    // which also makes it self-healing, since GHL may not have finished making
    // the contact in the ~1s it takes ManyChat to reach us.
    waitUntil(
      ensurePipelineCard({ client, lead }).then(
        (r) => {
          if (r.created) {
            return logEvent({
              client_id: client.id,
              lead_id: lead.id,
              event_type: "ghl_opportunity_created",
              metadata: { stage: "New Lead", opportunity_id: r.opportunityId },
            }).catch(() => { /* best-effort */ });
          }
        },
        (err) => console.error("[manychat/inbound] pipeline card failed:", err)
      )
    );

    // Both reply paths below delegate to /api/setter/reply-now, which runs the
    // engine in a FRESH invocation with a full 60s budget. Running it in THIS
    // invocation is what killed a live booking-stage reply: the watchdog had
    // already burned 25s of the budget, and the platform killed the process
    // mid-send - skipping the finally that frees the reply lock, which then
    // silenced the next message's watchdog too (5 minutes of dead air until
    // the sweep). reply-now also knows how to reclaim exactly that kind of
    // orphaned lock, so the failure can't chain anymore.
    const replyNowUrl = `${req.nextUrl.origin}/api/setter/reply-now?k=${encodeURIComponent(k)}`;
    // MUST throw on a non-2xx response, not only on network errors (review
    // 2026-07-24, P0): a 401/500 from reply-now resolves a bare fetch just
    // fine, which would skip the retry AND the reply_kickoff_failed event —
    // and with the GHL webhook now standing down when ManyChat owns the
    // message, that combination would leave NOBODY replying until the sweep.
    const fireReplyNow = async (payload: Record<string, unknown>) => {
      const res = await fetch(replyNowUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`reply-now answered ${res.status}`);
    };

    // MANYCHAT-FIRST: this path OWNS the considered reply. It saw the message
    // ~1s after it was sent — GHL's feed (10-105s lag, dropped bubbles) is now
    // the backup, not the boss. reply-now runs in a fresh invocation with an
    // 8s burst debounce (this stream is fast + in order, so 8s genuinely
    // coalesces a burst — unlike GHL's jittered feed which needed 12s+ and
    // still split). Double-reply safety with a late GHL invocation is
    // structural: the reply lock serializes generation, and a thread that
    // already ends with our reply is a no-op for whoever arrives second.
    if (saved?.id) {
      const kickoffPayload = {
        lead_id: lead.id,
        inbound_message_id: saved.id,
        debounce_ms: 8_000,
        reason: contactGone ? "ghl_gone_backup" : "manychat_primary",
      };
      waitUntil(
        (async () => {
          try {
            await fireReplyNow(kickoffPayload);
          } catch {
            try {
              await fireReplyNow(kickoffPayload); // one retry — transient fetch blips are common
            } catch (err) {
              console.error("[manychat/inbound] reply-now kickoff failed twice:", err);
              // This event is the signal that flips the GHL webhook back into
              // full-brain backup mode for this message (it normally skips the
              // pipeline when ManyChat owns the reply). Without it, a failed
              // kickoff here would leave NOBODY replying until the sweep.
              await logEvent({
                client_id: client.id,
                lead_id: lead.id,
                event_type: "reply_kickoff_failed",
                metadata: { inbound_message_id: saved.id },
              }).catch(() => { /* best-effort */ });
            }
          }
        })()
      );
    }

    return NextResponse.json({ ok: true, mode: "primary_reply" });
  } catch (err) {
    console.error("[manychat/inbound] error:", err);
    // WHAT AN UNEXPECTED THROW MEANS DEPENDS ON WHETHER THE MESSAGE EXISTS.
    // This catch used to answer 200 unconditionally "so ManyChat doesn't
    // hammer retries" - which quietly extended the saveMessage 503 contract's
    // exact failure to every step BEFORE the save. Live shape: the duplicate
    // gate's READ dies during a messages-table outage, the throw lands here,
    // ManyChat is told "delivered", and the message exists nowhere, forever.
    // Before persist -> retryable. After persist -> the row exists, the sweep
    // owns the rescue, and a 200 correctly stops the redelivery hammer.
    if (!messagePersisted) {
      return NextResponse.json({ ok: false, error: "pre_persist_failure" }, { status: 503 });
    }
    return NextResponse.json({ ok: false });
  }
}
