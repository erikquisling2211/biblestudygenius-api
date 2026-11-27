/**
 * churchpro.js — "Sermon Reach", what a church gets with the paid listing ($149/mo or $1,490/yr):
 * a suite of tools that turns the Sunday sermon into a full week of discipleship. Free directory
 * churches get none of this. "Pro" = churches.pro (set by admin) OR a Stripe subscription OR a dashboard login.
 *
 *  1. Small-group guide. Built from each sermon's transcript (theme, opener, 6 questions with leader
 *     notes, application, prayer) and emailed each Monday to the church's small-group leaders.
 *       GET  /church/:id/sermon/:sid/guide      printable guide page (public; linked from the app)
 *  2. Quote cards. 3 sentences quoted word-for-word from the sermon (checked against the transcript),
 *     rendered as 1080x1080 images for social media, with suggested captions.
 *       GET  /church/:id/sermon/:sid/quote/:n.png
 *     Staff get the cards + guide in a Monday "sermon kit" email and in the dashboard.
 *  3. Sermon search. GET /church/:id/search?q=  searches titles, summaries and transcripts.
 *  4. Featured placement. Pro churches come first (with a "Featured" tag) in church search, and a
 *     ZIP search lists churches within 25 miles. GET /churches/featured?zip= for the app's landing.
 *     The app reports "featured_view"; the dashboard shows how many people nearby saw the church.
 *  5. Visitor follow-up. A welcome email goes to the visitor right away (church's own wording,
 *     replies go to the church). Staff get a reminder if a visitor is still "new" after 2 days.
 *  7. Midweek email: the key verse, one question, and a link to the sermon quiz. Three ways, church's choice:
 *     a) copy it into their own email tool (in the Monday staff kit and the dashboard; no list shared),
 *     b) members sign up on the church's own page, shared as a link or QR code,
 *     c) the church pastes/uploads its member list in the dashboard. (b) and (c) are sent by us each Wednesday.
 *       GET  /church/:id/join               sign-up page;  GET /church/:id/join-qr.png  its QR code
 *       POST /church/:id/subscribe          the sign-up
 *       GET  /u/:token                      one-click unsubscribe (leaders and members)
 *
 *  Dashboard API (church login): GET /church/me/pro, POST /church/me/leaders, DELETE /church/me/leaders/:lid,
 *  POST /church/me/kit/rebuild, POST /church/me/kit/send-leaders, POST /church/me/welcome, POST /church/me/welcome/test
 *  Admin: POST /admin/church/:id/pro?on=1, POST /admin/church/:id/backfill-transcripts?limit=5,
 *         POST /admin/pro/run?job=kit|midweek|visitor-reminders
 */
import OpenAI from "openai";
import cron from "node-cron";
import crypto from "crypto";
import QRCode from "qrcode";
import ZIPS from "us-zips";
import { pool } from "./db.js";
import { renderVerse, backgrounds } from "./verseimage.js";
import { shareLinkFor } from "./smartlinks.js";
import { transcribeAudioUrl } from "./sermonprocess.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "missing" });
const API_BASE = (process.env.PUBLIC_API_URL || "https://biblestudygenius-api-production.up.railway.app").replace(/\/$/, "");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Every church with a dashboard login is a paid subscriber, so a login counts too (covers pilots set up by hand).
export const PRO_SQL = "(COALESCE(c.pro, false) OR c.stripe_subscription_id IS NOT NULL OR EXISTS (SELECT 1 FROM church_admins a WHERE a.church_id = c.id))";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const nameOf = (c) => (c && (c.display_name || c.name)) || "your church";

/* ---------------- schema ---------------- */
export async function initChurchPro() {
  const q = (s) => pool.query(s);
  await q(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS pro BOOLEAN NOT NULL DEFAULT false;`);
  await q(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS welcome_message TEXT;`);
  await q(`ALTER TABLE sermons ADD COLUMN IF NOT EXISTS kit JSONB;`);
  await q(`ALTER TABLE visitor_connects ADD COLUMN IF NOT EXISTS welcomed_at BIGINT;`);
  await q(`ALTER TABLE visitor_connects ADD COLUMN IF NOT EXISTS reminded_at BIGINT;`);
  await q(`CREATE TABLE IF NOT EXISTS church_group_leaders (
      id SERIAL PRIMARY KEY, church_id INTEGER NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
      name TEXT, email TEXT NOT NULL, token TEXT NOT NULL UNIQUE, unsub_at BIGINT, created_at BIGINT NOT NULL,
      UNIQUE (church_id, email));`);
  await q(`CREATE TABLE IF NOT EXISTS church_subscribers (
      id SERIAL PRIMARY KEY, church_id INTEGER NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
      email TEXT NOT NULL, anon_id TEXT, token TEXT NOT NULL UNIQUE, unsub_at BIGINT, created_at BIGINT NOT NULL,
      UNIQUE (church_id, email));`);
  // One row per email batch so a job that re-runs (deploy, restart, manual run) never sends twice.
  await q(`CREATE TABLE IF NOT EXISTS church_mail_log (
      id SERIAL PRIMARY KEY, church_id INTEGER NOT NULL, sermon_key TEXT NOT NULL, kind TEXT NOT NULL,
      recipients INTEGER NOT NULL DEFAULT 0, sent_at BIGINT NOT NULL, UNIQUE (church_id, sermon_key, kind));`);
  console.log("✅ Church pro tables ready");
}

export async function isPro(churchId) {
  try {
    const r = await pool.query(`SELECT ${PRO_SQL} AS pro FROM churches c WHERE c.id = $1`, [churchId]);
    return !!(r.rows[0] && r.rows[0].pro);
  } catch { return false; }
}

/* ---------------- email ---------------- */
// Off switch: Sermon Reach sends nothing until Railway has SERMON_STUDIO_EMAILS=on. While off, the weekly
// jobs still build each sermon's kit (so the dashboard shows it) but send and record nothing, so the first
// real week goes out normally once the switch is turned on.
export const emailsOn = () => process.env.SERMON_STUDIO_EMAILS === "on";
const EMAILS_OFF = "Sermon Reach emails are turned off for now.";
async function sendEmail({ to, subject, html, text, replyTo, fromName, unsubscribeUrl }) {
  if (!emailsOn()) { console.log(`✉️  (Sermon Reach emails off) not sending "${subject}"`); return false; }
  if (!process.env.RESEND_API_KEY) { console.log(`✉️  (no RESEND_API_KEY) would send "${subject}" to ${[].concat(to).join(", ")}`); return false; }
  const addr = (process.env.RESEND_FROM || "Bible Study Genius <hello@biblestudygenius.com>").match(/<([^>]+)>/);
  const from = fromName ? `${String(fromName).replace(/[<>"\r\n]/g, "").slice(0, 70)} <${addr ? addr[1] : "hello@biblestudygenius.com"}>` : (process.env.RESEND_FROM || "Bible Study Genius <hello@biblestudygenius.com>");
  const headers = unsubscribeUrl ? { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [].concat(to), subject, html, text, reply_to: replyTo || undefined, headers }),
    });
    if (!res.ok) console.error("email", res.status, (await res.text().catch(() => "")).slice(0, 200));
    return res.ok;
  } catch (e) { console.error("email", (e && e.message) || e); return false; }
}

async function staffEmails(churchId) {
  const r = await pool.query(
    `SELECT c.contact_email, (SELECT array_agg(a.email) FROM church_admins a WHERE a.church_id = c.id) AS admins
       FROM churches c WHERE c.id = $1`, [churchId]);
  const row = r.rows[0] || {};
  return [...new Set([row.contact_email, ...(row.admins || [])].filter(Boolean).map((e) => String(e).trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))].slice(0, 5);
}

function emailShell(church, inner, unsubUrl) {
  const color = /^#[0-9a-f]{6}$/i.test(church.brand_color || "") ? church.brand_color : "#9a7b1a";
  return `<!doctype html><html><body style="margin:0;background:#f6f3ec;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d1b38">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
<div style="background:#fff;border:1px solid #e6e1d4;border-radius:12px;overflow:hidden">
<div style="background:${color};color:#fff;padding:14px 20px;font-weight:700;font-size:15px">${esc(nameOf(church))}</div>
<div style="padding:20px 22px;line-height:1.55;font-size:15px">${inner}</div></div>
<p style="color:#8a8597;font-size:12px;text-align:center;margin-top:14px">Sent for ${esc(nameOf(church))} by Bible Study Genius.${unsubUrl ? ` <a href="${esc(unsubUrl)}" style="color:#8a8597">Unsubscribe</a>` : ""}</p>
</div></body></html>`;
}

/* ---------------- sermon kit (guide + quotes + midweek) ---------------- */
const KIT_PROMPT = `You help a church follow up on Sunday's sermon. Reply with JSON only:
{
 "guide": {
   "theme": "the sermon's big idea in one sentence",
   "opener": "one easy icebreaker question that leads into the theme",
   "passages": ["the main Bible passages the sermon preached on, e.g. 'Luke 15:11-32'"],
   "questions": [{"q": "discussion question", "leaderNote": "1-2 sentences to help the leader guide this question, drawn from what the sermon said"}],
   "application": "one practical challenge for the group this week",
   "prayer": "a short prayer focus for the group"
 },
 "quotes": ["exactly 3 memorable sentences COPIED WORD FOR WORD from the transcript, each 8 to 35 words, that would work on a social media image"],
 "captions": ["one short social media caption for each quote (no hashtags, under 25 words)"],
 "midweek": {"keyVerse": "the one verse reference that best sums up the sermon, e.g. 'Romans 8:28'", "question": "one personal reflection question for midweek"}
}
"questions" must have exactly 6 items that move from understanding the passage to personal application.
Stay faithful to what was preached. Never invent quotes, stories or claims the sermon did not make.`;

const normForMatch = (s) => String(s || "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

function cleanKit(raw, transcript) {
  const g = (raw && raw.guide) || {};
  const str = (v, n = 400) => String(v || "").trim().slice(0, n);
  const questions = (Array.isArray(g.questions) ? g.questions : []).map((x) =>
    typeof x === "string" ? { q: str(x), leaderNote: "" } : { q: str(x && (x.q || x.question)), leaderNote: str(x && (x.leaderNote || x.note), 600) }
  ).filter((x) => x.q).slice(0, 8);
  const hay = transcript ? normForMatch(transcript) : "";
  const rawQuotes = Array.isArray(raw && raw.quotes) ? raw.quotes : [];
  const rawCaps = Array.isArray(raw && raw.captions) ? raw.captions : [];
  const quotes = [];
  rawQuotes.forEach((qt, i) => {
    const text = str(qt, 300).replace(/^["“”']+|["“”']+$/g, "").trim();
    const n = normForMatch(text);
    const words = n.split(" ").length;
    // Only keep sentences the pastor actually said (word-for-word in the transcript).
    if (!hay || words < 6 || words > 45 || !hay.includes(n)) return;
    quotes.push({ text, caption: str(rawCaps[i], 200) });
  });
  const mw = (raw && raw.midweek) || {};
  return {
    guide: {
      theme: str(g.theme), opener: str(g.opener),
      passages: (Array.isArray(g.passages) ? g.passages : []).map((p) => str(p, 60)).filter(Boolean).slice(0, 4),
      questions, application: str(g.application, 500), prayer: str(g.prayer, 500),
    },
    quotes: quotes.slice(0, 3),
    midweek: { keyVerse: str(mw.keyVerse, 60), question: str(mw.question, 300) },
    builtAt: Date.now(),
  };
}

// Without a transcript (older sermons), fall back to what the study plan already has. No quotes.
function fallbackKit(s) {
  const qs = Array.isArray(s.questions) ? s.questions : [];
  return {
    guide: { theme: s.summary || "", opener: "", passages: Array.isArray(s.scriptures) ? s.scriptures.slice(0, 4) : [],
      questions: qs.map((q) => ({ q: String(q), leaderNote: "" })), application: "", prayer: "" },
    quotes: [], midweek: { keyVerse: (Array.isArray(s.scriptures) && s.scriptures[0]) || "", question: qs[0] || "" },
    builtAt: Date.now(), fallback: true,
  };
}

export async function buildKit(sermonId, { force = false } = {}) {
  const s = (await pool.query(`SELECT id, church_id, title, summary, scriptures, questions, transcript, kit FROM sermons WHERE id = $1`, [sermonId])).rows[0];
  if (!s) return null;
  if (s.kit && !force && !(s.kit.fallback && s.transcript)) return s.kit;
  let kit;
  if (!s.transcript || s.transcript.length < 500 || !process.env.OPENAI_API_KEY) kit = fallbackKit(s);
  else {
    for (let attempt = 1; attempt <= 2 && !kit; attempt++) {
      try {
        const r = await openai.chat.completions.create({
          model: "gpt-4o-mini", response_format: { type: "json_object" },
          messages: [{ role: "system", content: KIT_PROMPT }, { role: "user", content: `Sermon title: ${s.title || ""}\n\nTranscript:\n${s.transcript.slice(0, 48000)}` }],
        });
        const k = cleanKit(JSON.parse(r.choices[0].message.content || "{}"), s.transcript);
        if (k.guide.questions.length >= 3) kit = k;
        else console.error(`kit: too few questions (sermon ${sermonId}, attempt ${attempt})`);
      } catch (e) { console.error(`kit build sermon ${sermonId}`, (e && e.message) || e); }
    }
    if (!kit) kit = fallbackKit(s);
  }
  await pool.query(`UPDATE sermons SET kit = $1 WHERE id = $2`, [JSON.stringify(kit), sermonId]);
  return kit;
}

async function latestSermonRow(churchId, { withinDays = null } = {}) {
  const r = await pool.query(
    `SELECT id, church_id, title, sermon_date, sermon_ts, processed_at, summary, scriptures, questions, quiz, kit, transcript IS NOT NULL AS has_transcript
       FROM sermons WHERE church_id = $1 ORDER BY sermon_ts DESC NULLS LAST, processed_at DESC LIMIT 1`, [churchId]);
  const s = r.rows[0];
  if (!s) return null;
  if (withinDays != null && Number(s.processed_at) < Date.now() - withinDays * 86400000) return null;
  return s;
}
// Sermon ids change when a sermon is re-processed, so the mail log keys on church + date/title.
const sermonKey = (s) => `${s.sermon_date || ""}|${String(s.title || "").slice(0, 80)}`;

const joinUrl = (churchId) => `${API_BASE}/church/${churchId}/join`;
const joinQrUrl = (churchId) => `${API_BASE}/church/${churchId}/join-qr.png`;

/** The midweek email as a church can send it from its own email tool (no list shared with us). */
function midweekCopy(church, s, kit) {
  const appLink = shareLinkFor(church);
  const hasQuiz = Array.isArray(s.quiz) && s.quiz.length >= 3;
  const mw = (kit && kit.midweek) || {};
  const subject = `Midweek: ${mw.keyVerse ? mw.keyVerse + " · " : ""}${s.title || "Sunday's sermon"}`.slice(0, 140);
  const cta = hasQuiz ? "How much do you remember from Sunday? Take the 5-question sermon quiz and keep this week's study going in the Bible Study Genius app:" : "Keep this week's study going in the Bible Study Genius app:";
  const text = [`Midweek with Sunday's sermon: ${s.title || "this week's sermon"}`, "",
    mw.keyVerse ? `Key verse: ${mw.keyVerse}` : "", mw.question ? `Think about it: ${mw.question}` : "", "", cta, appLink]
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { subject, text, appLink };
}

const guideUrl = (churchId, sermonId) => `${API_BASE}/church/${churchId}/sermon/${sermonId}/guide`;
const quoteUrl = (churchId, sermonId, n) => `${API_BASE}/church/${churchId}/sermon/${sermonId}/quote/${n}.png`;

function guideHtmlBody(church, s, kit, { forEmail = false } = {}) {
  const g = kit.guide || {};
  const h = (t) => `<h3 style="font-size:15px;margin:22px 0 6px;color:#6d5612;text-transform:uppercase;letter-spacing:.04em">${t}</h3>`;
  return [
    `<h2 style="margin:0 0 4px;font-size:22px">${esc(s.title || "This week's sermon")}</h2>`,
    `<div style="color:#5b5878;font-size:14px">Small-group guide${s.sermon_date ? " · " + esc(fmtDay(s.sermon_date)) : ""}</div>`,
    g.theme ? `${h("The big idea")}<p style="margin:0">${esc(g.theme)}</p>` : "",
    g.passages && g.passages.length ? `${h("Read together")}<p style="margin:0">${g.passages.map(esc).join(" · ")}</p>` : "",
    g.opener ? `${h("Opener")}<p style="margin:0">${esc(g.opener)}</p>` : "",
    g.questions && g.questions.length ? `${h("Discussion")}<ol style="padding-left:20px;margin:0">${g.questions.map((q) =>
      `<li style="margin:0 0 12px"><div>${esc(q.q)}</div>${q.leaderNote ? `<div style="color:#5b5878;font-size:13px;margin-top:3px"><b>Leader note:</b> ${esc(q.leaderNote)}</div>` : ""}</li>`).join("")}</ol>` : "",
    g.application ? `${h("This week")}<p style="margin:0">${esc(g.application)}</p>` : "",
    g.prayer ? `${h("Pray")}<p style="margin:0">${esc(g.prayer)}</p>` : "",
    forEmail ? `<p style="margin:24px 0 0"><a href="${esc(guideUrl(church.id, s.id))}" style="color:#9a7b1a;font-weight:700">Open the printable guide →</a></p>` : "",
  ].join("");
}
function fmtDay(d) { const t = Date.parse(d); return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : String(d); }

/* ---------------- weekly jobs ---------------- */
async function proChurches() {
  return (await pool.query(`SELECT c.* FROM churches c WHERE c.active AND ${PRO_SQL} ORDER BY c.id`)).rows;
}
async function claimSend(churchId, key, kind) {
  const r = await pool.query(
    `INSERT INTO church_mail_log (church_id, sermon_key, kind, sent_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
    [churchId, key, kind, Date.now()]);
  return r.rows[0] ? r.rows[0].id : null;
}

export async function sendLeaderGuide(church, s, { force = false } = {}) {
  const kit = await buildKit(s.id);
  if (!emailsOn()) return { sent: 0, reason: EMAILS_OFF };
  const leaders = (await pool.query(`SELECT * FROM church_group_leaders WHERE church_id = $1 AND unsub_at IS NULL`, [church.id])).rows;
  if (!leaders.length) return { sent: 0, reason: "no leaders" };
  const logId = force ? null : await claimSend(church.id, sermonKey(s), "guide");
  if (!force && !logId) return { sent: 0, reason: "already sent" };
  const staff = await staffEmails(church.id);
  let sent = 0;
  for (const l of leaders) {
    const unsub = `${API_BASE}/u/${l.token}`;
    const hi = l.name ? `<p style="margin:0 0 14px">Hi ${esc(String(l.name).split(" ")[0])},</p>` : "";
    const ok = await sendEmail({
      to: l.email, fromName: nameOf(church), replyTo: staff[0], unsubscribeUrl: unsub,
      subject: `Small-group guide: ${s.title || "this week's sermon"}`,
      html: emailShell(church, hi + guideHtmlBody(church, s, kit, { forEmail: true }), unsub),
      text: `Small-group guide for "${s.title || "this week's sermon"}": ${guideUrl(church.id, s.id)}\n\nUnsubscribe: ${unsub}`,
    });
    if (ok) sent++;
  }
  if (logId) await pool.query(`UPDATE church_mail_log SET recipients = $1 WHERE id = $2`, [sent, logId]);
  return { sent };
}

async function sendStaffKit(church, s) {
  const logId = await claimSend(church.id, sermonKey(s), "kit");
  if (!logId) return { sent: 0, reason: "already sent" };
  const kit = await buildKit(s.id);
  const to = await staffEmails(church.id);
  if (!to.length) return { sent: 0, reason: "no staff email" };
  const dash = `${API_BASE}/church-dashboard`;
  const cards = (kit.quotes || []).map((qt, i) =>
    `<div style="margin:0 0 18px"><a href="${esc(quoteUrl(church.id, s.id, i + 1))}"><img src="${esc(quoteUrl(church.id, s.id, i + 1))}" width="260" height="260" alt="Quote card ${i + 1}" style="border-radius:8px;display:block"></a>
      <div style="font-size:13px;color:#5b5878;margin-top:6px">Caption idea: ${esc(qt.caption || qt.text)}</div></div>`).join("");
  const inner = `<p style="margin:0 0 2px;color:#9a7b1a;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">Sermon Reach</p>
    <h2 style="margin:0 0 6px;font-size:20px">This week's sermon kit</h2>
    <p style="margin:0 0 16px;color:#5b5878">Everything is ready from “${esc(s.title || "Sunday's sermon")}”.</p>
    <p style="margin:0 0 6px"><b>Small-group guide</b>: <a href="${esc(guideUrl(church.id, s.id))}" style="color:#9a7b1a">open / print</a>.</p>
    <p style="margin:0 0 18px;color:#5b5878;font-size:14px">${(await pool.query(`SELECT COUNT(*)::int AS n FROM church_group_leaders WHERE church_id=$1 AND unsub_at IS NULL`, [church.id])).rows[0].n
      ? "It went to your small-group leaders this morning." : "Add your small-group leaders in the dashboard and they'll get it every Monday."}</p>
    ${cards ? `<p style="margin:0 0 10px"><b>Quote cards for social media</b> (tap one to download):</p>${cards}` : ""}
    ${(() => { const mc = midweekCopy(church, s, kit); return `<p style="margin:22px 0 4px"><b>Midweek email, ready to send</b></p>
    <p style="margin:0 0 8px;color:#5b5878;font-size:14px">Copy this into the email tool you already use (Planning Center, Mailchimp, Flocknote…) and send it Wednesday morning.</p>
    <div style="border:1px solid #e7dfc8;border-radius:8px;padding:12px 14px;background:#fbf8ee;font-size:14px"><div style="color:#5b5878;font-size:12px;margin-bottom:6px">Subject: <b style="color:#1d1b38">${esc(mc.subject)}</b></div>${esc(mc.text).replace(/\n/g, "<br>")}</div>
    <p style="margin:12px 0 0;color:#5b5878;font-size:14px">Or let members sign themselves up and we'll send it for you: share <a href="${esc(joinUrl(church.id))}" style="color:#9a7b1a">your sign-up link</a> or <a href="${esc(joinQrUrl(church.id))}" style="color:#9a7b1a">QR code</a>.</p>`; })()}
    <p style="margin:18px 0 0"><a href="${esc(dash)}" style="color:#9a7b1a;font-weight:700">Open your dashboard →</a></p>`;
  const ok = await sendEmail({ to, subject: `Your sermon kit: ${s.title || "this week"}`, html: emailShell(church, inner), text: `Your sermon kit is ready: ${dash}` });
  await pool.query(`UPDATE church_mail_log SET recipients = $1 WHERE id = $2`, [ok ? to.length : 0, logId]);
  return { sent: ok ? to.length : 0 };
}

export async function runKitJob() {
  const out = [];
  for (const c of await proChurches()) {
    try {
      const s = await latestSermonRow(c.id, { withinDays: 8 });
      if (!s) { out.push({ church: c.id, skipped: "no new sermon" }); continue; }
      await buildKit(s.id);
      if (!emailsOn()) { out.push({ church: c.id, sermon: s.id, kitBuilt: true, emails: "off" }); continue; }
      const leaders = await sendLeaderGuide(c, s);
      const staff = await sendStaffKit(c, s);
      out.push({ church: c.id, sermon: s.id, leaders, staff });
    } catch (e) { out.push({ church: c.id, error: String((e && e.message) || e) }); console.error(`kit job church ${c.id}`, e); }
  }
  console.log("📦 Sermon kit job", JSON.stringify(out));
  return out;
}

export async function runMidweekJob() {
  if (!emailsOn()) { console.log("📨 Midweek job skipped (emails off)"); return [{ skipped: EMAILS_OFF }]; }
  const out = [];
  for (const c of await proChurches()) {
    try {
      const subs = (await pool.query(`SELECT * FROM church_subscribers WHERE church_id = $1 AND unsub_at IS NULL`, [c.id])).rows;
      if (!subs.length) { out.push({ church: c.id, skipped: "no subscribers" }); continue; }
      const s = await latestSermonRow(c.id, { withinDays: 10 });
      if (!s) { out.push({ church: c.id, skipped: "no recent sermon" }); continue; }
      const logId = await claimSend(c.id, sermonKey(s), "midweek");
      if (!logId) { out.push({ church: c.id, skipped: "already sent" }); continue; }
      const kit = await buildKit(s.id);
      const appLink = shareLinkFor(c);
      const hasQuiz = Array.isArray(s.quiz) && s.quiz.length >= 3;
      let sent = 0;
      for (const sub of subs) {
        const unsub = `${API_BASE}/u/${sub.token}`;
        const inner = `<p style="margin:0 0 4px;color:#5b5878;font-size:13px;text-transform:uppercase;letter-spacing:.05em">Midweek with Sunday's sermon</p>
          <h2 style="margin:0 0 14px;font-size:21px">${esc(s.title || "This week's sermon")}</h2>
          ${kit.midweek.keyVerse ? `<p style="margin:0 0 14px"><b>Key verse:</b> ${esc(kit.midweek.keyVerse)}</p>` : ""}
          ${kit.midweek.question ? `<div style="background:#faf5e6;border-left:3px solid #9a7b1a;padding:12px 14px;margin:0 0 16px"><b>Think about it:</b><br>${esc(kit.midweek.question)}</div>` : ""}
          <p style="margin:0 0 18px">${hasQuiz ? "How much do you remember from Sunday? Take the 5-question sermon quiz and keep this week's study going in the app." : "Keep this week's study going in the app."}</p>
          <p style="margin:0"><a href="${esc(appLink)}" style="display:inline-block;background:#9a7b1a;color:#fff;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:8px">${hasQuiz ? "Take the sermon quiz" : "Open this week's study"}</a></p>`;
        const ok = await sendEmail({
          to: sub.email, fromName: nameOf(c), unsubscribeUrl: unsub,
          subject: `Midweek: ${kit.midweek.keyVerse ? kit.midweek.keyVerse + " · " : ""}${s.title || "Sunday's sermon"}`.slice(0, 140),
          html: emailShell(c, inner, unsub),
          text: `${s.title || ""}\n${kit.midweek.keyVerse ? "Key verse: " + kit.midweek.keyVerse + "\n" : ""}${kit.midweek.question || ""}\n\n${appLink}\n\nUnsubscribe: ${unsub}`,
        });
        if (ok) sent++;
      }
      await pool.query(`UPDATE church_mail_log SET recipients = $1 WHERE id = $2`, [sent, logId]);
      out.push({ church: c.id, sermon: s.id, sent });
    } catch (e) { out.push({ church: c.id, error: String((e && e.message) || e) }); console.error(`midweek job church ${c.id}`, e); }
  }
  console.log("📨 Midweek job", JSON.stringify(out));
  return out;
}

/* ---------------- visitor follow-up ---------------- */
const DEFAULT_WELCOME = `Hi {name},

Thank you for letting us know you're planning to visit {church}{date}. We can't wait to meet you!

If you have any questions about service times, parking, or what to expect, just reply to this email and someone from our team will get back to you.

See you soon!`;

function fillWelcome(tpl, { name, church, visitDate }) {
  const first = String(name || "").trim().split(/\s+/)[0] || "there";
  const date = visitDate ? ` on ${new Date(visitDate + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })}` : "";
  return String(tpl || DEFAULT_WELCOME).replace(/\{name\}/g, first).replace(/\{church\}/g, church).replace(/\{date\}/g, date);
}

/** Called right after a Visitor Connect form is saved. Pro churches only, and only if the visitor gave an email. */
export async function welcomeVisitor(churchId, visitorId, v) {
  try {
    if (!emailsOn() || !v.email || !EMAIL_RE.test(v.email)) return false;
    const c = (await pool.query(`SELECT c.*, ${PRO_SQL} AS is_pro FROM churches c WHERE c.id = $1`, [churchId])).rows[0];
    if (!c || !c.is_pro) return false;
    const staff = await staffEmails(churchId);
    if (!staff.length) return false; // nobody would get the replies
    const body = fillWelcome(c.welcome_message, { name: v.name, church: nameOf(c), visitDate: v.visitDate });
    const ok = await sendEmail({
      to: v.email, fromName: nameOf(c), replyTo: staff[0],
      subject: `Welcome! We're glad you're coming to ${nameOf(c)}`.slice(0, 140),
      html: emailShell(c, esc(body).replace(/\n/g, "<br>")), text: body,
    });
    if (ok) await pool.query(`UPDATE visitor_connects SET welcomed_at = $1 WHERE id = $2`, [Date.now(), visitorId]);
    return ok;
  } catch (e) { console.error("welcomeVisitor", (e && e.message) || e); return false; }
}

export async function runVisitorReminders() {
  if (!emailsOn()) return [];
  const cutoff = Date.now() - 2 * 86400000, floor = Date.now() - 14 * 86400000;
  const rows = (await pool.query(
    `SELECT v.church_id, array_agg(v.id) AS ids, array_agg(v.name ORDER BY v.created_at) AS names
       FROM visitor_connects v JOIN churches c ON c.id = v.church_id
      WHERE v.status = 'new' AND v.reminded_at IS NULL AND v.created_at < $1 AND v.created_at > $2 AND c.active AND ${PRO_SQL}
      GROUP BY v.church_id`, [cutoff, floor])).rows;
  const out = [];
  for (const r of rows) {
    const c = (await pool.query(`SELECT * FROM churches WHERE id = $1`, [r.church_id])).rows[0];
    const to = await staffEmails(r.church_id);
    if (!to.length) continue;
    const list = r.names.map((n) => `<li>${esc(n)}</li>`).join("");
    const ok = await sendEmail({
      to, subject: `Reminder: ${r.names.length} visitor${r.names.length === 1 ? "" : "s"} still waiting to hear from you`,
      html: emailShell(c, `<p style="margin:0 0 10px">These people filled in “I’m New / Plan a Visit” more than two days ago and are still marked <b>new</b>:</p><ul>${list}</ul>
        <p>A quick call or note makes a big difference. Mark them “contacted” in your <a href="${API_BASE}/church-dashboard" style="color:#9a7b1a">dashboard</a> once someone has reached out.</p>`),
      text: `Visitors still waiting: ${r.names.join(", ")}. ${API_BASE}/church-dashboard`,
    });
    if (ok) await pool.query(`UPDATE visitor_connects SET reminded_at = $1 WHERE id = ANY($2::int[])`, [Date.now(), r.ids]);
    out.push({ church: r.church_id, visitors: r.names.length, ok });
  }
  if (out.length) console.log("🔔 Visitor reminders", JSON.stringify(out));
  return out;
}

/* ---------------- search ---------------- */
function snippetAround(text, terms) {
  const t = String(text || ""); const lower = t.toLowerCase();
  let idx = -1, len = 0;
  for (const term of terms) { const i = lower.indexOf(term); if (i >= 0 && (idx < 0 || i < idx)) { idx = i; len = term.length; } }
  if (idx < 0) return null;
  const start = Math.max(0, t.lastIndexOf(" ", Math.max(0, idx - 110)) + 1);
  const endRaw = Math.min(t.length, idx + len + 150);
  const end = t.indexOf(" ", endRaw) > 0 ? t.indexOf(" ", endRaw) : t.length;
  return { text: (start > 0 ? "…" : "") + t.slice(start, end).trim() + (end < t.length ? "…" : ""), pos: t.length ? idx / t.length : 0 };
}

export async function searchSermons(churchId, qRaw) {
  const q = String(qRaw || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (q.length < 2) return [];
  const words = q.toLowerCase().split(" ").filter((w) => w.length > 2 || /^\d+$/.test(w));
  const like = (s) => `%${s.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
  // Whole phrase first; if that finds nothing, sermons that contain every word.
  const run = async (conds, params) => (await pool.query(
    `SELECT id, title, sermon_date AS date, summary, transcript, sermon_ts
       FROM sermons WHERE church_id = $1 AND (${conds}) ORDER BY sermon_ts DESC NULLS LAST, processed_at DESC LIMIT 25`, [churchId, ...params])).rows;
  const field = (n) => `(COALESCE(title,'') || ' ' || COALESCE(summary,'') || ' ' || COALESCE(transcript,'')) ILIKE $${n}`;
  let rows = await run(field(2), [like(q)]);
  let terms = [q.toLowerCase()];
  if (!rows.length && words.length > 1) {
    rows = await run(words.map((_, i) => field(i + 2)).join(" AND "), words.map(like));
    terms = words;
  }
  return rows.map((r) => {
    const fromT = r.transcript ? snippetAround(r.transcript, terms) : null;
    const snip = fromT || snippetAround(r.summary, terms) || { text: r.summary ? String(r.summary).slice(0, 220) : "", pos: null };
    return { sermonId: r.id, title: r.title, date: r.date, snippet: snip.text, pos: fromT ? Math.round(fromT.pos * 1000) / 1000 : null };
  });
}

/* ---------------- nearby / featured ---------------- */
function milesBetween(a, b) {
  const toRad = (d) => (d * Math.PI) / 180, R = 3958.8;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
const zipPoint = (zip) => { const z = ZIPS[String(zip || "").slice(0, 5)]; return z ? { lat: z.latitude, lon: z.longitude } : null; };

/** Directory churches within `radius` miles of a ZIP: paid churches first ("featured"), then by distance. */
export async function churchesNearZip(zip, { radius = 25, proOnly = false, limit = 25 } = {}) {
  const origin = zipPoint(zip);
  if (!origin) return null;
  const rows = (await pool.query(
    `SELECT c.id, c.name, c.city, c.state, c.zip, c.denomination, c.website, c.lat, c.lon, ${PRO_SQL} AS featured
       FROM churches c WHERE c.active ${proOnly ? `AND ${PRO_SQL}` : ""}`)).rows;
  const out = [];
  for (const r of rows) {
    const p = r.lat != null && r.lon != null ? { lat: r.lat, lon: r.lon } : zipPoint(r.zip);
    if (!p) continue;
    const d = milesBetween(origin, p);
    if (d > radius) continue;
    const { lat, lon, ...rest } = r;
    out.push({ ...rest, distance: Math.round(d * 10) / 10 });
  }
  out.sort((a, b) => (b.featured - a.featured) || (a.distance - b.distance));
  return out.slice(0, limit);
}

/* ---------------- stats for the dashboard ---------------- */
export async function proStats(id) {
  const d30 = Date.now() - 30 * 86400000;
  const one = async (sql, params) => { try { return (await pool.query(sql, params)).rows[0] || {}; } catch { return {}; } };
  const [ev, subs, leaders, welcomed] = await Promise.all([
    one(`SELECT COUNT(DISTINCT anon_id) FILTER (WHERE type='featured_view' AND created_at > $2)::int AS seen30,
                COUNT(*) FILTER (WHERE type='sermon_search')::int AS searches,
                COUNT(*) FILTER (WHERE type='guide_open')::int AS guide_opens
           FROM sermon_events WHERE church_id = $1 AND type IN ('featured_view','sermon_search','guide_open')`, [id, d30]),
    one(`SELECT COUNT(*)::int AS n FROM church_subscribers WHERE church_id = $1 AND unsub_at IS NULL`, [id]),
    one(`SELECT COUNT(*)::int AS n FROM church_group_leaders WHERE church_id = $1 AND unsub_at IS NULL`, [id]),
    one(`SELECT COUNT(*)::int AS n FROM visitor_connects WHERE church_id = $1 AND welcomed_at IS NOT NULL`, [id]),
  ]);
  return {
    pro: await isPro(id),
    peopleNearbySawYouLast30: ev.seen30 || 0,
    sermonSearches: ev.searches || 0,
    leaderGuideOpens: ev.guide_opens || 0,
    midweekSubscribers: subs.n || 0,
    groupLeaders: leaders.n || 0,
    visitorsWelcomed: welcomed.n || 0,
  };
}

/* ---------------- routes ---------------- */
export function mountChurchPro(app, { admin, churchAuth }) {
  const err = (res, e, where) => { console.error(where, e); res.status(500).json({ error: String((e && e.message) || e) }); };
  const numId = (v) => (/^\d+$/.test(String(v)) ? parseInt(v, 10) : null);
  const newToken = () => crypto.randomBytes(18).toString("base64url");

  // Mondays 11:00 CT (the sermon pipeline runs at 6:00): kit to staff + guide to leaders.
  // Wednesdays 7:00 CT: midweek email. Every hour: visitor follow-up reminders.
  if (process.env.DISABLE_PRO_CRON !== "1") {
    cron.schedule("0 11 * * 1", () => { runKitJob().catch((e) => console.error("kit cron", e)); }, { timezone: "America/Chicago" });
    cron.schedule("0 7 * * 3", () => { runMidweekJob().catch((e) => console.error("midweek cron", e)); }, { timezone: "America/Chicago" });
    cron.schedule("17 * * * *", () => { runVisitorReminders().catch((e) => console.error("visitor reminder cron", e)); }, { timezone: "America/Chicago" });
    console.log("⏰ Church pro crons scheduled (kit Mon 11:00, midweek Wed 7:00 CT, visitor reminders hourly)");
  }

  // --- public: printable small-group guide ---
  app.get("/church/:id/sermon/:sid/guide", async (req, res) => {
    const id = numId(req.params.id), sid = numId(req.params.sid);
    if (!id || !sid) return res.status(404).send("not found");
    try {
      const c = (await pool.query(`SELECT c.*, ${PRO_SQL} AS is_pro FROM churches c WHERE c.id = $1 AND c.active`, [id])).rows[0];
      const s = (await pool.query(`SELECT * FROM sermons WHERE id = $1 AND church_id = $2`, [sid, id])).rows[0];
      if (!c || !s) return res.status(404).send("not found");
      if (!c.is_pro) return res.status(404).send("not found");
      const kit = await buildKit(s.id);
      res.set("Cache-Control", "public, max-age=600");
      res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.title || "Small-group guide")} · ${esc(nameOf(c))}</title><meta name="robots" content="noindex">
<style>body{margin:0;background:#faf7f0;color:#1d1b38;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.55}
.w{max-width:680px;margin:0 auto;padding:28px 18px 60px}.church{color:#9a7b1a;font-weight:700;font-size:14px;margin-bottom:10px}
.p{margin-top:28px}.p button{font:inherit;font-weight:700;border:0;border-radius:8px;padding:10px 16px;background:#9a7b1a;color:#fff;cursor:pointer}
@media print{.p{display:none}body{background:#fff}}</style></head><body><div class="w"><div class="church">${esc(nameOf(c))}</div>
${guideHtmlBody(c, s, kit)}<div class="p"><button onclick="window.print()">Print</button></div></div></body></html>`);
    } catch (e) { console.error("GET guide", e); res.status(500).send("error"); }
  });

  // --- public: quote card image ---
  const cardCache = new Map();
  app.get("/church/:id/sermon/:sid/quote/:n.png", async (req, res) => {
    const id = numId(req.params.id), sid = numId(req.params.sid), n = numId(req.params.n);
    if (!id || !sid || !n) return res.status(404).send("not found");
    try {
      const s = (await pool.query(`SELECT s.id, s.title, s.kit, c.name, c.display_name, ${PRO_SQL} AS is_pro
          FROM sermons s JOIN churches c ON c.id = s.church_id WHERE s.id = $1 AND s.church_id = $2`, [sid, id])).rows[0];
      if (!s || !s.is_pro) return res.status(404).send("not found");
      const kit = s.kit || await buildKit(sid);
      const qt = kit.quotes && kit.quotes[n - 1];
      if (!qt) return res.status(404).send("not found");
      const key = `${sid}|${n}|${kit.builtAt}`;
      let png = cardCache.get(key);
      if (!png) {
        const bgs = await backgrounds();
        png = renderVerse({ text: qt.text, ref: nameOf(s), translation: String(s.title || "").slice(0, 60), bg: bgs[(sid + n) % bgs.length] || null });
        cardCache.set(key, png);
        if (cardCache.size > 200) cardCache.delete(cardCache.keys().next().value);
      }
      res.set("Content-Type", "image/png");
      res.set("Cache-Control", "public, max-age=86400");
      if (req.query.download === "1") res.set("Content-Disposition", `attachment; filename="sermon-quote-${n}.png"`);
      res.send(png);
    } catch (e) { console.error("GET quote card", e); res.status(500).send("error"); }
  });

  // --- public: sermon search (paid churches) ---
  app.get("/church/:id/search", async (req, res) => {
    const id = numId(req.params.id);
    if (!id) return res.status(404).json({ error: "not found" });
    try {
      if (!(await isPro(id))) return res.status(404).json({ error: "not found", results: [] });
      res.set("Cache-Control", "public, max-age=300");
      res.json({ results: await searchSermons(id, req.query.q) });
    } catch (e) { err(res, e, "GET /church/:id/search"); }
  });

  // --- public: paid churches near a ZIP (the app's "Featured near you") ---
  app.get("/churches/featured", async (req, res) => {
    try {
      const list = await churchesNearZip(req.query.zip, { radius: 30, proOnly: true, limit: 5 });
      if (!list) return res.status(404).json({ error: "unknown zip", churches: [] });
      res.set("Cache-Control", "public, max-age=900");
      res.json({ churches: list });
    } catch (e) { err(res, e, "GET /churches/featured"); }
  });

  // --- public: midweek email sign-up ---
  const recentSubs = new Map();
  app.post("/church/:id/subscribe", async (req, res) => {
    const id = numId(req.params.id);
    if (!id) return res.status(404).json({ error: "not found" });
    const b = req.body || {};
    if (b.website) return res.json({ ok: true }); // honeypot
    const email = String(b.email || "").trim().toLowerCase().slice(0, 200);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "That email doesn't look right." });
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const now = Date.now(), hits = (recentSubs.get(ip) || []).filter((t) => now - t < 3600000);
    if (hits.length >= 10) return res.status(429).json({ error: "Please try again later." });
    hits.push(now); recentSubs.set(ip, hits); if (recentSubs.size > 5000) recentSubs.delete(recentSubs.keys().next().value);
    try {
      const c = (await pool.query(`SELECT c.*, ${PRO_SQL} AS is_pro FROM churches c WHERE c.id = $1 AND c.active`, [id])).rows[0];
      if (!c || !c.is_pro) return res.status(404).json({ error: "not found" });
      const r = await pool.query(
        `INSERT INTO church_subscribers (church_id, email, anon_id, token, created_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (church_id, email) DO UPDATE SET unsub_at = NULL RETURNING token, (xmax = 0) AS inserted`,
        [id, email, String(b.anonId || "").slice(0, 64) || null, newToken(), Date.now()]);
      res.json({ ok: true });
      if (r.rows[0] && r.rows[0].inserted) {
        const unsub = `${API_BASE}/u/${r.rows[0].token}`;
        sendEmail({ to: email, fromName: nameOf(c), unsubscribeUrl: unsub, subject: `You're signed up for ${nameOf(c)}'s midweek email`,
          html: emailShell(c, `<p style="margin:0">Thanks for signing up! Each Wednesday you'll get the key verse from Sunday's sermon, one question to think about, and a link to the sermon quiz.</p>`, unsub),
          text: `You're signed up. Each Wednesday you'll get the key verse from Sunday's sermon and one question. Unsubscribe: ${unsub}` }).catch(() => {});
      }
    } catch (e) { err(res, e, "POST /church/:id/subscribe"); }
  });

  // --- public: a church's own midweek email sign-up page (shared as a link or QR code; no list upload needed) ---
  app.get("/church/:id/join", async (req, res) => {
    const id = numId(req.params.id);
    try {
      const c = id && (await pool.query(`SELECT c.*, ${PRO_SQL} AS is_pro FROM churches c WHERE c.id = $1 AND c.active`, [id])).rows[0];
      if (!c || !c.is_pro) return res.status(404).type("html").send("<!doctype html><p style='font-family:sans-serif;padding:40px'>This sign-up page isn't available.</p>");
      const name = esc(nameOf(c));
      res.set("Cache-Control", "public, max-age=300");
      res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Midweek email · ${name}</title><meta name="robots" content="noindex">
<style>body{margin:0;background:#0f1424;color:#f4eeda;font:17px/1.55 -apple-system,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}
.card{max-width:440px;width:100%;background:#1d1c3a;border:1px solid rgba(230,196,92,.25);border-radius:18px;padding:30px 26px}
.k{color:#e6c45c;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}h1{font-family:Georgia,serif;font-weight:600;font-size:28px;line-height:1.15;margin:6px 0 12px}
ul{padding-left:20px;color:#c3cadb;margin:0 0 20px}input{width:100%;box-sizing:border-box;padding:13px 14px;border-radius:10px;border:1px solid rgba(230,196,92,.35);background:#0f1424;color:#f4eeda;font:inherit}
button{width:100%;margin-top:10px;padding:13px;border:0;border-radius:10px;background:#e6c45c;color:#241b05;font:700 16px inherit;cursor:pointer}button:disabled{opacity:.6}
.small{color:#9aa3b8;font-size:13px;margin-top:14px}.msg{margin-top:12px;font-weight:600}.hp{position:absolute;left:-9999px}a{color:#e6c45c}</style></head>
<body><main class="card"><div class="k">${name}</div><h1>Get the midweek email</h1>
<ul><li>The key verse from Sunday's sermon</li><li>One question to think about</li><li>A link to the sermon quiz</li></ul>
<form id="f"><input id="e" type="email" required placeholder="Your email address" autocomplete="email" aria-label="Email address"><input class="hp" id="w" tabindex="-1" autocomplete="off" aria-hidden="true">
<button id="b">Sign me up</button><div class="msg" id="m" role="status"></div></form>
<p class="small">One email each Wednesday, sent for ${name} by Bible Study Genius. We use your address only for this email. Every email has a one-click unsubscribe. <a href="https://biblestudygenius.com/privacy">Privacy</a></p></main>
<script>document.getElementById('f').onsubmit=function(ev){ev.preventDefault();var b=document.getElementById('b'),m=document.getElementById('m');b.disabled=true;m.textContent='';
fetch(${JSON.stringify(`/church/${id}/subscribe`)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('e').value,website:document.getElementById('w').value})})
.then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Something went wrong.');});})
.then(function(){document.getElementById('f').innerHTML='<p class="msg">You\u2019re signed up! Look for it on Wednesday morning.</p>';})
.catch(function(e){m.textContent=e.message;b.disabled=false;});};</script></body></html>`);
    } catch (e) { console.error("GET /church/:id/join", e); res.status(500).send("error"); }
  });
  app.get("/church/:id/join-qr.png", async (req, res) => {
    const id = numId(req.params.id);
    if (!id) return res.status(404).send("not found");
    try {
      const buf = await QRCode.toBuffer(joinUrl(id), { type: "png", width: 600, margin: 2, color: { dark: "#1b2340", light: "#ffffff" } });
      res.set("Cache-Control", "public, max-age=86400").type("png");
      if (req.query.download) res.set("Content-Disposition", `attachment; filename="midweek-email-signup-qr.png"`);
      res.send(buf);
    } catch (e) { console.error("GET join-qr", e); res.status(500).send("error"); }
  });

  // --- one-click unsubscribe (links in every email; POST is the mail apps' one-click) ---
  const unsubscribe = async (token) => {
    const t = String(token || "").slice(0, 64);
    const a = await pool.query(`UPDATE church_subscribers SET unsub_at = $1 WHERE token = $2 AND unsub_at IS NULL RETURNING id`, [Date.now(), t]);
    const b = await pool.query(`UPDATE church_group_leaders SET unsub_at = $1 WHERE token = $2 AND unsub_at IS NULL RETURNING id`, [Date.now(), t]);
    return a.rowCount + b.rowCount;
  };
  app.get("/u/:token", async (req, res) => {
    try { await unsubscribe(req.params.token); } catch (e) { console.error("unsubscribe", e); }
    res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:60px auto;padding:0 18px;color:#1d1b38"><h2>You're unsubscribed</h2><p>You won't get these emails anymore.</p></body>`);
  });
  app.post("/u/:token", async (req, res) => { try { await unsubscribe(req.params.token); res.json({ ok: true }); } catch (e) { err(res, e, "POST /u"); } });

  // --- dashboard ---
  app.get("/church/me/pro", churchAuth, async (req, res) => {
    const id = req.church.churchId;
    try {
      const c = (await pool.query(`SELECT c.*, ${PRO_SQL} AS is_pro FROM churches c WHERE c.id = $1`, [id])).rows[0];
      if (!c) return res.status(404).json({ error: "not found" });
      const leaders = (await pool.query(`SELECT id, name, email, unsub_at IS NOT NULL AS unsubscribed FROM church_group_leaders WHERE church_id = $1 ORDER BY created_at`, [id])).rows;
      const s = await latestSermonRow(id);
      let kit = null;
      if (s && c.is_pro) {
        const k = await buildKit(s.id);
        kit = { sermonId: s.id, title: s.title, date: s.sermon_date, guideUrl: guideUrl(id, s.id), theme: k.guide.theme, questions: k.guide.questions.length,
          quotes: (k.quotes || []).map((qt, i) => ({ ...qt, imageUrl: quoteUrl(id, s.id, i + 1) })), midweek: k.midweek, midweekCopy: midweekCopy(c, s, k), fallback: !!k.fallback };
      }
      const sent = (await pool.query(`SELECT kind, recipients, sent_at AS "sentAt" FROM church_mail_log WHERE church_id = $1 ORDER BY sent_at DESC LIMIT 12`, [id])).rows;
      res.set("Cache-Control", "no-store");
      res.json({ pro: !!c.is_pro, leaders, kit, sent, joinUrl: joinUrl(id), joinQrUrl: joinQrUrl(id), welcomeMessage: c.welcome_message || DEFAULT_WELCOME, ...(await proStats(id)) });
    } catch (e) { err(res, e, "GET /church/me/pro"); }
  });
  app.post("/church/me/leaders", churchAuth, async (req, res) => {
    const b = req.body || {};
    // Accept one leader or a pasted list ("Name <email>", "email", one per line or comma-separated).
    const raw = Array.isArray(b.leaders) ? b.leaders : String(b.text || [b.name, b.email].filter(Boolean).join(" ")).split(/[\n,;]+/);
    const parsed = raw.map((line) => {
      const s = typeof line === "string" ? line : `${line.name || ""} ${line.email || ""}`;
      const m = s.match(/[^\s<>"]+@[^\s<>"]+\.[^\s<>"]{2,}/);
      if (!m) return null;
      return { email: m[0].toLowerCase(), name: s.replace(m[0], "").replace(/[<>"]/g, "").trim().slice(0, 80) || null };
    }).filter(Boolean).slice(0, 200);
    if (!parsed.length) return res.status(400).json({ error: "Add at least one email address." });
    try {
      let added = 0;
      for (const l of parsed) {
        const r = await pool.query(
          `INSERT INTO church_group_leaders (church_id, name, email, token, created_at) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (church_id, email) DO UPDATE SET name = COALESCE(EXCLUDED.name, church_group_leaders.name), unsub_at = NULL RETURNING id`,
          [req.church.churchId, l.name, l.email, newToken(), Date.now()]);
        added += r.rowCount;
      }
      res.json({ ok: true, added });
    } catch (e) { err(res, e, "POST /church/me/leaders"); }
  });
  app.delete("/church/me/leaders/:lid", churchAuth, async (req, res) => {
    try {
      const r = await pool.query(`DELETE FROM church_group_leaders WHERE id = $1 AND church_id = $2`, [numId(req.params.lid), req.church.churchId]);
      if (!r.rowCount) return res.status(404).json({ error: "not found" });
      res.json({ ok: true });
    } catch (e) { err(res, e, "DELETE /church/me/leaders"); }
  });
  app.post("/church/me/kit/rebuild", churchAuth, async (req, res) => {
    try {
      if (!(await isPro(req.church.churchId))) return res.status(403).json({ error: "Part of Sermon Reach." });
      const s = await latestSermonRow(req.church.churchId);
      if (!s) return res.status(404).json({ error: "No sermon yet." });
      const kit = await buildKit(s.id, { force: true });
      res.json({ ok: true, quotes: kit.quotes.length, questions: kit.guide.questions.length });
    } catch (e) { err(res, e, "POST /church/me/kit/rebuild"); }
  });
  app.post("/church/me/kit/send-leaders", churchAuth, async (req, res) => {
    try {
      const c = (await pool.query(`SELECT c.*, ${PRO_SQL} AS is_pro FROM churches c WHERE c.id = $1`, [req.church.churchId])).rows[0];
      if (!c || !c.is_pro) return res.status(403).json({ error: "Part of Sermon Reach." });
      const s = await latestSermonRow(c.id);
      if (!s) return res.status(404).json({ error: "No sermon yet." });
      res.json({ ok: true, ...(await sendLeaderGuide(c, s, { force: true })) });
    } catch (e) { err(res, e, "POST /church/me/kit/send-leaders"); }
  });
  app.post("/church/me/welcome", churchAuth, async (req, res) => {
    const msg = String((req.body && req.body.message) || "").trim().slice(0, 3000);
    try {
      await pool.query(`UPDATE churches SET welcome_message = $1 WHERE id = $2`, [msg || null, req.church.churchId]);
      res.json({ ok: true, welcomeMessage: msg || DEFAULT_WELCOME });
    } catch (e) { err(res, e, "POST /church/me/welcome"); }
  });
  app.post("/church/me/welcome/test", churchAuth, async (req, res) => {
    try {
      const c = (await pool.query(`SELECT * FROM churches WHERE id = $1`, [req.church.churchId])).rows[0];
      const body = fillWelcome(c.welcome_message, { name: "Sam Visitor", church: nameOf(c), visitDate: new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10) });
      const ok = await sendEmail({ to: req.church.email, fromName: nameOf(c), subject: `[Test] Welcome! We're glad you're coming to ${nameOf(c)}`, html: emailShell(c, esc(body).replace(/\n/g, "<br>")), text: body });
      res.json({ ok, sentTo: req.church.email, error: emailsOn() ? undefined : EMAILS_OFF });
    } catch (e) { err(res, e, "POST /church/me/welcome/test"); }
  });

  // --- dashboard: the church's member email list for the midweek email (pasted or uploaded as CSV) ---
  // Someone who unsubscribed stays unsubscribed even if the church uploads their address again.
  const EMAILS_IN = /[^\s<>"',;]+@[^\s<>"',;]+\.[^\s<>"',;]{2,}/g;
  app.post("/church/me/members", churchAuth, async (req, res) => {
    const text = String((req.body && req.body.text) || "").slice(0, 2000000);
    const emails = [...new Set((text.match(EMAILS_IN) || []).map((e) => e.toLowerCase()).filter((e) => EMAIL_RE.test(e)))].slice(0, 20000);
    if (!emails.length) return res.status(400).json({ error: "We didn't find any email addresses in that." });
    try {
      let added = 0;
      for (let i = 0; i < emails.length; i += 500) {
        const chunk = emails.slice(i, i + 500);
        const vals = [], params = [];
        chunk.forEach((e, k) => { vals.push(`($1, $2, $${k * 2 + 3}, $${k * 2 + 4})`); params.push(e, newToken()); });
        const r = await pool.query(`INSERT INTO church_subscribers (church_id, created_at, email, token) VALUES ${vals.join(",")} ON CONFLICT (church_id, email) DO NOTHING`,
          [req.church.churchId, Date.now(), ...params]);
        added += r.rowCount;
      }
      const unsub = (await pool.query(`SELECT COUNT(*)::int AS n FROM church_subscribers WHERE church_id = $1 AND unsub_at IS NOT NULL AND email = ANY($2::text[])`, [req.church.churchId, emails])).rows[0].n;
      res.json({ ok: true, found: emails.length, added, alreadyOnList: emails.length - added - unsub, unsubscribed: unsub });
    } catch (e) { err(res, e, "POST /church/me/members"); }
  });
  app.post("/church/me/members/remove", churchAuth, async (req, res) => {
    const emails = (String((req.body && req.body.text) || "").match(EMAILS_IN) || []).map((e) => e.toLowerCase());
    if (!emails.length) return res.status(400).json({ error: "Add the email address to remove." });
    try {
      const r = await pool.query(`DELETE FROM church_subscribers WHERE church_id = $1 AND email = ANY($2::text[]) AND unsub_at IS NULL`, [req.church.churchId, emails]);
      res.json({ ok: true, removed: r.rowCount });
    } catch (e) { err(res, e, "POST /church/me/members/remove"); }
  });

  // --- admin ---
  app.post("/admin/church/:id/pro", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    try {
      const on = req.query.on !== "0";
      await pool.query(`UPDATE churches SET pro = $1 WHERE id = $2`, [on, numId(req.params.id)]);
      res.json({ ok: true, churchId: numId(req.params.id), pro: await isPro(numId(req.params.id)) });
    } catch (e) { err(res, e, "POST /admin/church/:id/pro"); }
  });
  // Transcribe a church's older sermons so they show up in sermon search (costs ~$0.25 per sermon).
  app.post("/admin/church/:id/backfill-transcripts", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 5));
    try {
      const rows = (await pool.query(`SELECT id, audio_url FROM sermons WHERE church_id = $1 AND transcript IS NULL AND audio_url IS NOT NULL
          ORDER BY sermon_ts DESC NULLS LAST LIMIT $2`, [numId(req.params.id), limit])).rows;
      const out = [];
      for (const r of rows) {
        try { const t = await transcribeAudioUrl(r.audio_url); await pool.query(`UPDATE sermons SET transcript = $1 WHERE id = $2`, [t, r.id]); out.push({ sermonId: r.id, chars: t.length }); }
        catch (e) { out.push({ sermonId: r.id, error: String((e && e.message) || e) }); }
      }
      res.json({ done: out.length, results: out });
    } catch (e) { err(res, e, "POST backfill-transcripts"); }
  });
  app.post("/admin/pro/run", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    try {
      const job = String(req.query.job || "");
      const out = job === "kit" ? await runKitJob() : job === "midweek" ? await runMidweekJob() : job === "visitor-reminders" ? await runVisitorReminders() : null;
      if (!out) return res.status(400).json({ error: "job must be kit, midweek or visitor-reminders" });
      res.json({ job, results: out });
    } catch (e) { err(res, e, "POST /admin/pro/run"); }
  });
}
