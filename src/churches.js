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
import { processPodcastFeed, processYouTube, latestEpisode, searchYouTube, searchChannelVideos } from "./sermonprocess.js";
import cron from "node-cron";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const CHURCH_JWT_SECRET = process.env.CHURCH_JWT_SECRET || process.env.ADMIN_TOKEN || "bsg-church-dev-secret";

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
  const [followers, listeners, plays, playsWk, planOpens, downloads, perSermon] = await Promise.all([
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

// Process every active church that has a podcast feed (audio + study plan). Used by the weekly cron.
async function processAllChurches() {
  const { rows } = await pool.query(`SELECT id, name, feed_url FROM churches WHERE active AND feed_url IS NOT NULL ORDER BY id`);
  console.log(`⏰ Weekly run: ${rows.length} church(es)`);
  const out = [];
  for (const ch of rows) {
    try {
      const result = await processPodcastFeed(ch.feed_url);
      if (result.error) { out.push({ church: ch.id, name: ch.name, error: result.error }); continue; }
      const sermonId = await saveSermon(ch.id, result, {});
      out.push({ church: ch.id, name: ch.name, sermonId, title: result.title });
      console.log(`✅ ${ch.name} -> sermon ${sermonId}: ${result.title}`);
    } catch (e) {
      out.push({ church: ch.id, name: ch.name, error: String((e && e.message) || e) });
      console.error(`cron ${ch.name} failed:`, (e && e.message) || e);
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
        `INSERT INTO churches (name,city,state,zip,lat,lon,denomination,website,feed_url,youtube_url,aliases,active,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12) RETURNING *`,
        [b.name, b.city || null, b.state || null, b.zip || null, b.lat ?? null, b.lon ?? null,
         b.denomination || null, b.website || null, b.feed_url || null, b.youtube_url || null, b.aliases || null, Date.now()]
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
    const allowed = ["name", "city", "state", "zip", "denomination", "website", "feed_url", "youtube_url", "aliases"];
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

  app.get("/church/:id", async (req, res) => {
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
  const EVENT_TYPES = new Set(["follow", "unfollow", "play", "video_play", "plan_open", "download", "view"]);

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

  // Church-facing engagement summary (token-gated for now; later per-church login).
  app.get("/admin/church/:id/stats", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    const id = parseInt(req.params.id, 10);
    const wk = Date.now() - 7 * 86400000;
    try {
      const q = (sql, params = [id]) => pool.query(sql, params);
      const [followers, listeners, plays, playsWk, planOpens, downloads, perSermon] = await Promise.all([
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
        q(`SELECT e.sermon_id, s.title, COUNT(*)::int AS plays
             FROM sermon_events e LEFT JOIN sermons s ON s.id = e.sermon_id
             WHERE e.church_id=$1 AND e.type IN ('play','video_play') AND e.sermon_id IS NOT NULL
             GROUP BY e.sermon_id, s.title ORDER BY plays DESC LIMIT 10`),
      ]);
      res.json({
        churchId: id,
        followers: followers.rows[0].n,
        uniqueListeners: listeners.rows[0].n,
        totalPlays: plays.rows[0].n,
        playsLast7: playsWk.rows[0].n,
        planOpens: planOpens.rows[0].n,
        downloads: downloads.rows[0].n,
        topSermons: perSermon.rows,
      });
    } catch (e) {
      console.error("GET /admin/church/:id/stats", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
}
