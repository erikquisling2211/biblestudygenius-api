/**
 * churchextras.js — the three extra sections on a church's page in the app, plus their dashboard side.
 *
 *  1. Weekly sermon quiz. Generated with the study plan by the sermon pipeline (sermonprocess.js) and
 *     stored on sermons.quiz. The app reports quiz_start / quiz_complete (value = score %) to POST /events.
 *       POST /admin/sermon/:id/quiz        (re)build one sermon's quiz (uses the stored transcript, or
 *                                          re-transcribes the audio for sermons processed before quizzes)
 *       POST /admin/church/:id/quiz        same, for the church's latest sermon
 *
 *  2. Upcoming events. A calendar feed (churches.calendar_url: ICS, Google Calendar, Planning Center)
 *     merged with events typed into the dashboard (church_events).
 *       GET  /church/:id/event.ics?…       one event as an .ics with a reminder (the app's "Remind me")
 *       GET  /church/me/events             dashboard: hand-entered events + calendar link + preview
 *       POST /church/me/events             dashboard: add an event
 *       DELETE /church/me/events/:eventId  dashboard: remove one
 *       POST /church/me/calendar           dashboard: set / clear the calendar feed (tested before saving)
 *
 *  3. Visitor Connect ("I'm New / Plan a Visit"). A contact form, not public content: stored in
 *     visitor_connects, emailed to the church's contact + dashboard logins, listed in the dashboard.
 *       POST /church/:id/visitor           the app's form
 *       GET  /church/me/visitors           dashboard list   (GET /church/me/visitors.csv to export)
 *       POST /church/me/visitors/:vid      dashboard: mark new / contacted / archived
 *
 *  Dashboard page: GET /church-dashboard (same logins as the main dashboard; shows engagement incl.
 *  quiz, event views and visitors, plus the Visitor Connect and Events tools above).
 *  Tables are created in churches.js initChurches().
 */
import { pool } from "./db.js";
import { welcomeVisitor } from "./churchpro.js";
import { fetchIcsEvents, normalizeCalendarUrl, zonedToEpoch, fmtWhen, DEFAULT_TZ, sermonQuiz, transcribeAudioUrl } from "./sermonprocess.js";

const tzOf = (church) => {
  const tz = church && church.timezone;
  if (tz) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { /* fall through */ } }
  return DEFAULT_TZ;
};

/* ---------------- events ---------------- */
const feedCache = new Map(); // url -> { at, data }
async function cachedFeed(url, tz) {
  const hit = feedCache.get(url);
  if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.data;
  let data;
  try { data = await fetchIcsEvents(url, { limit: 40, tz }); } catch (e) { data = { error: String((e && e.message) || e) }; }
  feedCache.set(url, { at: Date.now(), data });
  if (feedCache.size > 500) feedCache.delete(feedCache.keys().next().value);
  return data;
}

function manualRowToEvent(r, tz) {
  const startMs = Number(r.starts_at);
  const endMs = r.ends_at != null ? Number(r.ends_at) : (r.all_day ? startMs + 86400000 : startMs + 3600000);
  return {
    id: "m_" + r.id, title: r.title, when: fmtWhen(startMs, r.all_day, tz), startMs, endMs,
    allDay: !!r.all_day, tz, location: r.location || "", description: r.description || "", source: "manual",
  };
}

async function manualEvents(churchId, tz, { upcomingOnly = true } = {}) {
  // All-day rows store the date as UTC midnight, so give them a day of slack before calling them past.
  const r = await pool.query(
    `SELECT * FROM church_events WHERE church_id = $1
       ${upcomingOnly ? "AND COALESCE(ends_at, starts_at + CASE WHEN all_day THEN 86400000 ELSE 3600000 END) + CASE WHEN all_day THEN 86400000 ELSE 0 END > $2" : ""}
     ORDER BY starts_at LIMIT 200`,
    upcomingOnly ? [churchId, Date.now()] : [churchId]
  );
  return r.rows.map((row) => manualRowToEvent(row, tz));
}

export async function hasUpcomingManualEvents(churchId) {
  try {
    const r = await pool.query(`SELECT 1 FROM church_events WHERE church_id = $1 AND starts_at > $2 LIMIT 1`, [churchId, Date.now() - 86400000 * 2]);
    return r.rows.length > 0;
  } catch { return false; }
}

/** Calendar feed + hand-entered events, soonest first. Never throws on a bad feed. */
export async function upcomingEvents(church, { limit = 25 } = {}) {
  const tz = tzOf(church);
  const [manual, feed] = await Promise.all([
    manualEvents(church.id, tz),
    church.calendar_url ? cachedFeed(church.calendar_url, tz) : Promise.resolve(null),
  ]);
  const all = [...manual, ...((feed && feed.events) || [])].sort((a, b) => a.startMs - b.startMs);
  const out = { count: all.length, events: all.slice(0, limit) };
  if (feed && feed.error) out.feedError = feed.error;
  return out;
}

// "2026-11-29" + "18:30" in the church's zone -> event times. No time = all day.
function parseEventInput(b, tz) {
  const title = String(b.title || "").trim().slice(0, 140);
  const date = String(b.date || "").trim();
  const dm = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!title || !dm) return { error: "title and date (YYYY-MM-DD) are required" };
  const w = { Y: +dm[1], Mo: +dm[2], D: +dm[3], H: 0, Mi: 0 };
  const tm = String(b.time || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  const em = String(b.endTime || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  const allDay = !tm;
  let startsAt, endsAt = null;
  if (allDay) startsAt = Date.UTC(w.Y, w.Mo - 1, w.D);
  else {
    startsAt = zonedToEpoch({ ...w, H: +tm[1], Mi: +tm[2] }, tz);
    if (em) { endsAt = zonedToEpoch({ ...w, H: +em[1], Mi: +em[2] }, tz); if (endsAt <= startsAt) endsAt = null; }
  }
  return {
    title, allDay, startsAt, endsAt,
    location: String(b.location || "").trim().slice(0, 200) || null,
    description: String(b.description || "").trim().slice(0, 1000) || null,
  };
}

const icsEsc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsUtc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsDate = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

/* ---------------- Visitor Connect ---------------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const recent = new Map(); // ip|anon -> [timestamps] (simple abuse limit: 5 per hour)
function rateLimited(key) {
  const now = Date.now();
  const list = (recent.get(key) || []).filter((t) => now - t < 3600000);
  if (list.length >= 5) { recent.set(key, list); return true; }
  list.push(now); recent.set(key, list);
  if (recent.size > 5000) recent.delete(recent.keys().next().value);
  return false;
}

async function churchRecipients(churchId) {
  const r = await pool.query(
    `SELECT c.contact_email, COALESCE(c.display_name, c.name) AS name,
            (SELECT array_agg(a.email) FROM church_admins a WHERE a.church_id = c.id) AS admins
       FROM churches c WHERE c.id = $1`, [churchId]
  );
  const row = r.rows[0] || {};
  const to = [...new Set([row.contact_email, ...(row.admins || [])].filter(Boolean).map((e) => String(e).trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))].slice(0, 5);
  return { to, name: row.name || "your church" };
}

function fmtVisitDate(d) {
  const m = String(d || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
}

async function emailVisitor(churchId, v) {
  if (!process.env.RESEND_API_KEY) return false;
  const from = process.env.RESEND_FROM || "Bible Study Genius <hello@biblestudygenius.com>";
  const { to, name } = await churchRecipients(churchId);
  const dash = `${(process.env.PUBLIC_API_URL || "https://biblestudygenius-api-production.up.railway.app").replace(/\/$/, "")}/church-dashboard`;
  const oneLine = (s) => String(s || "").replace(/[\r\n]+/g, " ").trim();
  if (!to.length) {
    // No contact on file: tell BSG to fix the church's contact, without forwarding the visitor's details.
    const admin = process.env.ADMIN_ALERT_EMAIL;
    if (!admin) return false;
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [admin], subject: `Visitor Connect: church ${churchId} has no contact email`, text: `A Visitor Connect form arrived for ${name} (church ${churchId}), but the church has no contact email or dashboard login. It is saved in their dashboard.` }),
    }).catch(() => {});
    return false;
  }
  const lines = [
    `Someone filled in the "I'm New / Plan a Visit" card on ${name}'s page in the Bible Study Genius app.`,
    "",
    `  Name:     ${oneLine(v.name)}`,
    v.email ? `  Email:    ${oneLine(v.email)}` : null,
    v.phone ? `  Phone:    ${oneLine(v.phone)}` : null,
    v.visitDate ? `  Visiting: ${fmtVisitDate(v.visitDate)}` : null,
    v.message ? `\n  Message:\n  ${String(v.message).replace(/\r?\n/g, "\n  ")}` : null,
    "",
    `They agreed to be contacted by ${name} about visiting. Please use these details only for that.`,
    `All Visitor Connect requests are in your church dashboard: ${dash}`,
  ].filter((x) => x != null);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to, reply_to: v.email || undefined,
        subject: `New visitor: ${oneLine(v.name).slice(0, 60)}${v.visitDate ? ` (planning to visit ${fmtVisitDate(v.visitDate).replace(/, \d{4}$/, "")})` : ""}`,
        text: lines.join("\n"),
      }),
    });
    if (!res.ok) console.error("Visitor Connect email", res.status, (await res.text().catch(() => "")).slice(0, 200));
    return res.ok;
  } catch (e) { console.error("Visitor Connect email", (e && e.message) || e); return false; }
}

/* ---------------- analytics (merged into churchStats) ---------------- */
export async function extraStats(id) {
  const wk = Date.now() - 7 * 86400000;
  const one = async (sql, params = [id]) => { try { return (await pool.query(sql, params)).rows[0] || {}; } catch { return {}; } };
  const [quiz, quizWk, ev, vis, perSermon] = await Promise.all([
    one(`SELECT COUNT(*) FILTER (WHERE type='quiz_start')::int AS starts,
                COUNT(*) FILTER (WHERE type='quiz_complete')::int AS completions,
                ROUND(AVG(value) FILTER (WHERE type='quiz_complete'))::int AS avg
           FROM sermon_events WHERE church_id=$1 AND type IN ('quiz_start','quiz_complete')`),
    one(`SELECT COUNT(*)::int AS n FROM sermon_events WHERE church_id=$1 AND type='quiz_complete' AND created_at > $2`, [id, wk]),
    one(`SELECT COUNT(*) FILTER (WHERE type='event_view')::int AS views,
                COUNT(*) FILTER (WHERE type='event_view' AND created_at > $2)::int AS views7,
                COUNT(*) FILTER (WHERE type='event_reminder')::int AS reminders,
                COUNT(*) FILTER (WHERE type='visitor_open')::int AS visitor_opens
           FROM sermon_events WHERE church_id=$1 AND type IN ('event_view','event_reminder','visitor_open')`, [id, wk]),
    one(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at > $2)::int AS last7,
                COUNT(*) FILTER (WHERE status='new')::int AS unread
           FROM visitor_connects WHERE church_id=$1`, [id, wk]),
    (async () => { try {
      return (await pool.query(
        `SELECT e.sermon_id AS "sermonId", s.title, COUNT(*)::int AS completions, ROUND(AVG(e.value))::int AS "avgScorePct"
           FROM sermon_events e LEFT JOIN sermons s ON s.id = e.sermon_id
          WHERE e.church_id=$1 AND e.type='quiz_complete' AND e.sermon_id IS NOT NULL
          GROUP BY e.sermon_id, s.title, s.sermon_ts ORDER BY s.sermon_ts DESC NULLS LAST LIMIT 8`, [id])).rows;
    } catch { return []; } })(),
  ]);
  return {
    quizStarts: quiz.starts || 0,
    quizCompletions: quiz.completions || 0,
    quizCompletionsLast7: quizWk.n || 0,
    quizAvgScorePct: quiz.avg ?? null,
    quizBySermon: perSermon,
    eventViews: ev.views || 0,
    eventViewsLast7: ev.views7 || 0,
    eventReminders: ev.reminders || 0,
    visitorCardOpens: ev.visitor_opens || 0,
    visitorSubmissions: vis.total || 0,
    visitorSubmissionsLast7: vis.last7 || 0,
    visitorUnread: vis.unread || 0,
  };
}

/* ---------------- quiz (re)build ---------------- */
async function buildQuizForSermon(sermonId, { force = false } = {}) {
  const r = await pool.query(`SELECT id, church_id, title, audio_url, transcript, quiz FROM sermons WHERE id = $1`, [sermonId]);
  const s = r.rows[0];
  if (!s) return { error: "sermon not found" };
  if (!force && Array.isArray(s.quiz) && s.quiz.length) return { sermonId, skipped: true, questions: s.quiz.length };
  let text = s.transcript;
  if (!text) {
    if (!s.audio_url) return { error: "sermon has no transcript or audio to build a quiz from" };
    text = await transcribeAudioUrl(s.audio_url);
    await pool.query(`UPDATE sermons SET transcript = $1 WHERE id = $2`, [text, sermonId]);
  }
  const quiz = await sermonQuiz(text);
  if (!quiz.length) return { error: "quiz generation returned no usable questions" };
  await pool.query(`UPDATE sermons SET quiz = $1 WHERE id = $2`, [JSON.stringify(quiz), sermonId]);
  return { sermonId, title: s.title, questions: quiz.length, quiz };
}

/* ---------------- routes ---------------- */
export function mountChurchExtras(app, { admin, churchAuth }) {
  const err = (res, e, where) => { console.error(where, e); res.status(500).json({ error: String((e && e.message) || e) }); };

  // --- quiz backfill (admin) ---
  app.post("/admin/sermon/:id/quiz", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    try {
      const out = await buildQuizForSermon(parseInt(req.params.id, 10), { force: req.query.force === "1" });
      res.status(out.error ? 400 : 200).json(out);
    } catch (e) { err(res, e, "POST /admin/sermon/:id/quiz"); }
  });
  app.post("/admin/church/:id/quiz", async (req, res) => {
    if (!admin(req)) return res.status(401).json({ error: "unauthorized" });
    try {
      const s = await pool.query(`SELECT id FROM sermons WHERE church_id = $1 ORDER BY sermon_ts DESC NULLS LAST, processed_at DESC LIMIT 1`, [parseInt(req.params.id, 10)]);
      if (!s.rows[0]) return res.status(404).json({ error: "church has no sermons" });
      const out = await buildQuizForSermon(s.rows[0].id, { force: req.query.force === "1" });
      res.status(out.error ? 400 : 200).json(out);
    } catch (e) { err(res, e, "POST /admin/church/:id/quiz"); }
  });

  // --- one event as an .ics with a reminder (the app's "Remind me" on iPhone opens this) ---
  app.get("/church/:id/event.ics", (req, res) => {
    if (!/^\d+$/.test(String(req.params.id))) return res.status(404).send("not found");
    const q = req.query;
    const title = String(q.title || "Church event").slice(0, 140);
    const start = parseInt(q.start, 10), end = parseInt(q.end, 10);
    if (!Number.isFinite(start)) return res.status(400).send("start required");
    const allDay = q.allDay === "1";
    const endMs = Number.isFinite(end) && end > start ? end : start + (allDay ? 86400000 : 3600000);
    const body = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Bible Study Genius//Church Events//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:bsg-${req.params.id}-${start}-${Buffer.from(title).toString("hex").slice(0, 16)}@biblestudygenius.com`,
      `DTSTAMP:${icsUtc(Date.now())}`,
      allDay ? `DTSTART;VALUE=DATE:${icsDate(start)}` : `DTSTART:${icsUtc(start)}`,
      allDay ? `DTEND;VALUE=DATE:${icsDate(endMs)}` : `DTEND:${icsUtc(endMs)}`,
      `SUMMARY:${icsEsc(title)}`,
      q.location ? `LOCATION:${icsEsc(String(q.location).slice(0, 200))}` : null,
      q.church ? `DESCRIPTION:${icsEsc(String(q.church).slice(0, 120))}` : null,
      "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEsc(title)}`,
      allDay ? "TRIGGER:-PT15H" : "TRIGGER:-PT1H", // 9 AM the day before an all-day event; 1 hour before otherwise
      "END:VALARM",
      "END:VEVENT", "END:VCALENDAR",
    ].filter(Boolean).join("\r\n");
    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Content-Disposition", `inline; filename="event.ics"`);
    res.send(body);
  });

  // --- Visitor Connect form (from the app) ---
  app.post("/church/:id/visitor", async (req, res) => {
    if (!/^\d+$/.test(String(req.params.id))) return res.status(404).json({ error: "not found" });
    const churchId = parseInt(req.params.id, 10);
    const b = req.body || {};
    if (b.website) return res.json({ ok: true }); // honeypot field: bots fill it, people never see it
    const name = String(b.name || "").replace(/\s+/g, " ").trim().slice(0, 100);
    const email = String(b.email || "").trim().toLowerCase().slice(0, 200);
    const phone = String(b.phone || "").replace(/[^\d+()\-.\s]/g, "").trim().slice(0, 30);
    const visitDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.visitDate || "")) ? String(b.visitDate) : null;
    const message = String(b.message || "").trim().slice(0, 1000) || null;
    const anonId = String(b.anonId || "").slice(0, 64) || null;
    if (!name) return res.status(400).json({ error: "Please add your name." });
    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: "That email doesn't look right." });
    if (phone && phone.replace(/\D/g, "").length < 7) return res.status(400).json({ error: "That phone number looks too short." });
    if (!email && !phone) return res.status(400).json({ error: "Please add an email or a phone number." });
    if (b.consent !== true) return res.status(400).json({ error: "Please agree to be contacted." });
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    if (rateLimited(ip + "|" + churchId) || (anonId && rateLimited("a:" + anonId))) return res.status(429).json({ error: "Thanks! We already have your details." });
    try {
      const c = await pool.query(`SELECT id FROM churches WHERE id = $1 AND active`, [churchId]);
      if (!c.rows[0]) return res.status(404).json({ error: "church not found" });
      const ins = await pool.query(
        `INSERT INTO visitor_connects (church_id, name, email, phone, visit_date, message, anon_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [churchId, name, email || null, phone || null, visitDate, message, anonId, Date.now()]
      );
      const id = ins.rows[0].id;
      res.json({ ok: true });
      emailVisitor(churchId, { name, email, phone, visitDate, message })
        .then((sent) => sent && pool.query(`UPDATE visitor_connects SET emailed_at = $1 WHERE id = $2`, [Date.now(), id]))
        .catch(() => {});
      // Paid listing: an instant welcome email to the visitor, in the church's own words.
      welcomeVisitor(churchId, id, { name, email, visitDate }).catch(() => {});
    } catch (e) { err(res, e, "POST /church/:id/visitor"); }
  });

  // --- dashboard: Visitor Connect ---
  const visitorRows = (churchId) => pool.query(
    `SELECT id, name, email, phone, visit_date AS "visitDate", message, status, emailed_at AS "emailedAt", created_at AS "createdAt"
       FROM visitor_connects WHERE church_id = $1 ORDER BY created_at DESC LIMIT 1000`, [churchId]
  );
  app.get("/church/me/visitors", churchAuth, async (req, res) => {
    try { res.set("Cache-Control", "no-store"); res.json({ visitors: (await visitorRows(req.church.churchId)).rows }); }
    catch (e) { err(res, e, "GET /church/me/visitors"); }
  });
  app.get("/church/me/visitors.csv", churchAuth, async (req, res) => {
    try {
      const cell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const rows = (await visitorRows(req.church.churchId)).rows.map((v) =>
        [new Date(Number(v.createdAt)).toISOString().slice(0, 10), v.name, v.email, v.phone, v.visitDate, v.message, v.status].map(cell).join(","));
      res.set("Content-Type", "text/csv; charset=utf-8");
      res.set("Content-Disposition", 'attachment; filename="visitor-connect.csv"');
      res.set("Cache-Control", "no-store");
      res.send(["submitted,name,email,phone,planning_to_visit,message,status", ...rows].join("\n"));
    } catch (e) { err(res, e, "GET /church/me/visitors.csv"); }
  });
  app.post("/church/me/visitors/:vid", churchAuth, async (req, res) => {
    const status = String((req.body && req.body.status) || "");
    if (!["new", "contacted", "archived"].includes(status)) return res.status(400).json({ error: "status must be new, contacted or archived" });
    try {
      const r = await pool.query(`UPDATE visitor_connects SET status = $1 WHERE id = $2 AND church_id = $3`, [status, parseInt(req.params.vid, 10), req.church.churchId]);
      if (!r.rowCount) return res.status(404).json({ error: "not found" });
      res.json({ ok: true });
    } catch (e) { err(res, e, "POST /church/me/visitors/:vid"); }
  });

  // --- dashboard: events ---
  app.get("/church/me/events", churchAuth, async (req, res) => {
    try {
      const c = (await pool.query(`SELECT id, calendar_url, timezone FROM churches WHERE id = $1`, [req.church.churchId])).rows[0];
      if (!c) return res.status(404).json({ error: "not found" });
      const tz = tzOf(c);
      const [manual, upcoming] = await Promise.all([manualEvents(c.id, tz), upcomingEvents(c, { limit: 10 })]);
      res.set("Cache-Control", "no-store");
      res.json({ calendarUrl: c.calendar_url || "", timezone: tz, manual, upcoming: upcoming.events, feedError: upcoming.feedError || null });
    } catch (e) { err(res, e, "GET /church/me/events"); }
  });
  app.post("/church/me/events", churchAuth, async (req, res) => {
    try {
      const c = (await pool.query(`SELECT id, timezone FROM churches WHERE id = $1`, [req.church.churchId])).rows[0];
      const ev = parseEventInput(req.body || {}, tzOf(c));
      if (ev.error) return res.status(400).json({ error: ev.error });
      const r = await pool.query(
        `INSERT INTO church_events (church_id, title, starts_at, ends_at, all_day, location, description, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [c.id, ev.title, ev.startsAt, ev.endsAt, ev.allDay, ev.location, ev.description, Date.now()]
      );
      res.json({ ok: true, event: manualRowToEvent(r.rows[0], tzOf(c)) });
    } catch (e) { err(res, e, "POST /church/me/events"); }
  });
  app.delete("/church/me/events/:eventId", churchAuth, async (req, res) => {
    try {
      const id = parseInt(String(req.params.eventId).replace(/^m_/, ""), 10);
      const r = await pool.query(`DELETE FROM church_events WHERE id = $1 AND church_id = $2`, [id, req.church.churchId]);
      if (!r.rowCount) return res.status(404).json({ error: "not found" });
      res.json({ ok: true });
    } catch (e) { err(res, e, "DELETE /church/me/events/:eventId"); }
  });
  app.post("/church/me/calendar", churchAuth, async (req, res) => {
    const raw = String((req.body && req.body.calendarUrl) || "").trim();
    try {
      const c = (await pool.query(`SELECT id, calendar_url, timezone FROM churches WHERE id = $1`, [req.church.churchId])).rows[0];
      if (!raw) {
        await pool.query(`UPDATE churches SET calendar_url = NULL WHERE id = $1`, [c.id]);
        return res.json({ ok: true, calendarUrl: "" });
      }
      const url = normalizeCalendarUrl(raw);
      const test = await fetchIcsEvents(url, { limit: 5, tz: tzOf(c) });
      if (test.error) return res.status(400).json({ error: `We couldn't read that calendar (${test.error}). Paste the calendar's public iCal / "subscribe" link.` });
      await pool.query(`UPDATE churches SET calendar_url = $1 WHERE id = $2`, [url, c.id]);
      feedCache.delete(url);
      res.json({ ok: true, calendarUrl: url, upcomingCount: test.count, sample: test.events.slice(0, 3) });
    } catch (e) { err(res, e, "POST /church/me/calendar"); }
  });

  // --- lightweight dashboard page for these tools ---
  app.get("/church-dashboard", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.type("html").send(DASHBOARD_HTML);
  });
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Church Dashboard · Bible Study Genius</title>
<style>
  :root { --ink:#1d1b38; --muted:#5b5878; --gold:#9a7b1a; --line:#e6e1d4; --bg:#faf7f0; --card:#fff; --ok:#2f7d3a; --bad:#a33f3f; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; line-height:1.5; }
  .wrap { max-width:1000px; margin:0 auto; padding:28px 16px 80px; }
  h1 { font-size:26px; margin:0 0 4px; } h2 { font-size:19px; margin:34px 0 12px; }
  .sub { color:var(--muted); margin:0 0 18px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:12px; }
  .stat .n { font-size:28px; font-weight:800; } .stat .l { color:var(--muted); font-size:13px; }
  input, textarea { width:100%; font:inherit; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:#fff; }
  label { font-size:13px; color:var(--muted); display:block; margin:10px 0 4px; }
  button { font:inherit; font-weight:700; border:0; border-radius:8px; padding:10px 16px; background:var(--gold); color:#fff; cursor:pointer; }
  button.ghost { background:transparent; color:var(--gold); border:1px solid var(--line); padding:6px 10px; font-size:13px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .pill { display:inline-block; font-size:12px; font-weight:700; padding:2px 8px; border-radius:999px; background:#f3ead0; color:#6d5612; }
  .pill.contacted { background:#e2f1e4; color:var(--ok); } .pill.archived { background:#eee; color:#777; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:end; } .row > div { flex:1 1 160px; }
  .msg { color:var(--muted); font-size:14px; margin-top:8px; } .err { color:var(--bad); }
  .scroll { overflow-x:auto; } .hide { display:none; }
  header { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
</style></head>
<body><div class="wrap">
  <div id="login" class="card" style="max-width:420px;margin:40px auto">
    <h1>Church Dashboard</h1><p class="sub">Sign in with your church dashboard login.</p>
    <form id="lf"><label>Email</label><input id="le" type="email" autocomplete="username" required>
    <label>Password</label><input id="lp" type="password" autocomplete="current-password" required>
    <div style="margin-top:14px"><button>Sign in</button></div><div id="lmsg" class="msg err"></div></form>
  </div>
  <div id="app" class="hide">
    <header><div><h1 id="cname">Your church</h1><p class="sub">Sermon quiz, events and Visitor Connect in the Bible Study Genius app</p></div>
      <button class="ghost" id="logout">Sign out</button></header>

    <h2>Engagement</h2>
    <div class="grid" id="stats"></div>
    <div id="quizTable"></div>

    <div id="pro" class="hide">
      <h2 style="font-size:24px;margin-bottom:2px">Sermon Studio</h2>
      <p class="sub">A suite of tools that turns your Sunday sermon into a full week of discipleship.</p>
      <h2>This week's sermon kit</h2>
      <p class="sub">Made from Sunday's sermon every Monday. It's emailed to you, and the guide goes to your small-group leaders.</p>
      <div class="card" id="kit"></div>

      <h2>Small-group leaders</h2>
      <p class="sub">Each leader gets the small-group guide by email every Monday morning.</p>
      <div class="card">
        <label>Add leaders: one per line, like “Jane Smith jane@example.com”</label>
        <textarea id="ldtext" rows="3"></textarea>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button id="ldadd">Add</button><button class="ghost" id="ldsend">Send this week's guide to leaders now</button></div>
        <div id="ldmsg" class="msg"></div>
        <table id="ldt" style="margin-top:10px"></table>
      </div>

      <h2>Visitor welcome email</h2>
      <p class="sub">When someone taps “I’m New / Plan a Visit” and leaves an email, they get this right away. Replies come to your church email. {name}, {church} and {date} fill in automatically.</p>
      <div class="card">
        <textarea id="wmsg" rows="9"></textarea>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button id="wsave">Save</button><button class="ghost" id="wtest">Send me a test</button></div>
        <div id="wmsgout" class="msg"></div>
        <p class="msg">If a visitor is still marked “new” after two days, we’ll send you a reminder.</p>
      </div>

      <h2>Midweek email</h2>
      <p class="sub">Every Wednesday morning, your members get the key verse from Sunday, one question to think about, and a link to the sermon quiz. Each email has an unsubscribe link, and anyone who unsubscribes is never added back.</p>
      <div class="card">
        <p style="margin:0 0 10px" id="mwtext"></p>
        <label>Paste your member email list, or upload a CSV export from your church software (Planning Center, Mailchimp, Breeze, etc.)</label>
        <textarea id="mbtext" rows="4" placeholder="jane@example.com&#10;bob@example.com"></textarea>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button id="mbadd">Add to list</button>
          <label style="margin:0;cursor:pointer;border:1px solid var(--line);border-radius:8px;padding:6px 10px;color:var(--gold);font-weight:700;font-size:13px">Upload CSV<input id="mbfile" type="file" accept=".csv,.txt,text/csv,text/plain" style="display:none"></label></div>
        <div id="mbmsg" class="msg"></div>
        <div class="row" style="margin-top:14px"><div><label>Remove someone</label><input id="mbrm" type="email" placeholder="email@example.com"></div><div style="flex:0 0 auto"><button class="ghost" id="mbrmb">Remove</button></div></div>
      </div>
    </div>

    <h2>Visitor Connect <span id="vcount" class="pill"></span></h2>
    <p class="sub">People who tapped “I’m New / Plan a Visit” on your church’s page. Each one is also emailed to your church contact.</p>
    <div class="card scroll"><div style="text-align:right;margin-bottom:8px"><button class="ghost" id="csv">Download CSV</button></div><table id="vt"></table></div>

    <h2>Upcoming Events</h2>
    <div class="card">
      <strong>Calendar feed</strong>
      <p class="msg" style="margin-top:4px">Paste your calendar’s public iCal / “subscribe” link (Google Calendar, Planning Center Calendar or any .ics). The app shows your next events automatically.</p>
      <div class="row"><div><input id="calurl" placeholder="https://calendar.google.com/calendar/ical/…/public/basic.ics"></div><div style="flex:0 0 auto"><button id="calsave">Save</button></div></div>
      <div id="calmsg" class="msg"></div>
    </div>
    <div class="card" style="margin-top:12px">
      <strong>Add an event by hand</strong>
      <form id="ef">
        <div class="row"><div><label>Title</label><input id="et" required maxlength="140"></div></div>
        <div class="row"><div><label>Date</label><input id="ed" type="date" required></div><div><label>Start time (blank = all day)</label><input id="es" type="time"></div><div><label>End time (optional)</label><input id="ee" type="time"></div></div>
        <div class="row"><div><label>Location (optional)</label><input id="el" maxlength="200"></div></div>
        <div style="margin-top:12px"><button>Add event</button></div><div id="emsg" class="msg"></div>
      </form>
    </div>
    <div class="card scroll" style="margin-top:12px"><strong>What the app shows next</strong><table id="evt" style="margin-top:8px"></table></div>
  </div>
</div>
<script>
(function(){
  var API = location.origin, tok = null;
  try { tok = localStorage.getItem('bsg.church.token'); } catch(e) {}
  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function api(path, opts){ opts = opts||{}; opts.headers = Object.assign({'Content-Type':'application/json','Authorization':'Bearer '+tok}, opts.headers||{});
    return fetch(API+path, opts).then(function(r){ if(r.status===401){ signOut(); throw new Error('Please sign in again.'); } return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||('Error '+r.status)); return j; }); }); }
  function signOut(){ tok=null; try{localStorage.removeItem('bsg.church.token');}catch(e){} $('app').className='hide'; $('login').className='card'; }
  function fmtDate(ms){ var d=new Date(Number(ms)); return isNaN(d)?'':d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); }
  function fmtVisit(s){ if(!s) return ''; var p=s.split('-'); var d=new Date(Date.UTC(+p[0],+p[1]-1,+p[2])); return d.toLocaleDateString(undefined,{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'}); }
  $('lf').onsubmit = function(e){ e.preventDefault(); $('lmsg').textContent='';
    fetch(API+'/church/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('le').value,password:$('lp').value})})
      .then(function(r){return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||'Sign-in failed'); return j; });})
      .then(function(j){ tok=j.token; try{localStorage.setItem('bsg.church.token',tok);}catch(e){} start(); })
      .catch(function(err){ $('lmsg').textContent = err.message==='invalid credentials' ? 'That email and password don’t match.' : err.message; }); };
  $('logout').onclick = signOut;
  function stat(n,l){ return '<div class="card stat"><div class="n">'+esc(n)+'</div><div class="l">'+esc(l)+'</div></div>'; }
  function loadStats(){ return api('/church/me/stats').then(function(s){
    $('stats').innerHTML = stat(s.followers,'Followers') + stat(s.totalPlays,'Sermon plays') +
      stat(s.quizStarts,'Quiz starts') + stat(s.quizCompletions,'Quiz completions') +
      stat(s.quizAvgScorePct==null?'—':s.quizAvgScorePct+'%','Average quiz score') +
      stat(s.eventViews,'Event list views') + stat(s.eventReminders,'Event reminders set') +
      stat(s.visitorSubmissions,'Visitor Connect forms') + stat(s.visitorSubmissionsLast7,'Visitor forms, last 7 days') +
      (s.pro ? stat(s.peopleNearbySawYouLast30,'People nearby who saw your church, last 30 days') + stat(s.sermonSearches,'Sermon searches') +
        stat(s.midweekSubscribers,'Midweek email members') + stat(s.groupLeaders,'Small-group leaders') + stat(s.visitorsWelcomed,'Visitors welcomed by email') : '');
    var q = s.quizBySermon||[];
    $('quizTable').innerHTML = q.length ? '<div class="card scroll" style="margin-top:12px"><strong>Quiz by sermon</strong><table style="margin-top:8px"><tr><th>Sermon</th><th>Completions</th><th>Average score</th></tr>'+
      q.map(function(r){return '<tr><td>'+esc(r.title||('Sermon '+r.sermonId))+'</td><td>'+r.completions+'</td><td>'+(r.avgScorePct==null?'—':r.avgScorePct+'%')+'</td></tr>';}).join('')+'</table></div>' : '';
  }); }
  function loadVisitors(){ return api('/church/me/visitors').then(function(j){
    var v=j.visitors||[], unread=v.filter(function(x){return x.status==='new';}).length;
    $('vcount').textContent = unread ? unread+' new' : ''; $('vcount').className = unread ? 'pill' : 'hide';
    $('vt').innerHTML = v.length ? '<tr><th>Received</th><th>Name</th><th>Contact</th><th>Visiting</th><th>Message</th><th>Status</th></tr>' + v.map(function(x){
      return '<tr><td>'+fmtDate(x.createdAt)+'</td><td>'+esc(x.name)+'</td><td>'+(x.email?'<a href="mailto:'+esc(x.email)+'">'+esc(x.email)+'</a><br>':'')+(x.phone?'<a href="tel:'+esc(x.phone)+'">'+esc(x.phone)+'</a>':'')+'</td><td>'+esc(fmtVisit(x.visitDate))+'</td><td>'+esc(x.message||'')+'</td>'+
        '<td><span class="pill '+esc(x.status)+'">'+esc(x.status)+'</span><br>'+
        (x.status!=='contacted'?'<button class="ghost" data-v="'+x.id+'" data-s="contacted">Mark contacted</button> ':'')+
        (x.status!=='archived'?'<button class="ghost" data-v="'+x.id+'" data-s="archived">Archive</button>':'<button class="ghost" data-v="'+x.id+'" data-s="new">Restore</button>')+'</td></tr>'; }).join('')
      : '<tr><td class="msg">No Visitor Connect forms yet. They appear here (and in your email) as soon as someone sends one.</td></tr>';
  }); }
  $('vt').onclick = function(e){ var b=e.target.closest('button[data-v]'); if(!b) return; api('/church/me/visitors/'+b.getAttribute('data-v'),{method:'POST',body:JSON.stringify({status:b.getAttribute('data-s')})}).then(loadVisitors).catch(function(err){alert(err.message);}); };
  $('csv').onclick = function(){ fetch(API+'/church/me/visitors.csv',{headers:{Authorization:'Bearer '+tok}}).then(function(r){return r.blob();}).then(function(b){ var a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download='visitor-connect.csv'; document.body.appendChild(a); a.click(); a.remove(); }); };
  function loadEvents(){ return api('/church/me/events').then(function(j){
    $('calurl').value = j.calendarUrl||''; $('calmsg').className='msg'+(j.feedError?' err':''); $('calmsg').textContent = j.feedError ? 'Your calendar feed could not be read right now ('+j.feedError+').' : '';
    var up=j.upcoming||[];
    $('evt').innerHTML = up.length ? '<tr><th>When</th><th>Event</th><th>Where</th><th>From</th><th></th></tr>'+up.map(function(e){ return '<tr><td>'+esc(e.when)+'</td><td>'+esc(e.title)+'</td><td>'+esc(e.location||'')+'</td><td>'+(e.source==='manual'?'Added here':'Calendar feed')+'</td><td>'+(e.source==='manual'?'<button class="ghost" data-del="'+esc(e.id)+'">Delete</button>':'')+'</td></tr>'; }).join('')
      : '<tr><td class="msg">No upcoming events yet. Add a calendar feed or an event above.</td></tr>';
  }); }
  $('evt').onclick = function(e){ var b=e.target.closest('button[data-del]'); if(!b||!confirm('Delete this event?')) return; api('/church/me/events/'+b.getAttribute('data-del'),{method:'DELETE'}).then(loadEvents).catch(function(err){alert(err.message);}); };
  $('calsave').onclick = function(){ $('calmsg').className='msg'; $('calmsg').textContent='Checking your calendar…';
    api('/church/me/calendar',{method:'POST',body:JSON.stringify({calendarUrl:$('calurl').value})}).then(function(j){ $('calmsg').textContent = j.calendarUrl ? 'Saved. Found '+j.upcomingCount+' upcoming event'+(j.upcomingCount===1?'':'s')+'.' : 'Calendar feed removed.'; return loadEvents(); })
      .catch(function(err){ $('calmsg').className='msg err'; $('calmsg').textContent=err.message; }); };
  $('ef').onsubmit = function(e){ e.preventDefault(); $('emsg').className='msg'; $('emsg').textContent='';
    api('/church/me/events',{method:'POST',body:JSON.stringify({title:$('et').value,date:$('ed').value,time:$('es').value,endTime:$('ee').value,location:$('el').value})})
      .then(function(){ $('ef').reset(); $('emsg').textContent='Added.'; return loadEvents(); }).catch(function(err){ $('emsg').className='msg err'; $('emsg').textContent=err.message; }); };
  function loadPro(){ return api('/church/me/pro').then(function(p){
    $('pro').className = p.pro ? '' : 'hide';
    if (!p.pro) return;
    var k = p.kit;
    $('kit').innerHTML = !k ? '<p class="msg">Your kit appears here after your first sermon is processed.</p>' :
      '<strong>'+esc(k.title||'Latest sermon')+'</strong>'+(k.theme?'<p class="msg">'+esc(k.theme)+'</p>':'')+
      '<p><a href="'+esc(k.guideUrl)+'" target="_blank" rel="noopener">Open the small-group guide</a> ('+k.questions+' questions with leader notes)</p>'+
      (k.quotes.length ? '<p style="margin:14px 0 6px"><strong>Quote cards for social media</strong></p><div class="grid">'+k.quotes.map(function(q,i){
        return '<div><a href="'+esc(q.imageUrl)+'?download=1"><img src="'+esc(q.imageUrl)+'" style="width:100%;border-radius:8px" alt="Quote card '+(i+1)+'"></a>'+
          '<div class="msg">'+esc(q.caption||'')+'</div><a class="msg" href="'+esc(q.imageUrl)+'?download=1">Download</a></div>'; }).join('')+'</div>'
        : '<p class="msg">'+(k.fallback?'Quote cards need the sermon audio transcript, which this sermon doesn’t have.':'No quote cards this week.')+'</p>')+
      (k.midweek && k.midweek.keyVerse ? '<p class="msg" style="margin-top:14px">Midweek email: key verse '+esc(k.midweek.keyVerse)+' · “'+esc(k.midweek.question||'')+'”</p>' : '')+
      '<div style="margin-top:10px"><button class="ghost" id="kitre">Rebuild kit</button> <span id="kitmsg" class="msg"></span></div>';
    var L = p.leaders||[];
    $('ldt').innerHTML = L.length ? '<tr><th>Name</th><th>Email</th><th></th></tr>'+L.map(function(l){ return '<tr><td>'+esc(l.name||'')+'</td><td>'+esc(l.email)+(l.unsubscribed?' <span class="pill archived">unsubscribed</span>':'')+'</td><td><button class="ghost" data-ld="'+l.id+'">Remove</button></td></tr>'; }).join('')
      : '<tr><td class="msg">No leaders yet.</td></tr>';
    if (!$('wmsg').dataset.loaded) { $('wmsg').value = p.welcomeMessage||''; $('wmsg').dataset.loaded='1'; }
    $('mwtext').innerHTML = '<strong>'+p.midweekSubscribers+'</strong> '+(p.midweekSubscribers===1?'person is':'people are')+' on your midweek email list.';
  }); }
  $('kit').onclick = function(e){ if(e.target.id!=='kitre') return; $('kitmsg').textContent='Rebuilding… (about 30 seconds)';
    api('/church/me/kit/rebuild',{method:'POST'}).then(loadPro).catch(function(err){ $('kitmsg').textContent=err.message; }); };
  $('ldadd').onclick = function(){ $('ldmsg').className='msg'; api('/church/me/leaders',{method:'POST',body:JSON.stringify({text:$('ldtext').value})}).then(function(j){ $('ldtext').value=''; $('ldmsg').textContent='Added '+j.added+'.'; return loadPro(); }).catch(function(err){ $('ldmsg').className='msg err'; $('ldmsg').textContent=err.message; }); };
  $('ldsend').onclick = function(){ if(!confirm('Email this week’s guide to all your leaders now?')) return; $('ldmsg').className='msg'; $('ldmsg').textContent='Sending…';
    api('/church/me/kit/send-leaders',{method:'POST'}).then(function(j){ $('ldmsg').textContent = j.sent ? 'Sent to '+j.sent+' leader'+(j.sent===1?'':'s')+'.' : 'Nothing sent ('+(j.reason||'no leaders')+').'; }).catch(function(err){ $('ldmsg').className='msg err'; $('ldmsg').textContent=err.message; }); };
  $('ldt').onclick = function(e){ var b=e.target.closest('button[data-ld]'); if(!b||!confirm('Remove this leader?')) return; api('/church/me/leaders/'+b.getAttribute('data-ld'),{method:'DELETE'}).then(loadPro).catch(function(err){alert(err.message);}); };
  $('wsave').onclick = function(){ api('/church/me/welcome',{method:'POST',body:JSON.stringify({message:$('wmsg').value})}).then(function(j){ $('wmsg').value=j.welcomeMessage; $('wmsgout').textContent='Saved.'; }).catch(function(err){ $('wmsgout').textContent=err.message; }); };
  $('wtest').onclick = function(){ api('/church/me/welcome',{method:'POST',body:JSON.stringify({message:$('wmsg').value})}).then(function(){ return api('/church/me/welcome/test',{method:'POST'}); }).then(function(j){ $('wmsgout').textContent = j.ok ? 'Test sent to '+j.sentTo+'.' : (j.error || 'The test email couldn’t be sent.'); }).catch(function(err){ $('wmsgout').textContent=err.message; }); };
  function addMembers(text){ $('mbmsg').className='msg'; $('mbmsg').textContent='Adding…';
    api('/church/me/members',{method:'POST',body:JSON.stringify({text:text})}).then(function(j){
      $('mbtext').value=''; $('mbmsg').textContent='Found '+j.found+' email'+(j.found===1?'':'s')+': added '+j.added+(j.alreadyOnList?', '+j.alreadyOnList+' already on the list':'')+(j.unsubscribed?', '+j.unsubscribed+' had unsubscribed and were not added back':'')+'.'; return loadPro(); })
      .catch(function(err){ $('mbmsg').className='msg err'; $('mbmsg').textContent=err.message; }); }
  $('mbadd').onclick = function(){ addMembers($('mbtext').value); };
  $('mbfile').onchange = function(){ var f=this.files&&this.files[0]; if(!f) return; var r=new FileReader(); r.onload=function(){ addMembers(String(r.result||'')); }; r.readAsText(f); this.value=''; };
  $('mbrmb').onclick = function(){ api('/church/me/members/remove',{method:'POST',body:JSON.stringify({text:$('mbrm').value})}).then(function(j){ $('mbrm').value=''; $('mbmsg').className='msg'; $('mbmsg').textContent = j.removed ? 'Removed.' : 'That email wasn’t on the list.'; return loadPro(); }).catch(function(err){ $('mbmsg').className='msg err'; $('mbmsg').textContent=err.message; }); };
  function start(){ $('login').className='hide'; $('app').className='';
    api('/church/me').then(function(j){ $('cname').textContent = (j.church && (j.church.displayName||j.church.name)) || 'Your church'; }).catch(function(){});
    loadStats().catch(function(){}); loadPro().catch(function(){}); loadVisitors().catch(function(){}); loadEvents().catch(function(){}); }
  if (tok) start();
})();
</script>
</body></html>`;
