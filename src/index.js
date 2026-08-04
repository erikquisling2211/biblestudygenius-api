import express from "express";
import cors from "cors";
import { pool, initDb } from "./db.js";
import { requireAuth } from "./auth.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.json({ ok: true, service: "biblestudygenius-api" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

async function getOrCreateState(userId) {
  const { rows } = await pool.query("SELECT * FROM user_state WHERE user_id = $1", [userId]);
  if (rows[0]) return rows[0];
  await pool.query(
    "INSERT INTO user_state (user_id, iq, progress, settings, updated_at) VALUES ($1, 100, '{}', '{}', $2)",
    [userId, Date.now()]
  );
  return { user_id: userId, iq: 100, progress: {}, settings: {}, updated_at: Date.now() };
}

app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const state = await getOrCreateState(req.userId);
    const { rows: hl } = await pool.query(
      "SELECT id, book_id AS \"bookId\", chapter, verse, name, ref, text, translation, saved_at AS \"savedAt\" FROM highlights WHERE user_id = $1 ORDER BY saved_at DESC",
      [req.userId]
    );
    res.json({ iq: state.iq, progress: state.progress, settings: state.settings, highlights: hl });
  } catch (e) {
    console.error("GET /api/me", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.put("/api/state", requireAuth, async (req, res) => {
  try {
    await getOrCreateState(req.userId);
    const { iq, progress, settings } = req.body || {};
    await pool.query(
      `UPDATE user_state SET
         iq = COALESCE($2, iq),
         progress = COALESCE($3, progress),
         settings = COALESCE($4, settings),
         updated_at = $5
       WHERE user_id = $1`,
      [
        req.userId,
        typeof iq === "number" ? iq : null,
        progress ? JSON.stringify(progress) : null,
        settings ? JSON.stringify(settings) : null,
        Date.now(),
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("PUT /api/state", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.put("/api/highlights/:id", requireAuth, async (req, res) => {
  try {
    const h = req.body || {};
    await pool.query(
      `INSERT INTO highlights (user_id, id, book_id, chapter, verse, name, ref, text, translation, saved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, id) DO UPDATE SET
         book_id=$3, chapter=$4, verse=$5, name=$6, ref=$7, text=$8, translation=$9, saved_at=$10`,
      [req.userId, req.params.id, h.bookId, h.chapter, h.verse, h.name, h.ref, h.text, h.translation, h.savedAt ?? Date.now()]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("PUT /api/highlights", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/highlights/:id", requireAuth, async (req, res) => {
  try {
    await pool.query("DELETE FROM highlights WHERE user_id = $1 AND id = $2", [req.userId, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/highlights", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/sync", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const state = await getOrCreateState(req.userId);
    const { iq, progress, settings, highlights } = req.body || {};

    const mergedIq = Math.max(state.iq ?? 100, typeof iq === "number" ? iq : 100);
    const mergedProgress = { ...(state.progress || {}), ...(progress || {}) };
    const mergedSettings = { ...(state.settings || {}), ...(settings || {}) };
    await client.query(
      "UPDATE user_state SET iq=$2, progress=$3, settings=$4, updated_at=$5 WHERE user_id=$1",
      [req.userId, mergedIq, JSON.stringify(mergedProgress), JSON.stringify(mergedSettings), Date.now()]
    );

    if (Array.isArray(highlights)) {
      for (const h of highlights) {
        if (!h?.id) continue;
        await client.query(
          `INSERT INTO highlights (user_id, id, book_id, chapter, verse, name, ref, text, translation, saved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (user_id, id) DO NOTHING`,
          [req.userId, h.id, h.bookId, h.chapter, h.verse, h.name, h.ref, h.text, h.translation, h.savedAt ?? Date.now()]
        );
      }
    }
    await client.query("COMMIT");

    const { rows: hl } = await client.query(
      "SELECT id, book_id AS \"bookId\", chapter, verse, name, ref, text, translation, saved_at AS \"savedAt\" FROM highlights WHERE user_id = $1 ORDER BY saved_at DESC",
      [req.userId]
    );
    res.json({ iq: mergedIq, progress: mergedProgress, settings: mergedSettings, highlights: hl });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /api/sync", e);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 biblestudygenius-api listening on ${PORT}`));
  })
  .catch((e) => {
    console.error("Failed to init DB:", e);
    process.exit(1);
  });
