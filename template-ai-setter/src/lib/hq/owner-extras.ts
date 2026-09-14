/**
 * NO EXTRAS — this kit ships the AI setter, and only the AI setter.
 *
 * The live engine this kit is generated from also runs its owner's other
 * businesses: a YouTube content board, an idea engine, a thumbnail renderer, a
 * clip library, a staff roster. Those are real tools, but they belong to that
 * one business, not to the product your agency sells. So the generator
 * overlays this stub in their place: same exports, nothing in them.
 *
 * Your HQ brain therefore never sees those tools and never mentions them. The
 * setter, the dashboard, the CRM tools and Telegram control are all untouched.
 *
 * Adding your own tools here is the intended way to extend HQ. Push a tool
 * definition into OWNER_EXTRA_TOOLS, handle its name in runOwnerExtraTool, and
 * describe it in one line in OWNER_EXTRA_SYSTEM. Nothing else has to change.
 */

/** Extra tool definitions for your HQ brain. Empty by default. */
export const OWNER_EXTRA_TOOLS: Array<{
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}> = [];

/** Extra guidance appended to the HQ system prompt. Empty by default. */
export const OWNER_EXTRA_SYSTEM = "";

/**
 * Run one of the extra tools above. Returning null means "not one of mine",
 * which is how an empty tool list stays out of the way.
 */
export async function runOwnerExtraTool(
  _name: string,
  _input: Record<string, unknown>,
): Promise<{ result: unknown } | null> {
  return null;
}
