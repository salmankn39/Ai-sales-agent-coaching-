/**
 * YOUR LEAD MAGNETS — empty until you add one.
 *
 * A lead magnet is the "reply WORD for the free thing" flow: someone DMs a
 * keyword from your story, the setter asks for their email, sends the link,
 * then hands the conversation to the AI a minute later.
 *
 * This file ships empty ON PURPOSE. Nothing happens until you add an entry,
 * and no lead can trigger a magnet you have not set up.
 *
 * This is one of the very few files in the kit you are meant to edit. To add
 * one, copy the shape below and fill in your own words and your own link:
 *
 *   export const MAGNETS: Record<string, MagnetConfig> = {
 *     guide: {
 *       keyword: "guide",
 *       askEmail: "nice, sending it now. drop your email here so my system picks it up",
 *       linkMessage: (link) => `here you go, grab it here: ${link}`,
 *       link: "https://your-site.com/your-free-thing",
 *     },
 *   };
 *
 * The keyword must be lowercase letters and is matched with a one-letter typo
 * tolerance, so "guied" still counts. Add as many entries as you like; each is
 * keyed by its own trigger word.
 */

export interface MagnetConfig {
  /** The trigger word people reply to your story with (lowercase, letters). */
  keyword: string;
  /** The message that asks for their email. */
  askEmail: string;
  /** The message that delivers the link. */
  linkMessage: (link: string) => string;
  /** Where the free thing lives. */
  link: string;
}

export const MAGNETS: Record<string, MagnetConfig> = {};

/** The key used when a caller does not name one. null when none are set up. */
export function defaultMagnetKey(): string | null {
  return Object.keys(MAGNETS)[0] ?? null;
}
