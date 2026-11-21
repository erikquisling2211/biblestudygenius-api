/**
 * votd.js — Verse of the Day reactions: an "Amen" count and a share count.
 *
 * No comments and no accounts: each phone sends a random anonymous device id
 * (made by the app, not tied to any person). One Amen per device per day (tap
 * again to take it back); a share counts once per device per day.
 *
 *   GET  /api/votd/stats?day=YYYY-MM-DD&ref=book.c.v&device=…  → { amen, shares, mine: { amen } }
 *   POST /api/votd/amen   { day, ref, device, on }               → same shape
 *   POST /api/votd/share  { day, ref, device }                   → same shape
 */
import { pool } from "./db.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REF = /^[a-z0-9-]{2,30}\.\d{1,3}\.\d{1,3}$/;
const DEVICE = /^[A-Za-z0-9-]{8,64}$/;

// Only today's verse (±1 day for time zones) can be reacted to.
function dayOk(day) {
  if (!DAY.test(day)) return false;
  const t = Date.parse(day + "T12:00:00Z");
  return Number.isFinite(t) && Math.abs(Date.now() - t) <= 2 * 86400000;
}

async function stats(day, ref, device) {
  const r = await pool.query(
    `SELECT kind, COUNT(*)::int AS n, BOOL_OR(device = $3) AS mine
       FROM votd_reactions WHERE day = $1 AND ref = $2 GROUP BY kind`,
    [day, ref, device || ""]);
  const by = Object.fromEntries(r.rows.map((x) => [x.kind, x]));
  return { amen: by.amen?.n ?? 0, shares: by.share?.n ?? 0, mine: { amen: !!by.amen?.mine } };
}

function parse(src) {
  const day = String(src.day || ""), ref = String(src.ref || ""), device = String(src.device || "");
  return { day, ref, device, ok: DAY.test(day) && REF.test(ref) && (device === "" || DEVICE.test(device)) };
}

export function mountVotd(app) {
  pool.query(`CREATE TABLE IF NOT EXISTS votd_reactions (
      day TEXT NOT NULL, ref TEXT NOT NULL, device TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('amen','share')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (day, ref, device, kind))`).catch((e) => console.error("votd migrate", e.message));

  app.get("/api/votd/stats", async (req, res) => {
    const p = parse(req.query);
    if (!p.ok) return res.status(400).json({ error: "bad request" });
    try { res.set("Cache-Control", "no-store").json(await stats(p.day, p.ref, p.device)); }
    catch (e) { console.error("GET /api/votd/stats", e.message); res.status(500).json({ error: "error" }); }
  });

  app.post("/api/votd/amen", async (req, res) => {
    const p = parse(req.body || {});
    if (!p.ok || !p.device || !dayOk(p.day)) return res.status(400).json({ error: "bad request" });
    try {
      if (req.body.on === false) {
        await pool.query(`DELETE FROM votd_reactions WHERE day=$1 AND ref=$2 AND device=$3 AND kind='amen'`, [p.day, p.ref, p.device]);
      } else {
        await pool.query(`INSERT INTO votd_reactions (day, ref, device, kind) VALUES ($1,$2,$3,'amen') ON CONFLICT DO NOTHING`, [p.day, p.ref, p.device]);
      }
      res.json(await stats(p.day, p.ref, p.device));
    } catch (e) { console.error("POST /api/votd/amen", e.message); res.status(500).json({ error: "error" }); }
  });

  app.post("/api/votd/share", async (req, res) => {
    const p = parse(req.body || {});
    if (!p.ok || !p.device || !dayOk(p.day)) return res.status(400).json({ error: "bad request" });
    try {
      await pool.query(`INSERT INTO votd_reactions (day, ref, device, kind) VALUES ($1,$2,$3,'share') ON CONFLICT DO NOTHING`, [p.day, p.ref, p.device]);
      res.json(await stats(p.day, p.ref, p.device));
    } catch (e) { console.error("POST /api/votd/share", e.message); res.status(500).json({ error: "error" }); }
  });
}
