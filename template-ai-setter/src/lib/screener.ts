/**
 * ============================================================================
 * ICP SCREENER + LEAD TAGGING
 * ============================================================================
 * This wraps AROUND the existing reply pipeline. It never rewrites the reply
 * logic — the webhook calls into here BEFORE deciding to reply (Part A) and
 * ALONGSIDE the reply (Part B).
 *
 *   PART A — first-contact screener (runs once, when leads.screened = false):
 *     - FIRST: sync the real two-sided Instagram thread out of GHL into our
 *       messages table, then judge history from THAT. (Incident 2026-08-08:
 *       messages the owner typed by hand in the IG app were never recorded here, so
 *       months-old friendships looked like brand-new leads and got cold-opened.)
 *     - Human takeover in thread -> stand down permanently, ping, no reply
 *     - No prior history        -> engage, tag `icp`, screened = true
 *     - Has prior history       -> fetch full GHL thread, ONE Claude verdict:
 *         engage      -> tag `icp`, continue the reply seamlessly
 *         skip_owner  -> tag `biz owner`, PAUSE, ping the owner, no reply
 *         skip_friend -> tag `friend`,    PAUSE, ping the owner, no reply
 *         hold        -> tag `needs review`, PAUSE, ping the owner, no reply
 *       FAIL-CLOSED: any screener error on a lead WITH history => hold.
 *
 *   PART B — ongoing tagging (each inbound from a screened, non-paused lead):
 *     - qualified (operator's OWN criteria) -> add `qualified` (once)
 *     - biz_owner (established online biz ~$3k+/mo) -> remove `icp`+`qualified`,
 *       add `biz owner`, PAUSE, ping the owner (mid-conversation handoff)
 *     Runs alongside the reply; never blocks it. On error: log + skip.
 *
 * PAUSE ALWAYS MEANS BOTH: leads.ai_paused = true AND the GHL "ai off" tag.
 * GHL lowercases all tags.
 * ============================================================================
 */

import { claude } from "./anthropic";
// Named so this shows up as its own line in the spend report.
const anthropic = claude("screener");
import {
  supabase,
  logEvent,
  eventExists,
  recentEventExists,
  getRecentMessages,
  setDisqualifyReason,
  type Client,
  type Lead,
} from "./supabase";
import {
  addContactTags,
  removeContactTags,
  deleteContact,
  fetchContactThread,
  type ThreadMessage,
} from "./ghl";
import { sendTelegramPing, ghlContactLink, leadLabel } from "./telegram";
import { syncConversationFromGHL, threadHasHumanTakeover } from "./conversation-sync";
import { type Message } from "./prompts/master";


// Screening verdicts can PAUSE a real lead or DELETE a contact — the most
// sensitive calls in the system, worth a smarter model (owner ask 2026-08-08).
// Sonnet 5 with thinking disabled stays fast enough to never delay a reply.
export const CLASSIFIER_MODEL = "claude-sonnet-5";

// GHL tag vocabulary (GHL lowercases everything anyway).
const TAG_ICP = "icp";
const TAG_QUALIFIED = "qualified";
const TAG_BIZ_OWNER = "biz owner";
const TAG_FRIEND = "friend";
const TAG_NEEDS_REVIEW = "needs review";
const TAG_DISQUALIFIED = "disqualified";
const TAG_AI_OFF = "ai off";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Render a message list as a plain transcript for the classifier. */
function transcript(msgs: Array<{ role: string; content: string }>): string {
  return msgs
    .map((m) => `${m.role === "lead" ? "Lead" : "Me"}: ${m.content}`)
    .join("\n");
}

/** Extract the first JSON object from a model response and parse it. */
function parseJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`no JSON object in response: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(raw.slice(start, end + 1));
}

/** One classifier call. Returns the parsed JSON object (throws on failure). */
async function classify(
  system: string,
  user: string
): Promise<Record<string, unknown>> {
  const resp = await anthropic.messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 300,
    // Sonnet 5 runs adaptive thinking BY DEFAULT — with a 300-token cap the
    // thinking would eat the whole budget and truncate the JSON. Classifiers
    // want the fast direct answer.
    thinking: { type: "disabled" },
    system,
    messages: [{ role: "user", content: user }],
  });
  const raw = resp.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");
  return parseJsonObject(raw);
}

function leadName(lead: Lead): string {
  return lead.full_name?.trim() || "Unknown";
}
function leadIg(lead: Lead): string {
  return lead.ig_username?.trim() || "?";
}

/** Mark a lead as screened so the first-contact screener never re-runs. */
async function markScreened(lead: Lead): Promise<void> {
  await supabase
    .from("leads")
    .update({ screened: true })
    .eq("id", lead.id)
    .then(undefined, (err) =>
      console.error("[screener] markScreened failed:", err)
    );
}

/**
 * PAUSE = BOTH sides, so GHL and the engine never disagree:
 *   1. leads.ai_paused = true (Supabase)
 *   2. add the GHL "ai off" tag
 * Both are attempted; either failure is logged but never thrown.
 *
 * ALWAYS pings the owner. pauseLead is the SINGLE choke point for AUTONOMOUS pauses
 * (screener handoffs, disqualifies, stand-bys), so routing the ping here
 * guarantees he's notified 10/10 on every auto pause — including pre-existing
 * contacts — with no duplicate pings. Manual on/off (from Jarvis/Telegram) uses
 * a different code path and stays intentionally silent.
 */
export async function pauseLead(params: {
  client: Client;
  lead: Lead;
  /** `false` ONLY when the caller sends its own, richer ping about this exact
   *  pause (the stuck handover sends a tap-to-copy block with the draft in it).
   *  Two Telegram messages for one event is the noise the owner complains about;
   *  ZERO is the failure this choke point exists to prevent. Never pass false
   *  without pinging him yourself. */
  notify?: { label: string; reason?: string } | false;
}): Promise<void> {
  const { client, lead } = params;
  const notify = params.notify === false ? undefined : params.notify;
  const shouldPing = params.notify !== false;

  // A PAUSE STOPS EVERYTHING, not just replies (the owner, 2026-08-09: "if I say
  // turn off the AI for this person, then I mean everything, including follow
  // ups and nurturing"). This matters most for exactly the people who reach
  // this function: a friend, a business owner, someone the owner took over by hand.
  // ai_paused alone left the follow-up and nurture engines free to keep
  // touching them on their own cadence, days later, after the handoff.
  const dbUpdate = supabase
    .from("leads")
    .update({ ai_paused: true, followup_paused: true, nurture_paused: true })
    .eq("id", lead.id)
    .then(
      ({ error }) => {
        if (error) console.error("[screener] pause: pause flags update failed:", error);
      },
      (err) => console.error("[screener] pause: pause flags update threw:", err)
    );

  const tagAdd =
    client.ghl_api_key && lead.ghl_contact_id
      ? addContactTags(client.ghl_api_key, lead.ghl_contact_id, [TAG_AI_OFF]).then(
          (r) => {
            if (!r.success)
              console.error("[screener] pause: 'ai off' tag add failed:", r.error);
          }
        )
      : Promise.resolve(
          console.error("[screener] pause: missing GHL creds, 'ai off' tag NOT added")
        );

  await Promise.all([dbUpdate, tagAdd]);

  // ALWAYS notify the owner (best-effort — never throws into the caller).
  if (!shouldPing) return;
  try {
    const label = notify?.label || "AI auto-paused";
    const reasonLine = notify?.reason ? ` - ${notify.reason}` : "";
    const link =
      client.ghl_location_id && lead.ghl_contact_id
        ? `\nOpen: ${ghlContactLink(client.ghl_location_id, lead.ghl_contact_id)}`
        : "";
    // leadLabel carries the short reference, and `about` records the Telegram
    // message id against this lead — so "turn him off" as a reply to THIS ping
    // resolves exactly, which is the gesture that kept failing.
    await sendTelegramPing(
      `🔴 ${label}\n${leadLabel(lead, leadName(lead))}${reasonLine}${link}`,
      true,
      { leadId: lead.id, clientId: client.id, kind: "pause" }
    );
  } catch (err) {
    console.error("[screener] pause ping failed:", err);
  }
}

// ---------------------------------------------------------------------------
// PART A — first-contact screener
// ---------------------------------------------------------------------------

/**
 * WHO WE ARE, IN THE CLIENT'S OWN WORDS.
 *
 * The screener used to hardcode one business's niche ("an online-income
 * coaching business", "$3k+/month", the code words from its own story CTAs).
 * That is the operator's offer, not the engine, and it shipped into every copy
 * of this system. The decision RULES below are universal; only this block is
 * specific, and it comes from the client row the operator trained - so the
 * screener knows the same business the setter does.
 */
function whoWeAre(client: Client | null): string {
  const ctx = (client?.business_context || "").trim();
  const name = (client?.name || "").trim();
  const lines = [
    name ? `The operator's business: ${name}.` : null,
    ctx ? `BUSINESS CONTEXT (what we sell and who it is for):\n${ctx.slice(0, 1500)}` : null,
  ].filter(Boolean);
  return lines.length
    ? `\n\n${lines.join("\n")}`
    : "\n\nNo business context is saved yet, so judge on the thread alone and lean on the ENGAGE default.";
}

export function screenerSystemPrompt(client: Client | null) {
  return `You are a lead-screening classifier for an Instagram DM setter that books sales calls for the operator's business. We DM new followers a short opener (e.g. "yo brother"), and most threads you see are brand-new leads. You read a DM thread and decide whether the AI setter should ENGAGE the person or hand them off to a human.

Return ONLY strict minified JSON, nothing else, no prose, no code fences:
{"verdict":"engage|skip_owner|skip_friend|skip_their_funnel|hold","reason":"<one line>"}

ENGAGE IS THE DEFAULT. A normal, new, or sparse conversation is a new lead — engage it. This INCLUDES bare greetings and opener exchanges: we said "yo brother", they replied "yo" -> engage. Lack of signal on a fresh thread means new lead -> engage. Absence of signal is NEVER a reason to hold or skip.

Definitions:
- engage (the DEFAULT): use this unless there is CLEAR evidence for one of the categories below. The ICP is whoever the BUSINESS CONTEXT at the end says the offer is for, read generously: someone at any stage who wants the result it sells. Already running something of their own does NOT disqualify them. Thin/greeting/opener threads with no other signal ALSO engage (new lead).
- skip_owner: ONLY on CLEAR evidence they are ALREADY past the offer - established at the level it is meant to get people to - OR a clear peer relationship (talking shop as equals — "how's the agency going", "how's the coaching going", "hit 10k last month").
- skip_friend: ONLY on CLEAR evidence it is personal with NO prospect framing — banter, personal life, plans to meet up between people who clearly know each other. ALSO skip_friend when the person CLAIMS to already know the operator personally: "it's me [name]", "we've talked before", "I'm a friend of theirs", "I'm your student", "you know me", "habibi it's ...", references to shared history or past conversations. A personal-knowledge claim is a handoff, never something the setter keeps qualifying.
- skip_their_funnel: the OTHER person (or their automation) is running THEIR funnel at US — WE are their audience, not the other way around. Clear signs: they gate a freebie on following them ("hit that follow & I'll slide it over"), they deliver a lead magnet ("here's that resource I promised"), numbered click-instructions to join their community/Skool/Discord or a #free_resources channel, or the thread shows WE messaged/replied to THEM first to receive something (we said "Following", we asked for their freebie). If the relationship STARTED with us requesting their resource, it is their funnel even if later messages look casual.
  DIRECTION IS EVERYTHING. A keyword only means "their funnel" when WE sent it (WE opted into THEIR drop). When the LEAD sends US a short keyword/code word — a bare one-word reply like a code word from a story CTA - "info", "link", "guide", "free", "yes" — that is a reply to OUR OWN story/post CTA (WE told people to DM that word to get our freebie). That is OUR funnel, so ENGAGE — it is NEVER skip_their_funnel. A cryptic or short message from the lead is NOT evidence of their funnel; only clear evidence that WE opted into THEIR resource is.
- hold: ONLY when there is a GENUINE mixed signal pointing to friend or owner that you truly cannot resolve. NEVER use hold for thin, new, or greeting-only threads — those are engage.

Rules:
- When in doubt, ENGAGE. Skipping or holding requires clear evidence; engaging does not.
- Owning a business does NOT mean skip. Use skip_owner ONLY with clear evidence they are already past what the offer is for, or a clear peer relationship.
- A bare greeting or one-word reply to our opener is a new lead -> engage, never hold.
- "reason" must be one short line.${whoWeAre(client)}`;
}

/**
 * First-contact classifier. Runs ONLY on contacts with ZERO prior history.
 * Catches strangers who open by trying to SELL US something (SMMA/agency
 * outreach, "I can get you more clients", web/app/AI-bot builders,
 * paid promo/collab-for-money, lead-gen or signal sellers, etc.) — those are
 * erased entirely — plus creators promoting their own thing at us, plus people
 * writing to the operator personally rather than as a prospect.
 *
 * The "friend" class exists because of the 2026-08-08 incident: the only
 * friend/owner detector lived in the HAS-HISTORY branch, so when a friend's
 * thread had no recorded history the setter could not even express "this is
 * someone they know" and cold-opened the operator's actual friends mid-conversation.
 *
 * FAIL-SAFE: this can DELETE a contact, so "selling" must fire ONLY on a clear
 * vendor pitch. Anything else — a normal lead, a greeting, a question, a fan,
 * someone who merely mentions they run a business — is NOT a pitch. On any
 * doubt or error the caller falls through to the normal engage path (never
 * deletes).
 */
export function pitchScreenerSystemPrompt(client: Client | null) {
  return `You classify the FIRST message a stranger sends us on Instagram. "Us" is the operator: a real person who runs their business from their personal account, and who DMs new followers a short opener. Most first messages are real leads. But sometimes the sender is NOT a lead - they are marketing to US, or they are someone who knows the operator personally. Decide which of four kinds this is.

Return ONLY strict minified JSON, nothing else, no prose, no code fences:
{"kind":"lead|selling|promoting|friend","reason":"<one line>"}

"lead" is the DEFAULT - someone who could be a customer for OUR coaching:
- Wants to START or GROW their own online income, asks how to make money, replies to our opener, asks about our coaching/program/price, shows interest in what WE offer.
- Bare greetings, one-word replies, questions, fans, compliments with no offer.
- Someone merely mentioning they have a job or run a business is STILL a lead.

"selling" - a VENDOR cold-pitching to SELL US a paid service/product:
- Agency/SMMA outreach, "I can get you more clients/leads/appointments", editing/thumbnails/websites/apps/AI chatbots/automation, SEO, ghostwriting, paid promo or "collab" meaning we pay them, lead-gen "I have a system that…", crypto/forex/trading-signal selling.
- Classic shape: compliment about our page, then "I help [people like you] do [result], interested?" / "hop on a call".

"promoting" - the sender is a creator/marketer pushing THEIR OWN thing TO us, even for FREE. We are THEIR audience, not a customer they're qualifying:
- Delivering a lead magnet or free resource, "click join it's free", inviting us to their community / Skool / Discord / channel / newsletter.
- Numbered click-instructions to access a resource ("1. click the link 2. click the channel 3. click the resource"), or links to a #free_resources type drop.
- Promoting their own product, tool, course, agent, or app (whether paid or free).
This is the case where WE opted into THEIR funnel and their automation is messaging us. It is NOT a lead.

"friend" - the sender is writing to the OPERATOR as a person, not as a prospect. They are someone the operator knows:
- Greeting the operator by their first name or a nickname the way an acquaintance would ("yo <first name>", "habibi", "bro is that you"), or claiming to know them: "it's me [name]", "we've talked before", "you know me", "I'm your student", "don't you remember me".
- Referencing shared history: a past conversation, a place they both were, a mutual friend, something the operator said to them personally, plans to meet up or catch up.
- Reacting to the operator's story or post as a mate would - banter, a joke, a comment on their day, "hahaha", with no prospect framing anywhere.
Family, friends, students and acquaintances all belong here. When someone is writing to the operator personally the setter must stay out of it and let them answer themselves.

A short keyword/code word the sender types AT US — a bare one-word first message like a code word from a story CTA - "info", "link", "guide", "free" — is the OPPOSITE of promoting: it is someone replying to OUR OWN story/post CTA to claim OUR freebie. That is a "lead". Direction matters: THEM sending us a keyword = our funnel = lead; only clear evidence that WE opted into THEIR resource is "promoting".

Only choose "selling", "promoting" or "friend" on CLEAR evidence. Mishandling a real lead is worse than letting one through, so when genuinely unsure choose "lead". In particular, a bare greeting on its own ("yo", "hey", "hi bro") is a LEAD replying to our opener, not a friend - "friend" needs the personal signal spelled out above.
- "reason" must be one short line.${whoWeAre(client)}`;
}

export interface ScreenerOutcome {
  /** Whether the normal reply pipeline should run after screening. */
  shouldReply: boolean;
  /**
   * Prior thread (oldest-first) to feed into the reply so it continues
   * seamlessly. Only set when the history exists in GHL but not yet in
   * Supabase (avoids duplicating context the reply already has).
   */
  priorHistory?: Message[];
}

/**
 * Run the first-contact screener for a lead whose leads.screened = false.
 * Always marks the lead screened. Returns whether the reply should proceed.
 */
export async function runFirstContactScreener(params: {
  client: Client;
  lead: Lead;
}): Promise<ScreenerOutcome> {
  const { client, lead } = params;
  const apiKey = client.ghl_api_key;
  const locationId = client.ghl_location_id;
  const contactId = lead.ghl_contact_id;

  // --- 0a. ONE VERDICT PER PERSON, EVEN IF THEY OPEN WITH A BURST. ---
  //
  // A brand-new lead whose first message is three bubbles arrives as three
  // concurrent invocations, and each one ran this whole function: three Claude
  // calls over the same thread, three verdicts that can disagree with each
  // other, and three chances to hand off — or, on the purge branch, to act
  // against — the same human. It also multiplied the GHL thread sync by three.
  //
  // The claim is a unique insert, the same lock the follow-up and nurture
  // engines already use: exactly one invocation writes the row, everyone else
  // gets 23505 and stands down. Whoever wins reaches the verdict and the others
  // simply do not reply, which is correct — the winner is replying for them.
  //
  // Fail OPEN on any other error: a claim that cannot be written must never be
  // able to silence a real first contact.
  const { error: claimErr } = await supabase.from("events").insert({
    client_id: client.id,
    lead_id: lead.id,
    event_type: "screen_claim",
    metadata: {},
  });
  if (claimErr && String((claimErr as { code?: string }).code) === "23505") {
    console.log("[screener] first-contact screen already claimed for this lead — standing down");
    return { shouldReply: false };
  }

  // --- 0. Import the REAL two-sided Instagram thread from GHL first. ---
  // Nothing has ever recorded the replies the owner types by hand in the Instagram
  // app, so our messages table held only role='lead' and role='ai'. Every
  // history check below therefore read a months-old friendship as a brand-new
  // lead. Syncing before we judge anything is what makes the rest of this
  // function see the conversation that actually happened. Best-effort: a sync
  // failure must not stop screening (the checks below still run on whatever we
  // do have), so it is logged and swallowed.
  try {
    const sync = await syncConversationFromGHL({ client, lead });
    if (sync.skipped) {
      console.log("[screener] GHL conversation sync skipped:", sync.skipped);
    } else {
      console.log(
        `[screener] GHL conversation sync: imported=${sync.imported} human=${sync.humanMessages} total=${sync.totalThread}`
      );
    }
  } catch (e) {
    console.error("[screener] GHL conversation sync failed:", e);
  }

  // --- 0b. HUMAN TAKEOVER = HARD STAND-DOWN. ---
  // If the owner has personally answered this person by hand, he is handling them.
  // His standing rule: when it is unclear whether someone is a lead or someone
  // he knows, stay silent and ping him. This is the check that would have
  // stopped the setter cold-opening his friends mid-conversation.
  let humanTakeover = false;
  try {
    humanTakeover = await threadHasHumanTakeover(lead.id);
  } catch (e) {
    console.error("[screener] human takeover check failed:", e);
  }
  if (humanTakeover) {
    return actHumanHandled(client, lead);
  }

  // --- 1. Pull the GHL thread (the source of truth for prior history). ---
  // A ManyChat-first lead has NO GHL contact yet — there is no GHL thread to
  // pull, so prior history comes from our own DB only (Supabase cross-check
  // below). That's not an error: it's a brand-new-contact situation.
  let thread: ThreadMessage[] | null = null;
  let fetchError: string | null = null;
  if (apiKey && locationId && contactId) {
    try {
      thread = await fetchContactThread(apiKey, locationId, contactId);
    } catch (e) {
      fetchError = e instanceof Error ? e.message : String(e);
      console.error("[screener] GHL thread fetch failed:", fetchError);
    }
  }

  // --- 2. How much prior history exists (GHL + Supabase as a cross-check)? ---
  // This reads the POST-SYNC state, so it now counts the owner's hand-typed
  // replies too, not just what the setter itself wrote.
  let supaPriorCount = 0;
  try {
    const supaMsgs = await getRecentMessages(lead.id, 50);
    supaPriorCount = Math.max(0, supaMsgs.length - 1); // minus the current inbound
  } catch (e) {
    console.error("[screener] supabase history read failed:", e);
  }
  const ghlHasPrior = thread !== null && thread.length > 1;
  const hasPrior = ghlHasPrior || supaPriorCount > 0;

  // --- 3. FAIL-CLOSED: error while a lead clearly HAS history => hold. ---
  if (fetchError && hasPrior) {
    return actHold(client, lead, "screener error on lead with history", fetchError);
  }

  // --- 4. No prior history even AFTER the sync => genuinely a new contact.
  //        Before engaging, classify that first message: a vendor pitch at us is
  //        erased entirely (no reply, no ping, gone from GHL + DB), a creator
  //        promoting their own thing is handed off, and someone writing to the owner
  //        personally is handed off too. Otherwise => engage. ---
  if (!hasPrior) {
    const firstContact = await classifyFirstContact(client, lead);
    if (firstContact?.kind === "selling") {
      return actPurgePitch(client, lead, firstContact.reason);
    }
    if (firstContact?.kind === "promoting") {
      // Creator/marketer pushing their own thing to us (e.g. a free-resource drop we
      // opted into). Not a lead - hand off to the owner, don't engage, don't delete.
      return actHandoffNotLead(client, lead, firstContact.reason);
    }
    if (firstContact?.kind === "friend") {
      // Someone writing to the owner personally. Until now this verdict lived ONLY
      // in the has-history branch, which is exactly the branch a friend with no
      // recorded history never reached. Same stand-down as a takeover: silent,
      // paused, pinged.
      return actSkipFriend(client, lead, firstContact.reason);
    }
    // Phase 5: do NOT tag `icp` at hello. A brand-new opener exchange carries
    // no fit signal yet — icp/qualified are applied later by ongoing tagging
    // once the conversation actually shows fit.
    await markScreened(lead);
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "screen_engage",
      metadata: { reason: "no prior history — brand new lead" },
    });
    return { shouldReply: true };
  }

  // --- 5. Has prior history => ONE Claude classification over the full thread. ---
  const source = thread && thread.length > 0 ? thread : await safeSupaThread(lead.id);
  let verdict: string;
  let reason: string;
  try {
    const out = await classify(screenerSystemPrompt(client), transcript(source));
    verdict = String(out.verdict || "").toLowerCase();
    reason = String(out.reason || "").slice(0, 300);
  } catch (e) {
    // Classifier failed on a lead WITH history => fail closed.
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[screener] classification failed:", msg);
    return actHold(client, lead, "classifier error", msg);
  }

  switch (verdict) {
    case "engage": {
      // Phase 5: engaging means "not owner/friend" — it is NOT a fit signal,
      // so we do not tag `icp` here. Ongoing tagging applies icp/qualified once
      // the conversation actually shows intent + financial capacity.
      await markScreened(lead);
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "screen_engage",
        metadata: { reason },
      });
      // Feed the reply everything GHL has that Supabase doesn't. Supabase only
      // holds the newest messages (capture started when the lead entered the
      // system), so the pre-Supabase PREFIX of the GHL thread is the missing
      // context — without it the setter opened conversations having "read"
      // only the last couple of messages of a long real history.
      const overlap = supaPriorCount + 1; // + the current inbound, already saved
      const priorHistory =
        thread && thread.length > overlap
          ? threadToMessages(thread.slice(0, thread.length - overlap))
          : undefined;
      return { shouldReply: true, priorHistory };
    }
    case "skip_owner":
      return actSkipOwner(client, lead, reason);
    case "skip_friend":
      return actSkipFriend(client, lead, reason);
    case "skip_their_funnel": {
      // STRUCTURAL GUARD (mirrors runOngoingTagging): a lead in OUR lead-magnet
      // flow can never be "their funnel" — the magnet exchange looks like a
      // funnel to the classifier and it kept pausing our own magnet leads.
      const magnetLead =
        Boolean(lead.magnet_state) || (await eventExists(lead.id, "lead_magnet_triggered"));
      if (magnetLead) {
        await markScreened(lead);
        await logEvent({
          client_id: client.id,
          lead_id: lead.id,
          event_type: "screen_engage",
          metadata: { reason: `their_funnel verdict VOIDED — this is OUR magnet lead (${reason})` },
        });
        return { shouldReply: true };
      }
      return actSkipTheirFunnel(client, lead, reason);
    }
    case "hold":
    default:
      return actHold(client, lead, reason || "unclear", null);
  }
}

/**
 * WE are the lead in THEIR funnel (the owner requested their freebie / opted into
 * their resource drop). The setter must never qualify these people — it reads
 * as a bot gone rogue to a peer creator. Tag + pause + one ping; never delete
 * (it's a real relationship the owner started on purpose).
 */
async function actSkipTheirFunnel(
  client: Client,
  lead: Lead,
  reason: string
): Promise<ScreenerOutcome> {
  if (client.ghl_api_key && lead.ghl_contact_id) {
    await addContactTags(client.ghl_api_key, lead.ghl_contact_id, [TAG_NEEDS_REVIEW]);
  }
  await pauseLead({ client, lead, notify: { label: "Standing down - this is THEIR funnel (you requested their freebie)", reason } });
  await logEvent({
    client_id: client.id,
    lead_id: lead.id,
    event_type: "screen_skip_their_funnel",
    metadata: { reason },
  });
  await markScreened(lead);
  return { shouldReply: false };
}

// --- Part A action helpers (each: tag + pause + ping + event + screened) ---

async function actSkipOwner(
  client: Client,
  lead: Lead,
  reason: string
): Promise<ScreenerOutcome> {
  if (client.ghl_api_key && lead.ghl_contact_id) {
    await addContactTags(client.ghl_api_key, lead.ghl_contact_id, [TAG_BIZ_OWNER]);
  }
  await pauseLead({ client, lead, notify: { label: "Take over - established biz owner", reason } });
  await logEvent({
    client_id: client.id,
    lead_id: lead.id,
    event_type: "screen_skip_owner",
    metadata: { reason },
  });
  await markScreened(lead);
  return { shouldReply: false };
}

/**
 * The owner has been answering this person by hand in the Instagram app, so the
 * thread is his, not the setter's. The pause is PERMANENT and deliberate (his
 * explicit choice over anything that expires): a thread he took over should
 * never silently hand itself back to the AI.
 */
export async function standDownForHumanTakeover(
  client: Client,
  lead: Lead
): Promise<void> {
  await actHumanHandled(client, lead);
}

async function actHumanHandled(
  client: Client,
  lead: Lead
): Promise<ScreenerOutcome> {
  const reason = "you have been replying to this person by hand in Instagram";
  if (client.ghl_api_key && lead.ghl_contact_id) {
    await addContactTags(client.ghl_api_key, lead.ghl_contact_id, [TAG_NEEDS_REVIEW]);
  }
  await pauseLead({
    client,
    lead,
    notify: {
      label: "Standing down - you are handling this one yourself",
      reason,
    },
  });
  await logEvent({
    client_id: client.id,
    lead_id: lead.id,
    event_type: "screen_human_handled",
    metadata: { reason },
  });
  await markScreened(lead);
  return { shouldReply: false };
}

async function actSkipFriend(
  client: Client,
  lead: Lead,
  reason: string
): Promise<ScreenerOutcome> {
  if (client.ghl_api_key && lead.ghl_contact_id) {
    // "needs review" alongside "friend": every friend verdict is a request for
    // The owner to look, not a filing decision the AI makes on its own.
    await addContactTags(client.ghl_api_key, lead.ghl_contact_id, [
      TAG_FRIEND,
      TAG_NEEDS_REVIEW,
    ]);
  }
  await pauseLead({ client, lead, notify: { label: "Take over - friend", reason } });
  await setDisqualifyReason(lead.id, "friend_family"); // Phase 6
  await logEvent({
    client_id: client.id,
    lead_id: lead.id,
    event_type: "screen_skip_friend",
    metadata: { reason },
  });
  await markScreened(lead);
  return { shouldReply: false };
}

async function actHold(
  client: Client,
  lead: Lead,
  reason: string,
  error: string | null
): Promise<ScreenerOutcome> {
  if (client.ghl_api_key && lead.ghl_contact_id) {
    await addContactTags(client.ghl_api_key, lead.ghl_contact_id, [TAG_NEEDS_REVIEW]);
  }
  await pauseLead({ client, lead, notify: { label: "Review - unclear", reason } });
  await logEvent({
    client_id: client.id,
    lead_id: lead.id,
    event_type: "screen_hold",
    metadata: error ? { reason, error } : { reason },
  });
  await markScreened(lead);
  return { shouldReply: false };
}

/**
 * Decide what a brand-new contact's FIRST message actually is: an unsolicited
 * pitch at us, a creator promoting their own thing, someone writing to the owner
 * personally, or a real lead. Returns null for "lead". FAIL-SAFE by design: a
 * null result means "engage as a normal lead", so on an empty thread, a
 * classifier error, or any ambiguity we return null and NEVER delete the
 * contact.
 */
async function classifyFirstContact(
  client: Client | null,
  lead: Lead
): Promise<{ kind: "selling" | "promoting" | "friend"; reason: string } | null> {
  // The first inbound (plus any burst) is already in Supabase at this point.
  const msgs = await safeSupaThread(lead.id);
  if (msgs.length === 0) return null; // nothing to judge => treat as a lead

  try {
    const out = await classify(pitchScreenerSystemPrompt(client), transcript(msgs));
    const kind = String(out.kind || "lead").toLowerCase();
    const reason = String(out.reason || "").slice(0, 300);
    if (kind === "selling") return { kind: "selling", reason: reason || "unsolicited service pitch" };
    if (kind === "promoting") return { kind: "promoting", reason: reason || "creator marketing to us, not a lead" };
    if (kind === "friend") return { kind: "friend", reason: reason || "writing to you personally, not as a prospect" };
    return null; // "lead" (or anything unexpected) => engage normally
  } catch (e) {
    // Never act on a classifier failure — fall through to the normal engage path.
    console.error("[screener] first-contact classify failed (engaging as lead):", e);
    return null;
  }
}

/**
 * A creator/marketer whose FIRST message is promoting THEIR OWN thing to us (a free
 * resource, a community invite, their product/tool) - we opted into THEIR funnel, so
 * they're NOT our lead. Unlike a hard vendor pitch we do NOT delete a real person:
 * pause the AI, tag "needs review", and hand off to the owner. He decides what the
 * relationship is. Never engages them as a lead.
 */
async function actHandoffNotLead(
  client: Client,
  lead: Lead,
  reason: string
): Promise<ScreenerOutcome> {
  if (client.ghl_api_key && lead.ghl_contact_id) {
    await addContactTags(client.ghl_api_key, lead.ghl_contact_id, [TAG_NEEDS_REVIEW]);
  }
  await pauseLead({ client, lead, notify: { label: "Not a lead - they're marketing to us", reason } });
  await logEvent({
    client_id: client.id,
    lead_id: lead.id,
    event_type: "screen_not_lead",
    metadata: { reason },
  });
  await markScreened(lead);
  return { shouldReply: false };
}

/**
 * Erase an unsolicited pitcher caught at first contact. Per the owner's rule they
 * must "not exist": no reply, no Telegram ping, removed from GHL and the DB.
 * We snapshot a tiny audit record (with lead_id = null, since the lead row is
 * being deleted) so a wrongly-purged real lead can still be traced. Each step
 * is best-effort; failures are logged but never thrown.
 */
async function actPurgePitch(
  client: Client,
  lead: Lead,
  reason: string
): Promise<ScreenerOutcome> {
  const audit = {
    reason,
    ghl_contact_id: lead.ghl_contact_id,
    ig_username: lead.ig_username,
    full_name: lead.full_name,
  };

  // 1. Remove the contact from GHL entirely (best-effort). The CRM is the one
  //    place the owner genuinely wants spam gone from, and this half is unchanged.
  if (client.ghl_api_key && lead.ghl_contact_id) {
    const r = await deleteContact(client.ghl_api_key, lead.ghl_contact_id);
    if (!r.success) {
      console.error("[screener] purge: GHL deleteContact failed:", r.error);
    }
  } else {
    console.error("[screener] purge: missing GHL creds, contact NOT deleted");
  }

  // 2. QUARANTINE, NOT DELETE (2026-08-09).
  //
  //    This used to call purgeLead: the lead row, its messages, its decisions
  //    and its events, all gone. One classifier call, no human in the loop, and
  //    the person ceased to exist in the system.
  //
  //    The owner: "Turn Oscar off. You should not tell me, oh, there is no Oscar in
  //    the system." A hard delete is precisely how a real person becomes
  //    un-turn-off-able: he cannot pause someone who is not there, cannot see
  //    what was said, and cannot undo a verdict he never saw made. And the
  //    classifier only has to be wrong once — a student opening with "yo bro
  //    check out what I built" reads a lot like a pitch.
  //
  //    So the row stays, marked and silenced. It is out of every working view
  //    (status is not 'engaged'), it can never be replied to (ai_paused, and
  //    every pause flag set so no follow-up or nurture can wake it), the thread
  //    is preserved as the evidence for the verdict, and the owner can find the
  //    person and overrule it. ghl_contact_id is cleared because that contact
  //    was just deleted and a stale id would 404 on every later write.
  const { error: quarantineErr } = await supabase
    .from("leads")
    .update({
      status: "purged_pitch",
      ghl_contact_id: null,
      ai_paused: true,
      nurture_paused: true,
      followup_paused: true,
      whale_paused: true,
      disqualify_reason: "unsolicited_pitch",
    })
    .eq("id", lead.id);
  if (quarantineErr) {
    console.error("[screener] purge: quarantine update failed:", quarantineErr.message);
  }

  // 3. Audit event, now carrying the lead_id — the whole point is that this
  //    person is still there to be looked up and reinstated.
  await logEvent({
    client_id: client.id,
    lead_id: lead.id,
    event_type: "screen_purge_pitch",
    metadata: audit,
  });

  console.log("[screener] quarantined unsolicited pitcher:", JSON.stringify(audit));
  return { shouldReply: false };
}

// ---------------------------------------------------------------------------
// PART B — ongoing tagging (engaged ICP leads only)
// ---------------------------------------------------------------------------

/**
 * Build the Part B system prompt. "qualified" is defined ENTIRELY by the
 * operator's own criteria (their system prompt + business context) — we never
 * invent a new definition.
 */
export function buildOngoingSystemPrompt(client: Client): string {
  const criteria = [client.system_prompt, client.business_context]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join("\n\n");

  return `You are a lightweight classifier for an Instagram DM setter. A lead is in an ongoing conversation. Read the WHOLE conversation and decide the fields below. Be CONSERVATIVE — default to the non-committal value. NEVER decide anything off a greeting, a single location, or one trivial reply.

Return ONLY strict minified JSON, nothing else, no prose, no code fences:
{"qualified":bool,"icp":bool,"biz_owner":bool,"their_funnel":bool,"personal_claim":bool,"disqualify":"none|financial|no_intent","reason":"<one line>"}

- "qualified" (HARD GATE — both must be clearly confirmed in the conversation):
   (1) INTENT: the lead clearly wants to make money online / start or grow online income, AND
   (2) MONEY: the lead has the financial capacity to invest (can afford to pay for help, has income/savings/funds).
   If EITHER is missing or only implied, qualified=false. Never qualified from a greeting, a location, or one trivial answer.
- "icp": a SOFTER "looks like a fit". TRUE when there is REAL signal they fit (clearly wants online income / right profile), even before money is confirmed. Still NEVER true at hello or from a bare greeting/location.
- "biz_owner": TRUE only if it is clear they ALREADY run an established online business at roughly $3k+/month.
- "personal_claim": TRUE when the LEAD claims to already KNOW the operator personally, outside of this sales conversation: "it's me [name]", "we've talked before", "I know you / you know me", "I'm his friend", "I'm your student", "habibi it's ...", "don't you remember me", references to having met, hung out, or messaged before. A first-name introduction alone ("I'm John") is NOT a claim; knowing the OPERATOR is. When TRUE the human owner takes over, so only set it on a real claim, not a joke or a hypothetical.
- "their_funnel": TRUE only on CLEAR evidence that WE are the lead in THEIR funnel — they gated a freebie on following them ("hit that follow & I'll slide it over"), delivered a lead magnet to us ("here's that resource I promised"), sent numbered click-instructions to their community/Skool/Discord/#free_resources, or WE clearly messaged them first to receive something. A normal lead asking US questions is NEVER their_funnel. A short keyword the LEAD sent US ("bdp", "pdp", "info", "link") is a reply to OUR OWN funnel CTA → their_funnel=false. Direction is everything: only WE opting into THEIR resource counts.
- "disqualify": set "financial" ONLY when the LEAD THEMSELVES has explicitly stated a clear, PERMANENT inability to ever invest — they say in their own words that they fundamentally cannot afford this and that will not change (e.g. "I could never afford that", "I have no money and no way to ever get any"). "financial" is ALWAYS about a statement they made about THEIR OWN money. NEVER infer it from where someone lives, their nationality, their country, their city, their currency, their language, their name, or any assumption about how wealthy that place is. Where a person is from is NOT evidence about their money, and it is NEVER a reason to disqualify here. A TEMPORARY money situation is NOT a financial disqualify — keep it "none" so the setter can HANDLE it as an objection: "no savings right now", "money's tight at the moment", "broke this month", "need to save up first", "just got back from a trip", "not right now" all stay "none". Set "no_intent" ONLY if the lead EXPLICITLY says they do not want to make money / start an online business / are not interested at all (e.g. "I don't want a business", "not interested in making money", "stop messaging me", "leave me alone"). SKEPTICISM IS NOT no_intent — doubt, pushback or probing such as "I don't think you can help me", "why would you help me / what do you get out of it", "is this a scam", "what's the catch", "prove it", or general resistance ALL stay "none" so the setter can handle them (a skeptical lead is usually an INTERESTED lead testing you). Otherwise "none". Be very conservative — do not disqualify off thin or early threads, and when unsure, choose "none". (Friends/family are handled elsewhere — do not use disqualify for them. Business owners are handed off, never disqualified.)
- "reason": one short line.

Operator's qualification context (supporting signal only — the intent+money gate above is mandatory):
<criteria>
${criteria || "(no explicit criteria provided)"}
</criteria>`;
}

/**
 * Part B: classify an engaged lead's conversation and tag accordingly.
 * Runs alongside the reply; must never block it. On any error: log + skip.
 */
export async function runOngoingTagging(params: {
  client: Client;
  lead: Lead;
}): Promise<void> {
  const { client, lead } = params;
  try {
    // THROTTLE + RACE GUARD: this now runs on the primary reply path (every
    // inbound), so a 2-3 message burst would spawn concurrent classifier runs
    // whose check-then-act guards race (double "take over" pings) and pay
    // Sonnet over the full transcript several times for one exchange. One run
    // per lead per 45s: the run-marker event is logged BEFORE the classifier
    // call, so the burst's later invocations see it and skip.
    const THROTTLE_S = 45;
    const sinceIso = new Date(Date.now() - THROTTLE_S * 1000).toISOString();
    const ranRecently = await recentEventExists({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "ongoing_tagging_run",
      since_iso: sinceIso,
    });
    if (ranRecently) return;
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "ongoing_tagging_run",
      metadata: {},
    });

    const msgs = await getRecentMessages(lead.id, 50);
    if (msgs.length === 0) return;

    const out = await classify(
      buildOngoingSystemPrompt(client),
      transcript(msgs.map((m) => ({ role: m.role, content: m.content })))
    );
    const qualified = out.qualified === true;
    const icp = out.icp === true;
    const bizOwner = out.biz_owner === true;
    const theirFunnel = out.their_funnel === true;
    const personalClaim = out.personal_claim === true;
    const disqualify = String(out.disqualify || "none").toLowerCase();
    const reason = String(out.reason || "").slice(0, 300);

    // PERSONAL-CLAIM HANDOFF (owner incident: Asyah said "it's Asyah, you
    // know me" and the setter kept qualifying her; Oskar is a student and got
    // funnel questions). The moment someone says they KNOW the owner, the AI
    // stops and the owner gets pinged. Highest precedence: a friend claim beats
    // every other verdict this turn. Once per lead.
    if (personalClaim) {
      const already = await eventExists(lead.id, "personal_claim_handoff");
      if (!already) {
        if (client.ghl_api_key && lead.ghl_contact_id) {
          await addContactTags(client.ghl_api_key, lead.ghl_contact_id, [TAG_FRIEND, TAG_NEEDS_REVIEW]);
        }
        await pauseLead({
          client,
          lead,
          notify: { label: "Take over - they say they KNOW you (friend/student?)", reason },
        });
        await logEvent({
          client_id: client.id,
          lead_id: lead.id,
          event_type: "personal_claim_handoff",
          metadata: { reason },
        });
      }
      return;
    }

    // STRUCTURAL GUARD (not a prompt rule — those failed twice live): a lead
    // who triggered OUR lead magnet ("reply BDP") can NEVER be "their funnel".
    // The magnet exchange (keyword -> email ask -> link) structurally LOOKS
    // like a funnel to the classifier, and it kept pausing OUR OWN magnet
    // leads mid-flow despite explicit direction rules in the prompt. If the
    // magnet ever touched this lead, the their_funnel verdict is void.
    const magnetLead =
      Boolean(lead.magnet_state) || (await eventExists(lead.id, "lead_magnet_triggered"));

    // Their funnel takes precedence over everything: WE requested THEIR freebie
    // (opted into their resource drop), so the setter must stop treating them
    // as a lead — retroactive protection for threads screened before this
    // detection existed. Pause + tag once; the owner decides the relationship.
    if (theirFunnel && !magnetLead) {
      const already = await eventExists(lead.id, "screen_skip_their_funnel");
      if (!already) {
        if (client.ghl_api_key && lead.ghl_contact_id) {
          await addContactTags(client.ghl_api_key, lead.ghl_contact_id, [TAG_NEEDS_REVIEW]);
        }
        await pauseLead({ client, lead, notify: { label: "Standing down - this is THEIR funnel (you requested their freebie)", reason } });
        await logEvent({
          client_id: client.id,
          lead_id: lead.id,
          event_type: "screen_skip_their_funnel",
          metadata: { reason, via: "ongoing" },
        });
      }
      return;
    }

    // biz_owner takes precedence: established online business => handoff (NOT a
    // disqualify; we never set disqualify_reason for owners).
    if (bizOwner) {
      if (client.ghl_api_key && lead.ghl_contact_id) {
        await removeContactTags(client.ghl_api_key, lead.ghl_contact_id, [
          TAG_ICP,
          TAG_QUALIFIED,
        ]);
        await addContactTags(client.ghl_api_key, lead.ghl_contact_id, [TAG_BIZ_OWNER]);
      }
      await pauseLead({ client, lead, notify: { label: "Take over - established biz owner", reason } });
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "handoff_biz_owner",
        metadata: { reason },
      });
      return;
    }

    // Phase 6: clear financial / no-intent disqualify => record reason, tag,
    // pause, log (once). Conservative classifier guards against false positives.
    if (disqualify === "financial" || disqualify === "no_intent") {
      const already = await eventExists(lead.id, "lead_disqualified");
      if (!already) {
        await setDisqualifyReason(lead.id, disqualify);
        if (client.ghl_api_key && lead.ghl_contact_id) await addContactTags(client.ghl_api_key, lead.ghl_contact_id, [TAG_DISQUALIFIED]);
        await pauseLead({ client, lead, notify: { label: "Disqualified (auto-paused)", reason: `${disqualify} — ${reason}` } });
        await logEvent({
          client_id: client.id,
          lead_id: lead.id,
          event_type: "lead_disqualified",
          metadata: { reason: disqualify, note: reason },
        });
      }
      return;
    }

    // Phase 5: `qualified` (hard gate intent+money) and `icp` (softer fit) are
    // SEPARATE tags. Apply each once, keyed off its logged event. Never at hello
    // (the classifier already enforces that).
    if (qualified) {
      const already = await eventExists(lead.id, "tag_qualified");
      if (!already) {
        if (client.ghl_api_key && lead.ghl_contact_id) await addContactTags(client.ghl_api_key, lead.ghl_contact_id, [TAG_QUALIFIED]);
        await logEvent({
          client_id: client.id,
          lead_id: lead.id,
          event_type: "tag_qualified",
          metadata: { reason },
        });
      }
    }
    if (icp) {
      const already = await eventExists(lead.id, "tag_icp");
      if (!already) {
        if (client.ghl_api_key && lead.ghl_contact_id) await addContactTags(client.ghl_api_key, lead.ghl_contact_id, [TAG_ICP]);
        await logEvent({
          client_id: client.id,
          lead_id: lead.id,
          event_type: "tag_icp",
          metadata: { reason },
        });
      }
    }
  } catch (e) {
    // Never let tagging affect the reply path.
    console.error("[screener] ongoing tagging failed:", e);
  }
}

// ---------------------------------------------------------------------------
// internal mappers
// ---------------------------------------------------------------------------

function threadToMessages(thread: ThreadMessage[]): Message[] {
  return thread.map((m) => ({
    role: m.role,
    content: m.content,
    created_at: m.created_at,
  }));
}

/** Fallback transcript source from Supabase if the GHL thread is unavailable. */
async function safeSupaThread(
  lead_id: string
): Promise<Array<{ role: string; content: string }>> {
  try {
    const msgs = await getRecentMessages(lead_id, 50);
    return msgs.map((m) => ({ role: m.role, content: m.content }));
  } catch {
    return [];
  }
}
