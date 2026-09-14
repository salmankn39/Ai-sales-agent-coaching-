/**
 * ============================================================================
 * SETTER VOICE NOTES — speak a reply in the operator's cloned voice
 * ============================================================================
 * Turns a piece of reply text into an mp3 in the operator's ElevenLabs cloned
 * voice, hosts it on a public Supabase bucket, and returns the URL so it can be
 * sent as a GHL attachment into the IG DM.
 *
 * SAFETY: every function is best-effort and returns null on ANY failure (no
 * key, no voice id, TTS error, upload error). The caller MUST fall back to
 * sending text, so a voice hiccup can never drop or break a reply. Reuses the
 * same ElevenLabs key the orbit's Jarvis voice already uses.
 *
 * The conversation TEXT is always the source of truth (stored in messages,
 * used for memory + anti-repeat). Voice is only the DELIVERY of that text.
 * ============================================================================
 */
import { supabase } from "./supabase";
import { scrubOutboundText } from "./outbound";

const TTS_MODEL = "eleven_turbo_v2_5"; // snappier, more even conversational cadence (multilingual_v2 over-articulated word-by-word)
const VOICE_BUCKET = "voice-notes";
const MAX_TTS_CHARS = 800; // keep clips short + cheap; long replies stay text

// Voice delivery settings, tuned for a HUMAN, conversational sound. ONE const
// drives every voice path (live ManyChat WAV, draft mp3, demo) so they all sound
// identical and it's a one-line dial: lower stability = more emotion/variation,
// higher style = more of the operator's personality, speaker_boost = closer to
// the real clone. Nudge these to taste — or per-client WITHOUT a deploy via
// clients.voice_settings (see effectiveVoiceSettings below).
const VOICE_SETTINGS = { stability: 0.4, similarity_boost: 0.85, style: 0, use_speaker_boost: true, speed: 1.1 };

export interface VoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  speed: number;
}

// Length-adaptive stability: short clips need MORE variation (a flat 5-second
// aside sounds robotic), long clips need MORE stability (an expressive model
// drifts/warbles over 30+ seconds). The thresholds and both endpoint values
// are overridable per client.
const STABILITY_SHORT = 0.35;
const STABILITY_LONG = 0.55;
const SHORT_MAX_CHARS = 160;
const LONG_MIN_CHARS = 400;

/** Clamp-validated numeric override, else undefined (ignored). */
function numIn(v: unknown, lo: number, hi: number): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined;
}

/**
 * The voice settings actually sent to ElevenLabs for THIS clip: code defaults,
 * overlaid with the client's validated clients.voice_settings overrides, with
 * stability picked by clip LENGTH (short -> livelier, long -> steadier).
 * Invalid/unknown override keys are silently ignored — junk in the DB can
 * never break synthesis, it just falls back to the defaults.
 */
export function effectiveVoiceSettings(
  overrides: Record<string, unknown> | null | undefined,
  textLen: number
): VoiceSettings {
  const o = overrides && typeof overrides === "object" ? overrides : {};
  const base: VoiceSettings = {
    stability: numIn(o.stability, 0, 1) ?? VOICE_SETTINGS.stability,
    similarity_boost: numIn(o.similarity_boost, 0, 1) ?? VOICE_SETTINGS.similarity_boost,
    style: numIn(o.style, 0, 1) ?? VOICE_SETTINGS.style,
    use_speaker_boost:
      typeof o.use_speaker_boost === "boolean" ? o.use_speaker_boost : VOICE_SETTINGS.use_speaker_boost,
    speed: numIn(o.speed, 0.7, 1.2) ?? VOICE_SETTINGS.speed,
  };
  const shortMax = numIn(o.short_max_chars, 1, MAX_TTS_CHARS) ?? SHORT_MAX_CHARS;
  const longMin = numIn(o.long_min_chars, 1, MAX_TTS_CHARS) ?? LONG_MIN_CHARS;
  if (textLen <= shortMax) {
    base.stability = numIn(o.stability_short, 0, 1) ?? STABILITY_SHORT;
  } else if (textLen >= longMin) {
    base.stability = numIn(o.stability_long, 0, 1) ?? STABILITY_LONG;
  }
  return base;
}

/** Fire-and-forget synthesis observability (webhook_debug_logs, the existing
 *  free-form debug table) — lets us see chars/latency/settings per clip and
 *  verify a tuning change actually took, without touching the reply path. */
function logSynthesis(data: { chars: number; synth_ms: number; ok: boolean; stability: number; model: string }): void {
  supabase
    .from("webhook_debug_logs")
    .insert({ parse_result: "voice_synthesis", extracted_data: data })
    .then(undefined, (e) => console.error("[voice] synthesis log failed:", e));
}

/** Marker the brain puts at the start of a message it wants spoken. */
export const VOICE_MARKER_RE = /^\s*\[\[VOICE\]\]/i;

/** The right cloned-voice id for the thread's language: Swedish clone on a
 *  Swedish-locked thread, otherwise the default (English) clone. */
export function voiceIdForLang(opts: { voiceId?: string | null; voiceIdSv?: string | null; langState?: string | null }): string | null {
  return (opts.langState === "sv" ? opts.voiceIdSv : opts.voiceId) || null;
}

/** Voice is live for THIS reply when the per-language switch is on AND a clone
 *  id exists for the thread's language. English is governed by `enabled`
 *  (clients.voice_enabled); Swedish by `enabledSv` (clients.voice_enabled_sv),
 *  which ships OFF — the owner's rule is that Swedish conversations stay TEXT (the
 *  Swedish clone doesn't sound like him), so a Swedish thread only ever gets a
 *  voice note if the Swedish switch is explicitly turned on. */
export function voiceActive(opts: { enabled?: boolean; enabledSv?: boolean; voiceId?: string | null; voiceIdSv?: string | null; langState?: string | null }): boolean {
  if (opts.langState === "sv") return opts.enabledSv === true && !!opts.voiceIdSv;
  return opts.enabled === true && !!opts.voiceId;
}

/**
 * Backstop: expand the most common DM shorthand into real words BEFORE speaking,
 * so a stray "u"/"r"/"w/" can never get mangled by TTS. The brain already writes
 * voice messages in full words; this just catches slips. Conservative on purpose.
 */
const SPEECH_FIXES: [RegExp, string][] = [
  [/\bu're\b/gi, "you're"], [/\bu\b/gi, "you"], [/\bur\b/gi, "your"],
  [/\br\b/gi, "are"], [/\bw\/\b/gi, "with"], [/\bbc\b/gi, "because"],
  [/\brn\b/gi, "right now"], [/\btbh\b/gi, "to be honest"], [/\bidk\b/gi, "I don't know"],
  [/\blmk\b/gi, "let me know"], [/\bngl\b/gi, "not gonna lie"], [/\bimo\b/gi, "in my opinion"],
  // NOTE: no fr/ty/sec/k here — those collide with real words ("for real" vs
  // French, "thank you" vs ty the name, "second" vs sec the unit, "okay" vs k).
  [/\bpls\b/gi, "please"], [/\bplz\b/gi, "please"], [/\bthx\b/gi, "thanks"],
  [/\bmsg\b/gi, "message"], [/\bmins\b/gi, "minutes"], [/\bbtw\b/gi, "by the way"],
  [/\bnvm\b/gi, "never mind"], [/\bomw\b/gi, "on my way"], [/\brly\b/gi, "really"],
  [/\bdef\b/gi, "definitely"], [/\bprolly\b/gi, "probably"], [/\babt\b/gi, "about"],
  [/\bb4\b/gi, "before"], [/\b2day\b/gi, "today"], [/\b2moro\b/gi, "tomorrow"],
  [/\bgr8\b/gi, "great"],
];
export function normalizeForSpeech(text: string): string {
  let out = text || "";
  for (const [re, rep] of SPEECH_FIXES) out = out.replace(re, rep);
  return out;
}

// NOTE: we do NOT inject ElevenLabs <break> pause tags. They make the expressive
// model VOCALISE the pause ("uhm"/"ah") instead of staying silent — worse with
// several commas in one short clip (the opener sounded horrible). We rely on the
// model's own natural punctuation pacing instead.

/** The standing instruction injected into the reply when voice is live. Shared
 *  by the live webhook and the Test Chat so both decide voice identically.
 *  The beat list below is the owner's agreed voice policy (still a default — read
 *  the moment). Same in English and Swedish. */
export const VOICE_INSTRUCTION = `VOICE NOTES: you can send a message as a VOICE NOTE in your real voice instead of text by putting [[VOICE]] at the very START of that message. Rules:
- Write voice lines in FULL, correctly-spelled words with normal punctuation, because they are SPOKEN OUT LOUD ("are you with me" — never "r u w me") — but keep your natural casual spoken tone. (Same in Swedish: spell properly even though you'd text in shorthand.)
- Make it sound SPOKEN, not read aloud: use contractions and natural commas, and let a little warmth slip through where it fits — a soft "haha" or "honestly". In a VOICE note specifically, keep the words plain — NO slang or verbal-tic fillers (no "you know what i mean", "you feel me", "you get me", "i mean", "you know") because the spoken clone does slang badly. (Slang is totally fine in normal TEXT messages — this only applies to what actually gets voiced.) Keep it SMOOTH and flowing — do NOT stack lots of "..." in one clip, it makes the voice choppy and robotic. One natural pause at most.
- One short spoken thought (~1-2 sentences MAX, keep it really tight). A voice note is a quick casual aside like you're leaving a mate a 5-second message — NOT a speech or a performance. Don't over-emphasise, don't get dramatic or theatrical, don't reflect back their whole answer. If a line is getting long or has more than one part, send it as TEXT instead. Do NOT put [[SPLIT]] inside a voice message.
- NEVER voice anything with a link, a price, or specific times/numbers the lead has to read — those stay text.

HOW OFTEN: most of your messages are TEXT. AT MOST 1 in 4 of your messages (25%, never more) is a voice note — so across a whole conversation roughly three out of every four messages are typed. Voice is only for the big emotional / rapport / persuasion beats below, and not even all of those. If you've sent a voice note in the last few messages, the next ones are text. When in doubt, text.

NEVER END ON A SILENT VOICE NOTE: a voice note must never be the last bubble of a reply unless it itself ends with a question. If you voice an acknowledgement, a reframe or an affirmation that doesn't ask the next question, follow it with a short TEXT bubble that either digs deeper into what they just shared OR asks the next question. If they just shared something emotional, dig into THAT first — do NOT jump to the next funnel step just to keep moving. Every reply still ends with a question.

SEND A VOICE NOTE ON THESE BEATS (and basically only these):
- The MAIN-REASON question ("one of my favourite questions i love to ask is, what's the MAIN reason behind wanting to start?").
- The deeper GOAL question ("freedom means different things to everyone, what does it actually mean to you?" / "what's the outcome of having more time?") — but acknowledge their answer first.
- The PROBLEM normalize ("it's not that you don't want to, it's that you don't know where to start — a lot of guys feel that way") — but ONLY once THEY have actually named that struggle themselves. Never state their obstacle for them as if they said it; if you don't know it yet, ask an open question instead.
- The CONSEQUENCE — the future cost / the gap ("if this keeps going another two years you're still at 5k... are you actually okay just settling with that?").
- The PITCH ("what if i put you on a 45-60 min call with Ethan, he gives you a step-by-step roadmap...").
- The affirmation right after they agree to the call ("sick bro, the fact you'll invest 45 min tells me you're serious...") — then follow it with a text bubble that moves forward.
- The PRE-CALL reassurance ("just be yourself, show up 10 min early, you'll walk away with clarity").
- "IS THIS AN AI?" → ALWAYS answer with a voice note — your real voice instantly proves you're human.
- "why all these questions?" → voice ("haha obv trying to get a good interview bro... i'm here to help, i need the full picture").

ALWAYS TEXT, NEVER VOICE:
- The OPENER / your very first message ("appreciate the follow brother, tell me a bit about yourself, where you based?") — ALWAYS text, never a voice note.
- The REFRAME ("bro that's exactly it, so this isn't about the money, it's about the peace") — text.
- The WHY-NOW question ("what made you feel now is the time?") — text.
- Where they live, what they do for work, the income numbers (what they make / need), all recaps, the timeline pin-down nudges, any $ math, the booking times + email + link, the proof reel + training video links, all post-booking confirmation, "is the call free?", and price ranges.`;

/** text -> mp3 buffer in the given cloned voice. null on any failure. */
export async function synthesizeVoice(
  text: string,
  voiceId: string,
  overrides?: Record<string, unknown> | null
): Promise<Buffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  // Scrub internal tokens BEFORE speaking — the voice twin of the text send
  // chokepoint, so a stray [[...]] marker can never be read aloud to a lead.
  const clean = normalizeForSpeech(scrubOutboundText((text || "").trim()));
  if (!apiKey || !voiceId || !clean) return null;
  const spoken = clean.slice(0, MAX_TTS_CHARS);
  const settings = effectiveVoiceSettings(overrides, spoken.length);
  const started = Date.now();
  let synthLogged = false; // the try also covers reading the body — log exactly once
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text: spoken,
          model_id: TTS_MODEL,
          voice_settings: settings,
        }),
      }
    );
    synthLogged = true;
    logSynthesis({ chars: spoken.length, synth_ms: Date.now() - started, ok: res.ok, stability: settings.stability, model: TTS_MODEL });
    if (!res.ok) {
      console.error("[voice] elevenlabs tts failed:", res.status, (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (!synthLogged) {
      logSynthesis({ chars: spoken.length, synth_ms: Date.now() - started, ok: false, stability: settings.stability, model: TTS_MODEL });
    }
    console.error("[voice] synthesize threw:", err);
    return null;
  }
}

/** Upload an mp3 buffer to the public bucket, return its public URL. null on failure. */
export async function hostVoiceClip(buf: Buffer): Promise<string | null> {
  try {
    const path = `clips/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.mp3`;
    const { error } = await supabase.storage
      .from(VOICE_BUCKET)
      .upload(path, buf, { contentType: "audio/mpeg", upsert: false });
    if (error) {
      console.error("[voice] upload failed:", error.message);
      return null;
    }
    const { data } = supabase.storage.from(VOICE_BUCKET).getPublicUrl(path);
    return data?.publicUrl ?? null;
  } catch (err) {
    console.error("[voice] host threw:", err);
    return null;
  }
}

/** Full pipeline: text -> hosted mp3 URL in the cloned voice. null on any failure. */
export async function makeVoiceClip(text: string, voiceId: string): Promise<string | null> {
  const buf = await synthesizeVoice(text, voiceId);
  if (!buf) return null;
  return hostVoiceClip(buf);
}

// ===========================================================================
// WAV pipeline — for Instagram voice notes sent via ManyChat.
// ---------------------------------------------------------------------------
// ManyChat's IG "audio" message accepts m4a/wav/aac but REJECTS mp3 (Instagram
// error 3046). So for the ManyChat path we ask ElevenLabs for raw PCM and wrap
// it in a WAV header in code — no transcoder needed. (GHL's path keeps mp3.)
// Proven end-to-end: a real cloned-voice note lands in the IG DM this way.
// ===========================================================================

/** Wrap raw 16-bit mono little-endian PCM in a standard 44-byte WAV header. */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1, bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(numChannels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(byteRate, 28); h.writeUInt16LE(blockAlign, 32); h.writeUInt16LE(bitsPerSample, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * Full pipeline: text -> hosted WAV URL in the cloned voice, for the ManyChat
 * Instagram voice path. Same cloned voice + speech-normalisation as the mp3
 * path; only the container differs. null on ANY failure (caller falls back to
 * text), so a voice hiccup can never drop a reply.
 */
export async function makeVoiceClipWav(
  text: string,
  voiceId: string,
  overrides?: Record<string, unknown> | null
): Promise<string | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const clean = normalizeForSpeech((text || "").trim());
  if (!apiKey || !voiceId || !clean) return null;
  const sampleRate = 24000;
  const spoken = clean.slice(0, MAX_TTS_CHARS);
  const settings = effectiveVoiceSettings(overrides, spoken.length);
  const started = Date.now();
  let synthLogged = false; // the try also covers the upload — log the synth exactly once
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_${sampleRate}`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/pcm" },
        body: JSON.stringify({
          text: spoken,
          model_id: TTS_MODEL,
          voice_settings: settings,
        }),
      }
    );
    synthLogged = true;
    logSynthesis({ chars: spoken.length, synth_ms: Date.now() - started, ok: res.ok, stability: settings.stability, model: TTS_MODEL });
    if (!res.ok) {
      console.error("[voice] elevenlabs pcm tts failed:", res.status, (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const wav = pcmToWav(Buffer.from(await res.arrayBuffer()), sampleRate);
    const path = `clips/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.wav`;
    const { error } = await supabase.storage
      .from(VOICE_BUCKET)
      .upload(path, wav, { contentType: "audio/wav", upsert: false });
    if (error) {
      console.error("[voice] wav upload failed:", error.message);
      return null;
    }
    return supabase.storage.from(VOICE_BUCKET).getPublicUrl(path).data?.publicUrl ?? null;
  } catch (err) {
    if (!synthLogged) {
      logSynthesis({ chars: spoken.length, synth_ms: Date.now() - started, ok: false, stability: settings.stability, model: TTS_MODEL });
    }
    console.error("[voice] makeVoiceClipWav threw:", err);
    return null;
  }
}

/**
 * Hard guardrails on whether a given message is even ELIGIBLE to be a voice
 * note, regardless of the "when" policy. Things you can't tap/read inside a
 * voice note must always be text.
 */
export function voiceEligible(text: string): boolean {
  const t = (text || "").trim();
  if (t.length < 12) return false;                 // tiny acks stay text
  if (t.length > MAX_TTS_CHARS) return false;       // very long stays text
  if (/https?:\/\/|www\.|\.com|\.io|\b\d{1,2}[:.]\d{2}\b/i.test(t)) return false; // links / times
  if (/\b(calendly|booking|link|slot|am|pm)\b/i.test(t) && /\d/.test(t)) return false; // times-ish
  return true;
}
