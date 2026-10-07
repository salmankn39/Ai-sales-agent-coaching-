/**
 * TEST ENDPOINT (multi-tenant aware)
 * -----------------------------------
 * Chat with the AI directly, no GHL involvement.
 *
 * Usage:
 *   POST /api/test
 *   {
 *     "message": "hey are you taking new clients?",
 *     "session_id": "test-session-1",       // optional: groups messages into a fake convo
 *     "client_slug": "teu"                   // optional: which client's training to use (default your DEFAULT_CLIENT_SLUG)
 *   }
 *
 * For testing a different client (e.g. once you onboard a tattoo studio):
 *   { "message": "...", "client_slug": "ink-lab" }
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getClient,
  findOrCreateLead,
  getRecentMessages,
  saveMessage,
  updateLeadStage,
  logAIDecision,
  supabase,
} from "@/lib/supabase";
import { generateReply, PRODUCTION_MODEL } from "@/lib/brain";
import { resolveStage, parseStages } from "@/lib/stages";
import { painDigInstruction, painProtocolFor } from "@/lib/paindig";
import { resolveConversationLanguage } from "@/lib/language";
import { getFreeSlots } from "@/lib/ghl";
import { countryToTimezone } from "@/lib/timezones";
import { isRepeatReply } from "@/lib/dedup";
import { makeVoiceClip, voiceActive, voiceEligible, voiceIdForLang, VOICE_INSTRUCTION, VOICE_MARKER_RE } from "@/lib/voice";
import { type StageContext, type LanguageDirective } from "@/lib/prompts/master";
import { getAccessKey } from "@/lib/prompter/access";
import { ownerSlug } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const maxDuration = 45; // voiced demo replies add ElevenLabs TTS latency

export async function POST(req: NextRequest) {
  // LOCKED (audit 2026-08-13). This route runs the full production brain
  // (Anthropic + ElevenLabs spend), writes into the LIVE leads/messages
  // tables, and returns the client's real open calendar slots - and it was
  // reachable by any stranger on the internet with zero auth. Same key gate
  // as every other operator route.
  const k = req.nextUrl.searchParams.get("k") ?? "";
  const accessKey = await getAccessKey();
  if (!accessKey || k !== accessKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    message?: string;
    session_id?: string;
    client_slug?: string;
    reset?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sessionId = body.session_id || "test-default";
  const clientSlug = body.client_slug || ownerSlug();
  const fakeContactId = `test::${clientSlug}::${sessionId}`;

  const client = await getClient(clientSlug);
  if (!client) {
    return NextResponse.json(
      { error: `Client '${clientSlug}' not configured` },
      { status: 404 }
    );
  }

  if (body.reset) {
    await supabase
      .from("leads")
      .delete()
      .eq("client_id", client.id)
      .eq("ghl_contact_id", fakeContactId);
    return NextResponse.json({ ok: true, reset: true, client: clientSlug });
  }

  if (!body.message?.trim()) {
    return NextResponse.json({ error: "Missing message" }, { status: 400 });
  }

  const lead = await findOrCreateLead({
    client_id: client.id,
    ghl_contact_id: fakeContactId,
    full_name: `Test Session ${sessionId} (${clientSlug})`,
  });

  if (!lead) {
    return NextResponse.json({ error: "Failed to create test lead" }, { status: 500 });
  }

  await saveMessage({
    lead_id: lead.id,
    client_id: client.id,
    role: "lead",
    content: body.message,
    channel: "test",
  });

  const dbMessages = await getRecentMessages(lead.id, 50);
  const history = dbMessages.map((m) => ({
    role: m.role,
    content: m.content,
    created_at: m.created_at,
  }));
  // Runtime fact, not something the model has to infer: true only when no
  // prior "ai"/"human" turn exists anywhere in this lead's history, i.e. the
  // message we're about to generate really is the first reply ever sent to
  // this person. Computed here (not guessed by the model from a large prompt)
  // so it can be handed to the AI as an explicit directive instead of relying
  // on it noticing the absence of earlier assistant turns.
  const isFirstReply = dbMessages.every((m) => m.role === "lead");

  // Run the SAME brain the real setter (the GHL webhook) uses, so the Test Chat
  // is a faithful rehearsal: stage engine + "dig deeper into pain" + live
  // calendar slots on the book stage + Swedish language detection. Best-effort:
  // any failure falls back to a plain reply, so the test never hard-fails.
  // (The only deliberate differences vs live are background/timing things that
  // can't exist in a synchronous chat box: the rapid-fire reply debounce, and
  // the proactive nurture/follow-up/pipeline sends that fire later via timers.)
  let stageContext: StageContext | undefined;
  let painInstruction: string | undefined;
  let resolvedStageData: Record<string, unknown> = lead.stage_data ?? {};
  let disqualifyNote: string | undefined;
  try {
    const stages = parseStages(client.stages);
    if (stages.length > 0) {
      const resolution = await resolveStage({
        stages,
        currentStageId: lead.funnel_stage ?? null,
        stageData: lead.stage_data ?? {},
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        painEnabled: client.pain_dig_enabled === true,
        painProtocol: client.pain_protocol ?? null,
      });
      resolvedStageData = resolution.stageData;
      await updateLeadStage({
        lead_id: lead.id,
        stage: resolution.stage.id,
        stage_data: resolution.stageData,
      });

      // Disqualify branch — the live setter pauses + pings + sends nothing here.
      // In the sandbox we surface a note instead of going silently dead.
      if (resolution.disqualify) {
        disqualifyNote = `[the live setter would DISQUALIFY + pause here — reason: ${resolution.reason}]`;
      }

      // Book stage → pull Ethan's REAL open slots (in the lead's timezone),
      // exactly like production, so "what times are free" offers real availability.
      let availableSlots: string[] | undefined;
      const leadTimezone =
        countryToTimezone(
          typeof resolution.stageData.location === "string" ? resolution.stageData.location : null
        ) || client.timezone;
      if (resolution.stage.id === "book" && client.ghl_calendar_id && client.ghl_api_key) {
        try {
          const free = await getFreeSlots(client.ghl_api_key, client.ghl_calendar_id, {
            timezone: leadTimezone,
          });
          availableSlots = free.slots;
        } catch (err) {
          console.error("[test] getFreeSlots failed:", err);
        }
      }

      stageContext = {
        name: resolution.stage.name,
        goal: resolution.stage.goal,
        playbook: resolution.stage.playbook,
        knownFacts: resolution.stageData,
        objection: resolution.objection,
        funnelMap: stages.map((s) => s.name),
        availableSlots,
        slotsTimezone: leadTimezone,
      };
      if (resolution.digPain) {
        painInstruction = painDigInstruction(
          painProtocolFor(client.pain_protocol),
          resolution.stageData
        );
      }
    }
  } catch (err) {
    console.error("[test] stage/pain resolution failed — plain reply:", err);
  }

  // Conversation language (detect Swedish, ask once, then lock) — same as live.
  let languageDirective: LanguageDirective | undefined;
  try {
    const knownLocation = resolvedStageData?.location ?? lead.stage_data?.location;
    const lang = await resolveConversationLanguage({
      current: lead.conversation_language,
      history,
      knownLocation: typeof knownLocation === "string" ? knownLocation : undefined,
    });
    languageDirective = lang.directive ?? undefined;
    if (lang.state !== (lead.conversation_language ?? "en")) {
      await supabase.from("leads").update({ conversation_language: lang.state }).eq("id", lead.id);
    }
  } catch (err) {
    console.error("[test] language resolution failed:", err);
  }

  // Voice notes: same decision as live (enabled + clone id + English thread).
  // The Test Chat can't play audio in the browser, so a voiced message is shown
  // with a 🎤 marker — enough to verify the DECISION; the real audio test is a
  // live IG DM.
  const voiceOn = voiceActive({
    enabled: client.voice_enabled,
    enabledSv: client.voice_enabled_sv === true,
    voiceId: client.setter_voice_id,
    voiceIdSv: client.setter_voice_id_sv,
    langState: languageDirective === "lock_sv" ? "sv" : "en",
  });
  const voiceId = voiceIdForLang({
    voiceId: client.setter_voice_id,
    voiceIdSv: client.setter_voice_id_sv,
    langState: languageDirective === "lock_sv" ? "sv" : "en",
  });
  const extraForReply = [voiceOn ? VOICE_INSTRUCTION : undefined, painInstruction]
    .filter(Boolean)
    .join("\n\n") || undefined;

  // If the lead disqualified, mirror live: send nothing, just report what would happen.
  if (disqualifyNote) {
    return NextResponse.json({
      ok: true,
      client: clientSlug,
      reply: disqualifyNote,
      segments: [disqualifyNote],
      disqualified: true,
    });
  }

  let aiResult;
  try {
    aiResult = await generateReply({
      client: {
        name: client.name,
        slug: client.slug,
        system_prompt: client.system_prompt,
        voice_samples: client.voice_samples,
        active_rules: client.active_rules,
        business_context: client.business_context,
        timezone: client.timezone,
      },
      history,
      stage: stageContext,
      language: languageDirective,
      extraInstruction: extraForReply,
      isFirstReply,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "AI generation failed",
        details: err instanceof Error ? err.message : "Unknown",
      },
      { status: 500 }
    );
  }

  // Anti-repeat guard — same as live: never re-send a near-copy of a recent
  // reply; regenerate once, and if still a dupe, suppress it.
  const priorAiBubbles = dbMessages.filter((m) => m.role === "ai").slice(-6).map((m) => m.content);
  if (isRepeatReply(aiResult.segments, priorAiBubbles)) {
    try {
      const antiRepeatInstruction =
        "You have ALREADY sent your most recent 'assistant' messages above. Do NOT repeat them, reword them, or re-ask a question you have already asked. The lead has seen them. Move the conversation forward to the next thing instead.";
      const retry = await generateReply({
        client: {
          name: client.name,
          slug: client.slug,
          system_prompt: client.system_prompt,
          voice_samples: client.voice_samples,
          active_rules: client.active_rules,
          business_context: client.business_context,
          timezone: client.timezone,
        },
        history,
        stage: stageContext,
        language: languageDirective,
        extraInstruction: extraForReply
          ? `${extraForReply}\n\n${antiRepeatInstruction}`
          : antiRepeatInstruction,
        isFirstReply,
      });
      if (!isRepeatReply(retry.segments, priorAiBubbles)) {
        aiResult = retry;
      }
    } catch (err) {
      console.error("[test] anti-repeat regeneration failed:", err);
    }
  }

  // Empty-response guard. The model occasionally returns a 200 OK with
  // genuinely no text content at all (confirmed via ai_decisions.raw_response
  // being "" with no error - not a bug in cleaning/splitting, the API itself
  // returned nothing). Silently "succeeding" with zero segments is
  // indistinguishable from the app going silent, which is exactly what this
  // looked like live. One automatic retry recovers almost all of these.
  const hasContent = (segs: string[]) => segs.some((s) => s.trim().length > 0);
  if (!hasContent(aiResult.segments)) {
    try {
      const retry = await generateReply({
        client: {
          name: client.name,
          slug: client.slug,
          system_prompt: client.system_prompt,
          voice_samples: client.voice_samples,
          active_rules: client.active_rules,
          business_context: client.business_context,
          timezone: client.timezone,
        },
        history,
        stage: stageContext,
        language: languageDirective,
        extraInstruction: extraForReply,
        isFirstReply,
      });
      if (hasContent(retry.segments)) {
        aiResult = retry;
      }
    } catch (err) {
      console.error("[test] empty-response retry failed:", err);
    }
  }
  if (!hasContent(aiResult.segments)) {
    return NextResponse.json(
      {
        error: "AI generation failed",
        details: "The AI returned an empty response twice in a row. Please try sending your message again.",
      },
      { status: 500 }
    );
  }

  // The words said (saved to history), voice marker stripped.
  const saveSegments = aiResult.segments.map((s) => s.replace(VOICE_MARKER_RE, "").trim());
  // Real cloned-voice clips so the demo actually PLAYS the voice note instead of
  // just tagging it 🎤. mp3, the SAME cloned voice as live; only voice-marked +
  // eligible segments get one. Best-effort + parallel — a clip failure → text.
  const clips = await Promise.all(
    aiResult.segments.map(async (seg) => {
      const body = seg.replace(VOICE_MARKER_RE, "").trim();
      if (VOICE_MARKER_RE.test(seg) && voiceOn && voiceId && voiceEligible(body)) {
        return await makeVoiceClip(body, voiceId);
      }
      return null;
    })
  );

  for (let i = 0; i < saveSegments.length; i++) {
    await saveMessage({
      lead_id: lead.id,
      client_id: client.id,
      role: "ai",
      content: saveSegments[i],
      channel: "test",
      model_used: PRODUCTION_MODEL,
      input_tokens: i === 0 ? aiResult.input_tokens : undefined,
      output_tokens: i === 0 ? aiResult.output_tokens : undefined,
    });
  }

  await logAIDecision({
    lead_id: lead.id,
    client_id: client.id,
    system_prompt_used: aiResult.system_prompt_used,
    conversation_context: {
      test_session: sessionId,
      client_slug: clientSlug,
      message_count: dbMessages.length,
    },
    raw_response: aiResult.raw_response,
    final_reply: aiResult.reply,
    duration_ms: aiResult.duration_ms,
  });

  return NextResponse.json({
    ok: true,
    client: clientSlug,
    reply: saveSegments.join("\n"),
    segments: saveSegments,
    clips, // (string|null)[] parallel to segments — audio URL when it's a voice note
    duration_ms: aiResult.duration_ms,
    tokens: {
      input: aiResult.input_tokens,
      output: aiResult.output_tokens,
    },
  });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "ai-setter-test",
    instructions: "POST { message, session_id?, client_slug?, reset? }",
  });
}
