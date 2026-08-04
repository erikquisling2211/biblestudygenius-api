import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_state (
      user_id      TEXT PRIMARY KEY,
      iq           INTEGER NOT NULL DEFAULT 100,
      progress     JSONB   NOT NULL DEFAULT '{}'::jsonb,
      settings     JSONB   NOT NULL DEFAULT '{}'::jsonb,
      updated_at   BIGINT  NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS highlights (
      user_id     TEXT NOT NULL,
      id          TEXT NOT NULL,
      book_id     TEXT NOT NULL,
      chapter     INTEGER NOT NULL,
      verse       INTEGER NOT NULL,
      name        TEXT NOT NULL,
      ref         TEXT NOT NULL,
      text        TEXT NOT NULL,
      translation TEXT NOT NULL,
      saved_at    BIGINT NOT NULL,
      PRIMARY KEY (user_id, id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS highlights_user_idx ON highlights(user_id);`);
  console.log("✅ Database ready");
}
