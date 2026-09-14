/**
 * THE STORY ENGINE - daily IG story suggestions from the owner's proven 7-day
 * schedule, made personal with everything the system knows about the creator.
 *
 * Day-aware: the engine knows what weekday it is in the creator's timezone and
 * follows that day's play from the template. Output: 3 variations (a single
 * story or a sequence of at most 5 slides; 7 is the absolute cap, we stop at
 * 5) plus one interview question that digs for fresh ammo (wins, client
 * moments, screenshots).
 *
 * Used by BOTH the student app (/api/app/stories) and the owner's own pipeline
 * (/api/pipeline/stories) - one engine, two contexts.
 */
import { claude } from "./anthropic";

export const STORY_TEMPLATE = `THE PROVEN 7-DAY STORY SCHEDULE (follow the current day's play):
Monday - Hard Call to Action: post ONE hard CTA. Directly tell people to DM you, apply, or book a call. People feel guilty after the weekend and want to get back on track.
Tuesday - Social Proof + Document Your Day: 2-3 social proof slides (client wins, testimonials, results) + real behind-the-scenes moments through the day.
Wednesday - Authority + Q&A: 2-3 social proof slides (daily non-negotiable) + a Q&A sticker asking the audience for questions (small audience? ask yourself questions and answer them).
Thursday - Reset + Soft CTA: delete all stories, then post a soft CTA giving something free (guide, checklist, resource, audit) to start low-pressure conversations.
Friday - Social Proof + Lifestyle: at least 3 social proof slides + conversations with the audience + lifestyle moments (training, meals, behind the scenes).
Saturday - Keep It Light: delete all stories, post ONE client win only. Weekend off, you're a regular person.
Sunday - Life + Family Day: document family/life moments. Show you're human, not a robot.

WHY IT WORKS: structure kills decision fatigue; hard CTAs early in the week when motivation is high; repeated social proof compounds credibility; soft CTAs open conversations with warm-but-not-ready leads; lifestyle content humanizes; story resets keep the message clean.`;

const SYSTEM = `You draft today's Instagram stories for a creator, following their coach's proven 7-day story schedule.

${STORY_TEMPLATE}

RULES:
- You are told what day it is AND given TODAY'S PLAY verbatim. That play is the ONLY one you may use -
  ignore every other day of the schedule completely. Never mention or borrow another weekday's play.
- TEMPLATE LOCK (the most important rule): every variation must match the day's play from the winning
  schedule 100% - same sequence type, same slide roles, same order, same CTA behavior. You NEVER invent
  a new sequence format, structure, or play. The ONLY thing that changes between variations is the real
  topic filling the template (a different client, build, or moment from their actual context). If today
  says "one hard CTA", all 3 variations are one hard CTA slide, just three different real angles for it.
- Ground every suggestion in the creator's REAL context (their strategy, clients, logs, wins). Never invent wins, clients, numbers, or results. If the context is thin, suggest stories they can film today (behind the scenes, a lesson from today's work) instead of fabricating proof.
- Tone: raw and direct, documentary, short lines like a text message. No hype words, no influencer voice.
- BANNED VOICE: guru cliches and flex-comparisons are forbidden - nothing like "I clock off while you're
  still working", "I decide my day, you don't", "most people won't", "while they sleep". No motivational
  platitudes. Plain, concrete, specific lines only - like his own daily logs read.
- Never invent or showcase payment or money moments of any kind. Money appears ONLY if it is an
  explicitly logged win in the context.
- NEVER state or hint at what any client pays.
- A "single" is one story slide. A "sequence" is 2-5 slides - NEVER more than 5.
- Each slide: one short line describing exactly what to post (what's on screen + the text overlay or talking point). Concrete and filmable in minutes, no fluff.
- Give exactly 3 variations for today as THREE INTENSITY LEVELS of the SAME day-play: safe (lowest risk,
  easiest to post), medium (more direct, more personal), bold (the ballsiest version - strongest claim,
  most vulnerable or most direct ask the template allows). Same template, same core topic from their real
  day; only the intensity changes. Title each with its level.
- Also write ONE interview question that digs for fresh story ammo (a win they haven't logged, how a client build went, a screenshot they could post). Casual, direct, one sentence.

Respond with ONLY a JSON object:
{"day_line":"<Weekday> - <that day's play in a few words>",
 "variations":[{"kind":"single"|"sequence","title":"...","slides":["...","..."],"why":"one short line",
   "matched":"<Weekday> - <the play name from the 7-day template this follows>"}],
 "interview":"..."}
Never use an em dash; use a hyphen.`;

export type StoryResult = {
  day_line: string;
  variations: { kind: string; title: string; slides: string[]; why?: string; matched?: string }[];
  interview: string;
};

// The template, split per weekday, so the prompt carries ONLY today's play and
// the model physically cannot drift onto another day.
const DAY_PLAYS: Record<string, string> = {};
for (const line of STORY_TEMPLATE.split("\n")) {
  const m = line.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) - /);
  if (m) DAY_PLAYS[m[1]] = line.trim();
}

export function weekdayIn(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date());
  }
}

function extractObj(text: string): Record<string, unknown> | null {
  const t = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; } }
  return null;
}

export async function generateStories(opts: {
  weekday: string; context: string; audience: string; language?: string;
}): Promise<StoryResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const ai = claude("story_engine");
  const lang = (opts.language || "").trim();
  const langLine = lang && !/^(english|en)$/i.test(lang)
    ? ` Write all output in natural, native ${lang}.` : "";
  const play = DAY_PLAYS[opts.weekday] || "";
  const user = `Today is ${opts.weekday}.\nTODAY'S PLAY (the ONLY play allowed - every variation follows THIS, 100%):\n${play}\n\nTheir audience: ${opts.audience || "business owners curious about AI"}.\n\nEVERYTHING WE KNOW ABOUT THIS CREATOR:\n${opts.context}\n\nDraft today's 3 story variations (safe / medium / bold intensity) of TODAY'S play.`;
  try {
    const res = await ai.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 1200,
      system: SYSTEM + langLine,
      messages: [{ role: "user", content: user }],
    });
    const text = res.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("");
    const data = extractObj(text);
    if (!data) return null;
    const variations = (Array.isArray(data.variations) ? data.variations : [])
      .map((v) => {
        const raw = v as { kind?: unknown; title?: unknown; slides?: unknown; why?: unknown };
        const slides = (Array.isArray(raw.slides) ? raw.slides : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 5);
        const rawM = (raw as { matched?: unknown }).matched;
        const matched = String(rawM || "").trim().slice(0, 140);
        return {
          kind: slides.length > 1 ? "sequence" : "single",
          title: String(raw.title || "").trim().slice(0, 120),
          slides,
          why: raw.why ? String(raw.why).trim().slice(0, 200) : undefined,
          // The receipt the owner asked for: which template play this matches. If
          // the model names the wrong weekday, stamp today's real play instead.
          matched: matched.startsWith(opts.weekday) ? matched
            : `${opts.weekday} - ${(DAY_PLAYS[opts.weekday] || "").split(" - ")[1]?.split(":")[0] || "today's play"}`,
        };
      })
      .filter((v) => v.title && v.slides.length)
      .slice(0, 3);
    if (!variations.length) return null;
    return {
      day_line: String(data.day_line || opts.weekday).trim().slice(0, 120),
      variations,
      interview: String(data.interview || "").trim().slice(0, 300),
    };
  } catch {
    return null;
  }
}
