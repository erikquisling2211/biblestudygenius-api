import express from "express";
import cors from "cors";
import { pool, initDb } from "./db.js";
import { requireAuth } from "./auth.js";
import { mountScripture } from "./scripture.js";
import { mountWordStudy } from "./wordstudy.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
mountScripture(app);
  mountWordStudy(app);

app.get("/", (_req, res) => res.json({ ok: true, service: "biblestudygenius-api" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Legal pages (Terms of Use + Privacy Policy) ---
const TERMS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Terms of Use &mdash; Bible Study Genius</title>
<style>
  :root { --ink:#1d1b38; --muted:#4a4766; --gold:#9a7b1a; --line:#e6e1d4; --bg:#faf7f0; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; line-height:1.6; }
  .wrap { max-width:760px; margin:0 auto; padding:48px 20px 80px; }
  h1 { font-size:30px; margin:0 0 6px; }
  .eff { color:var(--muted); font-size:14px; margin-bottom:28px; }
  h2 { font-size:20px; margin:34px 0 10px; border-bottom:1px solid var(--line); padding-bottom:6px; }
  p, li { font-size:16px; color:#2b2947; }
  a { color:var(--gold); }
  .note { background:#fff; border:1px solid var(--line); border-radius:10px; padding:14px 16px; font-size:14px; color:var(--muted); }
  footer { margin-top:40px; color:var(--muted); font-size:14px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Terms of Use</h1>
  <div class="eff">Bible Study Genius &middot; Last updated October 14, 2026</div>
  <p>These Terms of Use ("Terms") are a legal agreement between you and Codeus, Inc. ("Codeus," "we," "us") governing your use of the Bible Study Genius mobile application and related services (the "App"). By downloading or using the App, you agree to these Terms. If you do not agree, do not use the App.</p>
  <h2>1. The Service</h2>
  <p>Bible Study Genius is a free Bible-reading and study application offering Scripture text, audio reading, original-language study tools, reading-progress tracking, and optional word games. Core features are available at no cost.</p>
  <h2>2. Accounts</h2>
  <p>You may use the App as a guest or create an account. Account creation and sign-in are handled by our authentication provider, Clerk. You are responsible for maintaining the confidentiality of your login credentials and for all activity under your account. You may use the App only in compliance with these Terms and all applicable laws.</p>
  <h2>3. Voluntary Support &mdash; Auto-Renewing Subscriptions</h2>
  <p>The App offers <strong>optional</strong> monthly Support subscriptions as a way to voluntarily support ongoing development. These contributions are not required to use the App, and they do <strong>not</strong> unlock any additional features, content, or services &mdash; the App is fully functional without them.</p>
  <ul>
    <li><strong>Subscription options:</strong> Monthly Support at $9.99, $24.99, or $49.99 (USD) per month.</li>
    <li><strong>Payment</strong> is charged to your Apple ID account upon confirmation of purchase.</li>
    <li><strong>Auto-renewal:</strong> Each subscription automatically renews for the same monthly period unless auto-renew is turned off at least 24 hours before the end of the current period.</li>
    <li><strong>Renewal charge:</strong> Your account is charged for renewal within 24 hours prior to the end of the current period, at the price for the selected tier.</li>
    <li><strong>Managing or canceling:</strong> You can manage or cancel your subscription at any time in your device's Settings &rarr; [your name] &rarr; Subscriptions (App Store account settings). Cancellation takes effect at the end of the current billing period; the current period cannot be canceled mid-term.</li>
    <li>Prices are shown in the App before purchase and may vary by region. Applicable taxes may apply.</li>
  </ul>
  <h2>4. One-Time Contributions</h2>
  <p>The App also offers optional one-time Support contributions ($9.99, $24.99, or $49.99 USD). Like subscriptions, these are voluntary, unlock nothing, and are consumed upon purchase. Except where required by law or the platform's policies, contributions are non-refundable.</p>
  <h2>5. Purchases and Refunds</h2>
  <p>All in-app purchases on iOS are processed by Apple through In-App Purchase and are subject to the <a href="https://www.apple.com/legal/internet-services/itunes/">Apple Media Services Terms and Conditions</a>. Refund requests for App Store purchases are handled by Apple, not Codeus. On other platforms and on our website, voluntary contributions may be processed by Stripe.</p>
  <h2>6. Scripture and Content</h2>
  <p>Scripture text and audio are provided under license or are in the public domain, and are used in accordance with the terms of their respective providers. All other App content, trademarks, and software are owned by Codeus or its licensors and are protected by applicable law. You may not copy, redistribute, or create derivative works from the App except as permitted by these Terms or applicable law.</p>
  <h2>7. Acceptable Use</h2>
  <p>You agree not to misuse the App, including by attempting to disrupt it, reverse-engineer it except as permitted by law, access it by unauthorized means, or use it for any unlawful purpose.</p>
  <h2>8. Disclaimers</h2>
  <p>The App is provided "as is" and "as available," without warranties of any kind, whether express or implied, to the fullest extent permitted by law. We do not warrant that the App will be uninterrupted, error-free, or free of harmful components.</p>
  <h2>9. Limitation of Liability</h2>
  <p>To the maximum extent permitted by law, Codeus will not be liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of data, arising out of or relating to your use of the App. Our total liability for any claim relating to the App will not exceed the amount you paid to us, if any, in the twelve months before the claim.</p>
  <h2>10. Changes</h2>
  <p>We may update these Terms from time to time. Material changes will be reflected by the "Last updated" date above. Your continued use of the App after changes take effect constitutes acceptance of the revised Terms.</p>
  <h2>11. Governing Law</h2>
  <p>These Terms are governed by the laws of the United States and the state in which Codeus, Inc. is organized, without regard to conflict-of-laws principles.</p>
  <h2>12. Contact</h2>
  <p>Questions about these Terms: <a href="mailto:support@biblestudygenius.com">support@biblestudygenius.com</a>.</p>
  <footer>&copy; 2026 Codeus, Inc. All rights reserved.</footer>
</div>
</body>
</html>`;
const PRIVACY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Privacy Policy &mdash; Bible Study Genius</title>
<style>
  :root { --ink:#1d1b38; --muted:#4a4766; --gold:#9a7b1a; --line:#e6e1d4; --bg:#faf7f0; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; line-height:1.6; }
  .wrap { max-width:760px; margin:0 auto; padding:48px 20px 80px; }
  h1 { font-size:30px; margin:0 0 6px; }
  .eff { color:var(--muted); font-size:14px; margin-bottom:28px; }
  h2 { font-size:20px; margin:34px 0 10px; border-bottom:1px solid var(--line); padding-bottom:6px; }
  p, li { font-size:16px; color:#2b2947; }
  a { color:var(--gold); }
  footer { margin-top:40px; color:var(--muted); font-size:14px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Privacy Policy</h1>
  <div class="eff">Bible Study Genius &middot; Last updated October 14, 2026</div>
  <p>This Privacy Policy explains how Codeus, Inc. ("Codeus," "we," "us") collects, uses, and protects information when you use the Bible Study Genius mobile application (the "App"). We built the App to respect your privacy: it is free, ad-free, and we do not sell your personal information.</p>
  <h2>Information We Collect</h2>
  <ul>
    <li><strong>Account information.</strong> If you create an account, our authentication provider, Clerk, collects your email address and basic profile information to create and secure your account. You may also use the App as a guest without an account.</li>
    <li><strong>App activity.</strong> We store your reading progress and in-app preferences so your experience carries across sessions and devices. If you are signed in, this may be associated with your account.</li>
    <li><strong>Diagnostics.</strong> We may collect limited, aggregated crash and performance data to keep the App stable. This is not used to identify you.</li>
  </ul>
  <p>We do not display advertising and do not use advertising trackers.</p>
  <h2>Payments</h2>
  <p>Optional Support contributions on iOS are processed by Apple through In-App Purchase; on our website and on Android they may be processed by Stripe. We do not collect or store your payment card details &mdash; those are handled directly by Apple or Stripe under their own privacy policies.</p>
  <h2>How We Use Information</h2>
  <ul>
    <li>To provide and maintain the App and your account.</li>
    <li>To save your reading progress and preferences.</li>
    <li>To diagnose problems and improve stability and performance.</li>
    <li>To respond to your support requests.</li>
  </ul>
  <h2>Service Providers</h2>
  <p>We share information only with providers that help us operate the App, each under their own privacy terms:</p>
  <ul>
    <li><strong>Clerk</strong> &mdash; account authentication.</li>
    <li><strong>Apple</strong> and <strong>Stripe</strong> &mdash; payment processing for optional contributions.</li>
    <li><strong>API.Bible / content providers</strong> &mdash; Scripture text and audio delivery.</li>
    <li><strong>Hosting and diagnostics providers</strong> &mdash; to run our backend and monitor stability.</li>
  </ul>
  <p>We do not sell or rent your personal information to anyone.</p>
  <h2>Data Retention</h2>
  <p>We keep account and progress information for as long as your account is active. You may request deletion of your account and associated data at any time by contacting us.</p>
  <h2>Children's Privacy</h2>
  <p>The App is intended for a general audience and is not directed to children under 13. We do not knowingly collect personal information from children under 13. If you believe a child has provided us information, contact us and we will delete it.</p>
  <h2>Your Choices and Rights</h2>
  <p>You may use the App as a guest, update your account information, or request access to or deletion of your data by contacting us. Depending on where you live, you may have additional rights under applicable privacy laws.</p>
  <h2>Changes</h2>
  <p>We may update this Policy from time to time. Material changes will be reflected by the "Last updated" date above.</p>
  <h2>Contact</h2>
  <p>Questions or requests: <a href="mailto:support@biblestudygenius.com">support@biblestudygenius.com</a>.</p>
  <footer>&copy; 2026 Codeus, Inc. All rights reserved.</footer>
</div>
</body>
</html>`;
app.get("/terms", (_req, res) => res.type("html").send(TERMS_HTML));
app.get("/privacy", (_req, res) => res.type("html").send(PRIVACY_HTML));

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
