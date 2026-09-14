/**
 * Student session - the web-app half of the one-tap Telegram login.
 *
 * The login TOKEN is now database-backed (see app_link.py + app/login/route.ts) - no shared
 * secret. This module only mints/reads the longer-lived SESSION cookie the app sets after a
 * successful login, signed with an HMAC. All server-side; the secret never reaches the browser.
 * verifyLoginToken stays as a legacy fallback for any pre-DB HMAC links still in flight.
 */
import crypto from "crypto";

// The session-cookie signing secret. Read the service-role key under any of its per-platform
// env NAMES (Railway: AISETTER_SUPABASE_SERVICE_KEY; Vercel: SUPABASE_SERVICE_ROLE_KEY), or an
// explicit SESSION_SECRET. We FAIL CLOSED in production if none is set: a public "dev-secret"
// fallback would let anyone forge a student_session cookie for any student id.
const HAS_REAL_SECRET = Boolean(
  process.env.AISETTER_SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SESSION_SECRET,
);
const SECRET =
  process.env.AISETTER_SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SESSION_SECRET ||
  "dev-secret";
const SESSION_DAYS = 90; // ~3 months - the length of a student engagement, so they stay logged in the whole time

function assertRealSecret(): void {
  if (!HAS_REAL_SECRET && process.env.NODE_ENV === "production") {
    throw new Error(
      "No session secret configured (set SUPABASE_SERVICE_ROLE_KEY) - refusing to sign/verify " +
        "student sessions with a public default.",
    );
  }
}

function hmac(payload: string): string {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex").slice(0, 32);
}

function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

/** Verify the bot's login token → the student id, or null if bad/expired. */
export function verifyLoginToken(token: string): number | null {
  try {
    const raw = b64urlDecode(token); // "<sid>.<exp>.<sig>"
    const [sid, exp, sig] = raw.split(".");
    if (!sid || !exp || !sig) return null;
    if (hmac(`${sid}.${exp}`) !== sig) return null;
    if (parseInt(exp, 10) * 1000 < Date.now()) return null;
    return parseInt(sid, 10);
  } catch {
    return null;
  }
}

/** Make the app session cookie value for a student. */
export function makeSession(studentId: number): string {
  assertRealSecret();
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const payload = `${studentId}.${exp}`;
  return Buffer.from(`${payload}.${hmac("sess:" + payload)}`, "utf8").toString("base64url");
}

/** Read + verify the session cookie → student id, or null. */
export function readSession(cookieVal: string | undefined): number | null {
  if (!cookieVal) return null;
  assertRealSecret();
  try {
    const raw = b64urlDecode(cookieVal); // "<sid>.<exp>.<sig>"
    const [sid, exp, sig] = raw.split(".");
    if (!sid || !exp || !sig) return null;
    if (hmac("sess:" + `${sid}.${exp}`) !== sig) return null;
    if (parseInt(exp, 10) < Date.now()) return null;
    return parseInt(sid, 10);
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = "student_session";
export const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60;
