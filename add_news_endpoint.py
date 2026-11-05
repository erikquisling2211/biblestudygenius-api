#!/usr/bin/env python3
# Add a /news endpoint to the Bible Study Genius backend: fetch several Christian news
# RSS feeds, merge + dedupe + sort newest-first, cache 15 min, return clean JSON.
# Failing feeds are skipped so one bad URL never breaks the endpoint.
# RUN FROM THE BACKEND FOLDER:  ~/Desktop/biblestudygenius-api
import sys, os

if not os.path.exists("src/index.js"):
    print("ABORT - run this from ~/Desktop/biblestudygenius-api (src/index.js not found)")
    sys.exit(1)

NEWS_JS = r'''import Parser from "rss-parser";

const parser = new Parser({
  timeout: 8000,
  headers: { "User-Agent": "BibleStudyGenius/1.0 (+https://biblestudygenius.com)" },
});

// Edit this list freely. { source: display name, url: RSS feed }.
const FEEDS = [
  { source: "The Christian Post", url: "https://www.christianpost.com/category/featured-news/rss" },
  { source: "The Christian Post", url: "https://www.christianpost.com/category/us/rss" },
  { source: "The Christian Post", url: "https://www.christianpost.com/category/world/rss" },
  { source: "The Christian Post", url: "https://www.christianpost.com/category/church-ministries/rss" },
  { source: "The Gospel Coalition", url: "https://www.thegospelcoalition.org/feed/" },
  { source: "Relevant", url: "https://relevantmagazine.com/feed/" },
  { source: "Baptist Press", url: "https://www.baptistpress.com/feed/" },
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
'''

# 1) write src/news.js
if os.path.exists("src/news.js"):
    print("src/news.js already exists — leaving it as-is")
else:
    open("src/news.js", "w", encoding="utf-8").write(NEWS_JS)
    print("created src/news.js OK")

# 2) wire into src/index.js
s = open("src/index.js", encoding="utf-8").read()
changed = False

if "mountNews" not in s:
    if 'import express from "express";' in s:
        s = s.replace('import express from "express";',
                      'import express from "express";\nimport { mountNews } from "./news.js";', 1)
        print("added news import OK")
    else:
        print("ABORT - could not find express import in src/index.js")
        sys.exit(1)

    anchor = 'app.get("/privacy", (_req, res) => res.type("html").send(PRIVACY_HTML));'
    if anchor in s:
        s = s.replace(anchor, anchor + "\nmountNews(app);", 1)
        print("mounted /news OK")
    else:
        # fallback: mount after /health
        h = 'app.get("/health", (_req, res) => res.json({ ok: true }));'
        if h in s:
            s = s.replace(h, h + "\nmountNews(app);", 1)
            print("mounted /news (after /health) OK")
        else:
            print("ABORT - could not find a mount anchor in src/index.js")
            sys.exit(1)
    changed = True
else:
    print("index.js already wired for news")

if changed:
    open("src/index.js", "w", encoding="utf-8").write(s)

print("\nnews endpoint patch done.")
