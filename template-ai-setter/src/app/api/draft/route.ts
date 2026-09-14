/**
 * DRAFT A REPLY — compose (don't send) the message the AI setter would send a
 * lead next, per its SOP. Used by the Telegram bot (and HQ uses the same brain
 * via lib/draft directly). Read-only: never sends, never writes to the lead.
 *
 * POST /api/draft?k=<access_key>
 *   body: { lead_id?: string, query?: string, voice?: boolean, language?: "en"|"sv" }
 *   → { ok:true, lead:{id,name}, bubbles:string[], text:string, stage, language,
 *       voice_url?, voiced?, voice_note? }   // voice_* only when voice:true
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase, type Lead } from "@/lib/supabase";
import { getAccessKey } from "@/lib/prompter/access";
import { draftReplyForLead } from "@/lib/draft";
import { ownerSlug } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // voice drafts add ElevenLabs TTS latency

export async function POST(req: NextRequest) {
  try {
    const k = req.nextUrl.searchParams.get("k") ?? "";
    const accessKey = await getAccessKey();
    if (!accessKey || k !== accessKey) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as
      | { lead_id?: string; query?: string; voice?: boolean; language?: "en" | "sv" }
      | null;
    const { data: clientRow } = await supabase.from("clients").select("*").eq("slug", ownerSlug()).maybeSingle();
    const client = clientRow as (Record<string, unknown> & { id: string }) | null;
    if (!client) return NextResponse.json({ error: "client_not_configured" }, { status: 500 });

    let lead: Lead | null = null;
    if (body?.lead_id) {
      const { data } = await supabase.from("leads").select("*")
        .eq("id", body.lead_id).eq("client_id", client.id).maybeSingle();
      lead = data as Lead | null;
    } else if (body?.query) {
      const q = body.query.trim().replace(/^@/, "").replace(/[%,()]/g, "");
      if (q) {
        const { data } = await supabase.from("leads").select("*")
          .eq("client_id", client.id)
          .or(`full_name.ilike.%${q}%,ig_username.ilike.%${q}%`)
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .limit(1);
        lead = (data?.[0] as Lead) ?? null;
      }
    }
    if (!lead) return NextResponse.json({ error: "lead_not_found" }, { status: 404 });

    const draft = await draftReplyForLead({
      client,
      lead,
      voice: body?.voice === true,
      languageOverride: body?.language === "sv" ? "sv" : body?.language === "en" ? "en" : undefined,
    });
    return NextResponse.json({
      ok: true,
      lead: { id: lead.id, name: lead.full_name },
      ...draft,
      voice_url: draft.voiceUrl ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    console.error("[draft] error:", msg);
    if (msg === "no_pending_lead_message") {
      return NextResponse.json(
        { error: "no_pending_lead_message", hint: "the lead's last message must be inbound to draft a reply" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: "draft_failed" }, { status: 500 });
  }
}
