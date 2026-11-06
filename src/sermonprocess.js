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
    const p = spawn(ffmpegPath, ["-y", "-i", input, "-ac", "1", "-ar", "16000", "-b:a", "32k", output]);
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error("ffmpeg exit " + c))));
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

async function studyPlan(text) {
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

export async function latestEpisode(feedUrl) {
  const res = await fetchViaProxyIfBlocked(feedUrl, { headers: { "User-Agent": BROWSER_UA } });
  if (!res.ok) throw new Error("feed " + res.status);
  const xml = await res.text();
  const item = xml.split(/<item[\s>]/)[1] || "";
  const pick = (re) => (item.match(re) || [])[1];
  const clean = (s) => decodeEntities((s || "").replace(/<!\[CDATA\[|\]\]>/g, "").trim());
  return {
    title: clean(pick(/<title>([\s\S]*?)<\/title>/)),
    date: clean(pick(/<pubDate>([\s\S]*?)<\/pubDate>/)),
    audio: pick(/<enclosure[^>]*url="([^"]+)"/),
  };
}

// Reusable: fetch a feed's latest episode and return the full study-plan object.
export async function processPodcastFeed(feed) {
  const stamp = Date.now();
  const raw = path.join(os.tmpdir(), `sermon_${stamp}.mp3`);
  const small = path.join(os.tmpdir(), `sermon_${stamp}.m4a`);
  try {
    const ep = await latestEpisode(feed);
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
// Captivate's CDN fingerprint-blocks Node's undici (404) but allows Python's urllib.
// Download via a python3 subprocess: try direct first, fall back to the proxy for hosts
// that block our server IP. python3 is already installed (for yt-dlp).
const PY_DL = `
import sys, urllib.request as u
url, dest = sys.argv[1], sys.argv[2]
proxy = sys.argv[3] if len(sys.argv) > 3 else ""
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
def dl(opener):
    req = u.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with opener.open(req, timeout=180) as r:
        return r.read()
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
async function downloadYouTubeAudio(vid, base) {
  const youtubedl = (await import("youtube-dl-exec")).default; // lazy: only needed for the YouTube path
  await youtubedl(`https://www.youtube.com/watch?v=${vid}`, {
    extractAudio: true,
    audioFormat: "mp3",
    output: `${base}.%(ext)s`,
    ffmpegLocation: ffmpegPath,
    noCheckCertificates: true,
    noWarnings: true,
    // Impersonate the TV / Safari / iOS players — these often bypass YouTube's
    // "confirm you're not a bot" challenge on datacenter IPs (no cookies needed).
    extractorArgs: "youtube:player_client=tv,web_safari,ios",
    ...(PROXY_URL ? { proxy: PROXY_URL } : {}),
    addHeader: ["referer:youtube.com", "user-agent:Mozilla/5.0"],
  });
  return `${base}.mp3`;
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
    return {
      source: "youtube",
      videoId: vid,
      title: span.title || "",
      sermonStartSec: span.startSec,
      sermonEndSec: span.endSec,
      embedUrl: `https://www.youtube.com/embed/${vid}?start=${span.startSec}&end=${span.endSec}`,
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
