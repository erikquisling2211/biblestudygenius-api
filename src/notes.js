// Notes & Journal sync. Each note is one row per (user, id). Writes only win when they are
// newer (updated_at) than what the server has, so edits from two phones merge sensibly.
import { pool } from "./db.js";
import { requireAuth } from "./auth.js";

const KINDS = new Set(["verse", "journal", "sermon"]);
const MAX_BODY = 100_000;

const SELECT = `SELECT id, kind, title, body, ref, book_id AS "bookId", chapter, verse, verse_end AS "verseEnd",
  extra, created_at AS "createdAt", updated_at AS "updatedAt" FROM notes`;

function clean(n) {
  if (!n || typeof n.id !== "string" || !n.id || n.id.length > 100) return null;
  const int = (x) => (Number.isFinite(Number(x)) && x !== null && x !== "" ? Math.trunc(Number(x)) : null);
  const now = Date.now();
  return {
    id: n.id,
    kind: KINDS.has(n.kind) ? n.kind : "journal",
    title: String(n.title ?? "").slice(0, 500),
    body: String(n.body ?? "").slice(0, MAX_BODY),
    ref: n.ref ? String(n.ref).slice(0, 200) : null,
    bookId: n.bookId ? String(n.bookId).slice(0, 40) : null,
    chapter: int(n.chapter),
    verse: int(n.verse),
    verseEnd: int(n.verseEnd),
    extra: n.extra && typeof n.extra === "object" ? n.extra : {},
    createdAt: int(n.createdAt) ?? now,
    updatedAt: int(n.updatedAt) ?? now,
    deleted: !!n.deleted,
  };
}

async function upsert(db, userId, n) {
  await db.query(
    `INSERT INTO notes (user_id, id, kind, title, body, ref, book_id, chapter, verse, verse_end, extra, created_at, updated_at, deleted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (user_id, id) DO UPDATE SET
       kind=$3, title=$4, body=$5, ref=$6, book_id=$7, chapter=$8, verse=$9, verse_end=$10, extra=$11,
       updated_at=$13, deleted=$14
     WHERE notes.updated_at < $13`,
    [userId, n.id, n.kind, n.title, n.body, n.ref, n.bookId, n.chapter, n.verse, n.verseEnd,
     JSON.stringify(n.extra), n.createdAt, n.updatedAt, n.deleted]
  );
}

async function listNotes(db, userId) {
  const { rows } = await db.query(`${SELECT} WHERE user_id = $1 AND deleted = false ORDER BY updated_at DESC`, [userId]);
  return rows.map((r) => ({ ...r, createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt) }));
}

export function mountNotes(app) {
  app.get("/api/notes", requireAuth, async (req, res) => {
    try { res.json({ notes: await listNotes(pool, req.userId) }); }
    catch (e) { console.error("GET /api/notes", e); res.status(500).json({ error: "Server error" }); }
  });

  // Two-way sync: the phone sends everything it has (including deletions), gets back the merged set.
  app.post("/api/notes/sync", requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const incoming = Array.isArray(req.body?.notes) ? req.body.notes.slice(0, 5000) : [];
      await client.query("BEGIN");
      for (const raw of incoming) { const n = clean(raw); if (n) await upsert(client, req.userId, n); }
      await client.query("COMMIT");
      res.json({ notes: await listNotes(client, req.userId) });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("POST /api/notes/sync", e);
      res.status(500).json({ error: "Server error" });
    } finally { client.release(); }
  });

  app.put("/api/notes/:id", requireAuth, async (req, res) => {
    try {
      const n = clean({ ...(req.body || {}), id: req.params.id });
      if (!n) return res.status(400).json({ error: "Bad note" });
      await upsert(pool, req.userId, n);
      res.json({ ok: true });
    } catch (e) { console.error("PUT /api/notes", e); res.status(500).json({ error: "Server error" }); }
  });

  app.delete("/api/notes/:id", requireAuth, async (req, res) => {
    try {
      const ts = Number(req.query.ts) || Date.now();
      await pool.query(
        `UPDATE notes SET deleted = true, updated_at = $3 WHERE user_id = $1 AND id = $2 AND updated_at < $3`,
        [req.userId, req.params.id, ts]
      );
      res.json({ ok: true });
    } catch (e) { console.error("DELETE /api/notes", e); res.status(500).json({ error: "Server error" }); }
  });
}
