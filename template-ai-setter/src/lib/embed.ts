/**
 * SEMANTIC EMBEDDING for the shared memory search.
 *
 * Lives in its own module because two callers need it: the HQ brain's
 * search_memory, and the owner-extras content search. Needs OPENAI_API_KEY;
 * degrades to null (and callers to a friendly note) without it.
 */
export async function embedQuery(text: string): Promise<number[] | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: (text || "").slice(0, 8000) || " " }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

