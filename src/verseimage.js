/*
 * verseimage.js — shareable verse-image card for Bible Study Genius.
 * Wiring (src/index.js):
 *   import { mountVerseImage } from "./verseimage.js";
 *   mountVerseImage(app);
 * Endpoint:
 *   GET /verseimage?text=...&ref=John%203:16&tr=Berean%20Standard%20Bible&red=1&bg=2  -> image/png
 *   bg = which VOTD background (0-6); omit to pick by day-of-year.
 */
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
GlobalFonts.registerFromPath(path.join(__dirname, "serif.ttf"), "VerseSerif");
GlobalFonts.registerFromPath(path.join(__dirname, "serif-bold.ttf"), "VerseSerifB");

// --- Backgrounds: load the 7 VOTD images once, then reuse the decoded bitmaps. ---
const BG_DIR = path.join(__dirname, "..", "assets", "votd");
const BG_FILES = [
  "votd-sunrise.jpg", "votd-sunrise-2.jpg", "votd-sunrise-3.jpg", "votd-sunrise-4.jpg",
  "votd-sunrise-5.jpg", "votd-sunrise-6.jpg", "votd-sunrise-7.jpg",
];
let _bgPromise = null;
function backgrounds() {
  if (!_bgPromise) {
    _bgPromise = Promise.all(
      BG_FILES.map((f) => loadImage(path.join(BG_DIR, f)).catch((e) => { console.error("bg load", f, e && e.message); return null; }))
    );
  }
  return _bgPromise;
}
function dayOfYear() {
  const now = new Date();
  return Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
}

// --- Rendered-PNG cache: the VOTD is identical for everyone each day, so this
// collapses thousands of shares into ~one render per verse+background. ---
const CACHE = new Map();
const CACHE_MAX = 400;
function cacheGet(k) { const v = CACHE.get(k); if (v) { CACHE.delete(k); CACHE.set(k, v); } return v; }
function cacheSet(k, v) { CACHE.set(k, v); if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value); }

function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/);
  const lines = []; let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; }
    else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

function drawCover(ctx, img, W, H) {
  const ir = img.width / img.height, cr = W / H;
  let dw, dh;
  if (ir > cr) { dh = H; dw = H * ir; } else { dw = W; dh = W / ir; }
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

export function renderVerse({ text, ref, translation, red, bg }) {
  const W = 1080, H = 1080;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Base gradient (also the fallback if the photo failed to load).
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#121828"); g.addColorStop(1, "#222c4e");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // Photo background + dark overlay for text legibility.
  if (bg) {
    drawCover(ctx, bg, W, H);
    const ov = ctx.createLinearGradient(0, 0, 0, H);
    ov.addColorStop(0, "rgba(12,12,30,0.42)");
    ov.addColorStop(0.5, "rgba(12,12,30,0.52)");
    ov.addColorStop(1, "rgba(10,10,26,0.82)");
    ctx.fillStyle = ov; ctx.fillRect(0, 0, W, H);
  }

  ctx.strokeStyle = "rgba(230,196,92,0.45)"; ctx.lineWidth = 3;
  ctx.strokeRect(46, 46, W - 92, H - 92);

  ctx.fillStyle = "rgba(230,196,92,0.20)";
  ctx.font = "240px VerseSerifB";
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillText("“", 70, 300);

  const maxW = 860, maxTextH = 540;
  let size = 76, lines, lh;
  while (size >= 30) {
    ctx.font = size + "px VerseSerif";
    lines = wrap(ctx, text, maxW);
    lh = Math.round(size * 1.34);
    if (lines.length * lh <= maxTextH) break;
    size -= 2;
  }

  ctx.textAlign = "center";
  // soft shadow so text reads over any photo
  ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = 12; ctx.shadowOffsetY = 2;
  ctx.fillStyle = red ? "#ff8178" : "#f7f2e2";
  ctx.font = size + "px VerseSerif";
  const blockH = lines.length * lh;
  let y = 460 - blockH / 2 + lh * 0.78;
  for (const ln of lines) { ctx.fillText(ln, W / 2, y); y += lh; }

  ctx.fillStyle = "#edc756";
  ctx.font = "46px VerseSerifB";
  ctx.fillText(ref, W / 2, 460 + blockH / 2 + 84);

  ctx.fillStyle = "#c3cadb";
  ctx.font = "30px VerseSerif";
  ctx.fillText(translation, W / 2, 460 + blockH / 2 + 132);
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

  // --- Footer: brand + store links ---
  ctx.strokeStyle = "rgba(230,196,92,0.4)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(W / 2 - 120, H - 184); ctx.lineTo(W / 2 + 120, H - 184); ctx.stroke();

  ctx.fillStyle = "rgba(237,199,86,0.95)";
  ctx.font = "27px VerseSerifB";
  ctx.fillText("B I B L E   S T U D Y   G E N I U S", W / 2, H - 140);

  ctx.fillStyle = "#eae6d6";
  ctx.font = "26px VerseSerif";
  ctx.fillText("Download free on Google Play & the App Store", W / 2, H - 100);

  ctx.fillStyle = "#aeb6cc";
  ctx.font = "22px VerseSerif";
  ctx.fillText("play.google.com/store/apps/details?id=com.biblestudygenius.app", W / 2, H - 62);

  return canvas.toBuffer("image/png");
}

export function mountVerseImage(app) {
  app.get("/verseimage", async (req, res) => {
    try {
      const text = String(req.query.text || "").slice(0, 1200).trim();
      const ref = String(req.query.ref || "").slice(0, 80).trim();
      const translation = String(req.query.tr || "").slice(0, 80).trim();
      const red = req.query.red === "1" || req.query.red === "true";
      if (!text) return res.status(400).json({ error: "missing text" });

      const bgs = await backgrounds();
      let bgIdx = parseInt(req.query.bg, 10);
      if (!Number.isFinite(bgIdx) || bgIdx < 0) bgIdx = dayOfYear() % BG_FILES.length;
      bgIdx = bgIdx % BG_FILES.length;
      const bgImg = bgs[bgIdx] || null;

      const key = `${bgIdx}|${red ? 1 : 0}|${translation}|${ref}|${text}`;
      let png = cacheGet(key);
      if (!png) { png = renderVerse({ text, ref, translation, red, bg: bgImg }); cacheSet(key, png); }

      res.set("Content-Type", "image/png");
      res.set("Cache-Control", "public, max-age=86400");
      res.send(png);
    } catch (e) {
      console.error("GET /verseimage", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
}
