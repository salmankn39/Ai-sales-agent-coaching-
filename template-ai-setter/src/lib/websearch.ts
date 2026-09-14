/**
 * Web research for Jarvis HQ — the TS twin of intelligence/web_research.py, so
 * HQ answers "what's the latest on X" exactly like the Telegram bot does.
 *
 * Tavily (synthesized answer + sources) when TAVILY_API_KEY is set, otherwise
 * free Google News RSS. Defensive: a network hiccup returns an empty-ish result,
 * never throws into the chat loop.
 */

export interface WebResult {
  query: string;
  answer?: string;
  results: { title: string; url?: string; source?: string }[];
}

async function tavily(query: string, maxResults: number): Promise<WebResult | null> {
  const key = (process.env.TAVILY_API_KEY || "").trim();
  if (!key) return null;
  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        max_results: maxResults,
        include_answer: true,
        search_depth: "basic",
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      answer?: string;
      results?: { title?: string; url?: string }[];
    };
    return {
      query,
      answer: (data.answer || "").trim() || undefined,
      results: (data.results || []).slice(0, maxResults).map((r) => ({
        title: (r.title || "").trim(),
        url: r.url,
      })),
    };
  } catch {
    return null;
  }
}

function stripTag(s: string): string {
  return s
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

async function newsRss(query: string, maxResults: number): Promise<WebResult> {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const resp = await fetch(url);
    if (!resp.ok) return { query, results: [] };
    const xml = await resp.text();
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
    const results = items.slice(0, maxResults).map((item) => {
      const title = stripTag((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
      const link = stripTag((item.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "");
      const source = stripTag((item.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || "");
      return { title, url: link || undefined, source: source || undefined };
    }).filter((r) => r.title);
    return { query, results };
  } catch {
    return { query, results: [] };
  }
}

/** Search the live web. Tavily if keyed, else Google News RSS. Never throws. */
export async function webSearch(query: string, maxResults = 6): Promise<WebResult> {
  const q = (query || "").trim();
  if (!q) return { query: "", results: [] };
  const t = await tavily(q, maxResults);
  if (t && (t.answer || t.results.length)) return t;
  return newsRss(q, maxResults);
}
