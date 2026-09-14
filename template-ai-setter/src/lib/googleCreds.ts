/**
 * Google OAuth client id/secret resolver — env-first, then the shared Supabase
 * store (service_tokens row service='google_app'). Storing the keys in Supabase
 * lets them be wired with no Vercel/Railway env edit, and both this HQ app and
 * the Telegram bot (intelligence/google_workspace.py) read the same row.
 */
import { supabase } from "@/lib/supabase";

export async function appCreds(): Promise<{ cid: string; secret: string }> {
  // The client that minted the stored refresh token must be the one used to
  // refresh it. Order: explicit GOOGLE_OAUTH env → shared google_app row (what
  // /connect-google used) → legacy YouTube client (back-compat only).
  const envCid = (process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
  const envSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
  if (envCid && envSecret) return { cid: envCid, secret: envSecret };
  try {
    const { data } = await supabase
      .from("service_tokens")
      .select("client_id, client_secret")
      .eq("service", "google_app")
      .limit(1)
      .maybeSingle();
    const row = data as { client_id?: string; client_secret?: string } | null;
    const cid = (row?.client_id || "").trim();
    const secret = (row?.client_secret || "").trim();
    if (cid && secret) return { cid, secret };
  } catch {
    // fall through to the legacy env fallback
  }
  return {
    cid: envCid || (process.env.YOUTUBE_OAUTH_CLIENT_ID || "").trim(),
    secret: envSecret || (process.env.YOUTUBE_OAUTH_CLIENT_SECRET || "").trim(),
  };
}
