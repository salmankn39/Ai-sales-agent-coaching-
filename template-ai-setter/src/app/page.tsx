/**
 * TEST CHAT UI
 * ------------
 * Visit http://localhost:3000 (or your Vercel URL) to chat with your AI.
 *
 * This is a tool for YOU — used to train and debug the AI before going
 * live in real Instagram DMs.
 *
 * Two modes, picked with the toggle at the top:
 *   - Inbound:      you type as a lead, the AI replies (the original demo).
 *   - Reactivation: you describe a dormant/old lead in one line, the AI
 *     drafts a cold outbound opener to them. After that, you keep typing —
 *     now playing that lead replying — and it's a completely normal
 *     conversation from there (same engine, same rules, same everything).
 */

"use client";

import { useState, useEffect, useRef } from "react";

type Message = { role: "lead" | "ai" | "note"; content: string; ts: number; audio?: string };
type Mode = "inbound" | "reactivation";

function newSessionId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export default function TestChat() {
  const [mode, setMode] = useState<Mode>("inbound");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // A fresh, random session id every time this page loads (mount) — NOT a
  // fixed constant. This is what makes a genuinely new conversation: each
  // load/reload gets its own id, so the backend creates a brand new lead row
  // with no history, instead of every visitor/reload sharing one permanent
  // row and its accumulated facts forever (2026-09-15 bug). Also regenerated
  // on every mode switch, so inbound and reactivation never share a thread.
  const [sessionId, setSessionId] = useState<string>(() => newSessionId());
  // Reactivation mode has two steps: first the one-line note drafts an
  // opener, then every send after that is the operator playing the lead's
  // replies — a completely normal conversation from there on.
  const [reactivationStarted, setReactivationStarted] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  // The API behind this page is key-gated (it spends real model/TTS money and
  // writes live tables), so the page passes the operator key from its own URL:
  // visit /?k=<access key>. Without it the chat answers 401.
  const [accessKey, setAccessKey] = useState("");
  useEffect(() => {
    setAccessKey(new URLSearchParams(window.location.search).get("k") ?? "");
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setMessages([]);
    setReactivationStarted(false);
    setSessionId(newSessionId());
  }

  async function sendReactivationNote(note: string) {
    setMessages((prev) => [...prev, { role: "note", content: note, ts: Date.now() }]);
    setLoading(true);
    try {
      const res = await fetch(`/api/reactivate?k=${encodeURIComponent(accessKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note, session_id: sessionId }),
      });
      const data = await res.json();
      if (data.error) {
        setMessages((prev) => [
          ...prev,
          { role: "ai", content: `[ERROR] ${data.error}: ${data.details ?? ""}`, ts: Date.now() },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "ai", content: (data.segments as string[]).join("\n\n"), ts: Date.now() },
        ]);
        setReactivationStarted(true);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "ai", content: `[NETWORK ERROR] ${String(err)}`, ts: Date.now() },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");

    if (mode === "reactivation" && !reactivationStarted) {
      await sendReactivationNote(text);
      return;
    }

    setMessages((prev) => [...prev, { role: "lead", content: text, ts: Date.now() }]);
    setLoading(true);

    try {
      const res = await fetch(`/api/test?k=${encodeURIComponent(accessKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, session_id: sessionId }),
      });
      const data = await res.json();

      if (data.error) {
        setMessages((prev) => [
          ...prev,
          { role: "ai", content: `[ERROR] ${data.error}: ${data.details ?? ""}`, ts: Date.now() },
        ]);
      } else {
        // ONE Anthropic generation already happened server-side (see
        // /api/test) — it just comes back as an array of short bubble-sized
        // strings, because the SAME reply engine also drives the real live
        // Instagram setter, where sending several quick natural-feeling
        // texts is the intended behaviour. For this demo chat window there
        // is no reason to re-present one generation as several separate
        // messages, so they're joined into a single bubble (still with the
        // model's own paragraph breaks). Voice-note segments are the one
        // exception: an audio clip is its own distinct item and can't be
        // merged into a text bubble, so that case keeps the original
        // one-bubble-per-segment rendering.
        const clips: (string | null)[] = Array.isArray(data.clips) ? data.clips : [];
        const hasAudio = clips.some((c) => !!c);

        if (hasAudio) {
          for (let i = 0; i < data.segments.length; i++) {
            const seg = data.segments[i] as string;
            const audio = clips[i] || undefined;
            if (i > 0) {
              const chars = seg.length;
              const delay = Math.min(1500 + chars * 40, 5000);
              await new Promise((resolve) => setTimeout(resolve, delay));
              setMessages((prev) => [...prev, { role: "ai", content: "__typing__", ts: Date.now() }]);
              await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 1200)));
              setMessages((prev) => prev.filter((m) => m.content !== "__typing__"));
            }
            setMessages((prev) => [...prev, { role: "ai", content: seg, ts: Date.now(), audio }]);
          }
        } else {
          setMessages((prev) => [
            ...prev,
            { role: "ai", content: (data.segments as string[]).join("\n\n"), ts: Date.now() },
          ]);
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "ai", content: `[NETWORK ERROR] ${String(err)}`, ts: Date.now() },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function reset() {
    await fetch(`/api/test?k=${encodeURIComponent(accessKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, reset: true }),
    });
    setMessages([]);
    setReactivationStarted(false);
    setSessionId(newSessionId());
  }

  const placeholder =
    mode === "inbound"
      ? "type a message as if you were a lead..."
      : reactivationStarted
      ? "now type as the lead, replying to that message..."
      : "describe the dormant lead, e.g. \"reach out to Sarah, enquired about her son 3 months ago, never booked\"";

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.headerTop}>
          <div style={styles.title}>AI Setter — Test Chat</div>
          <button onClick={reset} style={styles.resetBtn}>reset</button>
        </div>
        <div style={styles.modeRow}>
          <button
            onClick={() => switchMode("inbound")}
            style={{ ...styles.modeBtn, ...(mode === "inbound" ? styles.modeBtnActive : {}) }}
          >
            Inbound Setter
          </button>
          <button
            onClick={() => switchMode("reactivation")}
            style={{ ...styles.modeBtn, ...(mode === "reactivation" ? styles.modeBtnActive : {}) }}
          >
            Reactivation
          </button>
        </div>
      </div>

      <div style={styles.chat}>
        {messages.length === 0 && (
          <div style={styles.empty}>
            {mode === "inbound" ? (
              <>
                <div>👋 you're chatting with the AI as if you were a lead.</div>
                <div style={styles.emptyHint}>
                  type a message below to test how it responds. edit your training
                  in Supabase (`clients.system_prompt`, `voice_samples`, `active_rules`)
                  and try again.
                </div>
              </>
            ) : (
              <>
                <div>📨 describe a dormant lead and watch the AI draft a win-back opener.</div>
                <div style={styles.emptyHint}>
                  e.g. "reach out to Tom, his son came to one session back in June and never
                  booked again" — then keep typing, playing that lead replying, to see the
                  whole conversation play out.
                </div>
              </>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              ...styles.bubble,
              ...(m.role === "lead"
                ? styles.leadBubble
                : m.role === "note"
                ? styles.noteBubble
                : styles.aiBubble),
            }}
          >
            {m.role === "note" ? (
              <>
                <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 2 }}>🗒️ instruction to the AI</div>
                {m.content}
              </>
            ) : m.content === "__typing__" ? (
              <span style={{ opacity: 0.5, fontStyle: "italic" }}>typing...</span>
            ) : m.audio ? (
              <div>
                <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>🎤 voice note</div>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio src={m.audio} controls autoPlay style={{ width: "100%", maxWidth: 260 }} />
                <div style={{ fontSize: 12, opacity: 0.55, marginTop: 4, fontStyle: "italic" }}>{m.content}</div>
              </div>
            ) : (
              m.content
            )}
          </div>
        ))}
        {loading && <div style={styles.typing}>thinking…</div>}
        <div ref={endRef} />
      </div>

      <div style={styles.inputRow}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={placeholder}
          style={styles.input}
          disabled={loading}
        />
        <button onClick={send} disabled={loading || !input.trim()} style={styles.sendBtn}>
          send
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 700,
    margin: "0 auto",
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    background: "#0a0a0a",
    color: "#e8e8e8",
  },
  header: {
    padding: "16px 20px",
    borderBottom: "1px solid #222",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  headerTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: { fontSize: 18, fontWeight: 600 },
  modeRow: { display: "flex", gap: 8 },
  modeBtn: {
    background: "#1a1a1a",
    border: "1px solid #333",
    color: "#999",
    padding: "6px 12px",
    borderRadius: 999,
    fontSize: 13,
    cursor: "pointer",
  },
  modeBtnActive: {
    background: "#0066ff",
    borderColor: "#0066ff",
    color: "white",
  },
  resetBtn: {
    background: "#2a1a1a",
    border: "1px solid #4a2a2a",
    color: "#e88",
    padding: "4px 10px",
    borderRadius: 4,
    fontSize: 12,
    cursor: "pointer",
  },
  chat: {
    flex: 1,
    overflowY: "auto",
    padding: 20,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  empty: {
    color: "#666",
    textAlign: "center",
    margin: "auto 0",
    padding: 20,
  },
  emptyHint: { fontSize: 13, marginTop: 12, color: "#555" },
  bubble: {
    padding: "10px 14px",
    borderRadius: 16,
    maxWidth: "75%",
    fontSize: 15,
    lineHeight: 1.4,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  leadBubble: {
    alignSelf: "flex-end",
    background: "#0066ff",
    color: "white",
    borderBottomRightRadius: 4,
  },
  aiBubble: {
    alignSelf: "flex-start",
    background: "#1f1f1f",
    color: "#e8e8e8",
    borderBottomLeftRadius: 4,
  },
  noteBubble: {
    alignSelf: "center",
    background: "transparent",
    border: "1px dashed #444",
    color: "#999",
    fontStyle: "italic",
    maxWidth: "90%",
  },
  typing: { color: "#666", fontSize: 13, fontStyle: "italic", padding: "4px 12px" },
  inputRow: {
    display: "flex",
    gap: 8,
    padding: 16,
    borderTop: "1px solid #222",
  },
  input: {
    flex: 1,
    background: "#1a1a1a",
    border: "1px solid #333",
    color: "#e8e8e8",
    padding: "10px 14px",
    borderRadius: 20,
    fontSize: 15,
    outline: "none",
  },
  sendBtn: {
    background: "#0066ff",
    border: "none",
    color: "white",
    padding: "10px 20px",
    borderRadius: 20,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
};
