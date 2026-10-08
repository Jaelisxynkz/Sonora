// Sonora Cloudflare Worker — SoundCloud API proxy only.
//
// Stateless: no R2 / KV / D1 bindings required. Forwards validated
// SoundCloud API requests with CORS + caching so the client avoids
// browser CORS restrictions. Creator file storage is not handled here.
//
//   POST / { url, params }  -> proxied SoundCloud response

// ---------------------------------------------------------------------------
// Centralized release manifest (SonoraRelease).
// ONE source of truth for every platform. To publish a new version: bump
// `version`, add release notes, update the platform download URLs, and
// redeploy this worker. Every installed Sonora detects the update on next
// launch — no per-app hardcoding.
// Centralized release manifest — the single source of truth for every
// installed Sonora across every platform.
//
// `available` is the operator's explicit declaration that a real, hosted
// artifact exists for that platform. The client TRUSTS it for the "Coming
// Soon" gate, then VERIFIES the URL is actually reachable before showing a
// download button — two independent layers of honesty. To publish a release:
//   1. Build the real artifact (npm run build:windows / build:android / build:ios)
//   2. Host it at a real URL (R2, CDN, GitHub Releases)
//   3. Set available=true, fill url + size + sha256
//   4. Redeploy this worker
// Every installed Sonora detects the update on next launch.
const RELEASE = {
  version: "1.1.0",
  codename: "Aurora",
  releaseDate: "2026-10-08",
  minVersion: "1.0.0",
  mandatory: false,
  channel: "pre-release",
  releaseNotes: [
    "Multi-artist Smart Playlist — search and blend any number of artists into one taste-ranked playlist",
    "Artist Mixes for every artist — Spotify-style mixes generated on demand",
    "Pages auto-load with zero flash — cross-mount caching eliminates skeleton stutter",
    "Discord Rich Presence shows 'Listening to Sonora' with a live progress bar",
    "Shared application core across Web, Windows, Android, and iOS",
    "Centralized update architecture via the Sonora Cloudflare Worker",
    "SonoraMigrationManager for safe, versioned local data migrations",
    "Premium music streaming with personalized discovery and offline downloads",
  ],
  platforms: {
    web: {
      available: true,
      version: "1.1.0",
      url: "https://sonora-hub.base44.app",
      type: "pwa",
    },
    electron: {
      available: true,
      version: "1.1.0",
      architecture: "x64",
      url: "https://github.com/Jaelisxynkz/Sonora/releases/latest",
      type: "nsis",
      size: 95000000,
      sha256: null,
      channel: "pre-release",
    },
    android: {
      available: true,
      version: "1.1.0",
      architecture: "arm64",
      url: "https://github.com/Jaelisxynkz/Sonora/releases/latest",
      type: "apk",
      size: 12000000,
      sha256: null,
      channel: "pre-release",
    },
    ios: {
      available: false,
      version: "1.1.0",
      appStoreUrl: null,
      type: "appstore",
      channel: "pre-release",
    },
  },
};

// ---------------------------------------------------------------------------
// Live release source: the latest GitHub Release published by the
// "Release Sonora apps" workflow (ci/release.yml). When GITHUB_REPO is set in
// wrangler.toml, any .exe / .apk attached to the latest release automatically
// becomes the real download for Windows / Android — no manual manifest edits.
async function githubLatest(env) {
  const repo = env && env.GITHUB_REPO;
  if (!repo) return null;
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      "User-Agent": "Sonora-Worker",
      Accept: "application/vnd.github+json",
      ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
    },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) return null;
  return res.json();
}

function findAsset(gh, ext) {
  return (gh?.assets || []).find((a) => a.name.toLowerCase().endsWith(ext)) || null;
}

async function buildRelease(env, origin) {
  const rel = structuredClone(RELEASE);
  const gh = await githubLatest(env).catch(() => null);
  if (!gh) return rel;
  const ver = String(gh.tag_name || "").replace(/^v/, "") || rel.version;
  rel.version = ver;
  if (gh.published_at) rel.releaseDate = gh.published_at.slice(0, 10);
  const notes = String(gh.body || "").split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
  if (notes.length) rel.releaseNotes = notes;
  const asAvailable = (a) => ({
    available: true,
    version: ver,
    url: `${origin}/releases/asset/${encodeURIComponent(a.name)}`,
    size: a.size,
    sha256: typeof a.digest === "string" && a.digest.startsWith("sha256:") ? a.digest.slice(7) : null,
  });
  const exe = findAsset(gh, ".exe");
  const apk = findAsset(gh, ".apk");
  if (exe) rel.platforms.electron = { ...rel.platforms.electron, ...asAvailable(exe) };
  if (apk) rel.platforms.android = { ...rel.platforms.android, ...asAvailable(apk) };
  return rel;
}

// Streams a release asset from GitHub with CORS + Range so the Download
// Center can show progress, verify SHA-256, and save the file.
async function releaseAsset(request, env, name) {
  const gh = await githubLatest(env).catch(() => null);
  const asset = (gh?.assets || []).find((a) => a.name === name);
  if (!asset) return json({ error: "Release file not found" }, 404);
  const range = request.headers.get("Range");
  const upstream = await fetch(asset.browser_download_url, {
    redirect: "follow",
    headers: { "User-Agent": "Sonora-Worker", ...(range ? { Range: range } : {}) },
  });
  if (!upstream.ok) return json({ error: `Upstream error (${upstream.status})` }, 502);
  const headers = {
    ...CORS,
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${name.replace(/["\\]/g, "")}"`,
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=300",
  };
  for (const h of ["content-length", "content-range"]) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

// Per-platform update check. Compares the client's installed version against
// the latest release and returns a structured result the UI renders directly.
async function updateCheck(request, env) {
  try {
    const url = new URL(request.url);
    const RELEASE_NOW = await buildRelease(env, url.origin);
    const platform = url.searchParams.get("platform") || "web";
    const current = url.searchParams.get("current") || "0.0.0";
    const latest = RELEASE_NOW.version;
    const updateAvailable = compareSemver(latest, current) > 0;
    const belowMinimum = compareSemver(current, RELEASE_NOW.minVersion) < 0;
    const platInfo = RELEASE_NOW.platforms[platform] || {};
    return json({
      ok: true,
      current,
      latest,
      updateAvailable,
      mandatory: belowMinimum || RELEASE_NOW.mandatory,
      belowMinimum,
      downloadUrl: platInfo.url || null,
      size: platInfo.size || null,
      type: platInfo.type || null,
      releaseNotes: RELEASE_NOW.releaseNotes,
      releaseDate: RELEASE_NOW.releaseDate,
      minVersion: RELEASE_NOW.minVersion,
    });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

function compareSemver(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

const CLIENT_ID = "dkevB9EsY4jIoSm8RfddPNUKyn6hurXF";
const ALLOWED_HOSTS = [
  "api-v2.soundcloud.com",
  "api.soundcloud.com",
  "api-widget.soundcloud.com",
];

// Hosts permitted for media/image downloads (audio CDN + artwork CDN).
function isDlHost(host) {
  return (
    host === "cf-media.sndcdn.com" ||
    host === "api-v2.soundcloud.com" ||
    host === "playback.media-streaming.soundcloud.cloud" ||
    /\.sndcdn\.com$/.test(host) ||
    /\.soundcloud\.com$/.test(host) ||
    /\.media-streaming\.soundcloud\.cloud$/.test(host)
  );
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check — used by the client to test worker reachability
    if (path === "/health") return json({ ok: true, ts: Date.now() });

    // Centralized release manifest — the single source of truth for every
    // installed Sonora (web, Windows, Android, iOS) to check for updates.
    if (path === "/version" || path === "/releases") return json(await buildRelease(env, url.origin), 200, { "Cache-Control": "public, max-age=60" });
    // Per-platform update check: ?platform=electron&current=1.0.0
    if (path === "/updates") return updateCheck(request, env);
    // Real installer files streamed from the latest GitHub release
    if (path.startsWith("/releases/asset/")) {
      return releaseAsset(request, env, decodeURIComponent(path.slice("/releases/asset/".length)));
    }
    if (path.startsWith("/releases/")) {
      const rel = await buildRelease(env, url.origin);
      const plat = path.slice("/releases/".length);
      const info = rel.platforms?.[plat];
      if (!info) return json({ error: "Unknown platform" }, 404);
      return json({
        version: rel.version,
        codename: rel.codename,
        releaseDate: rel.releaseDate,
        minVersion: rel.minVersion,
        channel: rel.channel,
        releaseNotes: rel.releaseNotes,
        platform: info,
      });
    }

    // SoundCloud API proxy
    if ((path === "/" || path === "/sc") && request.method === "POST") return scProxy(request);
    // Producer AI — Cloudflare Workers AI arrangement planner (bypasses Base44 credits)
    if (path === "/ai/arrange" && request.method === "POST") return aiArrange(request, env);
    // Media/image download proxy — streams bytes back with attachment headers
    // so the browser can fetch cross-origin SoundCloud CDN URLs as blobs.
    if (path === "/dl" && (request.method === "POST" || request.method === "GET")) return dlProxy(request);

    return json({ error: "Not found" }, 404);
  },
};

async function scProxy(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { url: target, params } = body || {};
    if (!target || typeof target !== "string") return json({ error: "Missing url" }, 400);
    let u;
    try { u = new URL(target); } catch { return json({ error: "Invalid url" }, 400); }
    if (!ALLOWED_HOSTS.includes(u.hostname)) return json({ error: "Host not allowed" }, 400);
    if (u.protocol !== "https:") return json({ error: "https only" }, 400);
    if (params && typeof params === "object") {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
      }
    }
    u.searchParams.set("client_id", CLIENT_ID);
    if (u.searchParams.has("limit")) {
      const n = parseInt(u.searchParams.get("limit"), 10);
      if (n > 50) u.searchParams.set("limit", "50");
    }
    const upstream = await fetch(u.toString(), {
      headers: { Accept: "application/json", "User-Agent": "Sonora/1.0" },
      redirect: "follow",
    });
    // Server-side fallback for deprecated SoundCloud endpoints (charts/top,
    // featured-playlists, genre-specific charts). Synthesizes a valid response
    // from search so the client always gets real data — no dependency on the
    // credit-gated Base44 backend fallback.
    if (upstream.status === 404) {
      const fb = await synthFallback(u);
      if (fb !== null) return json(fb);
    }
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        "Cache-Control": "public, max-age=60",
        ...CORS,
      },
    });
  } catch (error) {
    return json({ error: error.message || "Proxy error" }, 500);
  }
}

// ---------------------------------------------------------------------------
// Server-side fallbacks for deprecated SoundCloud endpoints.
// When SoundCloud 404s an endpoint the app still needs, synthesize a valid
// response from search so the client always gets real data.
const CHART_GENRE_QUERIES = {
  "soundcloud:genres:all-music": "popular",
  "soundcloud:genres:pop": "pop",
  "soundcloud:genres:hiphoprap": "hip hop rap",
  "soundcloud:genres:rock": "rock",
  "soundcloud:genres:electronic": "electronic",
  "soundcloud:genres:danceedm": "dance edm",
  "soundcloud:genres:rbsoul": "r&b soul",
  "soundcloud:genres:ambient": "ambient",
  "soundcloud:genres:classical": "classical",
  "soundcloud:genres:country": "country",
  "soundcloud:genres:jazz": "jazz",
  "soundcloud:genres:latin": "latin",
  "soundcloud:genres:metal": "metal",
  "soundcloud:genres:reggae": "reggae",
  "soundcloud:genres:techno": "techno",
  "soundcloud:genres:deephouse": "deep house",
  "soundcloud:genres:alternativerock": "alternative rock",
};

// Internal helper — fetch a SoundCloud API URL with client_id + limit cap.
async function scFetch(url, params = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  }
  u.searchParams.set("client_id", CLIENT_ID);
  if (u.searchParams.has("limit")) {
    const n = parseInt(u.searchParams.get("limit"), 10);
    if (n > 50) u.searchParams.set("limit", "50");
  }
  const res = await fetch(u.toString(), {
    headers: { Accept: "application/json", "User-Agent": "Sonora/1.0" },
    redirect: "follow",
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function synthFallback(u) {
  const path = u.pathname;
  const limit = Math.min(50, parseInt(u.searchParams.get("limit") || "50", 10));

  // featured-playlists → search for popular playlists across several queries
  if (path === "/featured-playlists") {
    const queries = ["top hits 2026", "best playlists", "featured", "popular hits"];
    const seen = new Set();
    const collection = [];
    for (const q of queries) {
      if (collection.length >= limit) break;
      const r = await scFetch("https://api-v2.soundcloud.com/search/playlists", { q, limit: Math.min(20, limit - collection.length + 5) });
      if (!r?.collection) continue;
      for (const p of r.collection) {
        if (p && !seen.has(p.id) && (p.track_count || 0) >= 3) {
          seen.add(p.id);
          collection.push(p);
        }
      }
    }
    if (!collection.length) return null;
    return { collection, next_href: null, query_urn: "synth-featured" };
  }

  // charts → trending all-music sorted by plays (top), or genre search
  if (path === "/charts") {
    const kind = u.searchParams.get("kind");
    const genre = u.searchParams.get("genre");

    // "top" → fetch trending all-music and re-sort by playback_count
    if (kind === "top") {
      const r = await scFetch("https://api-v2.soundcloud.com/charts", {
        kind: "trending", genre: "soundcloud:genres:all-music", limit,
      });
      if (r?.collection) {
        r.collection.sort((a, b) =>
          (b.track?.playback_count || 0) - (a.track?.playback_count || 0)
        );
        r.kind = "top";
        return r;
      }
    }

    // genre-specific → search by genre query, sort by plays
    const q = CHART_GENRE_QUERIES[genre];
    if (q) {
      const r = await scFetch("https://api-v2.soundcloud.com/search/tracks", { q, limit });
      if (r?.collection) {
        const collection = r.collection
          .filter((t) => t && t.streamable)
          .sort((a, b) => (b.playback_count || 0) - (a.playback_count || 0))
          .map((t) => ({ track: t, score: t.playback_count || 0 }));
        if (collection.length) {
          return { genre, kind: kind || "trending", collection, last_updated: new Date().toISOString(), query_urn: "synth-charts" };
        }
      }
    }

    // ultimate fallback: trending all-music as-is
    const r = await scFetch("https://api-v2.soundcloud.com/charts", {
      kind: "trending", genre: "soundcloud:genres:all-music", limit,
    });
    return r;
  }

  return null;
}

// Download proxy — fetches a SoundCloud media/artwork URL server-side and
// streams the bytes back with permissive CORS + an attachment
// Content-Disposition, so the client can save cross-origin CDN content.
async function dlProxy(request) {
  try {
    let target, filename;
    if (request.method === "GET") {
      const q = new URL(request.url);
      target = q.searchParams.get("url");
      filename = q.searchParams.get("filename");
    } else {
      const body = await request.json().catch(() => ({}));
      target = body.url;
      filename = body.filename;
    }
    if (!target || typeof target !== "string") return json({ error: "Missing url" }, 400);
    let u;
    try { u = new URL(target); } catch { return json({ error: "Invalid url" }, 400); }
    if (u.protocol !== "https:") return json({ error: "https only" }, 400);
    if (!isDlHost(u.hostname)) return json({ error: "Host not allowed" }, 400);
    // Forward Range so <audio> can stream + seek through the proxy (206).
    const range = request.headers.get("Range");
    const upstream = await fetch(u.toString(), { redirect: "follow", headers: range ? { Range: range } : {} });
    if (!upstream.ok) return json({ error: `Upstream error (${upstream.status})` }, 502);
    const headers = {
      "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };
    for (const h of ["content-length", "content-range"]) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }
    if (filename) {
      const safe = String(filename).replace(/["\\]/g, "").slice(0, 200);
      headers["Content-Disposition"] = `attachment; filename="${safe}"`;
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    return json({ error: error.message || "Download proxy error" }, 500);
  }
}

// ---------------------------------------------------------------------------
// Producer AI — arrangement planner (Cloudflare Workers AI)
//   POST /ai/arrange { analysis:{A,B}, plan, settings, seed }
//   -> { directions:[{ lead, blueprint:[...], sections:[{type,feature[]}], rationale }] }
// The model only ARRANGES the real analysis the client sends (BPM, key, phrase
// energies/vocal/width). It never invents audio signals, so the honest-signaling
// policy holds. The client validates everything again and falls back to the
// heuristic planner if this endpoint is unreachable or returns garbage.
const AI_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast", // strongest first
  "@cf/meta/llama-3.1-8b-instruct",           // reliable fallback
];
const VALID_TYPES = ["intro","entry","build","drop","hook","bridge","second","breakdown","switch","hybrid","final","outro"];
const VALID_ROLES = ["hook","vocal","motif","texture"];

async function aiArrange(request, env) {
  if (!env || !env.AI) return json({ error: "Workers AI binding not configured" }, 503);
  const body = await request.json().catch(() => ({}));
  const { analysis, plan, settings, seed } = body || {};
  if (!analysis || !analysis.A || !analysis.B) return json({ error: "Missing analysis" }, 400);
  const messages = buildArrangePrompt(analysis, plan, settings, seed);

  let raw = null;
  for (const model of AI_MODELS) {
    try {
      const res = await env.AI.run(model, { messages, max_tokens: 1700, temperature: 0.85 });
      raw = res?.response || res?.result?.response || (typeof res === "string" ? res : null);
      if (raw) break;
    } catch (e) { /* try the next model */ }
  }
  if (!raw) return json({ error: "AI returned no output" }, 502);
  const parsed = extractJson(raw);
  if (!parsed) return json({ error: "AI output was not valid JSON" }, 502);
  const directions = sanitizeDirections(parsed);
  if (!directions.length) return json({ error: "AI output failed validation" }, 502);
  return json({ directions });
}

function buildArrangePrompt(analysis, plan, settings, seed) {
  const snap = (an) => ({
    title: an.title, artist: an.artist, bpm: Math.round(an.bpm), key: an.key || "unknown",
    durationSec: Math.round(an.durationSec || 0),
    phrases: (an.phrases || []).slice(0, 12).map((p) => ({
      label: p.label, start: Math.round((p.start || 0) * 10) / 10,
      energy: Math.round((p.energy ?? 0.5) * 100) / 100,
      vocal: Math.round((p.vocal ?? 0.3) * 100) / 100,
      width: Math.round((p.width ?? 0.3) * 100) / 100,
    })),
  });
  const sys = "You are Sonora's Producer AI — a professional music producer and arranger. You receive the REAL audio analysis of two songs (BPM, musical key, and a phrase list with energy, vocal-presence and stereo-width) plus the user's creative settings and the compatibility plan (target tempo, key relation, time-stretch). You design ORIGINAL song arrangements that combine material from BOTH songs into one new track. You NEVER invent BPM, key, or energy — you only choose the structure and which analyzed element to feature where. Respond with ONLY a single JSON object, no markdown, no prose.";
  const user = `Songs (real analysis):
A: ${JSON.stringify(snap(analysis.A))}
B: ${JSON.stringify(snap(analysis.B))}
Plan: targetBpm=${Math.round(plan?.targetBpm)}, keyLabel=${plan?.keyLabel || "unknown"}, transposeB=${plan?.transposeB || 0} semitones, stretchA=${((plan?.relA || 1) - 1).toFixed(2)}, stretchB=${((plan?.relB || 1) - 1).toFixed(2)}
Settings: mode=${settings?.mode}, influenceA=${settings?.influenceA}, influenceB=${settings?.influenceB}, creativity=${settings?.creativity}, energy=${settings?.energy}, vocalFocus=${settings?.vocalFocus}

Design 2 DISTINCT arrangement directions. Each is a JSON object:
{
  "lead": "A" or "B",
  "blueprint": [6-9 section types in order],
  "sections": [one object per blueprint entry, same order: {"type": <type>, "feature": [{"src":"A"|"B","role":"hook"|"vocal"|"motif"|"texture"}, ...]}],
  "rationale": "one short sentence"
}
Valid section types: ${VALID_TYPES.join(", ")}.
Valid roles: ${VALID_ROLES.join(", ")}.
Rules:
- "feature" lists 0-3 elements to layer in that section. Pick the most musically fitting analyzed phrase for each role: "hook" = high-energy vocal phrase, "vocal" = clear verse, "motif" = instrumental phrase, "texture" = wide/atmospheric phrase.
- Build a believable energy arc: low intro, rising build, peak at hook/drop, a breakdown or bridge, then resolve to outro.
- Make the two directions genuinely different (different lead OR different structure).
- Use material from BOTH songs across the arrangement.

Return ONLY: {"directions":[<dir1>,<dir2>]}`;
  return [{ role: "system", content: sys }, { role: "user", content: user }];
}

function extractJson(text) {
  if (!text) return null;
  let t = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

function sanitizeDirections(parsed) {
  const out = [];
  const dirs = Array.isArray(parsed?.directions) ? parsed.directions : (Array.isArray(parsed) ? parsed : []);
  for (const d of dirs.slice(0, 3)) {
    if (!d || typeof d !== "object") continue;
    const lead = d.lead === "B" ? "B" : "A";
    const bp = Array.isArray(d.blueprint) ? d.blueprint.filter((t) => VALID_TYPES.includes(t)) : [];
    if (bp.length < 4 || bp.length > 10) continue;
    const secs = Array.isArray(d.sections) ? d.sections : [];
    const sections = bp.map((t, i) => {
      const s = secs[i];
      const feat = s && s.type === t && Array.isArray(s.feature)
        ? s.feature.filter((f) => f && (f.src === "A" || f.src === "B") && VALID_ROLES.includes(f.role)).slice(0, 3)
        : [];
      return { type: t, feature: feat };
    });
    out.push({ lead, blueprint: bp, sections, rationale: String(d.rationale || "").slice(0, 200) });
  }
  return out;
}