/*
 * narrate.js — self-produced chapter narration for PUBLIC-DOMAIN translations.
 * (Generalized, resumable successor to ttspilot.js.)
 *
 * For each chapter: build natural prose from the bundled translation JSON
 * (verse numbers/markup are never included; omitted verses are skipped),
 * split into <4096-char chunks on sentence boundaries, generate one MP3 per
 * chunk with OpenAI TTS, concatenate into a single chapter MP3, compute
 * approximate verse timings, and upload to R2:
 *
 *   audio/<translation>/<bookId>/<chapter>.mp3
 *   audio/<translation>/<bookId>/<chapter>.timings.json
 *
 * Idempotent: a chapter whose MP3 already exists in R2 is skipped, so a re-run
 * never re-pays. The MP3 is uploaded LAST, so its presence means the chapter
 * (timings included) is complete.
 *
 * Usage (from this dir; Railway provides OPENAI_API_KEY + R2_* env):
 *   railway run node narrate.js --translation web --voice fable --model tts-1
 *   options: --book <bookId>  --chapter <n>  --concurrency <n>  --dry-run
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import OpenAI from "openai";
import ffmpegPath from "ffmpeg-static";
import { uploadFileToR2, r2Configured, r2Exists } from "./src/r2.js";

// Licensed translations: publishers prohibit TTS renderings. Never narrate these.
const LICENSED_NO_TTS = new Set(["esv", "nlt", "nkjv", "nasb"]);
const MAXCHARS = 4000; // OpenAI TTS input cap is 4096
const PRICE_PER_M = { "tts-1": 15, "tts-1-hd": 30 };

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const TRANSLATION = String(arg("translation", "")).toLowerCase();
const VOICE = String(arg("voice", "fable"));
const MODEL = String(arg("model", "tts-1"));
const ONLY_BOOK = arg("book", null);
const ONLY_CHAPTER = arg("chapter", null) ? parseInt(arg("chapter"), 10) : null;
const CONCURRENCY = parseInt(arg("concurrency", "4"), 10);
const DRY = !!arg("dry-run", false);

const BIBLE_DIR = path.join(os.homedir(), "Desktop/biblegenius-build1/lib/bible/dist", TRANSLATION, "books");

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
  const all = [...out.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)];
  const m = all.length ? all[all.length - 1] : out.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0;
}

/** Clean a verse into plain readable prose (defensive: WEB JSON is already plain). */
function clean(t) {
  return String(t || "")
    .replace(/<[^>]*>/g, " ")       // any markup
    .replace(/\[[^\]]*\]/g, " ")    // bracketed notes
    .replace(/[¶*#|\\{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Chapter text + each verse's char offset within it. */
function chapterProse(ch) {
  let text = "";
  const verses = [];
  for (const vs of ch.verses) {
    if (vs.omit) continue;
    const t = clean(vs.t);
    if (!t) continue;
    if (text) text += " ";
    verses.push({ v: vs.v, at: text.length });
    text += t;
  }
  return { text, verses };
}

/** Split [0,len) into chunks <= MAXCHARS, breaking after sentence ends where possible. */
function chunkRanges(text) {
  const ranges = [];
  let start = 0;
  while (start < text.length) {
    if (text.length - start <= MAXCHARS) { ranges.push([start, text.length]); break; }
    const window = text.slice(start, start + MAXCHARS);
    // last sentence end: . ? ! ; optionally followed by closing quotes/parens, then a space
    let cut = -1;
    const re = /[.?!;][”’"')\]]*\s/g;
    let m;
    while ((m = re.exec(window))) cut = m.index + m[0].length;
    if (cut < MAXCHARS * 0.5) { // no good sentence break; fall back to clause, then word
      const c2 = Math.max(window.lastIndexOf(", "), window.lastIndexOf(": "));
      cut = c2 > MAXCHARS * 0.5 ? c2 + 2 : window.lastIndexOf(" ") + 1;
    }
    if (cut <= 0) cut = MAXCHARS;
    ranges.push([start, start + cut]);
    start += cut;
  }
  return ranges.map(([a, b]) => [a, b, text.slice(a, b).trim()]).filter((r) => r[2]);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
async function tts(text, outFile) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await openai.audio.speech.create({ model: MODEL, voice: VOICE, input: text, response_format: "mp3" });
      await fs.writeFile(outFile, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (e) {
      const status = e?.status;
      if (attempt >= 6 || (status && status < 500 && status !== 429)) throw e;
      const wait = Math.min(60000, 2000 * 2 ** (attempt - 1));
      console.log(`    retry ${attempt} after ${status || e.message} (${wait / 1000}s)`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

let spentChars = 0, done = 0, skipped = 0, failed = 0;
const cost = (chars) => (chars / 1_000_000) * (PRICE_PER_M[MODEL] ?? 15);

async function narrateChapter(book, ch, tmpRoot, total) {
  const base = `audio/${TRANSLATION}/${book.id}/${ch.chapter}`;
  const label = `${book.name} ${ch.chapter}`;
  if (await r2Exists(`${base}.mp3`)) { skipped++; return; }
  const { text, verses } = chapterProse(ch);
  if (!text) { console.log(`  – ${label}: no text, skipped`); return; }
  const ranges = chunkRanges(text);
  if (DRY) { spentChars += text.length; console.log(`  [dry] ${label}: ${text.length} chars, ${ranges.length} chunk(s)`); return; }

  const dir = await fs.mkdtemp(path.join(tmpRoot, `${book.id}-${ch.chapter}-`));
  try {
    const files = [], timings = [];
    let offset = 0, vi = 0;
    for (let i = 0; i < ranges.length; i++) {
      const [a, b, chunk] = ranges[i];
      const cf = path.join(dir, `c${i}.mp3`);
      await tts(chunk, cf);
      spentChars += chunk.length;
      const dur = await durationSec(cf);
      while (vi < verses.length && verses[vi].at < b) {
        const rel = Math.max(0, verses[vi].at - a) / Math.max(1, b - a);
        timings.push({ v: verses[vi].v, t: Math.round((offset + rel * dur) * 100) / 100 });
        vi++;
      }
      offset += dur;
      files.push(cf);
    }
    const chapMp3 = path.join(dir, "chapter.mp3");
    if (files.length === 1) await fs.copyFile(files[0], chapMp3);
    else {
      const listFile = path.join(dir, "list.txt");
      await fs.writeFile(listFile, files.map((f) => `file '${f}'`).join("\n"));
      await run(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", chapMp3]);
    }
    const timingsFile = path.join(dir, "timings.json");
    await fs.writeFile(timingsFile, JSON.stringify({ translation: TRANSLATION, book: book.id, chapter: ch.chapter, voice: VOICE, model: MODEL, duration: Math.round(offset * 100) / 100, timings }));
    await uploadFileToR2(timingsFile, `${base}.timings.json`, "application/json");
    await uploadFileToR2(chapMp3, `${base}.mp3`, "audio/mpeg"); // last = completion marker
    done++;
    console.log(`  ✅ ${label}  ${Math.round(offset)}s, ${ranges.length} chunk(s)  [${done + skipped}/${total} · new ${done} · ~$${cost(spentChars).toFixed(2)}]`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  if (!TRANSLATION) throw new Error("--translation is required");
  if (LICENSED_NO_TTS.has(TRANSLATION)) throw new Error(`${TRANSLATION} is a licensed translation; TTS narration is prohibited`);
  if (!DRY && !process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set (use `railway run`)");
  if (!r2Configured()) throw new Error("R2_* env not set (use `railway run`)");

  const files = (await fs.readdir(BIBLE_DIR)).filter((f) => f.endsWith(".json"));
  const books = [];
  for (const f of files) {
    const b = JSON.parse(await fs.readFile(path.join(BIBLE_DIR, f), "utf8"));
    if (ONLY_BOOK && b.id !== ONLY_BOOK) continue;
    books.push(b);
  }
  books.sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
  const jobs = [];
  for (const b of books) for (const ch of b.chapters) {
    if (ONLY_CHAPTER && ch.chapter !== ONLY_CHAPTER) continue;
    jobs.push([b, ch]);
  }
  console.log(`\n${TRANSLATION.toUpperCase()} · ${MODEL}/${VOICE} · ${books.length} book(s), ${jobs.length} chapter(s) · concurrency ${CONCURRENCY}${DRY ? " · DRY RUN" : ""}\n`);

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "narrate-"));
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [b, ch] = jobs[next++];
      try { await narrateChapter(b, ch, tmpRoot, jobs.length); }
      catch (e) { failed++; console.log(`  ❌ ${b.name} ${ch.chapter}: ${e?.message || e}`); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  console.log(`\nDone. new ${done} · skipped (already in R2) ${skipped} · failed ${failed} · ${spentChars.toLocaleString()} chars · ~$${cost(spentChars).toFixed(2)} (${MODEL})`);
  if (failed) { console.log("Re-run the same command to retry failures (completed chapters are skipped)."); process.exit(1); }
}
main().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
