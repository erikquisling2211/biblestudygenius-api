/*
 * churches.js — paid church directory + their processed sermons (Postgres).
 * Wiring (src/index.js):
 *   import { mountChurches } from "./churches.js";
 *   mountChurches(app);
 * Admin writes require env ADMIN_TOKEN (passed as ?token= or x-admin-token header).
 * Endpoints:
 *   POST /admin/church                 add a church (JSON body)
 *   POST /admin/church/:id/process     fetch feed_url, process latest sermon, store it
 *   GET  /churches/search?q=           search active churches by name or zip (app)
 *   GET  /church/:id                   church detail + latest sermon (app)
 */
import { pool } from "./db.js";
import { processPodcastFeed, processYouTube, latestEpisode, searchYouTube, searchChannelVideos, processAudioUrl, scrapeWixSermons } from "./sermonprocess.js";
import cron from "node-cron";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const CHURCH_JWT_SECRET = process.env.CHURCH_JWT_SECRET || process.env.ADMIN_TOKEN || "bsg-church-dev-secret";
const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");

// Generic church-name words that don't identify a specific church (so they
// don't let a lookalike channel like "Fellowship Bible Church WV" score high).
const GENERIC_TOKENS = new Set([
  "church", "bible", "fellowship", "community", "christian", "gospel", "baptist",
  "methodist", "presbyterian", "lutheran", "chapel", "faith", "first", "the", "and",
  "god", "christ", "jesus", "life", "worship", "center", "assembly", "ministries",
  "ministry", "cathedral", "parish", "congregation", "sermon", "sermons", "service",
  "full", "part", "sunday",
]);
const tokenize = (x) =>
  (x || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);

// Find the best-matching YouTube video for a sermon. If the church has a
// youtube_url (a channel), search INSIDE it — every result is the right church,
// so a title match is reliable. Otherwise fall back to a global search, where
// only distinctive (non-generic) channel tokens count, to avoid lookalikes.
async function matchVideoForSermon(sermon, church) {
  const cleanTitle = String(sermon.title || "").split("|")[0].split(" - ")[0].trim() || String(sermon.title || "");
  let cands = [];
  let scoped = false;
  if (church.youtube_url) {
    const r = await searchChannelVideos(church.youtube_url, 15);
    if (!r.error && r.entries.length) { cands = r.entries; scoped = true; }
  }
  if (!cands.length) {
    const r = await searchYouTube(`${church.name} ${cleanTitle} sermon`, 6);
    if (r.error) return { error: r.error, scoped: false };
    cands = r.entries;
  }
  const stTokens = new Set(tokenize(sermon.title));
  const cnTokens = new Set(tokenize(church.name).filter((w) => !GENERIC_TOKENS.has(w)));
  let best = null, bestScore = -1;
  for (const c of cands) {
    let score = 0;
    for (const w of tokenize(c.title)) if (stTokens.has(w)) score += 2;
    if (!scoped) for (const w of tokenize(c.channel)) if (cnTokens.has(w)) score += 4; // distinctive only
    if (c.duration && c.duration >= 1200) score += 2;   // sermon-length
    if (c.duration && c.duration < 300) score -= 3;      // clip/short
    if (score > bestScore) { bestScore = score; best = c; }
  }
  // Channel-scoped: already the right church, so a modest title match is enough.
  // Global: require a stronger signal (distinctive channel + title overlap).
  const threshold = scoped ? 4 : 8;
  const ok = !!(best && bestScore >= threshold);
  return { best, bestScore, scoped, ok, candidates: cands };
}

async function initChurches() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS churches (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT, state TEXT, zip TEXT,
      lat DOUBLE PRECISION, lon DOUBLE PRECISION,
      denomination TEXT,
      website TEXT,
      feed_url TEXT,
      youtube_url TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at BIGINT NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sermons (
      id SERIAL PRIMARY KEY,
      church_id INTEGER NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
      title TEXT, preacher TEXT, sermon_date TEXT,
      audio_url TEXT,
      summary TEXT,
      scriptures JSONB, plan JSONB, questions JSONB,
      processed_at BIGINT NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS sermons_church_idx ON sermons(church_id, processed_at DESC);`);
  // video fields (YouTube-sourced sermons) — additive, safe on existing tables
  await pool.query(`ALTER TABLE sermons ADD COLUMN IF NOT EXISTS video_id TEXT;`);
  await pool.query(`ALTER TABLE sermons ADD COLUMN IF NOT EXISTS sermon_start_sec INTEGER;`);
  await pool.query(`ALTER TABLE sermons ADD COLUMN IF NOT EXISTS sermon_end_sec INTEGER;`);
  // searchable nicknames/abbreviations, e.g. "ACC", "BUMC"
  await pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS aliases TEXT;`);
  // numeric sermon timestamp (epoch ms) for chronological ordering / archive
  await pool.query(`ALTER TABLE sermons ADD COLUMN IF NOT EXISTS sermon_ts BIGINT;`);
  // Feed-less churches (e.g. Wix): the page we scrape for embedded sermon audio.
  await pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS scrape_url TEXT;`);
  const miss = await pool.query(`SELECT id, sermon_date FROM sermons WHERE sermon_ts IS NULL`);
  for (const row of miss.rows) {
    const ts = (row.sermon_date && Date.parse(row.sermon_date)) || 0;
    await pool.query(`UPDATE sermons SET sermon_ts = $1 WHERE id = $2`, [ts, row.id]);
  }
  // Engagement events (anonymous) for per-church analytics.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sermon_events (
      id SERIAL PRIMARY KEY,
      church_id INTEGER NOT NULL,
      sermon_id INTEGER,
      type TEXT NOT NULL,
      anon_id TEXT,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS sermon_events_idx ON sermon_events(church_id, created_at DESC);`);
  // Per-church branding for the dashboard.
  await pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS logo_url TEXT;`);
  await pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS brand_color TEXT;`);
  await pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS display_name TEXT;`);
  // Church dashboard logins (provisioned by admin).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS church_admins (
      id SERIAL PRIMARY KEY,
      church_id INTEGER NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);
  console.log("✅ Churches tables ready");
}

function admin(req) {
  const t = process.env.ADMIN_TOKEN;
  return !!t && (req.query.token === t || req.headers["x-admin-token"] === t);
}

// Verify a church-dashboard JWT; sets req.church = { churchId, adminId, email }.
function churchAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  try { req.church = jwt.verify(tok, CHURCH_JWT_SECRET); return next(); }
  catch { return res.status(401).json({ error: "unauthorized" }); }
}

// Engagement summary for one church (shared by the admin and dashboard endpoints).
async function churchStats(id) {
  const wk = Date.now() - 7 * 86400000;
  const q = (sql, params = [id]) => pool.query(sql, params);
  const [followers, listeners, plays, playsWk, planOpens, downloads, shares, perSermon] = await Promise.all([
    q(`SELECT COUNT(*)::int AS n FROM (
         SELECT anon_id,
           MAX(CASE WHEN type='follow' THEN created_at END) AS lf,
           MAX(CASE WHEN type='unfollow' THEN created_at END) AS lu
         FROM sermon_events WHERE church_id=$1 AND type IN ('follow','unfollow') AND anon_id IS NOT NULL
         GROUP BY anon_id
       ) t WHERE lf IS NOT NULL AND (lu IS NULL OR lf > lu)`),
    q(`SELECT COUNT(DISTINCT anon_id)::int AS n FROM sermon_events WHERE church_id=$1 AND type IN ('play','video_play')`),
    q(`SELECT COUNT(*)::int AS n FROM sermon_events WHERE church_id=$1 AND type IN ('play','video_play')`),
    q(`SELECT COUNT(*)::int AS n FROM sermon_events WHERE church_id=$1 AND type IN ('play','video_play') AND created_at > $2`, [id, wk]),
    q(`SELECT COUNT(*)::int AS n FROM sermon_events WHERE church_id=$1 AND type='plan_open'`),
    q(`SELECT COUNT(*)::int AS n FROM sermon_events WHERE church_id=$1 AND type='download'`),
    q(`SELECT COUNT(*)::int AS n FROM sermon_events WHERE church_id=$1 AND type='share'`),
    q(`SELECT e.sermon_id, s.title, COUNT(*)::int AS plays
         FROM sermon_events e LEFT JOIN sermons s ON s.id = e.sermon_id
         WHERE e.church_id=$1 AND e.type IN ('play','video_play') AND e.sermon_id IS NOT NULL
         GROUP BY e.sermon_id, s.title ORDER BY plays DESC LIMIT 10`),
  ]);
  return {
    churchId: id,
    followers: followers.rows[0].n,
    uniqueListeners: listeners.rows[0].n,
    totalPlays: plays.rows[0].n,
    playsLast7: playsWk.rows[0].n,
    planOpens: planOpens.rows[0].n,
    downloads: downloads.rows[0].n,
    shares: shares.rows[0].n,
    topSermons: perSermon.rows,
  };
}

// Insert a sermon, de-duplicating: a sermon with the same church + date (podcast) or
// church + videoId (youtube) REPLACES the old row instead of adding a duplicate.
// A manually-set video embed is preserved across a re-process that doesn't supply one.
async function saveSermon(churchId, r, opts = {}) {
  const date = r.date || null;
  let videoId = opts.videoId || null;
  let startSec = Number.isFinite(opts.startSec) ? opts.startSec : null;
  let endSec = Number.isFinite(opts.endSec) ? opts.endSec : null;
  const audio = opts.audioUrl !== undefined ? opts.audioUrl : (r.audioUrl || null);

  const keyCol = date ? "sermon_date" : (videoId ? "video_id" : null);
  const keyVal = date || videoId;
  if (keyCol) {
    const e = await pool.query(
      `SELECT video_id, sermon_start_sec, sermon_end_sec FROM sermons
         WHERE church_id = $1 AND ${keyCol} = $2 ORDER BY processed_at DESC LIMIT 1`,
      [churchId, keyVal]
    );
    const prev = e.rows[0];
    if (prev) {
      if (!videoId && prev.video_id) videoId = prev.video_id;
      if (startSec == null && prev.sermon_start_sec != null) startSec = prev.sermon_start_sec;
      if (endSec == null && prev.sermon_end_sec != null) endSec = prev.sermon_end_sec;
      await pool.query(`DELETE FROM sermons WHERE church_id = $1 AND ${keyCol} = $2`, [churchId, keyVal]);
    }
  }

  const sermonTs = (date && Date.parse(date)) || Date.now();
  const s = await pool.query(
    `INSERT INTO sermons (church_id,title,preacher,sermon_date,audio_url,summary,scriptures,plan,questions,video_id,sermon_start_sec,sermon_end_sec,sermon_ts,processed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [churchId, r.title || null, null, date, audio, r.summary || null,
     JSON.stringify(r.scriptures || []), JSON.stringify(r.plan || []), JSON.stringify(r.questions || []),
     videoId, startSec, endSec, sermonTs, Date.now()]
  );
  return s.rows[0].id;
}

// Resolve a feed-less church's sermon(s) from its scrape_url and run the pipeline.
// index=null (cron): newest scraped sermon not already stored (by audio_url); dedup prevents reprocessing.
// index=N (manual): process that item from the newest-first list.
// Shared by the /scrape endpoint and the weekly cron.
async function processScrapedChurch(church, { index = null } = {}) {
  const url = church.scrape_url;
  if (!url) return { error: "church has no scrape_url" };
  const r = await scrapeWixSermons(url);
  if (r.error) return { error: r.error };
  if (!r.sermons || !r.sermons.length) return { error: "no audio found on page" };

  let item;
  if (index != null) {
    item = r.sermons[index];
    if (!item) return { error: `index ${index} out of range (found ${r.sermons.length})` };
  } else {
    for (const s of r.sermons) {
      const ex = await pool.query(`SELECT 1 FROM sermons WHERE church_id = $1 AND audio_url = $2 LIMIT 1`, [church.id, s.audioUrl]);
      if (!ex.rows.length) { item = s; break; }
    }
    if (!item) return { skipped: true, reason: "latest already processed" };
  }

  const result = await processAudioUrl(item.audioUrl, { title: item.title, date: item.date });
  if (result.error) return { error: result.error };
  const sermonId = await saveSermon(church.id, result, {});
  let videoId = null;
  try {
    const m = await matchVideoForSermon({ id: sermonId, title: result.title }, church);
    if (m.ok) { await pool.query(`UPDATE sermons SET video_id = $1 WHERE id = $2`, [m.best.id, sermonId]); videoId = m.best.id; }
  } catch (e) { console.error(`scrape video ${church.name}:`, (e && e.message) || e); }
  return { sermonId, title: result.title, date: item.date, audioUrl: item.audioUrl, videoId, ...result };
}

// Process every active church that has a podcast feed (audio + study plan). Used by the weekly cron.
async function processAllChurches() {
  const { rows } = await pool.query(`SELECT id, name, youtube_url, feed_url FROM churches WHERE active AND feed_url IS NOT NULL ORDER BY id`);
  console.log(`⏰ Weekly run: ${rows.length} church(es)`);
  const out = [];
  for (const ch of rows) {
    try {
      const result = await processPodcastFeed(ch.feed_url);
      if (result.error) { out.push({ church: ch.id, name: ch.name, error: result.error }); continue; }
      const sermonId = await saveSermon(ch.id, result, {});
      // Auto-attach a matching YouTube video (same logic as the /process endpoint).
      let videoId = null;
      try {
        const m = await matchVideoForSermon({ id: sermonId, title: result.title }, { name: ch.name, youtube_url: ch.youtube_url });
        if (m.ok) { await pool.query(`UPDATE sermons SET video_id = $1 WHERE id = $2`, [m.best.id, sermonId]); videoId = m.best.id; }
      } catch (e) { console.error(`cron video ${ch.name}:`, (e && e.message) || e); }
      out.push({ church: ch.id, name: ch.name, sermonId, title: result.title, videoId });
      console.log(`✅ ${ch.name} -> sermon ${sermonId}: ${result.title}${videoId ? " (video " + videoId + ")" : ""}`);
    } catch (e) {
      out.push({ church: ch.id, name: ch.name, error: String((e && e.message) || e) });
      console.error(`cron ${ch.name} failed:`, (e && e.message) || e);
    }
  }

  // Feed-less churches (e.g. Wix): scrape the site for the latest sermon audio.
  const scrapeRows = (await pool.query(
    `SELECT * FROM churches WHERE active AND scrape_url IS NOT NULL AND feed_url IS NULL ORDER BY id`
  )).rows;
  if (scrapeRows.length) console.log(`⏰ Weekly scrape: ${scrapeRows.length} feed-less church(es)`);
  for (const ch of scrapeRows) {
    try {
      const r = await processScrapedChurch(ch, {});
      if (r.error) { out.push({ church: ch.id, name: ch.name, error: r.error }); console.error(`cron scrape ${ch.name}:`, r.error); continue; }
      if (r.skipped) { out.push({ church: ch.id, name: ch.name, skipped: true }); console.log(`↳ ${ch.name} (scrape): ${r.reason}`); continue; }
      out.push({ church: ch.id, name: ch.name, sermonId: r.sermonId, title: r.title, videoId: r.videoId, scraped: true });
      console.log(`✅ ${ch.name} (scrape) -> sermon ${r.sermonId}: ${r.title}${r.videoId ? " (video " + r.videoId + ")" : ""}`);
    } catch (e) {
      out.push({ church: ch.id, name: ch.name, error: String((e && e.message) || e) });
      console.error(`cron scrape ${ch.name} failed:`, (e && e.message) || e);
    }
  }

  console.log("⏰ Weekly run complete");
  return out;
}

async function churchSermons(churchId, limit = 50) {
  const r = await pool.query(
    `SELECT id, title, preacher, sermon_date AS date, audio_url AS "audioUrl", summary, scriptures, plan, questions,
            video_id AS "videoId", sermon_start_sec AS "sermonStartSec", sermon_end_sec AS "sermonEndSec", sermon_ts AS "sermonTs"
       FROM sermons WHERE church_id = $1 ORDER BY sermon_ts DESC NULLS LAST, processed_at DESC LIMIT $2`,
    [churchId, limit]
  );
  return r.rows;
}
async function latestSermon(churchId) {
  const rows = await churchSermons(churchId, 1);
  return rows[0] || null;
}

export function mountChurches(app) {
  initChurches().catch((e) => console.error("initChurches", e));

  // Serve brand imagery (sunrise photos, app icon) for the website — e.g.
  // /assets/votd/votd-sunrise.jpg, /assets/brand/icon.png
  app.use("/assets", express.static(ASSETS_DIR, { maxAge: "7d" }));

  // Weekly auto-processing: Mondays at 6:00 AM Central (after Sunday services are posted).
  if (cron.validate("0 6 * * 1")) {
    cron.schedule("0 6 * * 1", () => { processAllChurches().catch((e) => console.error("weekly cron", e)); }, { timezone: "America/Chicago" });
    console.log("⏰ Weekly sermon cron scheduled (Mon 6:00 AM CT)");
  }

  app.post("/admin/church", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: "name required" });
    try {
      const r = await pool.query(
        `INSERT INTO churches (name,city,state,zip,lat,lon,denomination,website,feed_url,youtube_url,aliases,scrape_url,active,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13) RETURNING *`,
        [b.name, b.city || null, b.state || null, b.zip || null, b.lat ?? null, b.lon ?? null,
         b.denomination || null, b.website || null, b.feed_url || null, b.youtube_url || null, b.aliases || null, b.scrape_url || null, Date.now()]
      );
      res.json(r.rows[0]);
    } catch (e) {
      console.error("POST /admin/church", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  app.post("/admin/church/:id/process", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    const id = parseInt(req.params.id, 10);
    try {
      const c = await pool.query(`SELECT * FROM churches WHERE id = $1`, [id]);
      const church = c.rows[0];
      if (!church) return res.status(404).json({ error: "church not found" });
      if (!church.feed_url) return res.status(400).json({ error: "church has no feed_url" });
      const index = parseInt(req.query.index, 10) || 0; // 0 = newest episode; higher = older
      const result = await processPodcastFeed(church.feed_url, index);
      if (result.error) return res.status(502).json(result);
      // Optional video embed (Tier-1: church's own YouTube video, no server download).
      // videoId from ?videoId= or the church's youtube_url; optional ?startSec=&endSec= bound the player.
      const vidRaw = String(req.query.videoId || church.youtube_url || "");
      const vm = vidRaw.match(/(?:v=|youtu\.be\/|\/embed\/|\/live\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
      const videoId = vm ? vm[1] : (/^[A-Za-z0-9_-]{11}$/.test(vidRaw) ? vidRaw : null);
      const startSec = parseInt(req.query.startSec, 10);
      const endSec = parseInt(req.query.endSec, 10);
      const sermonId = await saveSermon(id, result, { videoId, startSec, endSec });
      // Auto-attach a matching YouTube video when none was supplied (unless ?video=0).
      let video = null;
      if (!videoId && String(req.query.video || "1") !== "0") {
        try {
          const m = await matchVideoForSermon({ id: sermonId, title: result.title }, church);
          if (m.ok) {
            await pool.query(`UPDATE sermons SET video_id = $1 WHERE id = $2`, [m.best.id, sermonId]);
            video = { videoId: m.best.id, matched: m.best.title, channel: m.best.channel, scoped: m.scoped, score: m.bestScore };
          } else {
            video = { videoId: null, reason: m.error ? `search failed: ${m.error}` : `no confident match (best ${m.bestScore})` };
          }
        } catch (e) { console.error("auto video match", e); }
      }
      res.json({ churchId: id, sermonId, video, ...result });
    } catch (e) {
      console.error("POST /admin/church/:id/process", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // Process a direct audio URL (no feed) — e.g. a Wix-hosted sermon MP3.
  // POST /admin/church/:id/audio  body/query: { audioUrl, title?, date? }
  app.post("/admin/church/:id/audio", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const audioUrl = String(b.audioUrl || req.query.audioUrl || "").trim();
    const title = String(b.title || req.query.title || "").trim();
    const date = String(b.date || req.query.date || "").trim();
    try {
      const c = await pool.query(`SELECT * FROM churches WHERE id = $1`, [id]);
      const church = c.rows[0];
      if (!church) return res.status(404).json({ error: "church not found" });
      if (!audioUrl) return res.status(400).json({ error: "audioUrl required" });
      const result = await processAudioUrl(audioUrl, { title, date });
      if (result.error) return res.status(502).json(result);
      const sermonId = await saveSermon(id, result, {});
      let video = null;
      if (String(req.query.video || "1") !== "0") {
        try {
          const m = await matchVideoForSermon({ id: sermonId, title: result.title }, church);
          if (m.ok) {
            await pool.query(`UPDATE sermons SET video_id = $1 WHERE id = $2`, [m.best.id, sermonId]);
            video = { videoId: m.best.id, matched: m.best.title, channel: m.best.channel, scoped: m.scoped, score: m.bestScore };
          } else {
            video = { videoId: null, reason: m.error ? `search failed: ${m.error}` : `no confident match (best ${m.bestScore})` };
          }
        } catch (e) { console.error("auto video match", e); }
      }
      res.json({ churchId: id, sermonId, video, ...result });
    } catch (e) {
      console.error("POST /admin/church/:id/audio", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // Scrape a feed-less site (e.g. Wix) for embedded sermon audio and process the latest.
  // POST /admin/church/:id/scrape
  //   ?url=        override / set the church's scrape_url (persisted for future weekly runs)
  //   ?list=1      just return the sermons found on the page (no processing)
  //   ?index=N     process item N from the newest-first list (default: newest not yet stored)
  app.post("/admin/church/:id/scrape", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    const id = parseInt(req.params.id, 10);
    try {
      const c = await pool.query(`SELECT * FROM churches WHERE id = $1`, [id]);
      const church = c.rows[0];
      if (!church) return res.status(404).json({ error: "church not found" });
      const url = String(req.query.url || church.scrape_url || "").trim();
      if (!url) return res.status(400).json({ error: "no scrape_url (pass ?url= or set it on the church)" });
      // Persist a newly-supplied scrape_url so the weekly cron keeps this church updated.
      if (req.query.url && url !== church.scrape_url) {
        await pool.query(`UPDATE churches SET scrape_url = $1 WHERE id = $2`, [url, id]);
        church.scrape_url = url;
      }
      if (String(req.query.list || "") === "1") {
        return res.json(await scrapeWixSermons(url));
      }
      const index = req.query.index != null ? parseInt(req.query.index, 10) : null;
      const out = await processScrapedChurch(church, { index });
      if (out.error) return res.status(502).json(out);
      res.json({ churchId: id, ...out });
    } catch (e) {
      console.error("POST /admin/church/:id/scrape", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  app.post("/admin/church/:id/youtube", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    const id = parseInt(req.params.id, 10);
    const url = String(req.query.url || (req.body && req.body.url) || "");
    if (!url) return res.status(400).json({ error: "missing url param" });
    try {
      const c = await pool.query(`SELECT id, feed_url FROM churches WHERE id = $1`, [id]);
      if (!c.rows[0]) return res.status(404).json({ error: "church not found" });
      const result = await processYouTube(url);
      if (result.error) return res.status(502).json(result);
      // If the church also has a podcast feed, attach its latest downloadable MP3 for offline play.
      let audioUrl = null;
      if (c.rows[0].feed_url) {
        try { const ep = await latestEpisode(c.rows[0].feed_url); audioUrl = ep.audio || null; } catch (e) { console.error("feed audio attach", e); }
      }
      const sermonId = await saveSermon(id, result, {
        videoId: result.videoId || null,
        startSec: result.sermonStartSec,
        endSec: result.sermonEndSec,
        audioUrl: audioUrl || result.audioUrl || null, // feed audio preferred; else R2-hosted sermon audio
      });
      res.json({ churchId: id, sermonId, ...result });
    } catch (e) {
      console.error("POST /admin/church/:id/youtube", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // Set a sermon's video embed bounds (and/or videoId) without re-running transcription.
  app.post("/admin/sermon/:id/video", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    const id = parseInt(req.params.id, 10);
    const b = { ...req.query, ...(req.body || {}) };
    const sets = []; const vals = []; let i = 1;
    if (b.videoId != null) { sets.push(`video_id = $${i++}`); vals.push(b.videoId); }
    if (b.startSec != null) { sets.push(`sermon_start_sec = $${i++}`); vals.push(parseInt(b.startSec, 10)); }
    if (b.endSec != null) { sets.push(`sermon_end_sec = $${i++}`); vals.push(parseInt(b.endSec, 10)); }
    if (!sets.length) return res.status(400).json({ error: "no video fields to update" });
    vals.push(id);
    try {
      const r = await pool.query(
        `UPDATE sermons SET ${sets.join(", ")} WHERE id = $${i}
         RETURNING id, video_id AS "videoId", sermon_start_sec AS "sermonStartSec", sermon_end_sec AS "sermonEndSec"`,
        vals
      );
      if (!r.rows[0]) return res.status(404).json({ error: "not found" });
      res.json(r.rows[0]);
    } catch (e) {
      console.error("POST /admin/sermon/:id/video", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // Find the matching YouTube video for a sermon (by church name + title) and set its videoId.
  // ?apply=0 returns candidates without writing. Reusable by the weekly cron.
  app.post("/admin/sermon/:id/findvideo", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    const id = parseInt(req.params.id, 10);
    try {
      const sres = await pool.query(
        `SELECT s.id, s.title, s.church_id, c.name AS church_name, c.youtube_url
           FROM sermons s JOIN churches c ON c.id = s.church_id WHERE s.id = $1`,
        [id]
      );
      if (!sres.rows.length) return res.status(404).json({ error: "sermon not found" });
      const s = sres.rows[0];
      const m = await matchVideoForSermon({ id: s.id, title: s.title }, { name: s.church_name, youtube_url: s.youtube_url });
      if (m.error) return res.status(502).json({ error: `youtube search failed: ${m.error}` });
      const apply = String(req.query.apply || "1") !== "0" && m.ok;
      if (apply) await pool.query(`UPDATE sermons SET video_id = $1 WHERE id = $2`, [m.best.id, id]);
      res.json({ sermonId: id, applied: !!apply, scoped: m.scoped, videoId: apply ? m.best.id : null, bestScore: m.bestScore, best: m.best, candidates: m.candidates });
    } catch (e) {
      console.error("POST /admin/sermon/:id/findvideo", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  app.post("/admin/church/:id/update", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    const id = parseInt(req.params.id, 10);
    const b = { ...req.query, ...(req.body || {}) };
    const allowed = ["name", "city", "state", "zip", "denomination", "website", "feed_url", "youtube_url", "aliases", "scrape_url"];
    const sets = []; const vals = []; let i = 1;
    for (const k of allowed) {
      if (b[k] != null) { sets.push(`${k} = $${i++}`); vals.push(b[k]); }
    }
    if (!sets.length) return res.status(400).json({ error: "no fields to update" });
    vals.push(id);
    try {
      const r = await pool.query(`UPDATE churches SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`, vals);
      if (!r.rows[0]) return res.status(404).json({ error: "not found" });
      res.json(r.rows[0]);
    } catch (e) {
      console.error("POST /admin/church/:id/update", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // Manually trigger the weekly run now (for testing). Processes all active churches with a feed.
  app.post("/admin/cron/run", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    try {
      const results = await processAllChurches();
      res.json({ ok: true, results });
    } catch (e) {
      console.error("POST /admin/cron/run", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // One-time: remove today's reprocessing duplicates, keeping only the newest sermon per church.
  // Do NOT run this once you have a real multi-sermon archive.
  app.post("/admin/cleanup-dupes", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    try {
      const r = await pool.query(`
        DELETE FROM sermons s
        WHERE EXISTS (SELECT 1 FROM sermons s2 WHERE s2.church_id = s.church_id AND s2.processed_at > s.processed_at)
      `);
      res.json({ ok: true, deleted: r.rowCount });
    } catch (e) {
      console.error("POST /admin/cleanup-dupes", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  app.get("/churches/search", async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ churches: [] });
    try {
      const r = await pool.query(
        `SELECT id,name,city,state,zip,denomination,website FROM churches
          WHERE active AND (name ILIKE $1 OR aliases ILIKE $1 OR zip = $2) ORDER BY name LIMIT 25`,
        [`%${q}%`, q]
      );
      res.json({ churches: r.rows });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e), churches: [] });
    }
  });

  app.get("/church/:id", async (req, res, next) => {
    if (!/^\d+$/.test(String(req.params.id))) return next(); // let /church/me etc. through
    const id = parseInt(req.params.id, 10);
    try {
      const c = await pool.query(
        `SELECT id,name,city,state,zip,denomination,website FROM churches WHERE id = $1 AND active`, [id]
      );
      if (!c.rows[0]) return res.status(404).json({ error: "not found" });
      const sermons = await churchSermons(id, 50);
      res.json({ church: c.rows[0], sermon: sermons[0] || null, sermons });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // --- Engagement analytics ---
  const EVENT_TYPES = new Set(["follow", "unfollow", "play", "video_play", "plan_open", "download", "view", "share"]);

  // App posts anonymous engagement events here (no auth, no PII — just an anon device id).
  app.post("/events", async (req, res) => {
    try {
      const b = req.body || {};
      const churchId = parseInt(b.churchId, 10);
      const type = String(b.type || "").trim();
      if (!Number.isFinite(churchId) || !EVENT_TYPES.has(type)) return res.status(400).json({ error: "bad event" });
      const sermonId = Number.isFinite(parseInt(b.sermonId, 10)) ? parseInt(b.sermonId, 10) : null;
      const anonId = String(b.anonId || "").slice(0, 64) || null;
      await pool.query(
        `INSERT INTO sermon_events (church_id, sermon_id, type, anon_id, created_at) VALUES ($1,$2,$3,$4,$5)`,
        [churchId, sermonId, type, anonId, Date.now()]
      );
      res.json({ ok: true });
    } catch (e) {
      console.error("POST /events", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // Admin engagement summary (token-gated).
  app.get("/admin/church/:id/stats", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    try { res.json(await churchStats(parseInt(req.params.id, 10))); }
    catch (e) { console.error("GET /admin/church/:id/stats", e); res.status(500).json({ error: String((e && e.message) || e) }); }
  });

  // --- Church dashboard: provisioning (admin), branding (admin), login + scoped reads (church) ---

  // Create or reset a church's dashboard login (you run this when onboarding a paid church).
  app.post("/admin/church/:id/admin", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const email = String(b.email || "").trim().toLowerCase();
    const password = String(b.password || "");
    if (!email || password.length < 6) return res.status(400).json({ error: "email and password (min 6 chars) required" });
    try {
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        `INSERT INTO church_admins (church_id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (email) DO UPDATE SET church_id = EXCLUDED.church_id, password_hash = EXCLUDED.password_hash`,
        [id, email, hash, Date.now()]
      );
      res.json({ ok: true, churchId: id, email });
    } catch (e) {
      console.error("POST /admin/church/:id/admin", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // Set a church's dashboard branding.
  app.post("/admin/church/:id/branding", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    try {
      await pool.query(
        `UPDATE churches SET
           logo_url = COALESCE($2, logo_url),
           brand_color = COALESCE($3, brand_color),
           display_name = COALESCE($4, display_name)
         WHERE id = $1`,
        [id, b.logoUrl ?? null, b.brandColor ?? null, b.displayName ?? null]
      );
      res.json({ ok: true, churchId: id });
    } catch (e) {
      console.error("POST /admin/church/:id/branding", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // Church login → JWT.
  app.post("/church/login", async (req, res) => {
    const b = req.body || {};
    const email = String(b.email || "").trim().toLowerCase();
    const password = String(b.password || "");
    if (!email || !password) return res.status(400).json({ error: "email and password required" });
    try {
      const r = await pool.query(`SELECT id, church_id, password_hash FROM church_admins WHERE email = $1`, [email]);
      const row = r.rows[0];
      if (!row || !(await bcrypt.compare(password, row.password_hash))) return res.status(401).json({ error: "invalid credentials" });
      const token = jwt.sign({ churchId: row.church_id, adminId: row.id, email }, CHURCH_JWT_SECRET, { expiresIn: "30d" });
      const c = await pool.query(
        `SELECT id, name, city, state, display_name AS "displayName", logo_url AS "logoUrl", brand_color AS "brandColor" FROM churches WHERE id = $1`,
        [row.church_id]
      );
      res.json({ token, church: c.rows[0] || { id: row.church_id } });
    } catch (e) {
      console.error("POST /church/login", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // Logged-in church: its own profile + branding.
  app.get("/church/me", churchAuth, async (req, res) => {
    try {
      const c = await pool.query(
        `SELECT id, name, city, state, denomination, website, display_name AS "displayName", logo_url AS "logoUrl", brand_color AS "brandColor" FROM churches WHERE id = $1`,
        [req.church.churchId]
      );
      if (!c.rows[0]) return res.status(404).json({ error: "not found" });
      res.json({ church: c.rows[0] });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // Logged-in church: its own engagement stats.
  app.get("/church/me/stats", churchAuth, async (req, res) => {
    try { res.json(await churchStats(req.church.churchId)); }
    catch (e) { console.error("GET /church/me/stats", e); res.status(500).json({ error: String((e && e.message) || e) }); }
  });
}
