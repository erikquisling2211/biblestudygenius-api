/**
 * outreach.js — per-church outreach list for the Lovable → Brevo email pipeline.
 *
 * Every active church gets:
 *   demo_link     its smart link (smartlinks.js): https://sermons.biblestudygenius.com/c/:id
 *                 opens the church in the app, or carries it through install (Play referrer
 *                 "church_<id>" / iOS "bsg-church:<id>" clipboard hand-off)
 *   qr_image_url  a PNG QR code of demo_link, served by GET /church/:id/qr.png on our own domain
 *                 (generated on request, cached by browsers/CDNs and email image proxies)
 * Both are stored on the church row. Churches added later get them on create (ensureSmartLink)
 * and, as a safety net, on the next request to the endpoints below.
 *
 * Endpoints (protected: header "x-api-key: <OUTREACH_API_KEY>"; CSV also accepts ?key=):
 *   GET  /churches/outreach        { count, churches: [{ church_id, church_name, pastor_name,
 *                                    pastor_email, latest_sermon_title, demo_link, qr_image_url,
 *                                    city, state }] }
 *                                  ?with_email=1 → only churches that have a pastor email
 *   GET  /churches/outreach.csv    same rows as CSV
 *
 * Admin (ADMIN_TOKEN):
 *   POST /admin/churches/pastors   [{ church_id, pastor_name?, pastor_email? }, …] → fill pastor info
 *
 * pastor_name  = churches.pastor_name, else the preacher of the latest sermon
 * pastor_email = churches.pastor_email, else churches.contact_email, else the first dashboard admin
 */
import crypto from "crypto";
import { pool } from "./db.js";
import { SERMONS_SITE, smartLinkUrl, qrImageUrl, migrateSmartLinks } from "./smartlinks.js";

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = (async () => {
      await migrateSmartLinks();
      await pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS pastor_name TEXT;`);
      await pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS pastor_email TEXT;`);
    })().catch((e) => { migrated = null; throw e; });
  }
  return migrated;
}

/** Store demo link + QR URL on every active church that is missing them (or has stale ones). */
export async function backfillOutreachLinks() {
  await migrate();
  const r = await pool.query(
    `UPDATE churches
        SET smart_link   = $1 || '/c/' || id,
            qr_image_url = $1 || '/church/' || id || '/qr.png'
      WHERE smart_link IS DISTINCT FROM $1 || '/c/' || id
         OR qr_image_url IS DISTINCT FROM $1 || '/church/' || id || '/qr.png'
     RETURNING id`,
    [SERMONS_SITE]
  );
  return r.rowCount;
}

export async function outreachRows({ withEmail = false } = {}) {
  await backfillOutreachLinks();
  const r = await pool.query(
    `SELECT c.id, COALESCE(NULLIF(c.display_name, ''), c.name) AS church_name, c.city, c.state,
            c.smart_link, c.qr_image_url,
            COALESCE(NULLIF(c.pastor_name, ''), ls.preacher) AS pastor_name,
            COALESCE(NULLIF(c.pastor_email, ''), NULLIF(c.contact_email, ''),
                     (SELECT a.email FROM church_admins a WHERE a.church_id = c.id ORDER BY a.created_at, a.id LIMIT 1)) AS pastor_email,
            ls.title AS latest_sermon_title
       FROM churches c
       LEFT JOIN LATERAL (
         SELECT s.title, NULLIF(s.preacher, '') AS preacher FROM sermons s
          WHERE s.church_id = c.id ORDER BY s.sermon_ts DESC NULLS LAST, s.processed_at DESC LIMIT 1
       ) ls ON true
      WHERE c.active
      ORDER BY church_name`
  );
  return r.rows
    .map((c) => ({
      church_id: c.id,
      church_name: c.church_name || "",
      pastor_name: c.pastor_name || "",
      pastor_email: c.pastor_email || "",
      latest_sermon_title: c.latest_sermon_title || "",
      demo_link: c.smart_link || smartLinkUrl(c.id),
      qr_image_url: c.qr_image_url || qrImageUrl(c.id),
      city: c.city || "",
      state: c.state || "",
    }))
    .filter((c) => !withEmail || c.pastor_email);
}

const CSV_COLS = ["church_id", "church_name", "pastor_name", "pastor_email", "latest_sermon_title", "demo_link", "qr_image_url", "city", "state"];
const csvCell = (v) => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from treating a value as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const outreachCsv = (rows) => [CSV_COLS.join(","), ...rows.map((r) => CSV_COLS.map((k) => csvCell(r[k])).join(","))].join("\n");

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Checks the outreach API key. Fails closed when OUTREACH_API_KEY isn't set. */
function keyCheck(req, { allowQuery = false } = {}) {
  const want = process.env.OUTREACH_API_KEY;
  if (!want) return "not_configured";
  const h = req.headers.authorization || "";
  const got = req.headers["x-api-key"] || (h.startsWith("Bearer ") ? h.slice(7) : "") || (allowQuery ? req.query.key : "");
  return got && safeEqual(got, want) ? "ok" : "unauthorized";
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export function mountOutreach(app, { admin }) {
  migrate().catch((e) => console.error("outreach migrate", e.message));

  const guard = (allowQuery) => (req, res, next) => {
    const k = keyCheck(req, { allowQuery });
    if (k === "ok") return next();
    res.set("Cache-Control", "no-store");
    if (k === "not_configured") return res.status(503).json({ error: "outreach API key not configured" });
    return res.status(401).json({ error: "unauthorized" });
  };
  const withEmail = (req) => ["1", "true", "yes"].includes(String(req.query.with_email || "").toLowerCase());

  app.get("/churches/outreach", guard(false), async (req, res) => {
    try {
      const rows = await outreachRows({ withEmail: withEmail(req) });
      res.set("Cache-Control", "no-store");
      res.json({ count: rows.length, churches: rows });
    } catch (e) {
      console.error("GET /churches/outreach", e);
      res.status(500).json({ error: "server error" });
    }
  });

  app.get("/churches/outreach.csv", guard(true), async (req, res) => {
    try {
      const rows = await outreachRows({ withEmail: withEmail(req) });
      res.set("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="church-outreach.csv"');
      res.send(outreachCsv(rows));
    } catch (e) {
      console.error("GET /churches/outreach.csv", e);
      res.status(500).send("server error");
    }
  });

  // Fill in pastor names/emails, e.g. from a research spreadsheet. Blank fields are left alone.
  app.post("/admin/churches/pastors", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    const list = Array.isArray(req.body) ? req.body : Array.isArray(req.body?.churches) ? req.body.churches : null;
    if (!list) return res.status(400).json({ error: "send a JSON array of { church_id, pastor_name, pastor_email }" });
    try {
      await migrate();
      let updated = 0;
      const skipped = [];
      for (const it of list) {
        const id = parseInt(it?.church_id, 10);
        const name = String(it?.pastor_name ?? "").trim();
        const email = String(it?.pastor_email ?? "").trim().toLowerCase();
        if (!id || (email && !EMAIL_RE.test(email)) || (!name && !email)) { skipped.push(it?.church_id ?? null); continue; }
        const r = await pool.query(
          `UPDATE churches SET pastor_name = COALESCE(NULLIF($2, ''), pastor_name),
                               pastor_email = COALESCE(NULLIF($3, ''), pastor_email) WHERE id = $1`,
          [id, name, email]
        );
        if (r.rowCount) updated++; else skipped.push(id);
      }
      res.json({ updated, skipped });
    } catch (e) {
      console.error("POST /admin/churches/pastors", e);
      res.status(500).json({ error: "server error" });
    }
  });
}
