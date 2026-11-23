/**
 * startlink.js — one-tap sign-up links for churches already in our directory (pastor outreach).
 *
 *   https://sermons.biblestudygenius.com/start/<token>
 *
 * Tapping it goes straight to Stripe Checkout for the church plan (14-day trial), already tied to
 * that church. When payment completes, the Stripe webhook (churches.js) attaches the subscription
 * to the EXISTING church (no duplicate) and emails a dashboard login. A church that already pays
 * is sent to the dashboard instead.
 *
 * The token (churches.signup_token) is random so links can't be guessed or enumerated.
 * Admin (ADMIN_TOKEN): POST /admin/church/:id/signup-link/reset → new token.
 */
import crypto from "crypto";
import { pool } from "./db.js";
import { SERMONS_SITE } from "./smartlinks.js";

const SITE_URL = (process.env.SITE_URL || "https://biblestudygenius.com").replace(/\/$/, "");
const newToken = () => crypto.randomBytes(18).toString("base64url");

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = (async () => {
      await pool.query(`ALTER TABLE churches ADD COLUMN IF NOT EXISTS signup_token TEXT;`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS churches_signup_token_idx ON churches(signup_token);`);
    })().catch((e) => { migrated = null; throw e; });
  }
  return migrated;
}

export const signupLinkFor = (token) => `${SERMONS_SITE}/start/${token}`;

/** Give every church without a sign-up token a new one. */
export async function ensureSignupTokens() {
  await migrate();
  const r = await pool.query(`SELECT id FROM churches WHERE signup_token IS NULL`);
  for (const { id } of r.rows) {
    await pool.query(`UPDATE churches SET signup_token = $1 WHERE id = $2 AND signup_token IS NULL`, [newToken(), id]);
  }
  return r.rowCount;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const message = (title, text) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#faf7f0;color:#1b2340;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5}.w{max-width:460px;margin:0 auto;padding:48px 16px}h1{font-size:22px}p{color:#4a4f68}a{color:#8a6a10}</style></head>
<body><div class="w"><h1>${esc(title)}</h1><p>${text}</p></div></body></html>`;

export function mountStartLinks(app, { admin, stripe }) {
  migrate().catch((e) => console.error("startlink migrate", e.message));

  app.get("/start/:token", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex");
    const token = String(req.params.token || "");
    try {
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return res.status(404).type("html").send(message("Link not found", `This sign-up link isn't valid. Email <a href="mailto:support@biblestudygenius.com">support@biblestudygenius.com</a> and we'll help.`));
      await migrate();
      const r = await pool.query(
        `SELECT id, COALESCE(NULLIF(display_name,''), name) AS church_name, city, state, stripe_subscription_id
           FROM churches WHERE signup_token = $1`, [token]);
      const c = r.rows[0];
      if (!c) return res.status(404).type("html").send(message("Link not found", `This sign-up link isn't valid. Email <a href="mailto:support@biblestudygenius.com">support@biblestudygenius.com</a> and we'll help.`));
      if (c.stripe_subscription_id) return res.redirect(303, `${SITE_URL}/dashboard`); // already signed up
      if (!stripe || !process.env.STRIPE_PRICE_ID) return res.status(503).type("html").send(message("Sign-up is unavailable", `Please try again shortly, or email <a href="mailto:support@biblestudygenius.com">support@biblestudygenius.com</a>.`));

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
        subscription_data: { trial_period_days: 14, metadata: { existingChurchId: String(c.id) } },
        allow_promotion_codes: true,
        client_reference_id: `church_${c.id}`,
        custom_text: { submit: { message: `Starts your 14-day free trial for ${c.church_name}.`.slice(0, 1000) } },
        metadata: { existingChurchId: String(c.id), name: c.church_name, city: c.city || "", state: c.state || "" },
        success_url: `${SITE_URL}/welcome?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SERMONS_SITE}/c/${c.id}`,
      });
      res.redirect(303, session.url);
    } catch (e) {
      console.error("GET /start/:token", e);
      res.status(500).type("html").send(message("Something went wrong", `Please try again in a minute, or email <a href="mailto:support@biblestudygenius.com">support@biblestudygenius.com</a>.`));
    }
  });

  app.post("/admin/church/:id/signup-link/reset", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    try {
      await migrate();
      const token = newToken();
      const r = await pool.query(`UPDATE churches SET signup_token = $2 WHERE id = $1 RETURNING id`, [parseInt(req.params.id, 10), token]);
      if (!r.rowCount) return res.status(404).json({ error: "not found" });
      res.json({ churchId: r.rows[0].id, signup_link: signupLinkFor(token) });
    } catch (e) { console.error("signup-link reset", e); res.status(500).json({ error: "server error" }); }
  });
}
