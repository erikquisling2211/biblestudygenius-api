/**
 * sermonpages.js — public, server-rendered, SEO-friendly church + sermon pages.
 * Intended host: https://sermons.biblestudygenius.com (CNAME to this service).
 *
 *   GET /churches                          directory of all active churches
 *   GET /church/:slug                      church landing page (slug from the church name)
 *   GET /church/:slug/sermon/:sermonId     sermon + study guide page
 *   GET /sitemap.xml                       every church + sermon URL
 *   GET /robots.txt                        allow all, points at the sitemap
 *
 * Numeric /church/:id stays the app's JSON API (churches.js) — these routes only
 * handle non-numeric slugs. Data comes straight from the churches/sermons tables
 * the sermon pipeline fills (summary, scriptures, plan, questions, audio, video).
 *
 * Mount from index.js AFTER mountChurches(app).
 */
import { pool } from "./db.js";

const PUBLIC_BASE = (process.env.SERMONS_SITE_URL || "https://sermons.biblestudygenius.com").replace(/\/$/, "");
const APP_SITE = (process.env.SITE_URL || "https://biblestudygenius.com").replace(/\/$/, "");
// Same base churches.js uses for the podcast feed's self URL (what churches submit to Apple/Spotify).
const FEED_BASE = (process.env.PUBLIC_API_URL || "https://biblestudygenius-api-production.up.railway.app").replace(/\/$/, "");
const APP_STORE_URL = "https://apps.apple.com/app/id6797073366";
const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.biblestudygenius.app";
const RESERVED = new Set(["me", "login", "search", "near"]);
const TZ = "America/Chicago";

/* ---------------- helpers ---------------- */
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const xmlEsc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const jsonLd = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s; };

export function slugify(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/['’]/g, "").replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "church";
}

/** "The Widow’s Mite (Dr. Davis Chappell)" -> { title: "The Widow’s Mite", speaker: "Dr. Davis Chappell" } */
function splitTitle(rawTitle, preacher) {
  const t = String(rawTitle || "Sermon").trim();
  const m = t.match(/^(.*\S)\s*\(([^()]{3,60})\)\s*$/);
  if (m && !preacher) return { title: m[1], speaker: m[2] };
  if (m && preacher && m[2].includes(String(preacher).split(" ").pop())) return { title: m[1], speaker: preacher };
  return { title: t, speaker: preacher || null };
}

function sermonDate(s) {
  const ms = Number(s.sermon_ts) || Date.parse(s.sermon_date || "") || 0;
  if (!ms) return { iso: null, label: "" };
  const d = new Date(ms);
  return { iso: d.toISOString(), label: d.toLocaleDateString("en-US", { timeZone: TZ, year: "numeric", month: "long", day: "numeric" }) };
}

const coverPath = (name) => `/cover.png?title=${encodeURIComponent(String(name).slice(0, 80))}&sub=Sermons`;
const coverUrl = (name) => `${PUBLIC_BASE}${coverPath(name)}&w=1200`; // absolute: og:image / JSON-LD (1200px JPEG)
// Full official name (what people search for) for slugs, titles and headings; display_name is the app's short label.
const churchName = (c) => c.name || c.display_name;
const place = (c) => [c.city, c.state].filter(Boolean).join(", ");
const asArray = (v) => (Array.isArray(v) ? v : []);

/* ---------------- data (cached briefly) ---------------- */
let churchCache = { at: 0, list: [], bySlug: new Map(), byId: new Map() };
async function churches() {
  if (Date.now() - churchCache.at < 5 * 60 * 1000 && churchCache.list.length) return churchCache;
  const r = await pool.query(
    `SELECT c.id, c.name, c.display_name, c.city, c.state, c.denomination, c.website, c.feed_url,
            c.logo_url, c.brand_color, c.apple_podcasts_url, c.spotify_url,
            COUNT(s.id)::int AS sermon_count, MAX(COALESCE(s.sermon_ts, s.processed_at)) AS last_ts
       FROM churches c LEFT JOIN sermons s ON s.church_id = c.id
      WHERE c.active
      GROUP BY c.id ORDER BY c.name`
  );
  const bySlug = new Map(), byId = new Map(), taken = new Map();
  for (const c of r.rows) {
    let slug = slugify(churchName(c));
    if (taken.has(slug)) slug = slugify(`${churchName(c)} ${c.city || ""}`);
    if (taken.has(slug) || RESERVED.has(slug) || /^\d+$/.test(slug)) slug = `${slug}-${c.id}`;
    taken.set(slug, c.id);
    c.slug = slug;
    bySlug.set(slug, c); byId.set(c.id, c);
  }
  churchCache = { at: Date.now(), list: r.rows, bySlug, byId };
  return churchCache;
}

async function sermonsFor(churchId, limit = 100) {
  const r = await pool.query(
    `SELECT id, title, preacher, sermon_date, sermon_ts, processed_at, audio_url, summary, scriptures, plan, questions,
            video_id, sermon_start_sec, sermon_end_sec
       FROM sermons WHERE church_id = $1
      ORDER BY sermon_ts DESC NULLS LAST, processed_at DESC LIMIT $2`, [churchId, limit]
  );
  return r.rows;
}

/* Apple Podcasts show URL: stored value, else look up the church's feed in the iTunes directory. */
const appleCache = new Map(); // churchId -> { at, url }
async function appleUrl(c) {
  if (c.apple_podcasts_url) return c.apple_podcasts_url;
  const hit = appleCache.get(c.id);
  if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return hit.url;
  let url = null;
  try {
    const feeds = new Set([c.feed_url, `${FEED_BASE}/church/${c.id}/feed.xml`, `${PUBLIC_BASE}/church/${c.id}/feed.xml`]
      .filter(Boolean).map((u) => String(u).replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase()));
    const ctrl = AbortSignal.timeout(2500);
    const r = await fetch(`https://itunes.apple.com/search?media=podcast&entity=podcast&limit=25&term=${encodeURIComponent(churchName(c))}`, { signal: ctrl });
    if (r.ok) {
      const j = await r.json();
      const m = (j.results || []).find((p) => p.feedUrl && feeds.has(String(p.feedUrl).replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase()));
      url = m?.collectionViewUrl ? String(m.collectionViewUrl).split("?")[0] : null;
    }
  } catch { /* lookup is best-effort */ }
  appleCache.set(c.id, { at: Date.now(), url });
  return url;
}

/* ---------------- brand color contrast ---------------- */
function lum(hex) {
  let h = String(hex).replace("#", "");
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
/** Brand color for text/links only if readable on the dark page; button text flips white/dark for legibility. */
function palette(brand) {
  const gold = "#d8b25a", bg = "#14132b";
  const ok = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(brand || "");
  const btn = ok ? brand : gold;
  return {
    text: ok && contrast(brand, bg) >= 4.5 ? brand : gold,
    btn,
    btnText: contrast(btn, "#ffffff") >= 4.5 ? "#ffffff" : "#1a1830",
  };
}

/* ---------------- layout ---------------- */
function page({ title, description, canonical, image, type = "website", body, ld, accent }) {
  const pal = palette(accent);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:site_name" content="Bible Study Genius">
<meta property="og:type" content="${esc(type)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="1200">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${esc(image)}">
<meta name="apple-itunes-app" content="app-id=6797073366">
<link rel="icon" href="/assets/brand/icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Source+Sans+3:wght@400;600;700&display=swap">
${ld ? `<script type="application/ld+json">${jsonLd(ld)}</script>` : ""}
<style>
:root{--bg:#14132b;--card:#1e1d3a;--line:#2e2d52;--text:#ece9f7;--dim:#a9a6c4;--accent:${pal.text};--btn:${pal.btn};--btn-text:${pal.btnText}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 "Source Sans 3",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:760px;margin:0 auto;padding:20px 16px 56px}
.top{display:flex;align-items:center;gap:10px;font-weight:700;color:var(--text);margin-bottom:18px}
.top img{width:28px;height:28px;border-radius:7px}
h1,h2,h3{font-family:"Cormorant Garamond",Georgia,serif;line-height:1.15;margin:0 0 .4em}
h1{font-size:clamp(30px,6vw,42px)}h2{font-size:26px;margin-top:28px}h3{font-size:20px}
.muted{color:var(--dim)}.small{font-size:14px}
.hero{display:flex;gap:18px;align-items:center;margin-bottom:8px}
.hero img{width:120px;height:120px;border-radius:14px;object-fit:cover;flex:none;border:1px solid var(--line)}
@media(max-width:520px){.hero{gap:14px;align-items:flex-start}.hero img{width:84px;height:84px;border-radius:12px}}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:12px 0}
.btns{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}
.btn{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:999px;border:1px solid var(--line);background:#25244a;color:var(--text);font-weight:600;font-size:15px;cursor:pointer}
.btn:hover{text-decoration:none;border-color:var(--accent)}
.btn.primary{background:var(--btn);color:var(--btn-text);border-color:var(--btn)}
.list{list-style:none;padding:0;margin:0}
.list li{border-top:1px solid var(--line)}.list li:first-child{border-top:0}
.list a{display:block;padding:14px 2px;color:var(--text)}.list a:hover{text-decoration:none}
.list a strong{display:block;font-size:18px}.list a:hover strong{color:var(--accent)}
audio{width:100%;margin:8px 0}
.video{position:relative;padding-top:56.25%;border-radius:12px;overflow:hidden;margin:12px 0;background:#000}
.video iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.day{display:flex;gap:14px;padding:12px 0;border-top:1px solid var(--line)}.day:first-of-type{border-top:0}
.day b{flex:none;width:58px;color:var(--accent);font-family:"Cormorant Garamond",serif;font-size:20px}
.pill{display:inline-block;padding:2px 10px;border:1px solid var(--line);border-radius:999px;margin:2px 4px 2px 0;font-size:14px}
.cta{text-align:center;margin-top:30px}
footer{margin-top:40px;color:var(--dim);font-size:13px;text-align:center}
</style></head><body><div class="wrap">
<a class="top" href="/churches"><img src="/assets/brand/icon.png" alt="" width="28" height="28">Bible Study Genius</a>
${body}
<footer>&copy; ${new Date().getFullYear()} Codeus, Inc. · <a href="${APP_SITE}/privacy">Privacy</a> · <a href="${APP_SITE}/terms">Terms</a></footer>
</div></body></html>`;
}

// App download buttons. With a churchId they carry the church through the install (deferred deep link):
//  - Google Play: install referrer "church_<id>" — the app reads it on first launch.
//  - App Store: the tap copies "bsg-church:<id>" to the clipboard; on first launch the iOS app
//    offers "Were you looking for <church>?" (the App Store can't pass data through an install).
const appCta = (heading = "Get the Bible Study Genius app", churchId = null, churchLabel = "") => {
  const cid = Number.isInteger(churchId) ? churchId : null;
  const play = cid ? `${PLAY_STORE_URL}&referrer=${encodeURIComponent(`church_${cid}`)}` : PLAY_STORE_URL;
  const ios = cid ? ` data-church="${cid}"` : "";
  return `
<div class="card cta"><h3>${esc(heading)}</h3>
<p class="muted small">Follow your church, listen to every sermon, and get a daily reading plan for the week.</p>
<div class="btns" style="justify-content:center">
<a class="btn primary" href="${APP_STORE_URL}"${ios} rel="noopener">Download on the App Store</a>
<a class="btn" href="${esc(play)}" rel="noopener">Get it on Google Play</a></div>${cid && churchLabel ? `
<p class="muted small" style="margin:12px 0 0">After installing, if the app doesn't open to ${esc(churchLabel)}, tap <strong>My Church</strong> and search &ldquo;${esc(churchLabel)}&rdquo;.</p>` : ""}</div>${cid ? `
<script>document.querySelectorAll('a[data-church]').forEach(function(a){a.addEventListener('click',function(e){
var t='bsg-church:'+a.getAttribute('data-church'),h=a.href;
if(!navigator.clipboard||!navigator.clipboard.writeText)return;e.preventDefault();
var go=function(){location.href=h};navigator.clipboard.writeText(t).then(go,go);setTimeout(go,600);});});</script>` : ""}`;
};

function send(res, html, maxAge = 600) {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", `public, max-age=${maxAge}`);
  res.send(html);
}
function notFound(res) {
  res.status(404);
  send(res, page({ title: "Page not found · Bible Study Genius", description: "This page could not be found.", canonical: `${PUBLIC_BASE}/churches`, image: coverUrl("Bible Study Genius"),
    body: `<h1>Page not found</h1><p class="muted">That church or sermon isn't here. <a href="/churches">Browse all churches</a>.</p>${appCta()}` }), 60);
}

/* ---------------- routes ---------------- */
export function mountSermonPages(app) {
  // Optional per-church podcast directory links (Apple is auto-detected when blank).
  pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS apple_podcasts_url TEXT;`).catch((e) => console.error("sermonpages migrate", e.message));
  pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS spotify_url TEXT;`).catch((e) => console.error("sermonpages migrate", e.message));

  // Stable per-church web URL by id (used as the smart link's desktop target, so links made at
  // provisioning keep working after a church is renamed and its slug changes).
  // App-link verification for sermons.biblestudygenius.com: /c/:id short links open the app when installed.
  app.get("/.well-known/apple-app-site-association", (_req, res) => {
    res.set("Content-Type", "application/json");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(JSON.stringify({ applinks: { apps: [], details: [{ appID: "6A4S48Z4GV.com.biblestudygenius.app", paths: ["/c/*"] }] } }));
  });
  app.get("/.well-known/assetlinks.json", (_req, res) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.json([{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: "com.biblestudygenius.app",
      sha256_cert_fingerprints: ["34:63:39:CE:0F:4A:86:97:D1:FC:D7:E2:F9:87:E7:A5:71:4A:3E:F6:2D:F5:A4:6D:DB:6B:F4:79:22:44:B2:5F"] } }]);
  });

  app.get("/c/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const c = Number.isFinite(id) ? (await churches()).byId.get(id) : null;
      if (!c) return res.redirect(302, "/churches");
      res.redirect(302, `/church/${c.slug}`);
    } catch (e) { console.error("GET /c/:id", e); res.redirect(302, "/churches"); }
  });

  // Smart "get the app" link used by every share in the app (verses, sermons, Share this App).
  // The app can't know the recipient's phone, so this decides at tap time:
  //   iPhone/iPod/iPad → App Store · Android → Google Play · anything else → page with both buttons
  //   (that page's script also sends iPads that report a Mac user agent to the App Store).
  // Link-preview crawlers get the page so iMessage/WhatsApp/Facebook show a proper card.
  // Optional ?src=votd|verse|app|sermon|verdle is only logged, to see which shares bring installs.
  const PREVIEW_BOT = /bot|crawl|spider|facebookexternalhit|facebot|whatsapp|telegram|slack|discord|linkedin|embedly|preview|skype|pinterest/i;
  app.get("/get", (req, res) => {
    const ua = String(req.get("user-agent") || "");
    const src = String(req.query.src || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 20);
    res.set("Vary", "User-Agent");
    if (!PREVIEW_BOT.test(ua)) {
      const os = /iPhone|iPod|iPad/i.test(ua) ? "ios" : /Android/i.test(ua) ? "android" : "";
      console.log(`GET /get src=${src || "-"} os=${os || "other"}`);
      if (os) {
        res.set("Cache-Control", "no-store");
        const play = src ? `${PLAY_STORE_URL}&referrer=${encodeURIComponent(`utm_source=share&utm_content=${src}`)}` : PLAY_STORE_URL;
        return res.redirect(302, os === "ios" ? APP_STORE_URL : play);
      }
    }
    send(res, page({
      title: "Bible Study Genius — free Bible app for iPhone & Android",
      description: "Read and listen in 12 translations, study the original Greek and Hebrew, follow your church's sermon, and play Bible games. Free, no ads.",
      canonical: `${PUBLIC_BASE}/get`,
      image: coverUrl("Bible Study Genius"),
      body: `${appCta("Get Bible Study Genius — free")}
<script>if(/Macintosh/.test(navigator.userAgent)&&navigator.maxTouchPoints>1){location.replace(${JSON.stringify(APP_STORE_URL)});}</script>`,
    }), 300);
  });

  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").set("Cache-Control", "public, max-age=86400")
      .send(`User-agent: *\nAllow: /\nDisallow: /admin\n\nSitemap: ${PUBLIC_BASE}/sitemap.xml\n`);
  });

  app.get("/sitemap.xml", async (_req, res) => {
    try {
      const { list } = await churches();
      const r = await pool.query(`SELECT id, church_id, sermon_ts, processed_at FROM sermons ORDER BY church_id, sermon_ts DESC NULLS LAST`);
      const byChurch = new Map();
      for (const s of r.rows) { if (!byChurch.has(s.church_id)) byChurch.set(s.church_id, []); byChurch.get(s.church_id).push(s); }
      const lastmod = (ms) => (Number(ms) ? `<lastmod>${new Date(Number(ms)).toISOString().slice(0, 10)}</lastmod>` : "");
      const urls = [`<url><loc>${PUBLIC_BASE}/churches</loc><changefreq>daily</changefreq></url>`];
      for (const c of list) {
        urls.push(`<url><loc>${xmlEsc(`${PUBLIC_BASE}/church/${c.slug}`)}</loc>${lastmod(c.last_ts)}<changefreq>weekly</changefreq></url>`);
        for (const s of byChurch.get(c.id) || []) urls.push(`<url><loc>${xmlEsc(`${PUBLIC_BASE}/church/${c.slug}/sermon/${s.id}`)}</loc>${lastmod(s.sermon_ts || s.processed_at)}</url>`);
      }
      res.set("Content-Type", "application/xml; charset=utf-8").set("Cache-Control", "public, max-age=3600");
      res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`);
    } catch (e) {
      console.error("GET /sitemap.xml", e);
      res.status(500).type("text/plain").send("error");
    }
  });

  app.get("/churches", async (_req, res) => {
    try {
      const { list } = await churches();
      const items = list.map((c) => `<li><a href="/church/${esc(c.slug)}"><strong>${esc(churchName(c))}</strong>
        <span class="muted small">${esc([place(c), c.denomination].filter(Boolean).join(" · "))}${c.sermon_count ? ` · ${c.sermon_count} sermon${c.sermon_count === 1 ? "" : "s"}` : ""}</span></a></li>`).join("");
      send(res, page({
        title: "Church Sermons & Weekly Bible Studies · Bible Study Genius",
        description: `Listen to recent sermons and follow a weekly Bible study plan from ${list.length} churches on Bible Study Genius.`,
        canonical: `${PUBLIC_BASE}/churches`,
        image: coverUrl("Bible Study Genius"),
        ld: { "@context": "https://schema.org", "@type": "CollectionPage", name: "Churches on Bible Study Genius", url: `${PUBLIC_BASE}/churches` },
        body: `<h1>Churches</h1><p class="muted">Recent sermons, each with a study guide and a week of daily readings.</p>
          <div class="card"><ul class="list">${items || `<li class="muted">No churches yet.</li>`}</ul></div>${appCta()}`,
      }));
    } catch (e) { console.error("GET /churches", e); res.status(500).send("error"); }
  });

  app.get("/church/:slug", async (req, res, next) => {
    const slug = String(req.params.slug);
    if (/^\d+$/.test(slug) || RESERVED.has(slug)) return next();
    try {
      const { bySlug } = await churches();
      const c = bySlug.get(slug);
      if (!c) return notFound(res);
      const [sermons, apple] = await Promise.all([sermonsFor(c.id, 50), appleUrl(c)]);
      const name = churchName(c);
      const where = place(c);
      const desc = clip(`Sermons and weekly Bible study plans from ${name}${where ? ` in ${where}` : ""}. Listen to the latest message and follow a daily reading plan for the week.`, 158);
      const feed = `${FEED_BASE}/church/${c.id}/feed.xml`;
      const subscribe = [
        apple ? `<a class="btn" href="${esc(apple)}" rel="noopener">Apple Podcasts</a>` : "",
        c.spotify_url ? `<a class="btn" href="${esc(c.spotify_url)}" rel="noopener">Spotify</a>` : "",
        `<a class="btn" href="${esc(feed)}" rel="noopener">Podcast RSS</a>`,
      ].join("");
      const items = sermons.map((s) => {
        const { title, speaker } = splitTitle(s.title, s.preacher);
        const d = sermonDate(s);
        return `<li><a href="/church/${esc(c.slug)}/sermon/${s.id}"><strong>${esc(title)}</strong>
          <span class="muted small">${esc([d.label, speaker].filter(Boolean).join(" · "))}</span></a></li>`;
      }).join("");
      send(res, page({
        title: `${name} Sermons & Bible Study${where ? ` · ${where}` : ""}`,
        description: desc,
        canonical: `${PUBLIC_BASE}/church/${c.slug}`,
        image: coverUrl(name),
        accent: c.brand_color,
        ld: { "@context": "https://schema.org", "@type": "Church", name, url: `${PUBLIC_BASE}/church/${c.slug}`, image: coverUrl(name),
          ...(c.website ? { sameAs: [c.website] } : {}),
          ...(where ? { address: { "@type": "PostalAddress", addressLocality: c.city || undefined, addressRegion: c.state || undefined } } : {}) },
        body: `<div class="hero"><img src="${esc(coverPath(name))}&amp;w=240" alt="${esc(name)} sermons" width="120" height="120">
          <div><h1>${esc(name)}</h1><p class="muted">${esc([c.denomination, where].filter(Boolean).join(" · "))}${c.website ? ` · <a href="${esc(c.website)}" rel="noopener">Website</a>` : ""}</p></div></div>
          <p>${esc(desc)}</p>
          <h3>Subscribe</h3><div class="btns">${subscribe}</div>
          <h2>Recent sermons</h2>
          <div class="card"><ul class="list">${items || `<li class="muted" style="padding:12px 0">New sermons will appear here soon.</li>`}</ul></div>
          ${appCta(`Follow ${name} in the app`, c.id, name)}`,
      }));
    } catch (e) { console.error("GET /church/:slug", e); res.status(500).send("error"); }
  });

  app.get("/church/:slug/sermon/:sermonId", async (req, res, next) => {
    const slug = String(req.params.slug);
    if (/^\d+$/.test(slug)) return next();
    const sid = parseInt(req.params.sermonId, 10);
    if (!Number.isFinite(sid)) return notFound(res);
    try {
      const { bySlug, byId } = await churches();
      const r = await pool.query(
        `SELECT id, church_id, title, preacher, sermon_date, sermon_ts, processed_at, audio_url, summary, scriptures, plan, questions,
                video_id, sermon_start_sec, sermon_end_sec FROM sermons WHERE id = $1`, [sid]);
      const s = r.rows[0];
      const c = s && byId.get(s.church_id);
      if (!s || !c) return notFound(res);
      if (c.slug !== slug || String(req.params.sermonId) !== String(sid)) return res.redirect(301, `/church/${c.slug}/sermon/${sid}`);
      if (!bySlug.has(slug)) return notFound(res);

      const name = churchName(c);
      const { title, speaker } = splitTitle(s.title, s.preacher);
      const d = sermonDate(s);
      const canonical = `${PUBLIC_BASE}/church/${c.slug}/sermon/${sid}`;
      const desc = clip(s.summary || `${title} — a sermon from ${name}, with a study guide and a week of daily Bible readings.`, 158);
      const scriptures = asArray(s.scriptures).map((x) => (typeof x === "string" ? x : x?.ref || x?.passage)).filter(Boolean);
      const plan = asArray(s.plan);
      const questions = asArray(s.questions).map((q) => (typeof q === "string" ? q : q?.q || q?.question)).filter(Boolean);
      const start = Number(s.sermon_start_sec) || 0, end = Number(s.sermon_end_sec) || 0;
      const audioSrc = s.audio_url ? `${s.audio_url}${start || end ? `#t=${start}${end ? `,${end}` : ""}` : ""}` : null;

      const body = `
<p class="small"><a href="/church/${esc(c.slug)}">← ${esc(name)}</a></p>
<div class="hero"><img src="${esc(coverPath(name))}&amp;w=240" alt="${esc(name)}" width="120" height="120">
<div><h1>${esc(title)}</h1><p class="muted">${esc([d.label, speaker].filter(Boolean).join(" · "))}</p></div></div>
${audioSrc ? `<div class="card"><audio controls preload="none" src="${esc(audioSrc)}"></audio></div>` : ""}
${s.video_id ? `<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(s.video_id)}${start ? `?start=${start}` : ""}" title="${esc(title)} video" loading="lazy" allow="accelerometer; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>` : ""}
<div class="btns"><button class="btn" id="share" type="button">Copy link</button>
<a class="btn primary" href="${APP_SITE}/church/${c.id}">Open this study in the app</a></div>
<h2>Study guide</h2>
${s.summary ? `<div class="card"><h3>Summary</h3><p>${esc(s.summary)}</p></div>` : ""}
${scriptures.length ? `<div class="card"><h3>Key scripture</h3>${scriptures.map((x) => `<span class="pill">${esc(x)}</span>`).join("")}</div>` : ""}
${questions.length ? `<div class="card"><h3>Discussion questions</h3><ol>${questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ol></div>` : ""}
${plan.length ? `<h2>Reading plan for the week</h2><div class="card">${plan.map((p, i) => `<div class="day"><b>Day ${esc(p.day ?? i + 1)}</b><div>${p.passage ? `<strong>${esc(p.passage)}</strong><br>` : ""}<span class="muted">${esc(p.prompt || "")}</span></div></div>`).join("")}</div>` : ""}
${appCta("Follow along with this study in the app", c.id, name)}
<script>
document.getElementById("share").addEventListener("click", async function () {
  var url = ${JSON.stringify(canonical)}, b = this;
  try { if (navigator.share) { await navigator.share({ title: document.title, url: url }); return; } } catch (e) { if (e && e.name === "AbortError") return; }
  try { await navigator.clipboard.writeText(url); b.textContent = "Link copied ✓"; }
  catch (e) { window.prompt("Copy this link:", url); }
  setTimeout(function () { b.textContent = "Copy link"; }, 2500);
});
</script>`;
      send(res, page({
        title: `${title}${speaker ? ` — ${speaker}` : ""} · ${name}`,
        description: desc,
        canonical,
        image: coverUrl(name),
        type: "article",
        accent: c.brand_color,
        ld: { "@context": "https://schema.org", "@type": "Article", headline: title, description: desc, url: canonical, image: coverUrl(name),
          ...(d.iso ? { datePublished: d.iso } : {}),
          ...(speaker ? { author: { "@type": "Person", name: speaker } } : {}),
          publisher: { "@type": "Church", name, url: `${PUBLIC_BASE}/church/${c.slug}` },
          ...(audioSrc ? { audio: { "@type": "AudioObject", contentUrl: s.audio_url } } : {}),
          ...(s.video_id ? { video: { "@type": "VideoObject", name: title, embedUrl: `https://www.youtube.com/embed/${s.video_id}`, thumbnailUrl: `https://i.ytimg.com/vi/${s.video_id}/hqdefault.jpg`, ...(d.iso ? { uploadDate: d.iso } : {}) } } : {}) },
        body,
      }));
    } catch (e) { console.error("GET /church/:slug/sermon/:id", e); res.status(500).send("error"); }
  });
}
