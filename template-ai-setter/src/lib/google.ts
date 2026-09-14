/**
 * Google Calendar + Gmail for Jarvis HQ — the TS twin of
 * intelligence/google_workspace.py. Reads the SAME shared refresh token from
 * Supabase `service_tokens` (written by /connect-google), mints a short-lived
 * access token, and calls the Google REST APIs directly (no extra deps).
 *
 * Defensive: anything missing/erroring returns a tagged object the chat brain
 * can speak ({not_connected:true} | {error}), never throws into the loop.
 */
import { supabase } from "@/lib/supabase";
import { appCreds } from "@/lib/googleCreds";

export const NOT_CONNECTED = {
  not_connected: true,
  message: "Google isn't connected yet. Open the Connect-Google link and click Allow once.",
};

export async function accessToken(): Promise<string | null> {
  const { cid, secret } = await appCreds();
  if (!cid || !secret) return null;
  try {
    const { data } = await supabase
      .from("service_tokens")
      .select("refresh_token")
      .eq("service", "google")
      .limit(1)
      .maybeSingle();
    const refresh = (data as { refresh_token?: string } | null)?.refresh_token;
    if (!refresh) return null;
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cid,
        client_secret: secret,
        refresh_token: refresh,
        grant_type: "refresh_token",
      }),
    });
    if (!resp.ok) return null;
    const j = (await resp.json()) as { access_token?: string };
    return j.access_token ?? null;
  } catch {
    return null;
  }
}

// ── Calendar ──────────────────────────────────────────────────────────────
export async function listEvents(days = 7) {
  const token = await accessToken();
  if (!token) return NOT_CONNECTED;
  try {
    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + days * 86400000).toISOString();
    const url =
      `https://www.googleapis.com/calendar/v3/calendars/primary/events` +
      `?singleEvents=true&orderBy=startTime&maxResults=20` +
      `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`;
    const resp = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!resp.ok) return { error: `calendar_${resp.status}` };
    const j = (await resp.json()) as { items?: Array<Record<string, unknown>> };
    const events = (j.items || []).map((e) => {
      const start = (e.start || {}) as { dateTime?: string; date?: string };
      return { id: e.id as string, start: start.dateTime || start.date || "?", title: (e.summary as string) || "(no title)" };
    });
    return { events };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function manageEvent(input: {
  action: string;
  title?: string;
  start?: string;
  end?: string;
  description?: string;
  event_id?: string;
}) {
  const token = await accessToken();
  if (!token) return NOT_CONNECTED;
  const base = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    if (input.action === "create") {
      if (!input.title || !input.start) return { error: "need_title_and_start" };
      const end = input.end || new Date(new Date(input.start).getTime() + 30 * 60000).toISOString();
      const resp = await fetch(base, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          summary: input.title,
          description: input.description || "",
          start: { dateTime: input.start },
          end: { dateTime: end },
        }),
      });
      if (!resp.ok) return { error: `create_${resp.status}` };
      return { ok: true, created: input.title };
    }
    if (input.action === "cancel") {
      if (!input.event_id) return { error: "need_event_id" };
      const resp = await fetch(`${base}/${input.event_id}`, { method: "DELETE", headers: auth });
      if (!resp.ok && resp.status !== 410) return { error: `cancel_${resp.status}` };
      return { ok: true, cancelled: input.event_id };
    }
    if (input.action === "update") {
      if (!input.event_id) return { error: "need_event_id" };
      const patch: Record<string, unknown> = {};
      if (input.title) patch.summary = input.title;
      if (input.description) patch.description = input.description;
      if (input.start) patch.start = { dateTime: input.start };
      if (input.end) patch.end = { dateTime: input.end };
      const resp = await fetch(`${base}/${input.event_id}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify(patch),
      });
      if (!resp.ok) return { error: `update_${resp.status}` };
      return { ok: true, updated: input.event_id };
    }
    return { error: "unknown_action" };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// ── Gmail ───────────────────────────────────────────────────────────────────
export async function searchEmail(query = "", maxResults = 8) {
  const token = await accessToken();
  if (!token) return NOT_CONNECTED;
  const auth = { authorization: `Bearer ${token}` };
  try {
    const listUrl =
      `https://gmail.googleapis.com/gmail/v1/users/me/messages` +
      `?maxResults=${maxResults}&q=${encodeURIComponent(query || "in:inbox")}`;
    const listResp = await fetch(listUrl, { headers: auth });
    if (!listResp.ok) return { error: `gmail_${listResp.status}` };
    const ids = ((await listResp.json()) as { messages?: Array<{ id: string }> }).messages || [];
    const emails = await Promise.all(
      ids.slice(0, maxResults).map(async (m) => {
        const r = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
          { headers: auth },
        );
        if (!r.ok) return null;
        const full = (await r.json()) as {
          snippet?: string;
          payload?: { headers?: Array<{ name: string; value: string }> };
        };
        const h = Object.fromEntries((full.payload?.headers || []).map((x) => [x.name, x.value]));
        return { id: m.id, from: h.From || "?", subject: h.Subject || "(no subject)", snippet: (full.snippet || "").slice(0, 160) };
      }),
    );
    return { emails: emails.filter(Boolean) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function sendEmail(to: string, subject: string, body: string) {
  const token = await accessToken();
  if (!token) return NOT_CONNECTED;
  if (!to || !body) return { error: "need_to_and_body" };
  try {
    const raw = Buffer.from(
      `To: ${to}\r\nSubject: ${subject || "(no subject)"}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!resp.ok) return { error: `send_${resp.status}` };
    return { ok: true, sent_to: to };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
