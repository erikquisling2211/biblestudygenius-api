/*
 * localsermons.js — nearby churches ("Local Sermons") via OpenStreetMap Overpass (free).
 * Wiring (src/index.js):
 *   import { mountLocalSermons } from "./localsermons.js";
 *   mountLocalSermons(app);
 * Endpoint:
 *   GET /churches/near?zip=78701&radius=25
 *     -> { zip, lat, lon, radius, count, churches:[{id,name,lat,lon,address,denomination,website,distance,paid}] }
 * Requires: npm install us-zips   (Node 18+ for global fetch; backend is on Node 24)
 */
import ZIPS from "us-zips";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // cache a zip's result 30 days
const cache = new Map();

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchOverpass(lat, lon, radiusM) {
  // place_of_worship with a christian religion tag OR no religion tag at all
  // (many churches in OSM are untagged for religion).
  const q =
    `[out:json][timeout:25];(` +
    `nwr["amenity"="place_of_worship"]["religion"="christian"](around:${radiusM},${lat},${lon});` +
    `nwr["amenity"="place_of_worship"][!"religion"](around:${radiusM},${lat},${lon});` +
    `);out center tags;`;
  let lastErr = "no endpoints tried";
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "BibleStudyGenius/1.0 (church finder; contact: support@biblestudygenius.com)",
        },
        body: "data=" + encodeURIComponent(q),
      });
      if (!res.ok) { lastErr = `${url} -> HTTP ${res.status}`; continue; }
      const d = await res.json();
      return { elements: Array.isArray(d.elements) ? d.elements : [], error: null };
    } catch (e) {
      lastErr = `${url} -> ${(e && e.message) || e}`;
    }
  }
  return { elements: [], error: lastErr };
}

function toChurch(el, oLat, oLon) {
  const t = el.tags || {};
  if (!t.name) return null;
  const lat = el.lat != null ? el.lat : el.center && el.center.lat;
  const lon = el.lon != null ? el.lon : el.center && el.center.lon;
  if (lat == null || lon == null) return null;
  const street = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
  const city = [t["addr:city"], t["addr:state"]].filter(Boolean).join(", ");
  const address = [street, city, t["addr:postcode"]].filter(Boolean).join(", ") || null;
  return {
    id: `osm_${el.type[0]}${el.id}`,
    name: t.name,
    lat, lon,
    address,
    denomination: t.denomination || null,
    website: t.website || t["contact:website"] || null,
    distance: Math.round(haversineMiles(oLat, oLon, lat, lon) * 10) / 10,
    paid: false,
  };
}

export function mountLocalSermons(app) {
  app.get("/churches/near", async (req, res) => {
    try {
      const zip = String(req.query.zip || "").trim().slice(0, 5);
      let radius = parseFloat(req.query.radius) || 25;
      radius = Math.min(Math.max(radius, 1), 100);
      const z = ZIPS[zip];
      if (!z) return res.status(404).json({ error: "unknown zip", churches: [] });

      const key = `${zip}:${radius}`;
      const now = Date.now();
      const hit = cache.get(key);
      if (hit && now - hit.at < TTL_MS) return res.json(hit.data);

      const { elements, error } = await fetchOverpass(z.latitude, z.longitude, Math.round(radius * 1609.34));
      if (error) console.error("overpass", error);

      let churches = elements.map((el) => toChurch(el, z.latitude, z.longitude)).filter(Boolean);
      const seen = new Set();
      churches = churches.filter((c) => {
        const k = c.name.toLowerCase() + c.lat.toFixed(3) + c.lon.toFixed(3);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      churches.sort((a, b) => a.distance - b.distance);
      churches = churches.slice(0, 60);

      // TODO: merge paid churches from own DB here (mark paid:true, prepend / feature).

      const data = { zip, lat: z.latitude, lon: z.longitude, radius, count: churches.length, churches };
      if (error) data.error = error; // surface overpass failure for debugging
      // Only cache real, non-empty results so a transient failure isn't frozen for 30 days.
      if (!error && churches.length > 0) cache.set(key, { at: now, data });
      res.json(data);
    } catch (e) {
      console.error("GET /churches/near", e);
      res.status(500).json({ error: String((e && e.message) || e), churches: [] });
    }
  });
}

// local sanity check (no network): node localsermons.js
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("zip 78701 ->", ZIPS["78701"]);
  console.log("haversine Austin->Dallas mi:", Math.round(haversineMiles(30.27, -97.74, 32.78, -96.80)));
  const sample = toChurch({ type: "node", id: 1, lat: 30.28, lon: -97.74, tags: { name: "First Baptist", "addr:housenumber": "901", "addr:street": "Trinity St", "addr:city": "Austin", "addr:state": "TX", "addr:postcode": "78701", denomination: "baptist" } }, 30.27, -97.74);
  console.log("parsed church:", JSON.stringify(sample));
}
