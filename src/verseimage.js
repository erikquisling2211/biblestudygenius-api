/*
 * verseimage.js — shareable verse-image card for Bible Study Genius.
 * Wiring (src/index.js):
 *   import { mountVerseImage } from "./verseimage.js";
 *   mountVerseImage(app);
 * Endpoint:
 *   GET /verseimage?text=...&ref=John%203:16&tr=Berean%20Standard%20Bible&red=1  -> image/png
 */
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
GlobalFonts.registerFromPath(path.join(__dirname, "serif.ttf"), "VerseSerif");
GlobalFonts.registerFromPath(path.join(__dirname, "serif-bold.ttf"), "VerseSerifB");

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

export function renderVerse({ text, ref, translation, red }) {
  const W = 1080, H = 1080;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#121828"); g.addColorStop(1, "#222c4e");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = "rgba(230,196,92,0.45)"; ctx.lineWidth = 3;
  ctx.strokeRect(46, 46, W - 92, H - 92);

  ctx.fillStyle = "rgba(230,196,92,0.16)";
  ctx.font = "240px VerseSerifB";
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillText("“", 70, 300);

  const maxW = 860, maxTextH = 560;
  let size = 76, lines, lh;
  while (size >= 30) {
    ctx.font = size + "px VerseSerif";
    lines = wrap(ctx, text, maxW);
    lh = Math.round(size * 1.34);
    if (lines.length * lh <= maxTextH) break;
    size -= 2;
  }

  ctx.textAlign = "center";
  ctx.fillStyle = red ? "#f06a60" : "#f4eeda";
  ctx.font = size + "px VerseSerif";
  const blockH = lines.length * lh;
  let y = 470 - blockH / 2 + lh * 0.78;
  for (const ln of lines) { ctx.fillText(ln, W / 2, y); y += lh; }

  ctx.fillStyle = "#e6c45c";
  ctx.font = "46px VerseSerifB";
  ctx.fillText(ref, W / 2, 470 + blockH / 2 + 86);

  ctx.fillStyle = "#95a0c0";
  ctx.font = "30px VerseSerif";
  ctx.fillText(translation, W / 2, 470 + blockH / 2 + 134);

  ctx.strokeStyle = "rgba(230,196,92,0.4)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(W/2 - 120, H - 152); ctx.lineTo(W/2 + 120, H - 152); ctx.stroke();
  ctx.fillStyle = "rgba(230,196,92,0.92)";
  ctx.font = "27px VerseSerifB";
  ctx.fillText("B I B L E   S T U D Y   G E N I U S", W / 2, H - 108);
  ctx.fillStyle = "#9aa3bf";
  ctx.font = "italic 24px VerseSerif";
  ctx.fillText("Free on iOS & Android", W / 2, H - 66);

  return canvas.toBuffer("image/png");
}

export function mountVerseImage(app) {
  app.get("/verseimage", (req, res) => {
    try {
      const text = String(req.query.text || "").slice(0, 1200).trim();
      const ref = String(req.query.ref || "").slice(0, 80).trim();
      const translation = String(req.query.tr || "").slice(0, 80).trim();
      const red = req.query.red === "1" || req.query.red === "true";
      if (!text) return res.status(400).json({ error: "missing text" });
      const png = renderVerse({ text, ref, translation, red });
      res.set("Content-Type", "image/png");
      res.set("Cache-Control", "public, max-age=86400");
      res.send(png);
    } catch (e) {
      console.error("GET /verseimage", e);
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
}
