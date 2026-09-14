/**
 * JARVIS HQ — LIVE DEMO SETTER. Powers the interactive "fake DM" panel: the owner
 * (or a prospect) types AS THE LEAD, and the REAL AI setter replies — same
 * brain the production setter uses (generateReply → the client's own SOP,
 * voice samples, and rules from the DB). No GHL, no DB writes, no real lead —
 * pure showcase, but the setter behaves EXACTLY as it does live.
 *
 * POST /api/hq/demo-dm?k=<key>  body: { history:[{role:"lead"|"setter",content}] }
 *   → { messages: string[] }   (the setter's reply, split into real bubbles)
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { generateReply } from "@/lib/brain";
import type { ClientConfig, Message } from "@/lib/prompts/master";
import { getAccessKey } from "@/lib/prompter/access";
import { makeVoiceClip, voiceActive, voiceEligible, voiceIdForLang, VOICE_INSTRUCTION, VOICE_MARKER_RE } from "@/lib/voice";
import { ownerSlug } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const maxDuration = 45; // voiced demo replies add ElevenLabs TTS latency

const OPENER = "yo brother, what you working on these days?";

type VoiceClient = {
  voice_enabled?: boolean | null;
  voice_enabled_sv?: boolean | null;
  setter_voice_id?: string | null;
  setter_voice_id_sv?: string | null;
};

export async function POST(req: NextRequest) {
  try {
    const k = req.nextUrl.searchParams.get("k") ?? "";
    const accessKey = await getAccessKey();
    if (!accessKey || k !== accessKey) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const body = (await req.json().catch(() => null)) as { history?: Array<{ role: string; content: string }> } | null;
    const hist = (body?.history ?? []).slice(-20);

    // Load the REAL setter config — its SOP, voice, rules, offer.
    const { data: clientRow } = await supabase.from("clients").select("*").eq("slug", ownerSlug()).maybeSingle();
    const client = clientRow as (Record<string, unknown> & { id: string }) | null;
    const vc = (client ?? {}) as VoiceClient;
    const voiceOn = voiceActive({
      enabled: vc.voice_enabled === true, enabledSv: vc.voice_enabled_sv === true,
      voiceId: vc.setter_voice_id, voiceIdSv: vc.setter_voice_id_sv, langState: "en",
    });
    const voiceId = voiceIdForLang({ voiceId: vc.setter_voice_id, voiceIdSv: vc.setter_voice_id_sv, langState: "en" });

    // No lead message to reply to yet → the setter's real opener, ALWAYS as TEXT
    // (the owner's rule: the opener is never a voice note).
    if (!hist.length || hist[hist.length - 1].role !== "lead") {
      return NextResponse.json({ messages: [OPENER], clips: [null] });
    }
    if (!client) return NextResponse.json({ messages: [OPENER], clips: [null] });

    const history: Message[] = hist.map((m) => ({
      role: m.role === "setter" ? ("ai" as const) : ("lead" as const),
      content: String(m.content ?? "").slice(0, 600),
      created_at: new Date().toISOString(),
    }));

    // Same call the production setter makes. No stage rail → the operator's full
    // SOP drives the reply. Voice instruction injected so it can speak the
    // human/persuasion beats, exactly like live.
    const result = await generateReply({
      client: client as unknown as ClientConfig,
      history,
      extraInstruction: voiceOn ? VOICE_INSTRUCTION : undefined,
    });
    const built = (result.segments || [])
      .map((seg) => ({ text: seg.replace(VOICE_MARKER_RE, "").trim(), voiced: VOICE_MARKER_RE.test(seg) }))
      .filter((b) => b.text)
      .slice(0, 4);
    const messages = built.map((b) => b.text);
    const clips = await Promise.all(
      built.map(async (b) =>
        b.voiced && voiceOn && voiceId && voiceEligible(b.text) ? await makeVoiceClip(b.text, voiceId) : null
      )
    );
    return messages.length
      ? NextResponse.json({ messages, clips })
      : NextResponse.json({ messages: [result.reply.trim() || "got it — tell me more"], clips: [null] });
  } catch (err) {
    console.error("[hq/demo-dm] error:", err);
    return NextResponse.json({ messages: ["one sec — say that again?"], clips: [null] });
  }
}
