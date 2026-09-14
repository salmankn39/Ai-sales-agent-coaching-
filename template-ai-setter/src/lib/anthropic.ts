/**
 * Lazy Anthropic client (shared) - and the single place every dollar is counted.
 *
 * We must NOT construct the client — or throw on a missing key — at module import
 * time. Next.js loads every route module during `next build` page-data collection,
 * even force-dynamic ones, where the build env may lack ANTHROPIC_API_KEY. Throwing
 * there fails the whole production build. Instead we build the client on first real
 * use (a request), when the key is present in production. Build/preview = no throw.
 *
 * METERING LIVES HERE, NOT AT THE CALL SITES (2026-08-16). The owner topped up $20 and
 * asked to know "one hundred percent where each cent went". The honest answer at the
 * time was that we could not: the meter had exactly one reporting call site and read
 * $1.27 across ten days while real spend was several dollars a day. The fix that
 * would have rotted immediately is sprinkling a record() call into all 28 call
 * sites, because call site 29 lands next week and is silently free again - which is
 * the same failure that let the balance reach zero unannounced. So the wrapper below
 * meters `messages.create` once, and every client in the app comes from here.
 * `tests/no-unmetered-clients.test.ts` fails the build if a `new Anthropic()` appears
 * anywhere else, which is what actually keeps this at 100% rather than good intentions.
 */
import Anthropic from "@anthropic-ai/sdk";
import { recordUsage, type TokenUsage } from "./ai-usage";

let _client: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY in environment variables.");
  _client = new Anthropic({ apiKey: key });
  return _client;
}

type AnyFn = (...a: unknown[]) => unknown;
const bindIfFn = (v: unknown, self: unknown) =>
  typeof v === "function" ? (v as AnyFn).bind(self) : v;

/**
 * A client whose `messages.create` records what it cost, tagged with `action`.
 *
 * Construction stays deferred to first property access, so this is safe to call at
 * module scope in a route file. Nothing here can break a call: the usage row is
 * fire-and-forget and recordUsage never throws, because a bookkeeping failure must
 * never be the reason a lead does not get a reply.
 */
export function claude(action: string, studentId?: number | null): Anthropic {
  return new Proxy({} as Anthropic, {
    get(_t, prop) {
      const client = getAnthropic() as unknown as Record<string | symbol, unknown>;
      if (prop !== "messages") return bindIfFn(client[prop], client);

      const messages = client.messages as Record<string | symbol, unknown>;
      return new Proxy(messages, {
        get(_m, mprop) {
          if (mprop !== "create") return bindIfFn(messages[mprop], messages);
          return async (...args: unknown[]) => {
            const resp = await (messages.create as AnyFn).apply(messages, args);
            // The response carries the model the API actually served, which is the
            // one to price; the request's model is the fallback for a shape that
            // does not echo it back.
            const asked = (args[0] ?? {}) as { model?: string };
            const got = (resp ?? {}) as { model?: string; usage?: TokenUsage };
            void recordUsage(got.model || asked.model || "unknown", got.usage, action, studentId);
            return resp;
          };
        },
      });
    },
  });
}

/**
 * The shared client, for call sites that have not named their spend bucket.
 *
 * It is metered like every other client, just filed under "unattributed" - because
 * the number that must never be wrong is the TOTAL. A call landing in the wrong
 * bucket is a reporting annoyance; a call landing nowhere is the bug that hid the
 * screener. Prefer `claude("your_action")` so the breakdown stays useful.
 */
export const anthropic: Anthropic = claude("unattributed");
