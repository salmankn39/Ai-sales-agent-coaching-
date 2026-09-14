/**
 * DRAFT — compose the message the AI setter WOULD send a lead next, WITHOUT
 * sending it. Reuses the exact production brain: the lead's real thread, the
 * live funnel stage rail, the locked conversation language, and the client's
 * own SOP / voice / rules. So HQ and the Telegram bot can hand the owner a
 * ready-to-send reply for any lead — especially one the setter turned off.
 *
 * READ-ONLY: never sends, never writes to the lead. Pure compose.
 */
import { supabase, type Lead } from "./supabase";
import { generateReply } from "./brain";
import { parseStages, resolveStage } from "./stages";
import { makeVoiceClip, voiceEligible } from "./voice";
import type { ClientConfig, Message, StageContext, LanguageDirective } from "./prompts/master";

export interface DraftResult {
  /** The reply split into real send-ready bubbles (voice markers stripped). */
  bubbles: string[];
  /** The bubbles joined with newlines — convenient for a single paste. */
  text: string;
  /** The funnel stage the draft was railed to (null for legacy/no-stage clients). */
  stage: string | null;
  /** The language the draft was written in. */
  language: "en" | "sv";
  /** Voice draft only: hosted mp3 of the spoken reply in the cloned voice (null if none). */
  voiceUrl?: string | null;
  /** True when a voice clip was actually produced. */
  voiced?: boolean;
  /** When voice was requested but skipped/failed, a short plain reason for the UI. */
  voiceNote?: string;
}

/** Compose a voice draft AS A SINGLE SPOKEN voice note. Same brain/rules — this
 *  just steers the one reply into a clean spoken line that synthesizes well. */
const VOICE_DRAFT_INSTRUCTION = `DRAFT THIS REPLY AS A SINGLE SPOKEN VOICE NOTE in the operator's real voice:
- ONE natural, casual spoken thought (~1-4 sentences). Do NOT use [[SPLIT]] or [[VOICE]] markers.
- FULL, correctly-spelled words with normal punctuation, because it is SPOKEN OUT LOUD ("are you with me" — never "r u w me"). Keep your real casual tone.
- Do NOT include any link, price, specific time, or numbers the listener would have to read — a voice note can't carry those (if this beat genuinely needs one, write it normally and it'll be kept as text instead).`;

/** Strip the internal [[VOICE]] marker so a drafted bubble reads as plain text. */
function stripMarkers(s: string): string {
  return s.replace(/^\s*\[\[voice\]\]\s*/i, "").trim();
}

/** The one follow-up the setter itself would send to re-open a cold thread.
 *  Used by the cold-draft sweep: Instagram's 24h automation window is closed,
 *  so the draft goes to the owner on Telegram and HE sends it from the IG app. */
function followUpInstruction(daysQuiet: number): string {
  return `FOLLOW-UP MODE: the lead has gone quiet for about ${daysQuiet} days since your last message. Write the ONE follow-up you would send right now to re-open this conversation: short, casual, zero guilt-tripping, referencing where the conversation actually left off (do not repeat your last message or summarize the thread). No links unless the conversation was already at the booking step. Do NOT use [[VOICE]]. One to two bubbles max.`;
}

/**
 * Compose (don't send) the setter's next reply for a lead. Throws
 * "no_pending_lead_message" when the lead's last message isn't inbound (there's
 * nothing to reply to) — unless composing a follow-up, where OUR message being
 * last is the whole point.
 */
export async function draftReplyForLead(params: {
  // The full client row (clients.* — carries the SOP/voice/rules + stages + pain config).
  client: Record<string, unknown> & { id: string };
  lead: Lead;
  // When true, also produce the reply as a VOICE NOTE (English only; Swedish
  // conversations always stay text). The text is still returned regardless.
  voice?: boolean;
  // Force the draft language (otherwise it mirrors the lead's locked language).
  languageOverride?: "en" | "sv";
  // Compose a re-opener for a lead who's gone quiet for ~daysQuiet days since
  // OUR last message (text only — the owner pastes it into the IG app himself).
  followUp?: { daysQuiet: number };
}): Promise<DraftResult> {
  const { client, lead, followUp } = params;
  const wantVoice = params.voice === true;

  // Pull the real thread, oldest first — the same window the live setter reads.
  const { data: msgs } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("lead_id", lead.id)
    .order("created_at", { ascending: false })
    .limit(20);
  const history: Message[] = ((msgs ?? []) as { role: string; content: string; created_at: string }[])
    .reverse()
    .map((m) => ({ role: m.role as Message["role"], content: String(m.content ?? ""), created_at: m.created_at }));

  // A reply only makes sense when the lead spoke last (mirror the brain's
  // guard). A FOLLOW-UP is the opposite case by definition — in a cold ghost
  // the last message is OURS — so the guard is skipped there.
  if (!followUp && (!history.length || history[history.length - 1].role !== "lead")) {
    throw new Error("no_pending_lead_message");
  }

  // Language: mirror the live lock — only a fully-locked "sv" writes Swedish —
  // unless the owner explicitly overrides which language to draft in.
  const draftLang: "en" | "sv" =
    params.languageOverride === "sv" ? "sv"
    : params.languageOverride === "en" ? "en"
    : (lead as { conversation_language?: string | null }).conversation_language === "sv" ? "sv" : "en";
  const language: LanguageDirective | undefined = draftLang === "sv" ? "lock_sv" : undefined;

  // Stage rail: reproduce the live funnel position when the client has stages.
  // (No live GHL calendar fetch for a draft — the Book stage just gives a range.)
  let stage: StageContext | undefined;
  const stages = parseStages((client as { stages?: unknown }).stages);
  if (stages.length) {
    const resolution = await resolveStage({
      stages,
      currentStageId: lead.funnel_stage ?? null,
      stageData: (lead.stage_data ?? {}) as Record<string, unknown>,
      messages: history.map((m) => ({ role: m.role, content: m.content })),
      painEnabled: (client as { pain_dig_enabled?: boolean }).pain_dig_enabled === true,
      painProtocol: (client as { pain_protocol?: string | null }).pain_protocol ?? null,
      whaleEnabled: false,
    });
    stage = {
      name: resolution.stage.name,
      goal: resolution.stage.goal,
      playbook: resolution.stage.playbook,
      knownFacts: resolution.stageData,
      objection: resolution.objection,
      funnelMap: stages.map((s) => s.name),
    };
  }

  // In follow-up mode the REAL thread ends with our own message, but the brain
  // (correctly) refuses to generate unless the conversation ends on a lead
  // turn — a trailing assistant message would read as a prefill to continue.
  // So the generation call gets ONE synthetic lead turn describing the silence
  // (the stage rail above already ran on the real thread only).
  const genHistory: Message[] = followUp
    ? [
        ...history,
        {
          role: "lead",
          content: `[no reply from the lead for about ${followUp.daysQuiet} days — write your one follow-up to re-open this conversation]`,
          created_at: new Date().toISOString(),
        },
      ]
    : history;

  const result = await generateReply({
    client: client as unknown as ClientConfig,
    history: genHistory,
    stage,
    language,
    extraInstruction: followUp
      ? followUpInstruction(followUp.daysQuiet)
      : wantVoice
      ? VOICE_DRAFT_INSTRUCTION
      : undefined,
  });

  const bubbles = (result.segments || [])
    .map(stripMarkers)
    .filter(Boolean)
    .slice(0, 4);
  const finalBubbles = bubbles.length ? bubbles : [stripMarkers(result.reply)].filter(Boolean);
  const base: DraftResult = {
    bubbles: finalBubbles,
    text: finalBubbles.join("\n"),
    stage: stage?.name ?? null,
    language: draftLang,
  };

  if (!wantVoice) return base;

  // VOICE DRAFT — English only. Swedish conversations stay text (the owner's rule).
  if (draftLang === "sv") {
    return { ...base, voiced: false, voiceNote: "Swedish conversations stay text — the Swedish voice is off." };
  }
  const voiceId = (client as { setter_voice_id?: string | null }).setter_voice_id || "";
  if (!voiceId) {
    return { ...base, voiced: false, voiceNote: "No cloned voice is set up to speak this." };
  }
  // Speak the whole drafted line as one note — but only if it carries nothing a
  // listener would have to read (link/price/time); otherwise it stays text.
  const spoken = finalBubbles.join(" ").trim();
  if (!voiceEligible(spoken)) {
    return { ...base, voiced: false, voiceNote: "This one has a link, price, or specific time — it should go as text." };
  }
  const voiceUrl = await makeVoiceClip(spoken, voiceId);
  return {
    ...base,
    voiceUrl,
    voiced: !!voiceUrl,
    voiceNote: voiceUrl ? undefined : "Couldn't generate the voice clip — here's the text instead.",
  };
}
