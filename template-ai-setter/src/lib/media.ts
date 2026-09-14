/**
 * MEDIA HANDLING
 * --------------
 * A lead's Instagram voice note or photo, turned into text the setter can
 * answer:
 *   1. Download the file once from the URL the inbound webhook gave us.
 *   2. Audio -> transcribe with Groq Whisper (whisper-large-v3-turbo).
 *      Image -> describe with Claude vision (existing Anthropic key).
 *   3. Return the result as plain text, which is stored as the lead's message
 *      and flows through the normal pipeline as if they had typed it.
 *
 * If something can't be handled (reaction, story reply, share, failed fetch)
 * we return null and the caller skips.
 *
 * CHANGED 2026-07-26: this used to ASK GHL for the attachment URL, because
 * GHL's webhook delivered media as an empty "type 18" event with no URL in it.
 * That webhook is retired (it was a second ear on the same inbox and forked
 * leads into twin rows), so the URL now arrives directly on the ManyChat
 * payload and there is nothing to go fetch. Same transcription, same vision,
 * one less round trip, zero GHL.
 */

import { claude } from "./anthropic";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";

const anthropic = claude("media_describe");
const VISION_MODEL = "claude-sonnet-4-6";

type AllowedImageType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const ALLOWED_IMAGE_TYPES: AllowedImageType[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

/**
 * Resolve an incoming media message (voice note / image) into text, given the
 * attachment URL the inbound webhook handed us.
 * Returns null if there's no usable media.
 */
export async function resolveMediaFromUrl(url: string): Promise<string | null> {
  const src = (url || "").trim();
  if (!src) return null;

  // Download the file once so we can inspect its type and reuse the bytes.
  let bytes: Buffer;
  let contentType: string;
  try {
    const res = await fetch(src);
    if (!res.ok) {
      console.error("[media] download failed:", res.status, src);
      return null;
    }
    contentType = (res.headers.get("content-type") || "").toLowerCase();
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error("[media] download threw:", err);
    return null;
  }

  const media = { url: src };
  const kind = classifyMedia(contentType, media.url);
  console.log("[media] attachment:", { kind, contentType, size: bytes.length });

  // Audio AND video both go to transcription: IG voice notes arrive as .mp4
  // (audio in an mp4 container, messageType TYPE_INSTAGRAM), and Groq Whisper
  // transcribes mp4/m4a fine. Treating video as audio also lets us pull speech
  // out of any short clip a lead sends, instead of silently dropping it.
  if (kind === "audio" || kind === "video") {
    return transcribeAudio(bytes, contentType, media.url);
  }
  if (kind === "image") {
    const description = await describeImage(bytes, contentType);
    if (!description) return null;
    return `(the lead sent a photo - here is what's in it: ${description})`;
  }

  console.log("[media] unsupported media kind, skipping");
  return null;
}

function classifyMedia(
  contentType: string,
  url: string
): "audio" | "image" | "video" | "other" {
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";

  const u = url.toLowerCase().split("?")[0];
  if (/\.(ogg|oga|mp3|m4a|aac|wav|opus|webm|flac)$/.test(u)) return "audio";
  if (/\.(jpe?g|png|gif|webp)$/.test(u)) return "image";
  if (/\.(mp4|mov|m4v)$/.test(u)) return "video";
  return "other";
}

/**
 * Transcribe an audio file with Groq Whisper. Always resolves to a string: a
 * real transcript on success, or a graceful fallback the AI can respond to so
 * the conversation never dies on silence.
 */
async function transcribeAudio(
  bytes: Buffer,
  contentType: string,
  url: string
): Promise<string> {
  if (!GROQ_API_KEY) {
    console.error("[media] GROQ_API_KEY not set - cannot transcribe voice note");
    return "(the lead sent a voice note, but voice transcription isn't set up yet - ask them to type it out real quick)";
  }
  try {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(bytes)], { type: contentType || "audio/ogg" }),
      filenameForAudio(contentType, url)
    );
    form.append("model", GROQ_MODEL);
    form.append("response_format", "json");

    const res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: form,
    });
    if (!res.ok) {
      console.error("[media] Groq transcription failed:", res.status, await res.text());
      return "(the lead sent a voice note but it couldn't be transcribed - ask them to type it out)";
    }
    const data = await res.json();
    const text = String(data.text || "").trim();
    if (!text) {
      return "(the lead sent a voice note but it came through empty/inaudible - ask them to resend or type it)";
    }
    console.log("[media] transcript:", text.substring(0, 120));
    return text;
  } catch (err) {
    console.error("[media] transcription threw:", err);
    return "(the lead sent a voice note but it couldn't be transcribed - ask them to type it out)";
  }
}

function filenameForAudio(contentType: string, url: string): string {
  if (contentType.includes("ogg")) return "audio.ogg";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return "audio.mp3";
  if (contentType.includes("mp4") || contentType.includes("m4a") || contentType.includes("aac"))
    return "audio.m4a";
  if (contentType.includes("wav")) return "audio.wav";
  if (contentType.includes("webm")) return "audio.webm";
  if (contentType.includes("flac")) return "audio.flac";
  // IG voice notes (and short clips) come as .mp4/.mov — Groq accepts mp4.
  const ext = url.toLowerCase().split("?")[0].split(".").pop();
  if (ext === "mov" || ext === "m4v" || ext === "mp4") return "audio.mp4";
  return ext ? `audio.${ext}` : "audio.mp4";
}

/**
 * Describe an image with Claude vision so the AI can react to it naturally.
 * Includes any visible text. Returns null on failure.
 */
async function describeImage(
  bytes: Buffer,
  contentType: string
): Promise<string | null> {
  try {
    const mediaType: AllowedImageType = ALLOWED_IMAGE_TYPES.includes(
      contentType as AllowedImageType
    )
      ? (contentType as AllowedImageType)
      : "image/jpeg";

    const resp = await anthropic.messages.create({
      model: VISION_MODEL,
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") },
            },
            {
              type: "text",
              text:
                "A lead in an Instagram DM sales conversation just sent this image. " +
                "In 1-2 short sentences, plainly describe what it shows so the rep can react naturally. " +
                "If there is any text in the image, transcribe it exactly. No preamble - just the description.",
            },
          ],
        },
      ],
    });

    const desc = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("")
      .trim();
    console.log("[media] image description:", desc.substring(0, 120));
    return desc || null;
  } catch (err) {
    console.error("[media] image description threw:", err);
    return null;
  }
}
