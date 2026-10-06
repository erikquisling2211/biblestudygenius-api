/**
 * scripture.js — API.Bible proxy for Bible Study Genius.
 *
 * Serves licensed Scripture text and chapter audio to the app WITHOUT exposing
 * the API.Bible key (it lives here, server-side, in process.env.API_BIBLE_KEY).
 *
 * Routes (public — the reader works for guests too):
 *   GET /scripture/:translationId/:bookId/:chapter  -> { chapter: {chapter, verses:[{v,t}]}, fumsToken }
 *   GET /audio/:translationId/:bookId/:chapter       -> { resourceUrl, fumsToken }
 *
 * Mount from index.js:
 *   import { mountScripture } from "./scripture.js";
 *   mountScripture(app);
 */

const API_BASE = "https://rest.api.bible/v1";
const KEY = process.env.API_BIBLE_KEY || "";

// translationId -> API.Bible TEXT bibleId (licensed versions only; bundled ones never reach here)
const TEXT_BIBLE_ID = {
  nasb: "b8ee27bcd1cae43a-01", // New American Standard Bible 1995 (Lockman)
  nlt:  "d6e14a625393b4da-01", // New Living Translation (Tyndale)
  nkjv: "63097d2a0a2f7db3-01", // New King James Version (Thomas Nelson)
};

// translationId -> API.Bible AUDIO bibleId
const AUDIO_BIBLE_ID = {
  bsb: "aadc8a2f4bdb467b-01", // Berean Standard Bible — human audio
  web: "105a06b6146d11e7-01", // World English Bible — human audio
};

// app bookId -> USFM book code used by API.Bible chapter ids (e.g. "john" -> "JHN.3")
const BOOK_CODE = {
  "genesis": "GEN", "exodus": "EXO", "leviticus": "LEV", "numbers": "NUM", "deuteronomy": "DEU",
  "joshua": "JOS", "judges": "JDG", "ruth": "RUT", "1-samuel": "1SA", "2-samuel": "2SA",
  "1-kings": "1KI", "2-kings": "2KI", "1-chronicles": "1CH", "2-chronicles": "2CH", "ezra": "EZR",
  "nehemiah": "NEH", "esther": "EST", "job": "JOB", "psalms": "PSA", "proverbs": "PRO",
  "ecclesiastes": "ECC", "song-of-solomon": "SNG", "isaiah": "ISA", "jeremiah": "JER",
  "lamentations": "LAM", "ezekiel": "EZK", "daniel": "DAN", "hosea": "HOS", "joel": "JOL",
  "amos": "AMO", "obadiah": "OBA", "jonah": "JON", "micah": "MIC", "nahum": "NAM",
  "habakkuk": "HAB", "zephaniah": "ZEP", "haggai": "HAG", "zechariah": "ZEC", "malachi": "MAL",
  "matthew": "MAT", "mark": "MRK", "luke": "LUK", "john": "JHN", "acts": "ACT", "romans": "ROM",
  "1-corinthians": "1CO", "2-corinthians": "2CO", "galatians": "GAL", "ephesians": "EPH",
  "philippians": "PHP", "colossians": "COL", "1-thessalonians": "1TH", "2-thessalonians": "2TH",
  "1-timothy": "1TI", "2-timothy": "2TI", "titus": "TIT", "philemon": "PHM", "hebrews": "HEB",
  "james": "JAS", "1-peter": "1PE", "2-peter": "2PE", "1-john": "1JN", "2-john": "2JN",
  "3-john": "3JN", "jude": "JUD", "revelation": "REV",
};

// Walk API.Bible JSON content into [{v, t}]. Tracks verse markers and verseId attrs.
function parseVerses(content) {
  const map = new Map();
  let cur = 0;
  function walk(items) {
    if (!Array.isArray(items)) return;
    for (const it of items) {
      if (it && it.name === "verse" && it.attrs && it.attrs.number != null) {
        const n = parseInt(String(it.attrs.number), 10);
        if (!Number.isNaN(n)) cur = n;
      }
      if (it && it.type === "text" && typeof it.text === "string") {
        let v = cur;
        if (it.attrs && it.attrs.verseId) {
          const n = parseInt(String(it.attrs.verseId).split(".").pop(), 10);
          if (!Number.isNaN(n)) v = n;
        }
        if (v > 0) map.set(v, (map.get(v) || "") + it.text);
      }
      if (it && it.items) walk(it.items);
    }
  }
  walk(content);
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([v, t]) => ({ v, t: t.replace(/\s+/g, " ").trim() }))
    .filter((x) => x.t);
}

// Small in-memory cache for licensed text (cuts API.Bible calls; stays well under quota).
const TEXT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const textCache = new Map(); // key -> { at, body }
function cacheGet(key) {
  const hit = textCache.get(key);
  if (hit && Date.now() - hit.at < TEXT_TTL_MS) return hit.body;
  if (hit) textCache.delete(key);
  return null;
}
function cacheSet(key, body) {
  textCache.set(key, { at: Date.now(), body });
  if (textCache.size > 2000) textCache.delete(textCache.keys().next().value); // simple bound
}

// --- Bible Brain (Faith Comes By Hearing) audio ---
const BRAIN_KEY = process.env.BIBLE_BRAIN_KEY || "";
const BRAIN_BASE = "https://4.dbt.io/api";
// translationId -> Bible Brain filesets (MP3, single-narrator). OT/NT split; null = no recording.
const BRAIN_FILESET = {
  esv:  { ot: "ENGESVO1DA", nt: "ENGESVN1DA" },
  bsb:  { ot: "ENGBERO1DA", nt: "ENGBERN1DA" }, // full Bible, plain
  web:  { ot: null,         nt: "ENGWEBN2DA" }, // NT only (dramatized)
  kjv:  { ot: "ENGKJVO1DA", nt: "ENGKJVN1DA" },
  nlt:  { ot: "ENGNLHO1DA", nt: "ENGNLHN1DA" }, // her.BIBLE plain reading
  nkjv: { ot: null,         nt: "ENGNKJN1DA" }, // New Testament only
};
const OT_CODES = new Set(["GEN","EXO","LEV","NUM","DEU","JOS","JDG","RUT","1SA","2SA","1KI","2KI","1CH","2CH","EZR","NEH","EST","JOB","PSA","PRO","ECC","SNG","ISA","JER","LAM","EZK","DAN","HOS","JOL","AMO","OBA","JON","MIC","NAM","HAB","ZEP","HAG","ZEC","MAL"]);
async function brainAudioUrl(translationId, code, chapNum) {
  const sets = BRAIN_FILESET[translationId];
  if (!sets) return null;
  const fileset = OT_CODES.has(code) ? sets.ot : sets.nt;
  if (!fileset) return null;
  const url = `${BRAIN_BASE}/bibles/filesets/${fileset}/${code}/${chapNum}?v=4&key=${BRAIN_KEY}`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) return null;
  const j = await r.json();
  const data = Array.isArray(j.data) ? j.data : [];
  const hit = data.find((x) => x && x.path) || null;
  return hit ? hit.path : null;
}

const BRAIN_TEXT = {
  esv:  { ot: "ENGESVO_ET", nt: "ENGESVN_ET" },
  nasb: { ot: "ENGNASO_ET", nt: "ENGNASN_ET" }, // NASB 1995
  nlt:  { ot: "ENGNLHO_ET", nt: "ENGNLHN_ET" }, // her.BIBLE edition
  nkjv: { ot: "ENGNKJO_ET", nt: "ENGNKJN_ET" },
};
async function brainChapterText(translationId, code, chapNum) {
  const sets = BRAIN_TEXT[translationId];
  if (!sets) return null;
  const fileset = OT_CODES.has(code) ? sets.ot : sets.nt;
  if (!fileset) return null;
  const url = `${BRAIN_BASE}/bibles/filesets/${fileset}/${code}/${chapNum}?v=4&key=${BRAIN_KEY}`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) return null;
  const j = await r.json();
  const rows = Array.isArray(j.data) ? j.data : [];
  const map = new Map();
  for (const row of rows) {
    const v = parseInt(row.verse_start, 10);
    const t = String(row.verse_text || "").replace(/\s+/g, " ").trim();
    if (!Number.isNaN(v) && v > 0 && t) map.set(v, map.has(v) ? map.get(v) + " " + t : t);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([v, t]) => ({ v, t }));
}

export function mountScripture(app) {
  // --- licensed Scripture text ---
  app.get("/scripture/:translationId/:bookId/:chapter", async (req, res) => {
    try {
      const tt = req.params.translationId;
      if (BRAIN_TEXT[tt]) {
        if (!BRAIN_KEY) return res.status(503).json({ error: "Bible Brain key not configured" });
        const tcode = BOOK_CODE[req.params.bookId];
        const tchap = parseInt(req.params.chapter, 10);
        if (!tcode || Number.isNaN(tchap)) return res.status(404).json({ error: "Unknown book or chapter" });
        const tkey = `brain/${tt}/${tcode}.${tchap}`;
        const tcached = cacheGet(tkey);
        if (tcached) return res.json(tcached);
        const verses = await brainChapterText(tt, tcode, tchap);
        if (!verses || !verses.length) return res.status(502).json({ error: "Empty chapter" });
        const out = { chapter: { chapter: tchap, verses }, fumsToken: null };
        cacheSet(tkey, out);
        return res.json(out);
      }
      if (!KEY) return res.status(503).json({ error: "API key not configured" });
      const bibleId = TEXT_BIBLE_ID[req.params.translationId];
      const code = BOOK_CODE[req.params.bookId];
      const chapNum = parseInt(req.params.chapter, 10);
      if (!bibleId || !code || Number.isNaN(chapNum)) {
        return res.status(404).json({ error: "Unknown translation, book, or chapter" });
      }
      const chapterId = `${code}.${chapNum}`;
      const key = `${bibleId}/${chapterId}`;
      const cached = cacheGet(key);
      if (cached) return res.json(cached);

      const url = `${API_BASE}/bibles/${bibleId}/chapters/${chapterId}` +
        `?content-type=json&include-notes=false&include-titles=false` +
        `&include-chapter-numbers=false&include-verse-numbers=false&include-verse-spans=false`;
      const r = await fetch(url, { headers: { "api-key": KEY, "Accept": "application/json" } });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        console.error("API.Bible text", r.status, body.slice(0, 200));
        return res.status(502).json({ error: `Upstream ${r.status}` });
      }
      const j = await r.json();
      const verses = parseVerses(j && j.data ? j.data.content : []);
      if (!verses.length) return res.status(502).json({ error: "Empty chapter" });
      const out = {
        chapter: { chapter: chapNum, verses },
        fumsToken: (j.meta && (j.meta.fumsId || j.meta.fums)) || null,
      };
      cacheSet(key, out);
      res.json(out);
    } catch (e) {
      console.error("GET /scripture", e);
      res.status(500).json({ error: "Server error" });
    }
  });

  // --- chapter audio (signed URL; not cached because it expires) ---
  app.get("/audio/:translationId/:bookId/:chapter", async (req, res) => {
    try {
      const bt = req.params.translationId;
      if (BRAIN_FILESET[bt]) {
        if (!BRAIN_KEY) return res.status(503).json({ error: "Bible Brain key not configured" });
        const bcode = BOOK_CODE[req.params.bookId];
        const bchap = parseInt(req.params.chapter, 10);
        if (!bcode || Number.isNaN(bchap)) return res.status(404).json({ error: "Unknown book or chapter" });
        const burl = await brainAudioUrl(bt, bcode, bchap);
        if (!burl) return res.status(404).json({ error: "No audio for that chapter" });
        return res.json({ resourceUrl: burl, expiresAt: null, fumsToken: null });
      }
      if (!KEY) return res.status(503).json({ error: "API key not configured" });
      const audioId = AUDIO_BIBLE_ID[req.params.translationId];
      const code = BOOK_CODE[req.params.bookId];
      const chapNum = parseInt(req.params.chapter, 10);
      if (!audioId || !code || Number.isNaN(chapNum)) {
        return res.status(404).json({ error: "No audio for that translation/book/chapter" });
      }
      const chapterId = `${code}.${chapNum}`;
      const url = `${API_BASE}/audio-bibles/${audioId}/chapters/${chapterId}`;
      const r = await fetch(url, { headers: { "api-key": KEY, "Accept": "application/json" } });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        console.error("API.Bible audio", r.status, body.slice(0, 200));
        return res.status(502).json({ error: `Upstream ${r.status}` });
      }
      const j = await r.json();
      const resourceUrl = j && j.data ? j.data.resourceUrl : null;
      if (!resourceUrl) return res.status(502).json({ error: "No audio URL" });
      res.json({
        resourceUrl,
        expiresAt: j.data.expiresAt || null,
        fumsToken: (j.meta && (j.meta.fumsId || j.meta.fums)) || null,
      });
    } catch (e) {
      console.error("GET /audio", e);
      res.status(500).json({ error: "Server error" });
    }
  });
}
