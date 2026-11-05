import Parser from "rss-parser";

const parser = new Parser({
  timeout: 8000,
  headers: { "User-Agent": "BibleStudyGenius/1.0 (+https://biblestudygenius.com)" },
});

// Edit this list freely. { source: display name, url: RSS feed }.
const FEEDS = [
  { source: "The Gospel Coalition", url: "https://www.thegospelcoalition.org/feed/" },
  { source: "Relevant", url: "https://relevantmagazine.com/feed/" },
  { source: "Desiring God", url: "https://www.desiringgod.org/blog.rss" },
  { source: "(in)courage", url: "https://www.incourage.me/feed/" },
  { source: "Crosswalk", url: "https://www.crosswalk.com/devotionals/your-daily-bible-verse/rss/" },
];

const TTL = 15 * 60 * 1000;
let cache = { at: 0, items: [] };

function clean(html) {
  if (!html) return "";
  return String(html)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;/g, "’")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

async function build() {
  const results = await Promise.allSettled(
    FEEDS.map(async (f) => {
      const feed = await parser.parseURL(f.url);
      return (feed.items || []).slice(0, 12).map((it) => ({
        title: (it.title || "").trim(),
        link: it.link || "",
        source: f.source,
        summary: clean(it.contentSnippet || it.content || it.summary || ""),
        date: it.isoDate || it.pubDate || null,
      }));
    })
  );
  const all = [];
  for (const r of results) if (r.status === "fulfilled") all.push(...r.value);
  const seen = new Set();
  const deduped = all.filter((x) => x.link && x.title && !seen.has(x.link) && seen.add(x.link));
  deduped.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
  return deduped.slice(0, 40);
}

export function mountNews(app) {
  app.get("/news", async (_req, res) => {
    try {
      const now = Date.now();
      if (now - cache.at > TTL || !cache.items.length) {
        const items = await build();
        if (items.length) cache = { at: now, items };
      }
      res.json({ items: cache.items, updated: cache.at });
    } catch (e) {
      console.log("[news] error", String(e));
      res.json({ items: cache.items || [], updated: cache.at || 0 });
    }
  });
}
