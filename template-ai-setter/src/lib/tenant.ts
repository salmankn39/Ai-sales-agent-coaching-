/**
 * WHOSE SETTER IS THIS COPY?
 *
 * Two things your deployment needs to know about itself. Both come from your
 * Vercel environment variables, never from code, so nothing here has to be
 * edited and your copy stays identical to everyone else's.
 *
 * DEFAULT_CLIENT_SLUG is the name of YOUR OWN setter's row in the clients
 * table. It is what the dashboard, HQ chat and Telegram act on when you do not
 * name a client, and what an inbound webhook falls back to when its URL names
 * none. Set it once at setup and never change it.
 *
 * Selling to more than one business does NOT go through this: each client you
 * onboard gets their own webhook URL carrying ?client_slug=..., resolved per
 * request in the inbound route.
 *
 * BUSINESS_TIMEZONE decides which calendar day every number belongs to. Set it
 * to your own timezone (for example "America/New_York" or "Europe/London") and
 * "today" on your dashboard means today where you are. Left unset it is UTC,
 * which is correct but may cut your day at an odd hour.
 */
export function ownerSlug(): string {
  return (process.env.DEFAULT_CLIENT_SLUG || "").trim() || "my-setter";
}

/** The timezone the business day is measured in. */
export function businessTimezone(): string {
  return (process.env.BUSINESS_TIMEZONE || "").trim() || "UTC";
}
