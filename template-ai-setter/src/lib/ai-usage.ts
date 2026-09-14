/**
 * THE AI SPEND METER, TypeScript half.
 *
 * The owner, 2026-08-16: "i just filled it with twenty dollars of API costs. So I
 * want you to always measure them. So whenever I ask, you should know one
 * hundred percent where each cent went."
 *
 * A meter already existed on the Python side (intelligence/cost.py, writing to
 * the `ai_usage` table) but only one call site ever reported to it, and the
 * whole TypeScript app reported nothing at all. So the setter's reply - the
 * single most expensive call in the system, Opus 5 with a 45,000-character
 * prompt - was invisible, and the meter read $1.27 across ten days while real
 * spend was several dollars a day. A meter that misses the biggest spender is
 * worse than no meter, because it produces a number that looks like an answer.
 *
 * Same table, same columns, same rates as the Python half, so one query totals
 * both languages. Best-effort and non-throwing: metering a reply must never be
 * the reason a lead does not get one.
 */

import { supabase } from "./supabase";

/** USD per 1,000,000 tokens: [input, output, cache read, cache write].
 *
 * Kept byte-identical in meaning to PRICING in intelligence/cost.py. If
 * Anthropic's rates change, both tables move together. Cache reads are ~0.1x
 * input and 5-minute cache writes ~1.25x, which is why the setter's cached
 * 32,000-character stable block costs so little per reply. */
const PRICING: Record<string, [number, number, number, number]> = {
  // Haiku tier
  "claude-haiku-4-5": [1.0, 5.0, 0.1, 1.25],
  "claude-haiku-4-5-20251001": [1.0, 5.0, 0.1, 1.25],
  // Sonnet tier
  "claude-sonnet-5": [3.0, 15.0, 0.3, 3.75],
  "claude-sonnet-4-6": [3.0, 15.0, 0.3, 3.75],
  // Opus tier
  "claude-opus-5": [5.0, 25.0, 0.5, 6.25],
  "claude-opus-4-8": [5.0, 25.0, 0.5, 6.25],
  "claude-opus-4-7": [5.0, 25.0, 0.5, 6.25],
  "claude-opus-4-6": [5.0, 25.0, 0.5, 6.25],
  // Frontier tier
  "claude-fable-5": [10.0, 50.0, 1.0, 12.5],
};

/** An unmapped model is assumed to be Opus tier, never Sonnet. A meter that
 *  under-reports is the dangerous kind: it reads like an answer while the
 *  balance drains faster than it says. Over-reporting is visible and gets
 *  fixed. Same reasoning as _DEFAULT_RATE in intelligence/cost.py. */
const DEFAULT_RATE: [number, number, number, number] = [5.0, 25.0, 0.5, 6.25];

export interface TokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function costFor(
  model: string,
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0
): number {
  const [rin, rout, rcr, rcw] = PRICING[model] ?? DEFAULT_RATE;
  const usd =
    (input / 1e6) * rin +
    (output / 1e6) * rout +
    (cacheRead / 1e6) * rcr +
    (cacheWrite / 1e6) * rcw;
  return Math.round(usd * 1e6) / 1e6;
}

/**
 * Record one Anthropic call. Never throws, never blocks the caller's result.
 *
 * `action` is the spend bucket ("setter_reply", "screener", "stage_manager")
 * and is what a "where did the money go" query groups by, so name it after the
 * job rather than the function.
 */
export async function recordUsage(
  model: string,
  usage: TokenUsage | null | undefined,
  action: string,
  studentId?: number | null
): Promise<void> {
  try {
    if (!usage) return;
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    // A call that reported no tokens at all is a no-op, not a zero-cost row:
    // writing it would inflate the call count with nothing behind it.
    if (!input && !output && !cacheRead && !cacheWrite) return;
    // Columns match intelligence/cost.py's row exactly (there is no client_id
    // on this table, and the timestamp column is occurred_at with a default),
    // so one query totals both languages.
    await supabase.from("ai_usage").insert({
      model: model || "unknown",
      action,
      student_id: studentId ?? null,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      cost_usd: costFor(model, input, output, cacheRead, cacheWrite),
    });
  } catch (e) {
    // Observability only. Metering a reply must never break the reply.
    console.error("[ai-usage] record skipped:", e);
  }
}
