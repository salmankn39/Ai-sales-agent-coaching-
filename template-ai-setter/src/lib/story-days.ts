/**
 * The 7-day story schedule as DATA, for the surfaces that need the day's play as a
 * short line rather than as a prompt.
 *
 * The long-form version in story-engine.ts is what Claude is given. This is the same
 * schedule at a glance: the label a student reads on the card, and the one sentence
 * that tells them what today's job actually is. They must not drift, so if a day's
 * play changes, it changes in both.
 */
export type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export const DAY_PLAYS: Record<Weekday, { label: string; job: string }> = {
  monday:    { label: "Hard call to action",  job: "One direct ask. Tell people to DM you, apply, or book a call." },
  tuesday:   { label: "Social proof + your day", job: "Two or three wins, then document the day as it actually goes." },
  wednesday: { label: "Authority + Q&A",      job: "Two or three proof slides, then a question sticker. Answer them properly." },
  thursday:  { label: "Reset + soft ask",     job: "Clear your stories, then give something away free to start conversations." },
  friday:    { label: "Social proof + life",  job: "Three proof slides, talk to people, and show the life around the work." },
  saturday:  { label: "Keep it light",        job: "Clear your stories. One client win. That is the whole day." },
  sunday:    { label: "Life + family",        job: "Family and downtime. Let them see the person, not the business." },
};

const ORDER: Weekday[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** The weekday it is where the student is, not where the server is. */
export function weekdayIn(tz: string, now: Date = new Date()): Weekday {
  try {
    const name = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz })
      .format(now).toLowerCase() as Weekday;
    return ORDER.includes(name) ? name : ORDER[now.getDay()];
  } catch {
    // An unknown timezone must not take the card down with it.
    return ORDER[now.getDay()];
  }
}
