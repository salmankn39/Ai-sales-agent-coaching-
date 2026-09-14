/**
 * WHEN IS A REPLY LOCK SPENT?
 *
 * The reply lock serializes turns per lead. reply-now inspects a fresh-looking
 * lock instead of blindly trusting it: the locked generation may have finished
 * (killed invocation, orphaned lock) or may still be alive mid-send. Getting
 * this call wrong in the "still alive" direction is how the Scott Hall
 * incident happened (2026-08-20): one delivered bubble out of four was read as
 * "send-complete", the lock was reclaimed, and a second concurrent turn ran
 * against a half-sent volley - it read the unsent question out of the DB as
 * already-said, declared itself stuck, and switched the AI off, which then
 * blocked the real question's send four seconds later.
 *
 * So: a volley is finished when EVERY bubble is settled, not when the first
 * lands. The only ways a lock is spent:
 *   - a human message landed after the stamp (the owner took the thread), or
 *   - owner rows exist and every AI row among them is delivered, or
 *   - owner rows exist but the newest is older than SEND_GRACE_MS - a live
 *     sender would have finished long ago, so the run died mid-send.
 * No rows after the stamp = the generation is still composing: back off.
 */

export const SEND_GRACE_MS = 45_000;

export type OwnerRow = {
  role: string;
  created_at: string;
  delivered_at?: string | null;
};

export function replyLockIsSpent(ownerRows: OwnerRow[], nowMs: number): boolean {
  if (ownerRows.some((m) => m.role === "human")) return true;
  if (ownerRows.length === 0) return false;

  const aiRows = ownerRows.filter((m) => m.role === "ai");
  if (aiRows.length > 0 && aiRows.every((m) => !!m.delivered_at)) return true;

  const newestMs = Math.max(...ownerRows.map((m) => new Date(m.created_at).getTime()));
  return nowMs - newestMs > SEND_GRACE_MS;
}
