/**
 * wordstudy.js — original-language (Greek / Hebrew) word study with Strong's.
 *
 * Serves the tagged original text for a chapter plus the Strong's lexicon
 * entries used in it, so the app can show the original verse with tappable
 * word definitions alongside the modern translation.
 *
 * Data (open-license, in ./data — credit required, see below):
 *   strongs.json — Strong's Greek (1890) + Hebrew (1894) dictionary
 *                  (OpenScriptures, CC BY-SA)
 *   ot.json      — Hebrew OT tagged  (OpenScriptures Hebrew Bible, CC BY 4.0)
 *   nt.json      — Greek NT tagged   (OpenGNT, CC BY-SA 4.0)
 *
 * Mount from index.js:
 *   import { mountWordStudy } from "./wordstudy.js";
 *   mountWordStudy(app);
 *
 * Response shape for GET /wordstudy/:bookId/:chapter
 *   { lang: "hebrew"|"greek"|null,
 *     verses: { "1": [["בְּרֵאשִׁית","H7225"], ...], ... },
 *     lex:    { "H7225": {w,t,p?,d,k}, ... } }   // only the Strong's used here
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "data");

let LEX = null, OT = null, NT = null;
let CONC = null;
let ENGTAGS = {};
let CROSS = null;
function ensureLoaded() {
  if (LEX) return;
  LEX = JSON.parse(fs.readFileSync(path.join(DATA, "strongs.json"), "utf8"));
  OT  = JSON.parse(fs.readFileSync(path.join(DATA, "ot.json"), "utf8"));
  NT  = JSON.parse(fs.readFileSync(path.join(DATA, "nt.json"), "utf8"));
}

// Build a Strong's -> verse list index once, from the tagged OT/NT text.
function buildConc() {
  if (CONC) return CONC;
  ensureLoaded();
  CONC = {};
  for (const data of [OT, NT]) {
    for (const b of Object.keys(data)) {
      for (const ch of Object.keys(data[b])) {
        for (const v of Object.keys(data[b][ch])) {
          const seen = new Set();
          for (const w of data[b][ch][v]) {
            const st = w[1];
            if (st && !seen.has(st)) {
              seen.add(st);
              (CONC[st] = CONC[st] || []).push({ b, c: parseInt(ch, 10), v: parseInt(v, 10) });
            }
          }
        }
      }
    }
  }
  return CONC;
}

function ensureEngtags(tr) {
  if (ENGTAGS[tr]) return ENGTAGS[tr];
  const file = tr === "kjv" ? "kjv_engtags.json" : "bsb_engtags.json";
  ENGTAGS[tr] = JSON.parse(fs.readFileSync(path.join(DATA, file), "utf8"));
  return ENGTAGS[tr];
}

function ensureCross() {
  if (CROSS) return CROSS;
  CROSS = JSON.parse(fs.readFileSync(path.join(DATA, "crossrefs.json"), "utf8"));
  return CROSS;
}

export function mountWordStudy(app) {
  // Cross-references (Treasury of Scripture Knowledge) for a verse.
  app.get("/crossref/:book/:chapter/:verse", (req, res) => {
    try {
      const C = ensureCross();
      const b = req.params.book;
      const ch = String(parseInt(req.params.chapter, 10));
      const v = String(parseInt(req.params.verse, 10));
      const refs = (C[b] && C[b][ch] && C[b][ch][v]) || [];
      res.json({ refs });
    } catch (e) {
      console.error("GET /crossref", e);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Tagged English (BSB/KJV): each word in a chapter -> Strong's, plus the lexicon for those Strong's.
  app.get("/engstudy/:translation/:book/:chapter", (req, res) => {
    try {
      ensureLoaded();
      const tr = req.params.translation === "kjv" ? "kjv" : "bsb";
      const E = ensureEngtags(tr);
      const b = req.params.book;
      const ch = String(parseInt(req.params.chapter, 10));
      const chap = (E[b] && E[b][ch]) || null;
      if (!chap) return res.json({ verses: {}, lex: {} });
      const used = new Set();
      for (const v of Object.keys(chap)) for (const w of chap[v]) if (w[1]) used.add(w[1]);
      const lex = {};
      for (const st of used) if (LEX[st]) lex[st] = LEX[st];
      res.json({ verses: chap, lex });
    } catch (e) {
      console.error("GET /engstudy", e);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Concordance: every verse where a Strong's number occurs.
  app.get("/concordance/:strongs", (req, res) => {
    try {
      const idx = buildConc();
      const st = String(req.params.strongs);
      const all = idx[st] || [];
      const LIMIT = 500;
      res.json({ strongs: st, count: all.length, refs: all.slice(0, LIMIT), truncated: all.length > LIMIT });
    } catch (e) {
      console.error("GET /concordance", e);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Which books have original-language data (for the app to show/hide the toggle).
  app.get("/wordstudy/books", (_req, res) => {
    try {
      ensureLoaded();
      res.json({ hebrew: Object.keys(OT), greek: Object.keys(NT) });
    } catch (e) {
      console.error("GET /wordstudy/books", e);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Original text + used lexicon for one chapter.
  app.get("/wordstudy/:bookId/:chapter", (req, res) => {
    try {
      ensureLoaded();
      const bid = req.params.bookId;
      const ch = parseInt(req.params.chapter, 10);
      if (Number.isNaN(ch)) return res.status(404).json({ error: "Bad chapter" });
      const key = String(ch);
      const chap = (OT[bid] && OT[bid][key]) || (NT[bid] && NT[bid][key]) || null;
      if (!chap) return res.json({ lang: null, verses: {}, lex: {} });
      const lang = OT[bid] ? "hebrew" : "greek";
      const used = new Set();
      for (const v of Object.keys(chap))
        for (const w of chap[v]) if (w[1]) used.add(w[1]);
      const lex = {};
      for (const s of used) if (LEX[s]) lex[s] = LEX[s];
      res.json({ lang, verses: chap, lex });
    } catch (e) {
      console.error("GET /wordstudy", e);
      res.status(500).json({ error: "Server error" });
    }
  });
}
