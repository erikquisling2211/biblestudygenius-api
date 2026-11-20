import Parser from "rss-parser";

const parser = new Parser({
  timeout: 8000,
  headers: { "User-Agent": "BibleStudyGenius/1.0 (+https://biblestudygenius.com)" },
});

// Edit this list freely. { source: display name, url: RSS feed, category }.
// category "news" = Christian News (the default /news feed); "archaeology" = biblical archaeology.
const FEEDS = [
  { source: "The Gospel Coalition", url: "https://www.thegospelcoalition.org/feed/", category: "news" },
  { source: "Relevant", url: "https://relevantmagazine.com/feed/", category: "news" },
  { source: "Desiring God", url: "https://www.desiringgod.org/blog.rss", category: "news" },
  { source: "(in)courage", url: "https://www.incourage.me/feed/", category: "news" },
  { source: "Crosswalk", url: "https://www.crosswalk.com/devotionals/your-daily-bible-verse/rss/", category: "news" },
  { source: "Bible History Daily (BAS)", url: "https://www.biblicalarchaeology.org/feed/", category: "archaeology" },
  { source: "Bible Archaeology Report", url: "https://biblearchaeologyreport.com/feed/", category: "archaeology" },
  { source: "Associates for Biblical Research", url: "https://biblearchaeology.org/feed", category: "archaeology" },
  { source: "ASOR", url: "https://www.asor.org/feed/", category: "archaeology" },
];
// Housekeeping posts some archaeology feeds mix in (scam alerts, office notices).
const SKIP = /phishing|fraudulent|scam|office (closed|closure)|job opening|we.re hiring/i;
const CAP = { news: 40, archaeology: 30 };

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
        category: f.category,
        summary: clean(it.contentSnippet || it.content || it.summary || ""),
        date: it.isoDate || it.pubDate || null,
      })).filter((x) => !SKIP.test(x.title));
    })
  );
  const all = [];
  for (const r of results) if (r.status === "fulfilled") all.push(...r.value);
  const seen = new Set();
  const deduped = all.filter((x) => x.link && x.title && !seen.has(x.link) && seen.add(x.link));
  deduped.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
  // keep the newest N of each category so one category can't crowd out the other
  const count = {};
  return deduped.filter((x) => (count[x.category] = (count[x.category] || 0) + 1) <= (CAP[x.category] || 40));
}

function pick(items, category) {
  const c = String(category || "news");
  return c === "all" ? items : items.filter((x) => x.category === c);
}

export function mountNews(app) {
  // GET /news                      → Christian News only (what app builds before Nov 2026 expect)
  // GET /news?category=archaeology  → archaeology only
  // GET /news?category=all          → everything, each item tagged with its category
  app.get("/news", async (req, res) => {
    try {
      const now = Date.now();
      if (now - cache.at > TTL || !cache.items.length) {
        const items = await build();
        if (items.length) cache = { at: now, items };
      }
      res.json({ items: pick(cache.items, req.query.category), updated: cache.at });
    } catch (e) {
      console.log("[news] error", String(e));
      res.json({ items: pick(cache.items || [], req.query.category), updated: cache.at || 0 });
    }
  });
}
