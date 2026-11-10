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
import { processPodcastFeed, processYouTube, latestEpisode, searchYouTube, searchChannelVideos, processAudioUrl, scrapeWixSermons, detectSermonSource, detectGivingUrl, fetchIcsEvents } from "./sermonprocess.js";
import cron from "node-cron";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import Stripe from "stripe";
import QRCode from "qrcode";

const CHURCH_JWT_SECRET = process.env.CHURCH_JWT_SECRET || process.env.ADMIN_TOKEN || "bsg-church-dev-secret";
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const SITE_URL = process.env.SITE_URL || "https://biblestudygenius.com";
const API_BASE = process.env.PUBLIC_API_URL || "https://biblestudygenius-api-production.up.railway.app";
// BSG centrally owns/manages church podcasts — all feeds use this owner email so Spotify's
// verification codes land in one inbox we control.
const PODCAST_OWNER_EMAIL = process.env.PODCAST_OWNER_EMAIL || "podcasts@biblestudygenius.com";
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
  // Self-serve signup: billing linkage + contact.
  await pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS contact_email TEXT;`);
  await pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;`);
  await pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS churches_stripe_cust_idx ON churches(stripe_customer_id);`);
  // "Church app" extras: events calendar feed + a link to the church's existing giving page.
  await pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS calendar_url TEXT;`);
  await pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS giving_url TEXT;`);
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

// Best-effort welcome email via Resend (no-op if RESEND_API_KEY isn't set).
// needsSetup=true (card-first signup): tell them to log in and connect their sermons.
// needsSetup=false (detect-first): their church is already live.
async function sendWelcomeEmail(email, { churchName, tempPassword, needsSetup = false }) {
  if (!process.env.RESEND_API_KEY || !email) return false;
  const from = process.env.RESEND_FROM || "Bible Study Genius <hello@biblestudygenius.com>";
  const setupBody = `Welcome to Bible Study Genius!

Your subscription is active and your 14-day free trial has started. Log in to your dashboard to finish setting up your church and connect your sermons:

  ${SITE_URL}/dashboard
  Email: ${email}
  Temporary password: ${tempPassword}

Add your sermon link (website, podcast, or YouTube) and we take it from there — study plans, podcast, and in-app audio, automatically. Please change your password after signing in. Reply with any questions.`;
  const liveBody = `Welcome to Bible Study Genius!

${churchName} is live. Your sermons are already being turned into weekly study plans in the app.

Your dashboard login:
  ${SITE_URL}/dashboard
  Email: ${email}
  Temporary password: ${tempPassword}

Please sign in and change your password. Reply to this email with any questions.`;
  const subject = needsSetup ? "Finish setting up your church on Bible Study Genius" : `${churchName} is live on Bible Study Genius`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [email], subject, text: needsSetup ? setupBody : liveBody }),
    });
    return res.ok;
  } catch (e) { console.error("sendWelcomeEmail", (e && e.message) || e); return false; }
}

// Process a church's first sermon from whichever source is set on its row (feed / scrape / youtube),
// attaching a matching YouTube video where possible. Shared by onboarding and dashboard setup.
async function processFirstSermon(church) {
  try {
    if (church.scrape_url) return await processScrapedChurch(church, { index: 0 });
    if (church.feed_url) {
      const r = await processPodcastFeed(church.feed_url);
      if (r.error) return { error: r.error };
      const sid = await saveSermon(church.id, r, {});
      let videoId = null;
      try { const m = await matchVideoForSermon({ id: sid, title: r.title }, church); if (m.ok) { await pool.query(`UPDATE sermons SET video_id=$1 WHERE id=$2`, [m.best.id, sid]); videoId = m.best.id; } } catch {}
      return { sermonId: sid, title: r.title, videoId };
    }
    if (church.youtube_url) {
      // youtube_url may be a channel/handle (from auto-detect) rather than a single video —
      // processYouTube needs a watchable video, so resolve the channel's latest upload first.
      let videoUrl = church.youtube_url;
      const isVideo = /(?:[?&]v=|youtu\.be\/|\/embed\/|\/live\/|\/shorts\/)[A-Za-z0-9_-]{11}/.test(videoUrl);
      if (!isVideo) {
        const vids = await searchChannelVideos(church.youtube_url, 5);
        if (!vids || vids.error || !(vids.entries && vids.entries.length)) return { error: (vids && vids.error) || "no videos found on channel" };
        videoUrl = `https://www.youtube.com/watch?v=${vids.entries[0].id}`;
      }
      const r = await processYouTube(videoUrl);
      if (r.error) return { error: r.error };
      const sid = await saveSermon(church.id, r, { videoId: r.videoId || null, startSec: r.sermonStartSec, endSec: r.sermonEndSec, audioUrl: r.audioUrl || null });
      return { sermonId: sid, title: r.title, videoId: r.videoId || null };
    }
    return { error: "no source set" };
  } catch (e) { console.error(`processFirstSermon (church ${church.id}):`, (e && e.message) || e); return { error: String((e && e.message) || e) }; }
}

// Create a paid church end-to-end: insert the row (active), wire its detected source,
// process the first sermon so it's live immediately, and provision a dashboard login.
// Returns { churchId, tempPassword }. Called by the Stripe webhook after payment clears.
async function onboardChurch({ name, city, state, email, sourceType, sourceUrl, stripeCustomerId, stripeSubscriptionId }) {
  const feedUrl = sourceType === "feed" ? sourceUrl : null;
  const youtubeUrl = sourceType === "youtube" ? sourceUrl : null;
  const scrapeUrl = sourceType === "scrape" ? sourceUrl : null;
  const ins = await pool.query(
    `INSERT INTO churches (name,city,state,feed_url,youtube_url,scrape_url,contact_email,stripe_customer_id,stripe_subscription_id,active,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10) RETURNING *`,
    [name || "New Church", city || null, state || null, feedUrl, youtubeUrl, scrapeUrl,
     email || null, stripeCustomerId || null, stripeSubscriptionId || null, Date.now()]
  );
  const church = ins.rows[0];

  // If a source was detected at signup (detect-first flow), process the first sermon now so
  // content is live immediately. Card-first signups have no source yet — they connect it in the dashboard.
  const needsSetup = !sourceType;
  if (sourceType) {
    try { await processFirstSermon(church); }
    catch (e) { console.error(`onboard first sermon (church ${church.id}):`, (e && e.message) || e); }
  }

  // Provision a dashboard login with a temporary password.
  let tempPassword = null;
  if (email) {
    tempPassword = Math.random().toString(36).slice(2, 10) + "A9!";
    const hash = await bcrypt.hash(tempPassword, 10);
    await pool.query(
      `INSERT INTO church_admins (church_id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO UPDATE SET church_id=EXCLUDED.church_id, password_hash=EXCLUDED.password_hash`,
      [church.id, String(email).toLowerCase(), hash, Date.now()]
    );
    await sendWelcomeEmail(email, { churchName: church.name, tempPassword, needsSetup });
  }
  console.log(`🎉 Onboarded church ${church.id} (${church.name})${sourceType ? " via " + sourceType : " (card-first, awaiting setup)"}${tempPassword ? "" : " — no login (no email)"}`);
  return { churchId: church.id, tempPassword };
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

/* ---------- per-church podcast RSS (Apple Podcasts / Spotify) ---------- */
const xmlEsc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cdata = (s) => `<![CDATA[${String(s || "").replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
const rssDate = (ms) => new Date(ms || Date.now()).toUTCString();
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

// Build a valid podcast RSS 2.0 feed (iTunes namespace) for one church from its stored sermons.
async function buildChurchFeed(church) {
  const rows = (await pool.query(
    `SELECT id, title, audio_url, summary, sermon_ts, sermon_start_sec, sermon_end_sec
       FROM sermons WHERE church_id = $1 AND audio_url IS NOT NULL
       ORDER BY sermon_ts DESC NULLS LAST, processed_at DESC LIMIT 300`,
    [church.id]
  )).rows;
  const name = church.display_name || church.name;
  const selfUrl = `${API_BASE}/church/${church.id}/feed.xml`;
  const siteLink = `${SITE_URL}/church/${church.id}`;
  const cover = church.logo_url || `${API_BASE}/cover.png?title=${encodeURIComponent(name)}`;
  const email = PODCAST_OWNER_EMAIL;
  const desc = `Weekly sermons from ${name}, with a daily Bible study plan for each message in the free Bible Study Genius app.`;
  const items = rows.map((r) => {
    const dur = (r.sermon_end_sec != null && r.sermon_start_sec != null) ? (r.sermon_end_sec - r.sermon_start_sec) : null;
    return `    <item>
      <title>${xmlEsc(r.title || "Sermon")}</title>
      <description>${cdata(r.summary || "")}</description>
      <itunes:summary>${cdata(r.summary || "")}</itunes:summary>
      <pubDate>${rssDate(Number(r.sermon_ts) || Date.now())}</pubDate>
      <enclosure url="${xmlEsc(r.audio_url)}" type="audio/mpeg" length="0"/>
      <guid isPermaLink="false">bsg-${church.id}-${r.id}</guid>${dur != null ? `\n      <itunes:duration>${fmtDuration(dur)}</itunes:duration>` : ""}
      <itunes:explicit>false</itunes:explicit>
    </item>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEsc(name)}</title>
    <link>${xmlEsc(siteLink)}</link>
    <language>en-us</language>
    <description>${cdata(desc)}</description>
    <itunes:author>${xmlEsc(name)}</itunes:author>
    <itunes:summary>${cdata(desc)}</itunes:summary>
    <itunes:type>episodic</itunes:type>
    <itunes:owner><itunes:name>${xmlEsc(name)}</itunes:name><itunes:email>${xmlEsc(email)}</itunes:email></itunes:owner>
    <itunes:image href="${xmlEsc(cover)}"/>
    <itunes:category text="Religion &amp; Spirituality"><itunes:category text="Christianity"/></itunes:category>
    <itunes:explicit>false</itunes:explicit>
    <atom:link href="${xmlEsc(selfUrl)}" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
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
        `INSERT INTO churches (name,city,state,zip,lat,lon,denomination,website,feed_url,youtube_url,aliases,scrape_url,calendar_url,giving_url,active,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15) RETURNING *`,
        [b.name, b.city || null, b.state || null, b.zip || null, b.lat ?? null, b.lon ?? null,
         b.denomination || null, b.website || null, b.feed_url || null, b.youtube_url || null, b.aliases || null, b.scrape_url || null, b.calendar_url || null, b.giving_url || null, Date.now()]
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
    let church;
    try {
      const c = await pool.query(`SELECT id, feed_url FROM churches WHERE id = $1`, [id]);
      church = c.rows[0];
      if (!church) return res.status(404).json({ error: "church not found" });
    } catch (e) {
      console.error("POST /admin/church/:id/youtube (lookup)", e);
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
    // Download + transcribe + plan can run several minutes — longer than the HTTP edge will hold
    // the connection. Do the work off the request and return right away; the sermon appears when done.
    const work = async () => {
      const result = await processYouTube(url);
      if (result.error) { console.error(`youtube process (church ${id}): ${result.error}`); throw new Error(result.error); }
      let audioUrl = null;
      if (church.feed_url) {
        try { const ep = await latestEpisode(church.feed_url); audioUrl = ep.audio || null; } catch (e) { console.error("feed audio attach", e); }
      }
      const sermonId = await saveSermon(id, result, {
        videoId: result.videoId || null,
        startSec: result.sermonStartSec,
        endSec: result.sermonEndSec,
        audioUrl: audioUrl || result.audioUrl || null, // feed audio preferred; else R2-hosted sermon audio
      });
      console.log(`✅ youtube sermon saved: church ${id} sermon ${sermonId} — "${result.title}"`);
      return { sermonId, result };
    };
    // ?sync=1 keeps the old blocking behavior (handy for short clips / debugging).
    if (String(req.query.sync || "") === "1") {
      try {
        const { sermonId, result } = await work();
        return res.json({ churchId: id, sermonId, ...result });
      } catch (e) {
        return res.status(502).json({ error: String((e && e.message) || e) });
      }
    }
    work().catch((e) => console.error(`POST /admin/church/${id}/youtube (background)`, (e && e.message) || e));
    res.json({ churchId: id, status: "processing", message: "Transcribing in the background — the sermon will appear on the church in a few minutes." });
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

  // Set a sermon's title and/or date (e.g. when transcript-based title detection came up empty).
  app.post("/admin/sermon/:id/update", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    const id = parseInt(req.params.id, 10);
    const b = { ...req.query, ...(req.body || {}) };
    const sets = []; const vals = []; let i = 1;
    if (b.title != null) { sets.push(`title = $${i++}`); vals.push(String(b.title)); }
    if (b.date != null) { sets.push(`sermon_date = $${i++}`); vals.push(String(b.date)); }
    if (!sets.length) return res.status(400).json({ error: "no fields to update (title, date)" });
    vals.push(id);
    try {
      const r = await pool.query(
        `UPDATE sermons SET ${sets.join(", ")} WHERE id = $${i} RETURNING id, title, sermon_date AS date`, vals
      );
      if (!r.rows[0]) return res.status(404).json({ error: "not found" });
      res.json(r.rows[0]);
    } catch (e) {
      console.error("POST /admin/sermon/:id/update", e);
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
    const allowed = ["name", "city", "state", "zip", "denomination", "website", "feed_url", "youtube_url", "aliases", "scrape_url", "calendar_url", "giving_url"];
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

  // --- Self-serve church signup (public) ---

  // Preview: does this URL have detectable sermons? Powers the "we found your sermons" screen.
  app.post("/detect", async (req, res) => {
    const url = String((req.body && req.body.url) || req.query.url || "").trim();
    if (!url) return res.status(400).json({ error: "url required" });
    try { res.json(await detectSermonSource(url)); }
    catch (e) { console.error("POST /detect", e); res.status(500).json({ error: String((e && e.message) || e) }); }
  });

  // One-call admin onboarding (for batch imports): detect source from a URL, create the church,
  // and process its latest sermon in the background. Returns immediately with the detected source.
  // Body: { name, url, city?, state? }. If no source is found, nothing is created (returns found:false).
  app.post("/admin/onboard", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    const b = req.body || {};
    const name = String(b.name || "").trim();
    const url = String(b.url || b.website || "").trim();
    if (!name || !url) return res.status(400).json({ error: "name and url required" });
    let det;
    try { det = await detectSermonSource(url); }
    catch (e) { return res.status(502).json({ error: "detect failed: " + String((e && e.message) || e) }); }
    if (!det || !det.found) return res.json({ found: false, name, url, message: "no sermon source detected" });
    let church;
    try {
      const ins = await pool.query(
        `INSERT INTO churches (name,city,state,website,feed_url,youtube_url,scrape_url,active,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8) RETURNING *`,
        [name, b.city || null, b.state || null, url,
         det.sourceType === "feed" ? det.sourceUrl : null,
         det.sourceType === "youtube" ? det.sourceUrl : null,
         det.sourceType === "scrape" ? det.sourceUrl : null,
         Date.now()]
      );
      church = ins.rows[0];
    } catch (e) {
      console.error("POST /admin/onboard insert", e);
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
    // Download + transcribe can take minutes — do it off the request.
    processFirstSermon(church)
      .then((r) => {
        if (r && r.error) console.error(`onboard process (church ${church.id} "${name}"): ${r.error}`);
        else console.log(`✅ onboarded church ${church.id} "${name}" via ${det.sourceType} — sermon ${r && r.sermonId} "${r && r.title}"`);
      })
      .catch((e) => console.error(`onboard background (church ${church.id})`, (e && e.message) || e));
    res.json({ found: true, churchId: church.id, name, sourceType: det.sourceType, sourceUrl: det.sourceUrl, sampleSermons: det.sampleSermons || [], status: "processing" });
  });

  // Start checkout. Detects the source first (never sell what we can't deliver); if nothing is
  // found, returns { found:false } so the site can route to concierge onboarding instead of charging.
  app.post("/signup", async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || "").trim();
    const email = String(b.email || "").trim().toLowerCase();
    const url = String(b.url || b.website || "").trim();
    if (!name || !email || !url) return res.status(400).json({ error: "name, email, and url required" });
    try {
      const det = await detectSermonSource(url);
      if (!det.found) return res.json({ found: false }); // → site shows "we'll set you up within 24h"
      if (!stripe || !process.env.STRIPE_PRICE_ID) return res.status(503).json({ found: true, error: "billing not configured" });
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
        subscription_data: { trial_period_days: 14 },
        customer_email: email,
        allow_promotion_codes: true,
        metadata: {
          name, city: String(b.city || ""), state: String(b.state || ""), email,
          sourceType: det.sourceType, sourceUrl: det.sourceUrl,
        },
        success_url: `${SITE_URL}/welcome?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_URL}/for-churches`,
      });
      res.json({ found: true, sourceType: det.sourceType, sampleSermons: det.sampleSermons, checkoutUrl: session.url });
    } catch (e) {
      console.error("POST /signup", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // Stripe webhook. We treat the payload only as a ping and re-fetch the authoritative object
  // from Stripe by id (so a forged body can't onboard a church or flip a flag).
  app.post("/stripe/webhook", async (req, res) => {
    if (!stripe) return res.status(503).json({ error: "stripe not configured" });
    const event = req.body || {};
    try {
      if (event.type === "checkout.session.completed") {
        const session = await stripe.checkout.sessions.retrieve(event.data.object.id);
        const paid = session.status === "complete" || session.payment_status === "paid" || session.payment_status === "no_payment_required";
        if (paid) {
          const dupe = await pool.query(`SELECT id FROM churches WHERE stripe_customer_id = $1 LIMIT 1`, [session.customer]);
          if (!dupe.rows.length) {
            const md = session.metadata || {};
            // Detect-first: metadata carries name + detected source. Card-first (Payment Link):
            // no metadata, so pull the email Stripe collected and create a bare church to set up in the dashboard.
            const email = (session.customer_details && session.customer_details.email) || session.customer_email || md.email || "";
            await onboardChurch({
              name: md.name, city: md.city, state: md.state, email,
              sourceType: md.sourceType, sourceUrl: md.sourceUrl,
              stripeCustomerId: session.customer, stripeSubscriptionId: session.subscription,
            });
          }
        }
      } else if (event.type === "customer.subscription.deleted") {
        const sub = await stripe.subscriptions.retrieve(event.data.object.id);
        await pool.query(`UPDATE churches SET active = false WHERE stripe_customer_id = $1`, [sub.customer]);
        console.log(`🚫 Deactivated church(es) for customer ${sub.customer} (subscription canceled)`);
      } else if (event.type === "customer.subscription.updated") {
        const sub = await stripe.subscriptions.retrieve(event.data.object.id);
        const live = ["active", "trialing", "past_due"].includes(sub.status);
        await pool.query(`UPDATE churches SET active = $2 WHERE stripe_customer_id = $1`, [sub.customer, live]);
      }
      res.json({ received: true });
    } catch (e) {
      console.error("POST /stripe/webhook", e);
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

  // QR code that points to a church's page — for bulletins, Sunday slides, etc.
  app.get("/church/:id/qr.png", async (req, res) => {
    if (!/^\d+$/.test(String(req.params.id))) return res.status(404).send("not found");
    try {
      const url = `${SITE_URL}/church/${parseInt(req.params.id, 10)}`;
      const buf = await QRCode.toBuffer(url, { type: "png", width: 600, margin: 2, color: { dark: "#1b2340", light: "#ffffff" } });
      res.set("Content-Type", "image/png");
      res.set("Cache-Control", "public, max-age=86400");
      res.send(buf);
    } catch (e) {
      console.error("GET /church/:id/qr.png", e);
      res.status(500).send("error");
    }
  });

  // Upcoming events for a church, parsed from its Google Calendar / iCal feed.
  app.get("/church/:id/events", async (req, res) => {
    if (!/^\d+$/.test(String(req.params.id))) return res.status(404).json({ error: "not found" });
    try {
      const c = await pool.query(`SELECT calendar_url FROM churches WHERE id = $1 AND active`, [parseInt(req.params.id, 10)]);
      if (!c.rows[0]) return res.status(404).json({ error: "church not found" });
      if (!c.rows[0].calendar_url) return res.json({ count: 0, events: [] });
      const r = await fetchIcsEvents(c.rows[0].calendar_url, { limit: 25 });
      res.set("Cache-Control", "public, max-age=1800");
      res.json(r.error ? { count: 0, events: [], error: r.error } : r);
    } catch (e) {
      console.error("GET /church/:id/events", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // Per-church podcast RSS feed — submit this URL to Apple Podcasts & Spotify.
  app.get("/church/:id/feed.xml", async (req, res) => {
    if (!/^\d+$/.test(String(req.params.id))) return res.status(404).send("not found");
    try {
      const c = await pool.query(`SELECT * FROM churches WHERE id = $1 AND active`, [parseInt(req.params.id, 10)]);
      if (!c.rows[0]) return res.status(404).send("church not found");
      const xml = await buildChurchFeed(c.rows[0]);
      res.set("Content-Type", "application/rss+xml; charset=utf-8");
      res.set("Cache-Control", "public, max-age=1800");
      res.send(xml);
    } catch (e) {
      console.error("GET /church/:id/feed.xml", e);
      res.status(500).send("error building feed");
    }
  });

  app.get("/church/:id", async (req, res, next) => {
    if (!/^\d+$/.test(String(req.params.id))) return next(); // let /church/me etc. through
    const id = parseInt(req.params.id, 10);
    try {
      const c = await pool.query(
        `SELECT id,name,city,state,zip,denomination,website,giving_url AS "givingUrl",
                (calendar_url IS NOT NULL) AS "hasEvents" FROM churches WHERE id = $1 AND active`, [id]
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
        `SELECT id, name, city, state, denomination, website, display_name AS "displayName", logo_url AS "logoUrl", brand_color AS "brandColor",
                giving_url AS "givingUrl", calendar_url AS "calendarUrl",
                (feed_url IS NOT NULL OR youtube_url IS NOT NULL OR scrape_url IS NOT NULL) AS configured
           FROM churches WHERE id = $1`,
        [req.church.churchId]
      );
      if (!c.rows[0]) return res.status(404).json({ error: "not found" });
      const row = c.rows[0];
      res.json({ church: row, needsSetup: !row.configured });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // Logged-in church: its own engagement stats.
  app.get("/church/me/stats", churchAuth, async (req, res) => {
    try { res.json(await churchStats(req.church.churchId)); }
    catch (e) { console.error("GET /church/me/stats", e); res.status(500).json({ error: String((e && e.message) || e) }); }
  });

  // --- Dashboard onboarding (church sets up its own sermons after a card-first signup) ---

  // Preview: church pastes their website/podcast/YouTube URL → we detect their sermons (no save).
  app.post("/church/me/detect", churchAuth, async (req, res) => {
    const url = String((req.body && req.body.url) || "").trim();
    if (!url) return res.status(400).json({ error: "url required" });
    try {
      const [det, giving] = await Promise.all([
        detectSermonSource(url),
        detectGivingUrl(url).catch(() => ({ found: false })),
      ]);
      res.json({ ...det, giving: giving.found ? giving.givingUrl : null });
    } catch (e) { console.error("POST /church/me/detect", e); res.status(500).json({ error: String((e && e.message) || e) }); }
  });

  // Share kit: the church's link, QR, and ready-to-use announcement copy for reaching their congregation.
  app.get("/church/me/share", churchAuth, async (req, res) => {
    try {
      const c = await pool.query(`SELECT id, name, display_name FROM churches WHERE id = $1`, [req.church.churchId]);
      const church = c.rows[0];
      if (!church) return res.status(404).json({ error: "not found" });
      const name = church.display_name || church.name || "our church";
      const id = church.id;
      const shareUrl = `${SITE_URL}/church/${id}`;
      const qrUrl = `${API_BASE}/church/${id}/qr.png`;
      res.json({
        shareUrl,
        qrUrl,
        announcements: {
          pulpit: `We've put ${name} on Bible Study Genius — a free app that turns every sermon into a daily study plan for the whole week. Scan the code on the screen to follow us, and keep this week's message going all week.`,
          bulletin: `📱 Follow ${name} on the free Bible Study Genius app — every sermon becomes a week of daily study, plus streaming and our own podcast. Follow us: ${shareUrl}`,
          email: `${name} is now on Bible Study Genius, a free Bible app. Follow us there and each Sunday's sermon becomes a daily study plan you can walk through all week — with sermon streaming and our own podcast. Download the free app and follow us here: ${shareUrl}`,
          text: `Follow ${name} on the free Bible Study Genius app and keep Sunday's sermon going all week: ${shareUrl}`,
        },
      });
    } catch (e) {
      console.error("GET /church/me/share", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // Save the church's profile + confirmed sermon source, then process the first sermon so it goes live.
  // Body: { name?, city?, state?, sourceType, sourceUrl }  (sourceType: feed|youtube|scrape, from /detect)
  app.post("/church/me/setup", churchAuth, async (req, res) => {
    const id = req.church.churchId;
    const b = req.body || {};
    const sourceType = String(b.sourceType || "").trim();
    const sourceUrl = String(b.sourceUrl || "").trim();
    try {
      const sets = []; const vals = []; let i = 1;
      for (const k of ["name", "city", "state"]) {
        if (b[k] != null) { sets.push(`${k} = $${i++}`); vals.push(String(b[k])); }
      }
      if (b.givingUrl != null) { sets.push(`giving_url = $${i++}`); vals.push(String(b.givingUrl).trim() || null); }
      if (b.calendarUrl != null) { sets.push(`calendar_url = $${i++}`); vals.push(String(b.calendarUrl).trim() || null); }
      if (sourceType && sourceUrl) {
        sets.push(`feed_url = $${i++}`); vals.push(sourceType === "feed" ? sourceUrl : null);
        sets.push(`youtube_url = $${i++}`); vals.push(sourceType === "youtube" ? sourceUrl : null);
        sets.push(`scrape_url = $${i++}`); vals.push(sourceType === "scrape" ? sourceUrl : null);
      }
      if (sets.length) { vals.push(id); await pool.query(`UPDATE churches SET ${sets.join(", ")} WHERE id = $${i}`, vals); }

      const c = await pool.query(`SELECT * FROM churches WHERE id = $1`, [id]);
      const church = c.rows[0];
      let processed = null;
      if (sourceType && sourceUrl) processed = await processFirstSermon(church);
      res.json({ ok: true, churchId: id, sourceType: sourceType || null, processed });
    } catch (e) {
      console.error("POST /church/me/setup", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
}
