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
import { processPodcastFeed, processYouTube, latestEpisode } from "./sermonprocess.js";

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
  console.log("✅ Churches tables ready");
}

function admin(req) {
  const t = process.env.ADMIN_TOKEN;
  return !!t && (req.query.token === t || req.headers["x-admin-token"] === t);
}

async function latestSermon(churchId) {
  const r = await pool.query(
    `SELECT id, title, preacher, sermon_date AS date, audio_url AS "audioUrl", summary, scriptures, plan, questions,
            video_id AS "videoId", sermon_start_sec AS "sermonStartSec", sermon_end_sec AS "sermonEndSec"
       FROM sermons WHERE church_id = $1 ORDER BY processed_at DESC LIMIT 1`,
    [churchId]
  );
  return r.rows[0] || null;
}

export function mountChurches(app) {
  initChurches().catch((e) => console.error("initChurches", e));

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
      const result = await processPodcastFeed(church.feed_url);
      if (result.error) return res.status(502).json(result);
      // Optional video embed (Tier-1: church's own YouTube video, no server download).
      // videoId from ?videoId= or the church's youtube_url; optional ?startSec=&endSec= bound the player.
      const vidRaw = String(req.query.videoId || church.youtube_url || "");
      const vm = vidRaw.match(/(?:v=|youtu\.be\/|\/embed\/|\/live\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
      const videoId = vm ? vm[1] : (/^[A-Za-z0-9_-]{11}$/.test(vidRaw) ? vidRaw : null);
      const startSec = parseInt(req.query.startSec, 10);
      const endSec = parseInt(req.query.endSec, 10);
      const s = await pool.query(
        `INSERT INTO sermons (church_id,title,preacher,sermon_date,audio_url,summary,scriptures,plan,questions,video_id,sermon_start_sec,sermon_end_sec,processed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [id, result.title || null, null, result.date || null, result.audioUrl || null, result.summary || null,
         JSON.stringify(result.scriptures || []), JSON.stringify(result.plan || []), JSON.stringify(result.questions || []),
         videoId, Number.isFinite(startSec) ? startSec : null, Number.isFinite(endSec) ? endSec : null, Date.now()]
      );
      res.json({ churchId: id, sermonId: s.rows[0].id, ...result });
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
      const s = await pool.query(
        `INSERT INTO sermons (church_id,title,preacher,sermon_date,audio_url,summary,scriptures,plan,questions,video_id,sermon_start_sec,sermon_end_sec,processed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [id, result.title || null, null, null, audioUrl, result.summary || null,
         JSON.stringify(result.scriptures || []), JSON.stringify(result.plan || []), JSON.stringify(result.questions || []),
         result.videoId || null, result.sermonStartSec ?? null, result.sermonEndSec ?? null, Date.now()]
      );
      res.json({ churchId: id, sermonId: s.rows[0].id, ...result });
    } catch (e) {
      console.error("POST /admin/church/:id/youtube", e);
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
      res.json({ church: c.rows[0], sermon: await latestSermon(id) });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
}
