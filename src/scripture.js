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
};

// translationId -> API.Bible AUDIO bibleId
const AUDIO_BIBLE_ID = {
  bsb: "aadc8a2f4bdb467b-01", // Berean Standard Bible — human audio
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

export function mountScripture(app) {
  // --- licensed Scripture text ---
  app.get("/scripture/:translationId/:bookId/:chapter", async (req, res) => {
    try {
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
