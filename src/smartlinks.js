/**
 * smartlinks.js — one smart link per church, on our own domain (no third-party link service):
 *
 *   https://sermons.biblestudygenius.com/c/:id
 *
 *   Desktop                    → the church's web page (/c/:id redirects to /church/:slug, so the
 *                                link survives renames)
 *   Mobile, app installed      → opens the app straight to the church (iOS Universal Link /
 *                                Android App Link; verification files served by sermonpages.js)
 *   Mobile, app not installed  → the church page's store buttons carry the church through install:
 *                                Google Play via install referrer "church_<id>"; App Store via a
 *                                "bsg-church:<id>" clipboard hand-off the app offers on first launch.
 *
 * The link is stored on churches.smart_link at provisioning.
 *
 * Admin:
 *   POST /admin/smart-links/backfill   store links for every church missing one
 *   GET  /admin/churches/links.csv     name, contact emails, smart link… for email merges
 */
import { pool } from "./db.js";

const SERMONS_SITE = (process.env.SERMONS_SITE_URL || "https://sermons.biblestudygenius.com").replace(/\/$/, "");

let migrated = null;
function migrate() {
  if (!migrated) migrated = pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS smart_link TEXT;`).catch((e) => { migrated = null; throw e; });
  return migrated;
}

export const smartLinkUrl = (churchId) => `${SERMONS_SITE}/c/${churchId}`;

/** Return the church's smart link, storing it on the record if missing. Never throws. */
export async function ensureSmartLink(churchId) {
  const url = smartLinkUrl(churchId);
  try {
    await migrate();
    await pool.query(`UPDATE churches SET smart_link = $1 WHERE id = $2 AND smart_link IS DISTINCT FROM $1`, [url, churchId]);
  } catch (e) {
    console.error(`ensureSmartLink(${churchId})`, (e && e.message) || e);
  }
  return url;
}

/** Link to share for a church row. */
export function shareLinkFor(church) {
  return church.smart_link || smartLinkUrl(church.id);
}

const csvCell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function mountSmartLinks(app, { admin }) {
  migrate().catch((e) => console.error("smartlinks migrate", e.message));

  app.post("/admin/smart-links/backfill", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    try {
      await migrate();
      const r = await pool.query(
        `UPDATE churches SET smart_link = $1 || '/c/' || id WHERE smart_link IS NULL OR smart_link <> $1 || '/c/' || id RETURNING id`,
        [SERMONS_SITE]
      );
      res.json({ updated: r.rowCount });
    } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
  });

  app.get("/admin/churches/links.csv", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    try {
      await migrate();
      const r = await pool.query(
        `SELECT c.id, c.name, c.display_name, c.city, c.state, c.contact_email, c.smart_link,
                (SELECT string_agg(a.email, '; ') FROM church_admins a WHERE a.church_id = c.id) AS admin_emails
           FROM churches c WHERE c.active ORDER BY c.name`
      );
      const head = ["church_id", "church_name", "display_name", "city", "state", "contact_email", "admin_emails", "smart_link"];
      const rows = r.rows.map((c) => [c.id, c.name, c.display_name, c.city, c.state, c.contact_email, c.admin_emails, shareLinkFor(c)]
        .map(csvCell).join(","));
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="church-links.csv"');
      res.send([head.join(","), ...rows].join("\n"));
    } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
  });
}
