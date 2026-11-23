/**
 * claim.js — "claim your church" links for pastor outreach.
 *
 * Every church gets a secret claim token (churches.claim_token). Its claim link,
 *   https://sermons.biblestudygenius.com/claim/<token>
 * opens a small page where the pastor (or church office) creates the church's FIRST dashboard
 * login (email + password). After that the church is "claimed": the link only says so and
 * points to the dashboard login, so a forwarded link can't take over a church that already
 * has a login. The admin is emailed on every claim (ADMIN_ALERT_EMAIL, via Resend).
 *
 *   GET  /claim/:token     claim page (or "already claimed")
 *   POST /claim/:token     { name, email, password } → creates the login
 *
 * Admin (ADMIN_TOKEN):
 *   POST /admin/church/:id/claim-link/reset   new token (old link stops working)
 */
import crypto from "crypto";
import bcrypt from "bcryptjs";
import express from "express";
import { pool } from "./db.js";
import { SERMONS_SITE } from "./smartlinks.js";

const SITE_URL = (process.env.SITE_URL || "https://biblestudygenius.com").replace(/\/$/, "");
export const DASHBOARD_URL = `${SITE_URL}/dashboard`;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
const newToken = () => crypto.randomBytes(18).toString("base64url");

let migrated = null;
export function migrateClaims() {
  if (!migrated) {
    migrated = (async () => {
      await pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS claim_token TEXT;`);
      await pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS claimed_at BIGINT;`);
      await pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS claimed_by_name TEXT;`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS churches_claim_token_idx ON churches(claim_token);`);
    })().catch((e) => { migrated = null; throw e; });
  }
  return migrated;
}

export const claimLinkFor = (token) => `${SERMONS_SITE}/claim/${token}`;

/** Give every church without a claim token a new one. */
export async function ensureClaimTokens() {
  await migrateClaims();
  const r = await pool.query(`SELECT id FROM churches WHERE claim_token IS NULL`);
  for (const { id } of r.rows) {
    await pool.query(`UPDATE churches SET claim_token = $1 WHERE id = $2 AND claim_token IS NULL`, [newToken(), id]);
  }
  return r.rowCount;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)} · Bible Study Genius</title>
<style>
:root{--ink:#1b2340;--muted:#5a5f78;--gold:#b8901f;--goldbg:#c9a227;--line:#e3dfd3;--bg:#faf7f0;--card:#fff;--err:#a12a2a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5}
.wrap{max-width:460px;margin:0 auto;padding:40px 16px 60px}.brand{font-weight:700;color:var(--gold);letter-spacing:.02em;margin-bottom:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}h1{font-size:24px;margin:0 0 8px}p{margin:0 0 14px;color:var(--muted)}
label{display:block;font-size:14px;font-weight:600;margin:14px 0 6px}input{width:100%;font:inherit;padding:11px 12px;border:1px solid #cfcab9;border-radius:10px;background:#fff;color:var(--ink)}
input:focus{outline:2px solid var(--goldbg);outline-offset:1px}button,.btn{display:block;width:100%;text-align:center;margin-top:20px;padding:13px;border:0;border-radius:10px;background:var(--goldbg);color:var(--ink);font:inherit;font-weight:700;text-decoration:none;cursor:pointer}
.err{background:#fbeaea;color:var(--err);border-radius:10px;padding:10px 12px;margin:0 0 12px;font-size:14px}.small{font-size:13px;color:var(--muted);margin-top:14px}
ul{color:var(--muted);padding-left:20px;margin:0 0 14px}
</style></head><body><div class="wrap"><div class="brand">Bible Study Genius</div><div class="card">${body}</div></div></body></html>`;
}

function claimForm(church, token, { error = "", name = "", email = "" } = {}) {
  const cname = esc(church.church_name);
  return page(`Claim ${church.church_name}`, `
<h1>Claim ${cname}</h1>
<p>${cname} is already in the Bible Study Genius app. Each week your sermon becomes a study plan, quiz and audio for your congregation.</p>
<p>Create your dashboard login to:</p>
<ul><li>see how your congregation uses each sermon</li><li>add your logo, events and giving link</li><li>get your church's QR code and share link</li></ul>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<form method="post" action="/claim/${esc(token)}">
<label for="name">Your name</label><input id="name" name="name" autocomplete="name" required maxlength="100" value="${esc(name)}">
<label for="email">Email (your login)</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="200" value="${esc(email)}">
<label for="password">Choose a password</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="200">
<button type="submit">Claim ${cname}</button>
</form>
<p class="small">Questions? Email <a href="mailto:support@biblestudygenius.com">support@biblestudygenius.com</a>.</p>`);
}

const alreadyClaimed = (church) => page("Already claimed", `
<h1>${esc(church.church_name)} is already claimed</h1>
<p>Someone from your church already has a dashboard login. Sign in with that email, or ask them to share access.</p>
<a class="btn" href="${esc(DASHBOARD_URL)}">Go to the dashboard</a>
<p class="small">Need help? Email <a href="mailto:support@biblestudygenius.com">support@biblestudygenius.com</a>.</p>`);

const notFound = () => page("Link not found", `<h1>This link isn't valid</h1><p>It may have been replaced by a newer link. Email <a href="mailto:support@biblestudygenius.com">support@biblestudygenius.com</a> and we'll send you a new one.</p>`);

async function churchByToken(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ""))) return null;
  await migrateClaims();
  const r = await pool.query(
    `SELECT c.id, COALESCE(NULLIF(c.display_name,''), c.name) AS church_name, c.claimed_at,
            EXISTS (SELECT 1 FROM church_admins a WHERE a.church_id = c.id) AS has_login
       FROM churches c WHERE c.claim_token = $1`, [token]);
  return r.rows[0] || null;
}

async function sendClaimAlert({ church, name, email }) {
  if (!process.env.RESEND_API_KEY) return false;
  const from = process.env.RESEND_FROM || "Bible Study Genius <hello@biblestudygenius.com>";
  const to = process.env.ADMIN_ALERT_EMAIL;
  if (!to) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject: `Church claimed: ${church.church_name}`,
        text: `${church.church_name} (church #${church.id}) was just claimed.\n\nName: ${name}\nEmail: ${email}\n\nThey can now sign in at ${DASHBOARD_URL}.` }),
    });
    return r.ok;
  } catch (e) { console.error("sendClaimAlert", (e && e.message) || e); return false; }
}

// Light per-IP throttle on claim attempts (in memory; resets on deploy).
const attempts = new Map();
function throttled(ip) {
  const now = Date.now(), win = 15 * 60 * 1000;
  const list = (attempts.get(ip) || []).filter((t) => now - t < win);
  list.push(now); attempts.set(ip, list);
  if (attempts.size > 5000) attempts.clear();
  return list.length > 20;
}

export function mountClaims(app, { admin }) {
  migrateClaims().catch((e) => console.error("claim migrate", e.message));
  const form = express.urlencoded({ extended: false, limit: "10kb" });
  const noStore = (res) => { res.set("Cache-Control", "no-store"); res.set("X-Robots-Tag", "noindex"); res.type("html"); };

  app.get("/claim/:token", async (req, res) => {
    noStore(res);
    try {
      const c = await churchByToken(req.params.token);
      if (!c) return res.status(404).send(notFound());
      if (c.has_login) return res.send(alreadyClaimed(c));
      res.send(claimForm(c, req.params.token));
    } catch (e) { console.error("GET /claim", e); res.status(500).send(page("Error", "<h1>Something went wrong</h1><p>Please try again in a minute.</p>")); }
  });

  app.post("/claim/:token", form, async (req, res) => {
    noStore(res);
    const token = req.params.token;
    const name = String(req.body?.name || "").trim().slice(0, 100);
    const email = String(req.body?.email || "").trim().toLowerCase().slice(0, 200);
    const password = String(req.body?.password || "");
    try {
      if (throttled(String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip)) return res.status(429).send(page("Slow down", "<h1>Too many tries</h1><p>Please wait a few minutes and try again.</p>"));
      const c = await churchByToken(token);
      if (!c) return res.status(404).send(notFound());
      if (c.has_login) return res.send(alreadyClaimed(c));
      if (!name) return res.status(400).send(claimForm(c, token, { error: "Please enter your name.", name, email }));
      if (!EMAIL_RE.test(email)) return res.status(400).send(claimForm(c, token, { error: "Please enter a valid email address.", name, email }));
      if (password.length < 8) return res.status(400).send(claimForm(c, token, { error: "Please choose a password of at least 8 characters.", name, email }));

      const hash = await bcrypt.hash(password, 10);
      const client = await pool.connect();
      let outcome;
      try {
        await client.query("BEGIN");
        // Lock the church row so two simultaneous claims can't both succeed.
        await client.query(`SELECT id FROM churches WHERE id = $1 FOR UPDATE`, [c.id]);
        const has = await client.query(`SELECT 1 FROM church_admins WHERE church_id = $1 LIMIT 1`, [c.id]);
        const taken = await client.query(`SELECT church_id FROM church_admins WHERE email = $1`, [email]);
        if (has.rowCount) outcome = "claimed";
        else if (taken.rowCount) outcome = "email_taken";
        else {
          await client.query(`INSERT INTO church_admins (church_id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)`, [c.id, email, hash, Date.now()]);
          await client.query(
            `UPDATE churches SET claimed_at = $2, claimed_by_name = $3,
                    pastor_email = COALESCE(NULLIF(pastor_email, ''), $4) WHERE id = $1`,
            [c.id, Date.now(), name, email]);
          outcome = "ok";
        }
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
      finally { client.release(); }

      if (outcome === "claimed") return res.send(alreadyClaimed(c));
      if (outcome === "email_taken") return res.status(409).send(claimForm(c, token, { error: "That email already has a Bible Study Genius dashboard login. Please use a different email, or contact support@biblestudygenius.com.", name, email: "" }));
      console.log(`⛪ Church ${c.id} (${c.church_name}) claimed by ${email}`);
      sendClaimAlert({ church: c, name, email }).catch(() => {});
      res.send(page(`${c.church_name} claimed`, `
<h1>You're all set!</h1>
<p>${esc(c.church_name)} is now yours to manage. Sign in to your dashboard with <strong>${esc(email)}</strong> and the password you just chose.</p>
<a class="btn" href="${esc(DASHBOARD_URL)}">Go to your dashboard</a>`));
    } catch (e) { console.error("POST /claim", e); res.status(500).send(page("Error", "<h1>Something went wrong</h1><p>Please try again in a minute.</p>")); }
  });

  app.post("/admin/church/:id/claim-link/reset", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    const id = parseInt(req.params.id, 10);
    try {
      await migrateClaims();
      const token = newToken();
      const r = await pool.query(`UPDATE churches SET claim_token = $2 WHERE id = $1 RETURNING id`, [id, token]);
      if (!r.rowCount) return res.status(404).json({ error: "not found" });
      res.json({ churchId: id, claim_link: claimLinkFor(token) });
    } catch (e) { console.error("claim-link reset", e); res.status(500).json({ error: "server error" }); }
  });
}
