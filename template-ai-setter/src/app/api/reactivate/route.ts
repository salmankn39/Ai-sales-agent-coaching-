/**
 * REACTIVATION — draft a cold outbound opener to a dormant lead
 * ---------------------------------------------------------------
 * The operator describes an old/dormant lead in one sentence (who they are,
 * what happened last time - enquired but never booked, no-showed a trial,
 * came to one session and never returned, etc). This generates ONE opening
 * message using the SAME brain (business knowledge, voice, rules) as the
 * normal setter, but framed as an outbound re-engagement rather than a reply.
 *
 * Usage:
 *   POST /api/reactivate?k=<key>
 *   { "note": "reach out to Sarah, enquired about her son 3 months ago, never booked",
 *     "session_id": "...", "client_slug": "..." }
 *
 * The opener is saved as the lead's first "ai" message(s), using the SAME
 * fake-contact-id format as /api/test, so the SAME session_id can continue
 * the conversation there afterwards (the operator plays the lead from then
 * on) exactly like a normal test conversation - no extra plumbing needed,
 * since buildMessageHistory already folds a leading assistant-only run into
 * a context turn (built for "a thread the operator started himself").
 */
import { NextRequest, NextResponse } from "next/server";
import { getClient, findOrCreateLead, saveMessage, supabase } from "@/lib/supabase";
import { generateReply, PRODUCTION_MODEL } from "@/lib/brain";
import { getAccessKey } from "@/lib/prompter/access";
import { ownerSlug } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

export async function POST(req: NextRequest) {
  const k = req.nextUrl.searchParams.get("k") ?? "";
  const accessKey = await getAccessKey();
  if (!accessKey || k !== accessKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { note?: string; session_id?: string; client_slug?: string; reset?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sessionId = body.session_id || "reactivate-default";
  const clientSlug = body.client_slug || ownerSlug();
  // Same namespace /api/test uses, so the same session_id can continue the
  // conversation there once the opener has been drafted.
  const fakeContactId = `test::${clientSlug}::${sessionId}`;

  const client = await getClient(clientSlug);
  if (!client) {
    return NextResponse.json({ error: `Client '${clientSlug}' not configured` }, { status: 404 });
  }

  if (body.reset) {
    await supabase
      .from("leads")
      .delete()
      .eq("client_id", client.id)
      .eq("ghl_contact_id", fakeContactId);
    return NextResponse.json({ ok: true, reset: true, client: clientSlug });
  }

  if (!body.note?.trim()) {
    return NextResponse.json({ error: "Missing note" }, { status: 400 });
  }

  const lead = await findOrCreateLead({
    client_id: client.id,
    ghl_contact_id: fakeContactId,
    full_name: `Reactivation ${sessionId} (${clientSlug})`,
  });
  if (!lead) {
    return NextResponse.json({ error: "Failed to create lead" }, { status: 500 });
  }

  // The operator's note is what the model reads, but it is NEVER saved as a
  // real message — it's an instruction, not something said in the
  // conversation. Only the drafted opener becomes a real, persisted message.
  const ephemeralHistory = [
    {
      role: "lead" as const,
      content: `[OPERATOR NOTE about a dormant lead - not a message from the lead]: ${body.note.trim()}`,
      created_at: new Date().toISOString(),
    },
  ];

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
        reactivation_playbook: client.reactivation_playbook,
      },
      history: ephemeralHistory,
      isReactivationOpener: true,
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

  const segments = aiResult.segments.map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    await saveMessage({
      lead_id: lead.id,
      client_id: client.id,
      role: "ai",
      content: segments[i],
      channel: "test",
      model_used: i === 0 ? PRODUCTION_MODEL : undefined,
      input_tokens: i === 0 ? aiResult.input_tokens : undefined,
      output_tokens: i === 0 ? aiResult.output_tokens : undefined,
    });
  }

  return NextResponse.json({
    ok: true,
    client: clientSlug,
    segments,
    reply: segments.join("\n"),
  });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "ai-setter-reactivate",
    instructions: "POST { note, session_id?, client_slug?, reset? }",
  });
}
