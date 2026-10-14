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
function ensureLoaded() {
  if (LEX) return;
  LEX = JSON.parse(fs.readFileSync(path.join(DATA, "strongs.json"), "utf8"));
  OT  = JSON.parse(fs.readFileSync(path.join(DATA, "ot.json"), "utf8"));
  NT  = JSON.parse(fs.readFileSync(path.join(DATA, "nt.json"), "utf8"));
}

export function mountWordStudy(app) {
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
