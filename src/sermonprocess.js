/*
 * sermonprocess.js — turn a church's latest sermon into a study plan.
 * Wiring (src/index.js):
 *   import { mountSermonProcess } from "./sermonprocess.js";
 *   mountSermonProcess(app);
 * Endpoints (demo, synchronous):
 *   GET /sermon/process?feed=<podcast RSS>     audio podcast (already just the sermon)
 *   GET /sermon/youtube?url=<youtube url>      full service -> isolates ONLY the sermon
 * Requires: npm install openai ffmpeg-static youtube-dl-exec   +   env OPENAI_API_KEY
 */
import OpenAI from "openai";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "child_process";
import { createReadStream, promises as fs } from "fs";
import os from "os";
import path from "path";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { uploadFileToR2, r2Configured } from "./r2.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Residential proxy (set PROXY_URL=http://user:pass@host:port in Railway).
// Used ONLY for fetching sermon media from hosts that block our server IP (e.g. Captivate, YouTube).
// OpenAI calls never go through it.
const PROXY_URL = process.env.PROXY_URL || "";
let _proxyDispatcher = null;
function proxyDispatcher() {
  if (!PROXY_URL) return null;
  if (!_proxyDispatcher) _proxyDispatcher = new ProxyAgent(PROXY_URL);
  return _proxyDispatcher;
}

// Try a direct fetch first (free). If the host blocks our server IP, retry once through the proxy.
async function fetchViaProxyIfBlocked(url, opts = {}) {
  // Use undici's own fetch so it matches the installed undici's ProxyAgent dispatcher.
  try {
    const res = await undiciFetch(url, opts);
    if (res.ok) return res;
    const d = proxyDispatcher();
    if (!d || ![401, 403, 404, 429, 451].includes(res.status)) return res;
    return await undiciFetch(url, { ...opts, dispatcher: d });
  } catch (e) {
    const d = proxyDispatcher();
    if (!d) throw e;
    return await undiciFetch(url, { ...opts, dispatcher: d });
  }
}

// low-bitrate 16kHz mono keeps even a long service under Whisper's 25MB limit
function toWhisperAudio(input, output) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", output]);
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error("ffmpeg exit " + c))));
  });
}

// Extract [startSec, endSec] of an audio file to a compact speech-quality mp3 (for hosting/download).
function sliceAudio(input, output, startSec, endSec) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ["-y", "-ss", String(startSec), "-to", String(endSec), "-i", input, "-vn", "-ac", "1", "-b:a", "96k", output]);
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error("ffmpeg slice exit " + c))));
  });
}

async function transcribePlain(file) {
  const r = await openai.audio.transcriptions.create({ file: createReadStream(file), model: "whisper-1" });
  return r.text;
}

async function transcribeTimestamped(file) {
  const r = await openai.audio.transcriptions.create({
    file: createReadStream(file),
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  });
  return r; // r.text, r.segments: [{start,end,text}]
}

const PLAN_PROMPT = `You are a Bible study assistant for a church app. Given a sermon transcript, reply with JSON only:
{
 "summary": "2-3 sentences on the sermon's main message, faithful to what was preached",
 "scriptures": ["main passages the sermon is built on, e.g. 'Matthew 5:1-12'"],
 "plan": [ {"day":1,"passage":"Book 0:0","prompt":"one reflective question tied to the sermon"} ],
 "questions": ["4 small-group discussion questions drawn from the sermon"]
}
"plan" must have exactly 5 days, each a passage that deepens the sermon's theme. Do not invent quotes.`;

async function planOnly(text) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: PLAN_PROMPT },
      { role: "user", content: text.slice(0, 48000) },
    ],
  });
  return JSON.parse(r.choices[0].message.content);
}

/* ---------- weekly sermon quiz (shown at the bottom of the church page in the app) ---------- */
const QUIZ_PROMPT = `You write a short comprehension quiz for people who heard this sermon. Reply with JSON only:
{"quiz":[{"q":"question","options":["correct answer","wrong","wrong","wrong"],"explain":"one sentence on why, drawn from the sermon","ref":"Bible reference if the question is about a passage, else empty"}]}
Rules: exactly 5 questions. Ask about what THIS sermon actually said: its main point, the passage it preached on, its illustrations and its practical challenge. Never ask about things the sermon did not say.
Each question has exactly 4 short options; the FIRST option is the correct one (it will be shuffled later). Wrong options must be plausible but clearly wrong to someone who listened.
Keep questions under 25 words and options under 12 words. Do not invent quotes. Do not ask about the preacher's name, the date or the church.`;

function shuffleArr(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// Keep only well-formed questions; shuffle options and record the correct index.
export function normalizeQuiz(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const q = String(item?.q || "").trim();
    const opts = (Array.isArray(item?.options) ? item.options : []).map((o) => String(o || "").trim()).filter(Boolean);
    if (!q || opts.length !== 4 || new Set(opts.map((o) => o.toLowerCase())).size !== 4) continue;
    const correct = opts[0];
    const options = shuffleArr(opts);
    out.push({ q, options, answer: options.indexOf(correct), explain: String(item?.explain || "").trim(), ref: String(item?.ref || "").trim() });
    if (out.length === 5) break;
  }
  return out.length >= 3 ? out : [];
}

export async function sermonQuiz(text) {
  if (!text || text.length < 500) return [];
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: QUIZ_PROMPT },
      { role: "user", content: text.slice(0, 48000) },
    ],
  });
  return normalizeQuiz(JSON.parse(r.choices[0].message.content).quiz);
}

// Study plan + weekly quiz from one transcript. The quiz never blocks the plan: a quiz failure
// just leaves it empty. The transcript rides along so the quiz can be regenerated later.
async function studyPlan(text) {
  const [plan, quiz] = await Promise.all([
    planOnly(text),
    sermonQuiz(text).catch((e) => { console.error("sermon quiz", (e && e.message) || e); return []; }),
  ]);
  return { ...plan, quiz, transcript: text };
}

// Download + transcribe any sermon audio URL (used to backfill quizzes for already-processed sermons).
export async function transcribeAudioUrl(audioUrl) {
  const stamp = Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  const raw = path.join(os.tmpdir(), `bf_${stamp}.mp3`);
  const small = path.join(os.tmpdir(), `bf_${stamp}.m4a`);
  try {
    await downloadTo(audioUrl, raw);
    await toWhisperAudio(raw, small);
    return await transcribePlain(small);
  } finally {
    fs.unlink(raw).catch(() => {});
    fs.unlink(small).catch(() => {});
  }
}

/* ---------- podcast (audio, already just the sermon) ---------- */
function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}

export // Some podcast CDNs (e.g. Captivate) 404 unknown bot User-Agents, so present a browser UA.
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export async function latestEpisode(feedUrl, index = 0) {
  const res = await fetchViaProxyIfBlocked(feedUrl, { headers: { "User-Agent": BROWSER_UA } });
  if (!res.ok) throw new Error("feed " + res.status);
  const xml = await res.text();
  // split() yields [preamble, item0, item1, ...]; index 0 = newest episode.
  const item = xml.split(/<item[\s>]/)[index + 1] || "";
  const pick = (re) => (item.match(re) || [])[1];
  const clean = (s) => decodeEntities((s || "").replace(/<!\[CDATA\[|\]\]>/g, "").trim());
  return {
    title: clean(pick(/<title>([\s\S]*?)<\/title>/)),
    date: clean(pick(/<pubDate>([\s\S]*?)<\/pubDate>/)),
    audio: decodeEntities(pick(/<enclosure[^>]*url="([^"]+)"/)),
  };
}

// Reusable: fetch a feed's episode (index 0 = newest) and return the full study-plan object.
export async function processPodcastFeed(feed, index = 0) {
  const stamp = Date.now();
  const raw = path.join(os.tmpdir(), `sermon_${stamp}.mp3`);
  const small = path.join(os.tmpdir(), `sermon_${stamp}.m4a`);
  try {
    const ep = await latestEpisode(feed, index);
    if (!ep.audio) return { error: "no audio enclosure in feed", episode: ep };
    await downloadTo(ep.audio, raw);
    await toWhisperAudio(raw, small);
    const transcript = await transcribePlain(small);
    const plan = await studyPlan(transcript);
    return { source: "podcast", title: ep.title, date: ep.date, audioUrl: ep.audio, transcriptChars: transcript.length, ...plan };
  } finally {
    fs.unlink(raw).catch(() => {});
    fs.unlink(small).catch(() => {});
  }
}
// Process a direct audio URL (e.g. a Wix-hosted sermon MP3) with no feed — same
// transcribe → study-plan pipeline, with the title/date supplied by the caller.
export async function processAudioUrl(audioUrl, { title = "", date = "" } = {}) {
  const stamp = Date.now();
  const raw = path.join(os.tmpdir(), `sermon_${stamp}.mp3`);
  const small = path.join(os.tmpdir(), `sermon_${stamp}.m4a`);
  try {
    if (!audioUrl) return { error: "no audio url" };
    await downloadTo(audioUrl, raw);
    await toWhisperAudio(raw, small);
    const transcript = await transcribePlain(small);
    const plan = await studyPlan(transcript);
    return { source: "audio", title, date, audioUrl, transcriptChars: transcript.length, ...plan };
  } finally {
    fs.unlink(raw).catch(() => {});
    fs.unlink(small).catch(() => {});
  }
}

/* ---------- feed-less sites: scrape embedded audio (e.g. Wix) ---------- */
// Wix stores sermon audio in the page HTML as references like
//   wix:audio://v1/<id>.mp3/<original filename>.mp3#duration=<sec>
// (the public music.wixstatic.com URL is assembled by JS only at play time).
// We read those refs straight from the HTML — no headless browser — build the
// public URL from the media id, and pull the title + date out of the filename.

// First VALID M/D/Y anywhere in a string (skips scripture ranges like "9-51-10-1").
function parseLooseDate(name) {
  const re = /(\d{1,2})[._\/-](\d{1,2})[._\/-](\d{2,4})/g;
  let m;
  while ((m = re.exec(name))) {
    let mo = +m[1], d = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100) {
      const dt = new Date(Date.UTC(y, mo - 1, d));
      if (!isNaN(dt.getTime())) return dt;
    }
  }
  return null;
}

// Drop a leading date token so the title is clean ("8.16.26 - Luke 9 - X" -> "Luke 9 - X").
function cleanSermonTitle(name) {
  const base = String(name).replace(/\.mp3$/i, "").trim();
  const t = base.replace(/^\s*\d{1,2}[._\/-]\d{1,2}[._\/-]\d{2,4}\s*[-–—:]*\s*/, "").trim();
  return t || base;
}

// Scrape a Wix-style page for its sermon audio, newest first.
// -> { count, sermons: [{ audioUrl, title, date("YYYY-MM-DD"|""), duration }] }
export async function scrapeWixSermons(pageUrl, { limit = 30 } = {}) {
  const res = await fetchViaProxyIfBlocked(pageUrl, { headers: { "User-Agent": BROWSER_UA } });
  if (!res.ok) return { error: "page " + res.status };
  let html = await res.text();
  html = html.replace(/\\\//g, "/"); // un-escape JSON slashes so the refs are matchable
  const re = /wix:audio:\/\/v1\/([0-9a-f]{6}_[0-9a-f]{32}\.mp3)\/([^"#\\?]+?\.mp3)(?:#duration=(\d+))?/gi;
  const seen = new Set();
  const items = [];
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    let name = m[2];
    try { name = decodeURIComponent(name); } catch { /* keep raw */ }
    const dt = parseLooseDate(name);
    items.push({
      audioUrl: "https://music.wixstatic.com/mp3/" + id,
      title: cleanSermonTitle(name),
      date: dt ? dt.toISOString().slice(0, 10) : "",
      duration: m[3] ? parseInt(m[3], 10) : null,
      _ord: items.length,
    });
  }
  // Newest first: dated items by date desc, undated kept in document order after them.
  items.sort((a, b) => {
    if (a.date && b.date) return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    if (a.date) return -1;
    if (b.date) return 1;
    return a._ord - b._ord;
  });
  for (const it of items) delete it._ord;
  return { count: items.length, sermons: items.slice(0, limit) };
}

/* ---------- unified source detection (for self-serve church signup) ---------- */
// Given any church URL (homepage, podcast feed, YouTube channel, Wix page), work out
// how to pull their sermons and return a few samples as proof. Used by /detect and /signup.
// -> { found:true, sourceType:"feed"|"youtube"|"scrape", sourceUrl, sampleSermons:[{title,date}] }
//    { found:false, reason }
export async function detectSermonSource(inputUrl) {
  const raw = String(inputUrl || "").trim();
  if (!raw) return { found: false, reason: "no url" };
  const norm = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
  const sample = (arr, n = 5) => arr.slice(0, n).map((x) => ({ title: x.title || "", date: x.date || "" }));

  // 1) Direct YouTube channel / video URL.
  if (/youtube\.com|youtu\.be/i.test(norm)) {
    try {
      const r = await searchChannelVideos(norm, 5);
      if (!r.error && r.entries && r.entries.length)
        return { found: true, sourceType: "youtube", sourceUrl: norm, sampleSermons: sample(r.entries) };
    } catch { /* fall through */ }
  }

  // 2) Direct podcast RSS. Try the URL as a feed regardless of its shape — feed hosts use
  // many URL forms (anchor.fm/.../rss, sermon.net/rss, logos .../feed, subsplash podcast.rss,
  // planningcenter podcast_feeds). If it parses to an episode with audio, it's a feed.
  if (!/^https?:\/\/[^/]*\.?youtube\.com|youtu\.be/i.test(norm)) {
    try {
      const ep = await latestEpisode(norm, 0);
      if (ep && ep.audio) return { found: true, sourceType: "feed", sourceUrl: norm, sampleSermons: [{ title: ep.title, date: ep.date }] };
    } catch { /* not a feed — fall through to HTML sniffing */ }
  }

  // 3) Fetch the page and sniff its platform.
  let html = "";
  try {
    const res = await fetchViaProxyIfBlocked(norm, { headers: { "User-Agent": BROWSER_UA } });
    if (res.ok) html = await res.text();
  } catch { /* no html */ }

  if (html) {
    // 3a) Wix embedded audio (the detector we already have).
    if (/wix:audio:/i.test(html)) {
      try {
        const w = await scrapeWixSermons(norm);
        if (!w.error && w.sermons && w.sermons.length)
          return { found: true, sourceType: "scrape", sourceUrl: norm, sampleSermons: sample(w.sermons) };
      } catch { /* fall through */ }
    }
    // 3b) RSS autodiscovery (<link rel=alternate type=application/rss+xml>, or a feeds.* URL).
    let feedUrl =
      ((html.match(/<link[^>]+type=["']application\/rss\+xml["'][^>]*>/i) || [])[0] || "")
        .match(/href=["']([^"']+)["']/i)?.[1] ||
      (html.match(/https?:\/\/[^"'<> ]*(?:feeds?\.[^"'<> ]+|\/feed\/podcast[^"'<> ]*)/i) || [])[0] || "";
    if (feedUrl) {
      if (feedUrl.startsWith("/")) { try { feedUrl = new URL(norm).origin + feedUrl; } catch {} }
      try {
        const ep = await latestEpisode(feedUrl, 0);
        if (ep && ep.audio) return { found: true, sourceType: "feed", sourceUrl: feedUrl, sampleSermons: [{ title: ep.title, date: ep.date }] };
      } catch { /* fall through */ }
    }
    // 3c) A YouTube channel linked from the page.
    const ytLink = (html.match(/https?:\/\/(?:www\.)?youtube\.com\/(?:channel\/|@|c\/|user\/)[A-Za-z0-9_\-.]+/i) || [])[0];
    if (ytLink) {
      try {
        const r = await searchChannelVideos(ytLink, 5);
        if (!r.error && r.entries && r.entries.length)
          return { found: true, sourceType: "youtube", sourceUrl: ytLink, sampleSermons: sample(r.entries) };
      } catch { /* fall through */ }
    }
  }

  return { found: false, reason: "no recognizable sermon source" };
}

/* ---------- church giving link (detected from their site) ---------- */
// Scan a church's website for a "Give/Donate/Tithe" link or a known giving provider,
// so the app can show a Give button that opens their existing giving page.
export async function detectGivingUrl(pageUrl) {
  const raw = String(pageUrl || "").trim();
  if (!raw) return { found: false };
  const norm = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
  let html = "";
  try { const res = await fetchViaProxyIfBlocked(norm, { headers: { "User-Agent": BROWSER_UA } }); if (res.ok) html = await res.text(); } catch { /* none */ }
  if (!html) return { found: false };
  // Known giving-provider URLs anywhere on the page.
  const providers = /https?:\/\/[^"'<> ]*(?:tithe\.ly|pushpay\.com|givelify\.com|planningcenter(?:online)?\.com[^"'<> ]*giving|subsplash\.com[^"'<> ]*give|givebutter\.com|easytithe\.com|onrealm\.org|donorbox\.org|paypal\.com\/donate)[^"'<> ]*/i;
  const pm = html.match(providers);
  if (pm) return { found: true, givingUrl: pm[0].replace(/&amp;/g, "&") };
  // A link whose text or href says give/donate/tithe/offering.
  for (const a of (html.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi) || [])) {
    const href = (a.match(/href=["']([^"']+)["']/i) || [])[1] || "";
    const text = a.replace(/<[^>]+>/g, " ");
    if (/\b(give|giving|donate|donation|tithe|offering)\b/i.test(text) || /\/(give|giving|donate|tithe|offering)(\b|\/)/i.test(href)) {
      let u = href.replace(/&amp;/g, "&");
      if (u.startsWith("/")) { try { u = new URL(norm).origin + u; } catch { /* keep */ } }
      if (/^https?:\/\//i.test(u)) return { found: true, givingUrl: u };
    }
  }
  return { found: false };
}

/* ---------- church events (ICS feed: Google Calendar, Planning Center, any iCal) ---------- */
// Times are shown in the calendar's own time zone (TZID / X-WR-TIMEZONE, default Central),
// and startMs is the true instant so the app can set reminders. Simple repeating events
// (daily / weekly / monthly / yearly RRULEs) are expanded, with EXDATE and moved instances.
export const DEFAULT_TZ = "America/Chicago";
const _ICS_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
function icalUnescape(s) {
  return String(s || "").replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\;/g, ";").replace(/\\\\/g, "\\").replace(/\s+/g, " ").trim();
}
function validTz(tz) {
  if (!tz) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return null; }
}
// Wall-clock parts of an instant in a time zone.
function wallOf(ms, tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(ms))) p[x.type] = +x.value;
  return { Y: p.year, Mo: p.month, D: p.day, H: p.hour % 24, Mi: p.minute };
}
const wallMs = (w) => Date.UTC(w.Y, w.Mo - 1, w.D, w.H || 0, w.Mi || 0);
const msWall = (ms) => { const d = new Date(ms); return { Y: d.getUTCFullYear(), Mo: d.getUTCMonth() + 1, D: d.getUTCDate(), H: d.getUTCHours(), Mi: d.getUTCMinutes() }; };
// Wall-clock time in a zone -> the real instant.
export function zonedToEpoch(w, tz) {
  const guess = wallMs(w);
  const off1 = wallMs(wallOf(guess, tz)) - guess;
  const t = guess - off1;
  const off2 = wallMs(wallOf(t, tz)) - t;
  return guess - off2;
}
export function fmtWhen(startMs, allDay, tz) {
  const opts = allDay
    ? { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }
    : { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  return new Intl.DateTimeFormat("en-US", opts).format(new Date(startMs)).replace(/,(?= \d{1,2}:)/, " ·").replace(/ at /, " · ");
}
// "DTSTART;TZID=America/Chicago:20261122T090000" -> { wall, allDay, tz }
function parseIcalProp(line, calTz) {
  if (!line) return null;
  const allDay = /VALUE=DATE(?!-TIME)/i.test(line) || /:\d{8}\s*$/.test(line);
  const m = line.match(/:(\d{8})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const w = { Y: +m[1].slice(0, 4), Mo: +m[1].slice(4, 6), D: +m[1].slice(6, 8), H: m[2] ? +m[2] : 0, Mi: m[3] ? +m[3] : 0 };
  if (allDay) return { wall: { ...w, H: 0, Mi: 0 }, allDay: true };
  if (m[5]) return { wall: wallOf(wallMs(w), calTz), allDay: false }; // UTC -> calendar's local time
  const tzid = validTz(((line.match(/TZID=([^;:]+)/i) || [])[1] || "").replace(/^"|"$/g, ""));
  if (tzid && tzid !== calTz) return { wall: wallOf(zonedToEpoch(w, tzid), calTz), allDay: false };
  return { wall: w, allDay: false };
}
const wallKey = (w) => `${w.Y}${String(w.Mo).padStart(2, "0")}${String(w.D).padStart(2, "0")}T${String(w.H).padStart(2, "0")}${String(w.Mi).padStart(2, "0")}`;
const dayKeyOf = (w) => wallKey(w).slice(0, 8);

// Expand an RRULE into wall-clock starts between [fromWall, toWall] (wall ms). Capped, best effort.
function expandRrule(rule, start, fromMs, toMs) {
  const r = {};
  for (const part of rule.split(";")) { const [k, v] = part.split("="); if (k && v) r[k.toUpperCase()] = v; }
  const freq = r.FREQ, interval = Math.max(1, parseInt(r.INTERVAL || "1", 10) || 1);
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  let untilMs = Infinity;
  if (r.UNTIL) { const u = r.UNTIL.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/); if (u) untilMs = Date.UTC(+u[1], +u[2] - 1, +u[3], u[4] ? +u[4] : 23, u[5] ? +u[5] : 59); }
  const byday = (r.BYDAY || "").split(",").filter(Boolean);
  const out = [];
  let n = 0;
  const startMs = wallMs(start);
  const push = (ms) => {
    if (ms < startMs) return true;
    if (ms > untilMs || n >= count) return false;
    n++;
    if (ms >= fromMs && ms <= toMs) out.push(msWall(ms));
    return ms <= toMs;
  };
  const DAY = 86400000;
  if (freq === "DAILY") {
    for (let i = 0, ms = startMs; i < 2000; i++, ms += interval * DAY) if (!push(ms)) break;
  } else if (freq === "WEEKLY") {
    const days = byday.length ? byday.map((d) => _ICS_DAYS.indexOf(d.slice(-2))).filter((d) => d >= 0).sort() : [new Date(startMs).getUTCDay()];
    const weekStart = startMs - new Date(startMs).getUTCDay() * DAY;
    outer: for (let wk = 0; wk < 600; wk++) {
      for (const d of days) { if (!push(weekStart + (wk * interval * 7 + d) * DAY)) break outer; }
    }
  } else if (freq === "MONTHLY") {
    const nth = byday.length === 1 ? byday[0].match(/^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/) : null;
    const bymd = r.BYMONTHDAY ? parseInt(r.BYMONTHDAY, 10) : start.D;
    for (let i = 0; i < 400; i++) {
      const mi = start.Mo - 1 + i * interval;
      const Y = start.Y + Math.floor(mi / 12), Mo = (mi % 12) + 1;
      const dim = new Date(Date.UTC(Y, Mo, 0)).getUTCDate();
      let D;
      if (nth && nth[1]) {
        const want = _ICS_DAYS.indexOf(nth[2]), k = parseInt(nth[1], 10);
        if (k > 0) { const first = new Date(Date.UTC(Y, Mo - 1, 1)).getUTCDay(); D = 1 + ((want - first + 7) % 7) + (k - 1) * 7; }
        else { const last = new Date(Date.UTC(Y, Mo - 1, dim)).getUTCDay(); D = dim - ((last - want + 7) % 7) + (k + 1) * 7; }
      } else D = bymd < 0 ? dim + bymd + 1 : bymd;
      if (D < 1 || D > dim) continue;
      if (!push(Date.UTC(Y, Mo - 1, D, start.H, start.Mi))) break;
    }
  } else if (freq === "YEARLY") {
    for (let i = 0; i < 50; i++) if (!push(Date.UTC(start.Y + i * interval, start.Mo - 1, start.D, start.H, start.Mi))) break;
  }
  return out;
}

// Accept the forms churches paste: webcal://, Google Calendar embed/share links, Planning Center ICS links.
export function normalizeCalendarUrl(input) {
  let url = String(input || "").trim();
  if (!url) return "";
  url = url.replace(/^webcal:/i, "https:");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try {
    const u = new URL(url);
    if (/calendar\.google\.com$/i.test(u.hostname) && !/\/ical\//.test(u.pathname)) {
      const src = u.searchParams.get("src") || u.searchParams.get("cid");
      if (src) {
        let id = src;
        if (u.searchParams.get("cid")) { try { id = Buffer.from(src, "base64").toString("utf8") || src; } catch { /* keep */ } if (!/@/.test(id)) id = src; }
        return `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`;
      }
    }
  } catch { /* leave as typed */ }
  return url;
}

// Fetch a church's public iCal feed and return upcoming events, soonest first.
export async function fetchIcsEvents(icalUrl, { limit = 20, days = 120, tz: fallbackTz = DEFAULT_TZ } = {}) {
  const url = normalizeCalendarUrl(icalUrl);
  if (!url) return { error: "no calendar url" };
  const res = await fetchViaProxyIfBlocked(url, { headers: { "User-Agent": BROWSER_UA } });
  if (!res.ok) return { error: "calendar " + res.status };
  let text = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) return { error: "not a calendar feed" };
  text = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, ""); // unfold continuation lines
  const calTz = validTz(((text.match(/(?:^|\n)X-WR-TIMEZONE[^:\n]*:([^\n]*)/i) || [])[1] || "").trim()) || validTz(fallbackTz) || DEFAULT_TZ;
  const now = Date.now();
  const horizon = now + days * 86400000;
  const nowWall = wallMs(wallOf(now, calTz)) - 2 * 86400000; // wall-clock window, a little slack
  const horizonWall = wallMs(wallOf(horizon, calTz));
  const prop = (body, name) => { const m = body.match(new RegExp("(?:^|\\n)" + name + "[^:\\n]*:([^\\n]*)", "i")); return m ? m[1] : ""; };
  const line = (body, name) => (body.match(new RegExp("(?:^|\\n)(" + name + "[;:][^\\n]*)", "i")) || [])[1] || "";
  const blocks = text.split(/BEGIN:VEVENT/i).slice(1).map((b) => b.split(/END:VEVENT/i)[0]);
  const moved = new Set(); // "uid|wallKey" instances replaced by a RECURRENCE-ID override
  for (const body of blocks) {
    const rid = parseIcalProp(line(body, "RECURRENCE-ID"), calTz);
    if (rid) moved.add(prop(body, "UID") + "|" + (rid.allDay ? dayKeyOf(rid.wall) : wallKey(rid.wall)));
  }
  const events = [];
  for (const body of blocks) {
    if (/(?:^|\n)STATUS[^:\n]*:CANCELLED/i.test(body)) continue;
    const ds = parseIcalProp(line(body, "DTSTART"), calTz);
    if (!ds) continue;
    const de = parseIcalProp(line(body, "DTEND"), calTz);
    const durMs = de ? Math.max(0, wallMs(de.wall) - wallMs(ds.wall)) : (ds.allDay ? 86400000 : 3600000);
    const uid = prop(body, "UID") || "";
    const isOverride = !!line(body, "RECURRENCE-ID");
    const rrule = prop(body, "RRULE");
    let starts = [ds.wall];
    if (rrule && !isOverride) {
      const ex = new Set();
      for (const m of body.matchAll(/(?:^|\n)(EXDATE[^\n]*)/gi)) {
        const tzPart = m[1].split(":")[0];
        for (const v of (m[1].split(":")[1] || "").split(",")) { const p = parseIcalProp(tzPart + ":" + v.trim(), calTz); if (p) ex.add(p.allDay ? dayKeyOf(p.wall) : wallKey(p.wall)); }
      }
      starts = expandRrule(rrule, ds.wall, nowWall - durMs, horizonWall).filter((w) => {
        const k = ds.allDay ? dayKeyOf(w) : wallKey(w);
        return !ex.has(k) && !moved.has(uid + "|" + k);
      });
    }
    const title = icalUnescape(prop(body, "SUMMARY")) || "Event";
    const location = icalUnescape(prop(body, "LOCATION"));
    const description = icalUnescape(prop(body, "DESCRIPTION")).slice(0, 400);
    for (const w of starts) {
      const startMs = ds.allDay ? wallMs(w) : zonedToEpoch(w, calTz);
      const endMs = ds.allDay ? startMs + durMs : startMs + durMs;
      const realEnd = ds.allDay ? zonedToEpoch(msWall(wallMs(w) + durMs), calTz) : endMs;
      if (realEnd < now || startMs > horizon) continue;
      events.push({
        id: "f_" + hashId(uid + "|" + wallKey(w)),
        title, when: fmtWhen(startMs, ds.allDay, calTz), startMs, endMs, allDay: ds.allDay, tz: calTz,
        location, description, source: "feed",
      });
    }
  }
  events.sort((a, b) => a.startMs - b.startMs);
  return { count: events.length, tz: calTz, events: events.slice(0, limit) };
}
function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Captivate's CDN fingerprint-blocks Node's undici (404) but allows Python's urllib.
// Download via a python3 subprocess: try direct first, fall back to the proxy for hosts
// that block our server IP. python3 is already installed (for yt-dlp).
const PY_DL = `
import sys, urllib.request as u
from urllib.parse import urlsplit
url, dest = sys.argv[1], sys.argv[2]
proxy = sys.argv[3] if len(sys.argv) > 3 else ""
# Podcast-app UA: hosts like Buzzsprout serve media to podcast apps but block browser/bot UAs.
UA = "AppleCoreMedia/1.0.0 (iPhone; CPU OS 17_0 like Mac OS X)"
_sp = urlsplit(url)
REFERER = _sp.scheme + "://" + _sp.netloc + "/"
def dl(opener):
    req = u.Request(url, headers={"User-Agent": UA, "Accept": "*/*", "Referer": REFERER})
    with opener.open(req, timeout=180) as r:
        ct = (r.headers.get("Content-Type") or "").lower()
        data = r.read()
    # Some hosts serve a 200-OK HTML anti-bot page to datacenter IPs; treat that as a failure
    # so the caller retries through the residential proxy.
    if ("html" in ct) or data[:1] == b"<" or len(data) < 2048:
        raise Exception("non-audio response (ct=%s len=%d)" % (ct, len(data)))
    return data
data = None
try:
    data = dl(u.build_opener())
except Exception as e1:
    if not proxy:
        sys.stderr.write("direct failed: %r" % (e1,)); sys.exit(2)
    try:
        data = dl(u.build_opener(u.ProxyHandler({"https": proxy, "http": proxy})))
    except Exception as e2:
        sys.stderr.write("proxy failed: %r" % (e2,)); sys.exit(3)
open(dest, "wb").write(data)
sys.stderr.write("OK %d" % len(data))
`;

function downloadTo(url, dest) {
  return new Promise((resolve, reject) => {
    const args = ["-c", PY_DL, url, dest];
    if (PROXY_URL) args.push(PROXY_URL);
    const p = spawn("python3", args);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error("download failed: " + err.trim()))));
  });
}

/* ---------- youtube (full service -> isolate the sermon) ---------- */
function videoId(url) {
  const m = String(url).match(/(?:v=|youtu\.be\/|\/embed\/|\/live\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{11}$/.test(url) ? url : null;
}
// YouTube changes its anti-bot challenge often, and the yt-dlp that ships inside
// youtube-dl-exec goes stale ("ERROR: [youtube] <id>: The page needs to be reloaded.").
// Fetch the latest self-contained yt-dlp binary once per container and run that instead;
// fall back to the bundled binary if the download is unavailable. This self-heals on redeploy.
let _ytdlpPromise = null;
let _ytCookiesPath = null; // set by ytdlp() init if YT cookies are provided via env
// Write a YouTube cookies file from env so yt-dlp can clear the "Sign in to confirm you're
// not a bot" wall on datacenter IPs. Provide YT_COOKIES_B64 (base64 of a Netscape cookies.txt
// exported from a logged-in — ideally throwaway — YouTube account); refresh it when it expires.
async function setupYtCookies() {
  try {
    const raw = process.env.YT_COOKIES_B64
      ? Buffer.from(process.env.YT_COOKIES_B64, "base64").toString("utf8")
      : (process.env.YT_COOKIES || "");
    if (raw && /youtube\.com/i.test(raw)) {
      const cp = path.join(os.tmpdir(), "yt-cookies.txt");
      await fs.writeFile(cp, raw);
      _ytCookiesPath = cp;
      console.log("✅ yt-dlp: using YouTube cookies from env");
    }
  } catch (e) {
    console.error("yt-dlp cookies setup failed:", (e && e.message) || e);
  }
}
// YouTube now binds a GVS PO Token to most clients; yt-dlp can mint that token itself, but only
// if it has a JavaScript runtime to run its bundled challenge solver (yt_dlp_ejs). Railway's image
// has none that yt-dlp accepts, so download a standalone Deno once per container and put it on PATH.
// Verified fix: with Deno present, yt-dlp reports "Solving JS challenges using deno" and extracts.
async function setupDeno() {
  try {
    const denoDir = path.join(os.tmpdir(), "deno-bin");
    const denoBin = path.join(denoDir, "deno");
    let have = false;
    try { await fs.access(denoBin); have = true; } catch { /* needs download */ }
    if (!have) {
      await fs.mkdir(denoDir, { recursive: true });
      const zipPath = path.join(denoDir, "deno.zip");
      const url = "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip";
      const res = await undiciFetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`deno download HTTP ${res.status}`);
      await fs.writeFile(zipPath, Buffer.from(await res.arrayBuffer()));
      // Node has no built-in zip extractor; python3 is already present (for yt-dlp).
      await new Promise((resolve, reject) => {
        const p = spawn("python3", ["-c", "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", zipPath, denoDir]);
        let err = ""; p.stderr.on("data", (d) => (err += d));
        p.on("error", reject);
        p.on("close", (c) => (c === 0 ? resolve() : reject(new Error("deno unzip failed: " + err.trim()))));
      });
      await fs.chmod(denoBin, 0o755);
      await fs.unlink(zipPath).catch(() => {});
      console.log("✅ deno: downloaded for yt-dlp JS challenge solving");
    }
    if (!(process.env.PATH || "").split(":").includes(denoDir)) {
      process.env.PATH = denoDir + ":" + (process.env.PATH || "");
    }
  } catch (e) {
    console.error("deno setup failed (YouTube extraction may fail):", (e && e.message) || e);
  }
}
// Extra yt-dlp options shared by every YouTube call: residential proxy + cookies when present.
function ytAuthOpts() {
  return {
    ...(PROXY_URL ? { proxy: PROXY_URL } : {}),
    ...(_ytCookiesPath ? { cookies: _ytCookiesPath } : {}),
  };
}
async function ytdlp() {
  if (_ytdlpPromise) return _ytdlpPromise;
  _ytdlpPromise = (async () => {
    const mod = await import("youtube-dl-exec");
    await setupYtCookies();
    await setupDeno();
    try {
      const binPath = path.join(os.tmpdir(), "yt-dlp_linux");
      let have = false;
      try { await fs.access(binPath); have = true; } catch { /* needs download */ }
      if (!have) {
        const url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
        const res = await undiciFetch(url, { redirect: "follow" });
        if (!res.ok) throw new Error(`download HTTP ${res.status}`);
        await fs.writeFile(binPath, Buffer.from(await res.arrayBuffer()));
        await fs.chmod(binPath, 0o755);
        console.log("✅ yt-dlp: downloaded latest self-contained binary");
      }
      return mod.create(binPath);
    } catch (e) {
      console.error("yt-dlp self-update failed, using bundled binary:", (e && e.message) || e);
      return mod.default;
    }
  })();
  return _ytdlpPromise;
}

async function downloadYouTubeAudio(vid, base) {
  const youtubedl = await ytdlp(); // latest self-contained yt-dlp (falls back to bundled)
  await youtubedl(`https://www.youtube.com/watch?v=${vid}`, {
    extractAudio: true,
    audioFormat: "mp3",
    output: `${base}.%(ext)s`,
    ffmpegLocation: ffmpegPath,
    noCheckCertificates: true,
    noWarnings: true,
    // Impersonate the TV / Safari / iOS players, and send the residential proxy + account
    // cookies (when configured) so YouTube's "confirm you're not a bot" wall is cleared.
    extractorArgs: "youtube:player_client=default",
    ...ytAuthOpts(),
    addHeader: ["referer:youtube.com", "user-agent:Mozilla/5.0"],
  });
  return `${base}.mp3`;
}
// Search YouTube for candidate videos (flat metadata only; no download).
// Reuses the same proxy + player-client impersonation as the audio path.
export async function searchYouTube(query, n = 6) {
  const youtubedl = await ytdlp();
  let out;
  try {
    out = await youtubedl(`ytsearch${n}:${query}`, {
      flatPlaylist: true,
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      extractorArgs: "youtube:player_client=default",
      ...ytAuthOpts(),
      addHeader: ["referer:youtube.com", "user-agent:Mozilla/5.0"],
    });
  } catch (e) {
    return { error: String((e && e.message) || e), entries: [] };
  }
  const entries = (out && out.entries) || [];
  return {
    entries: entries
      .map((e) => ({ id: e.id, title: e.title || "", channel: e.channel || e.uploader || "", duration: e.duration || 0 }))
      .filter((e) => e.id),
  };
}

// Normalize a channel reference (UC id, @handle, or full URL) to a /videos listing URL.
function channelUrl(ref) {
  ref = String(ref || "").trim();
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) {
    if (/youtube\.com\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/?$/i.test(ref)) return ref.replace(/\/$/, "") + "/videos";
    return ref;
  }
  if (/^UC[\w-]{20,}$/.test(ref)) return `https://www.youtube.com/channel/${ref}/videos`;
  if (ref.startsWith("@")) return `https://www.youtube.com/${ref}/videos`;
  return `https://www.youtube.com/@${ref}/videos`;
}

// List a channel's recent uploads (flat metadata only). Every result is guaranteed
// to be from that channel, so matching a sermon by title can't pick a lookalike church.
export async function searchChannelVideos(ref, n = 15) {
  const url = channelUrl(ref);
  if (!url) return { error: "no channel", entries: [] };
  const youtubedl = await ytdlp();
  let out;
  try {
    out = await youtubedl(url, {
      flatPlaylist: true,
      dumpSingleJson: true,
      playlistEnd: n,
      noCheckCertificates: true,
      noWarnings: true,
      extractorArgs: "youtube:player_client=default",
      ...ytAuthOpts(),
      addHeader: ["referer:youtube.com", "user-agent:Mozilla/5.0"],
    });
  } catch (e) {
    return { error: String((e && e.message) || e), entries: [] };
  }
  const entries = (out && out.entries) || [];
  const chName = (out && out.title) || "";
  return {
    channel: chName,
    entries: entries
      .map((e) => ({ id: e.id, title: e.title || "", channel: e.channel || e.uploader || chName, duration: e.duration || 0 }))
      .filter((e) => e.id),
  };
}

async function findSermonSpan(segments) {
  const lines = segments.map((s) => `[${Math.round(s.start)}] ${(s.text || "").trim()}`).join("\n");
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `This is a timestamped transcript of a full church service (each line starts with its time in seconds). ` +
          `Identify the main sermon — the preacher's extended teaching/message — AND the scripture reading that immediately precedes and introduces it (the reading of the day's Bible passage right before the preacher begins the message). ` +
          `Set startSec to the beginning of that immediately-preceding scripture reading, so the span includes the reading through the end of the sermon. ` +
          `EXCLUDE everything earlier in the service (opening music, hymns, worship songs, choir anthems, announcements, offering, pastoral prayers) and everything after the sermon ends (closing hymn, benediction, postlude). ` +
          `Reply JSON only: {"startSec": <int>, "endSec": <int>, "title": "<short sermon title if evident, else empty>"}.`,
      },
      { role: "user", content: lines.slice(0, 120000) },
    ],
  });
  return JSON.parse(r.choices[0].message.content);
}
function sliceTranscript(segments, startSec, endSec) {
  return segments.filter((s) => s.end >= startSec && s.start <= endSec).map((s) => (s.text || "").trim()).join(" ");
}

// Reusable: full YouTube service -> isolate the sermon -> study plan (same shape the endpoint returns).
export async function processYouTube(urlOrId) {
  const vid = videoId(String(urlOrId || ""));
  if (!vid) return { error: "missing or invalid youtube url" };
  const stamp = Date.now();
  const base = path.join(os.tmpdir(), `yt_${stamp}`);
  const small = path.join(os.tmpdir(), `yt_${stamp}.m4a`);
  let raw;
  try {
    raw = await downloadYouTubeAudio(vid, base);
    await toWhisperAudio(raw, small);
    const tr = await transcribeTimestamped(small);
    const segs = tr.segments || [];
    const span = await findSermonSpan(segs);
    const sermonText = sliceTranscript(segs, span.startSec, span.endSec) || tr.text;
    const plan = await studyPlan(sermonText);
    // Host the sermon-only audio on R2 so YouTube-only churches get downloadable/offline audio.
    let audioUrl = null;
    if (r2Configured()) {
      const clip = path.join(os.tmpdir(), `yt_${stamp}_sermon.mp3`);
      try {
        await sliceAudio(raw, clip, span.startSec, span.endSec);
        audioUrl = await uploadFileToR2(clip, `sermons/${vid}.mp3`, "audio/mpeg");
      } catch (e) {
        console.error("R2 sermon audio", e);
      } finally {
        fs.unlink(clip).catch(() => {});
      }
    }
    return {
      source: "youtube",
      videoId: vid,
      title: span.title || "",
      sermonStartSec: span.startSec,
      sermonEndSec: span.endSec,
      embedUrl: `https://www.youtube.com/embed/${vid}?start=${span.startSec}&end=${span.endSec}`,
      audioUrl,
      ...plan,
    };
  } finally {
    if (raw) fs.unlink(raw).catch(() => {});
    fs.unlink(small).catch(() => {});
  }
}

export function mountSermonProcess(app) {
  app.get("/sermon/process", async (req, res) => {
    const feed = String(req.query.feed || "");
    if (!feed) return res.status(400).json({ error: "missing feed param" });
    try {
      const result = await processPodcastFeed(feed);
      if (result.error) return res.status(404).json(result);
      res.json(result);
    } catch (e) {
      console.error("GET /sermon/process", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  app.get("/sermon/youtube", async (req, res) => {
    try {
      const result = await processYouTube(String(req.query.url || ""));
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("GET /sermon/youtube", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
}
