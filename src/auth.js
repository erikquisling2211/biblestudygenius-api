import { createClient } from "@supabase/supabase-js";
import { verifyToken } from "@clerk/backend";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  // New auth: Supabase
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data?.user) { req.userId = data.user.id; return next(); }
  } catch (e) {}

  // Transition fallback: existing Clerk sessions (build 54 / App Review)
  try {
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    if (payload?.sub) { req.userId = payload.sub; return next(); }
  } catch (e) {}

  return res.status(401).json({ error: "Invalid or expired token" });
}
