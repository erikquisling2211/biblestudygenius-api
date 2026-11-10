/*
 * ttspilot.js — AI-narration pilot (public-domain/free translations).
 * Generates audio in FLOWING CHUNKS (grouped verses, not per-verse, so the
 * narration doesn't fall on every verse), concatenates into chapter MP3s,
 * builds approximate verse timings, and uploads to R2. Nothing touches the app.
 *
 * Run from the backend dir (needs node_modules: openai, ffmpeg-static, @aws-sdk):
 *   cd ~/Desktop/biblestudygenius-api
 *   mkdir -p "$HOME/ttspilot-tmp"
 *   TMPDIR="$HOME/ttspilot-tmp" TTS_MODEL=tts-1-hd TTS_VOICE=onyx railway run node ttspilot.js 1
 *   # drop the trailing 1 to do all of John. Voices: alloy echo fable onyx nova shimmer
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import OpenAI from "openai";
import ffmpegPath from "ffmpeg-static";
import { uploadFileToR2, r2Configured } from "./src/r2.js";

const TRANSLATION = "bsb";
const BOOK = "john";
const VOICE = process.env.TTS_VOICE || "onyx";
const MODEL = process.env.TTS_MODEL || "tts-1";
const MAXCHARS = 3500; // under OpenAI's 4096 input limit, with margin

const BIBLE_JSON = path.join(os.homedir(), "Desktop/biblegenius-build1/lib/bible/dist", TRANSLATION, "books", `${BOOK}.json`);
const ONLY = process.argv[2] ? parseInt(process.argv[2], 10) : null;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("close", (code) => (code === 0 ? resolve(err) : reject(new Error(`${cmd} exit ${code}: ${err.slice(-300)}`))));
  });
}
async function durationSec(file) {
  const out = await run(ffmpegPath, ["-i", file, "-f", "null", "-"]).catch((e) => String(e));
  const m = out.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0;
}
async function tts(text, outFile) {
  const res = await openai.audio.speech.create({ model: MODEL, voice: VOICE, input: text });
  await fs.writeFile(outFile, Buffer.from(await res.arrayBuffer()));
}

// Group a chapter's verses into chunks up to MAXCHARS; track each verse's char offset within its chunk.
function buildChunks(verses) {
  const chunks = [];
  let cur = { text: "", verses: [] };
  for (const vs of verses) {
    const t = String(vs.t || "").trim();
    if (!t) continue;
    if (cur.text && cur.text.length + 1 + t.length > MAXCHARS) { chunks.push(cur); cur = { text: "", verses: [] }; }
    const startChar = cur.text ? cur.text.length + 1 : 0;
    cur.verses.push({ v: vs.v, startChar });
    cur.text += (cur.text ? " " : "") + t;
  }
  if (cur.text) chunks.push(cur);
  return chunks;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set (use `railway run`)");
  if (!r2Configured()) throw new Error("R2_* env not set (use `railway run`)");

  const book = JSON.parse(await fs.readFile(BIBLE_JSON, "utf8"));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ttspilot-"));
  let totalChars = 0;
  const urls = [];
  const chapters = book.chapters.filter((c) => (ONLY ? c.chapter === ONLY : true));
  console.log(`\n${book.name} (${TRANSLATION.toUpperCase()}) · ${MODEL}/${VOICE} · ${chapters.length} chapter(s)\n`);

  for (const ch of chapters) {
    const chDir = path.join(tmp, String(ch.chapter));
    await fs.mkdir(chDir, { recursive: true });
    const chunks = buildChunks(ch.verses);
    const files = [];
    const timings = [];
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      totalChars += chunk.text.length;
      process.stdout.write(`  ${book.name} ${ch.chapter}  chunk ${i + 1}/${chunks.length}   \r`);
      const cf = path.join(chDir, `c${i}.mp3`);
      await tts(chunk.text, cf);
      const dur = await durationSec(cf);
      for (const vinfo of chunk.verses) {
        const t = offset + (chunk.text.length ? (vinfo.startChar / chunk.text.length) * dur : 0);
        timings.push({ v: vinfo.v, t: Math.round(t * 100) / 100 });
      }
      offset += dur;
      files.push(cf);
    }
    const listFile = path.join(chDir, "list.txt");
    await fs.writeFile(listFile, files.map((f) => `file '${f}'`).join("\n"));
    const chapMp3 = path.join(chDir, `${ch.chapter}.mp3`);
    await run(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", chapMp3]);
    const timingsFile = path.join(chDir, `${ch.chapter}.timings.json`);
    await fs.writeFile(timingsFile, JSON.stringify({ translation: TRANSLATION, book: BOOK, chapter: ch.chapter, voice: VOICE, model: MODEL, timings }));
    const base = `audio/${TRANSLATION}/${BOOK}/${VOICE}/${ch.chapter}`;
    const audioUrl = await uploadFileToR2(chapMp3, `${base}.mp3`, "audio/mpeg");
    await uploadFileToR2(timingsFile, `${base}.timings.json`, "application/json");
    urls.push(audioUrl);
    console.log(`  ✅ ${book.name} ${ch.chapter}  (${Math.round(offset)}s, ${chunks.length} chunk(s))  ${audioUrl}`);
  }

  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  const est = (totalChars / 1_000_000) * (MODEL === "tts-1-hd" ? 30 : 15);
  console.log(`\nDone. ${totalChars.toLocaleString()} chars · est. cost ~$${est.toFixed(2)} (${MODEL})`);
  console.log(`\nListen: ${urls[0] || "(none)"}\n`);
}
main().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
