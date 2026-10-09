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
  version: "1.3.0",
  codename: "Aurora",
  releaseDate: "2026-10-09",
  minVersion: "1.0.0",
  mandatory: false,
  channel: "stable",
  releaseNotes: [
    "Google, Microsoft, Facebook and Apple sign-in now reliably return you to the app on every platform",
    "Android sign-in handoff fixed — a one-tap 'Open Sonora' button is shown as a fallback",
    "Desktop fullscreen support — press F11 or use the toggle in the top bar",
    "Offline download integrity — evicted downloads are detected and cleaned up on startup",
    "Download resume no longer corrupts files when a server ignores range requests",
    "Sign-in state survives Android suspending the app while the browser is open",
    "Auto-update reliability overhaul — releases publish only after both builds succeed",
    "Music data keeps flowing even when Base44 integration credits are exhausted",
    "Crash isolation at app, route, and section level — a retry is always one click away",
  ],
  platforms: {
    web: {
      available: true,
      version: "1.3.0",
      url: "https://sonora-hub.base44.app",
      type: "pwa",
    },
    electron: {
      available: true,
      version: "1.3.0",
      architecture: "x64",
      url: "https://github.com/Jaelisxynkz/Sonora/releases/latest",
      type: "nsis",
      sha256: null,
      channel: "stable",
    },
    android: {
      available: true,
      version: "1.3.0",
      architecture: "arm64",
      url: "https://github.com/Jaelisxynkz/Sonora/releases/latest",
      type: "apk",
      sha256: null,
      channel: "stable",
    },
    ios: {
      available: false,
      version: "1.3.0",
      appStoreUrl: null,
      type: "appstore",
      channel: "stable",
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

    // Social rich-embed pages — return server-side Open Graph metadata so
    // Discord / X / WhatsApp / iMessage render a premium preview with real
    // artwork + track metadata. Humans are redirected (client-side) to the
    // exact Sonora page; crawlers read the OG tags without executing JS.
    // Artwork proxy — streams the real SoundCloud artwork through our origin so
    // Discord's crawler always gets the image (no CDN/UA blocking), with long
    // edge caching. Used as the og:image in /share/* pages.
    if (path === "/share/art") return shareArt(request, url.searchParams);

    if (path.startsWith("/share/track/")) return sharePage("track", path.slice("/share/track/".length), url.searchParams, url.origin);
    if (path.startsWith("/share/playlist/")) return sharePage("playlist", path.slice("/share/playlist/".length), url.searchParams, url.origin);
    if (path.startsWith("/share/album/")) return sharePage("album", path.slice("/share/album/".length), url.searchParams, url.origin);
    if (path.startsWith("/share/artist/")) return sharePage("artist", path.slice("/share/artist/".length), url.searchParams, url.origin);

    // Embeddable iframe player — a self-contained, playable widget (like
    // Spotify / SoundCloud embeds) for websites, blogs, Notion, etc. Resolves
    // the track's stream server-side and plays it through the /dl proxy.
    if (path.startsWith("/embed/track/")) return embedPage("track", path.slice("/embed/track/".length), url.origin);
    // Fresh stream data for the embed player (JSON): resolves the playable URL
    // on demand so signed CDN URLs never expire while the widget is open.
    if (path.startsWith("/embed/stream/")) return embedStream(path.slice("/embed/stream/".length), url.origin);
    // oEmbed discovery — lets platforms/tools that support oEmbed render the
    // playable Sonora embed from the share URL automatically.
    if (path === "/oembed") return oembedJson(url, url.origin);

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

// ---------------------------------------------------------------------------
// Social rich-embed pages (/share/*).
// Fetch real SoundCloud metadata, emit Open Graph + Twitter card tags in the
// initial HTML (no JS needed by crawlers), and redirect humans to the exact
// Sonora page. Artwork uses the real high-resolution SoundCloud artwork URL.
// ---------------------------------------------------------------------------
const SONORA_APP = "https://sonora-hub.base44.app";

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeAttr(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// Upgrade a SoundCloud artwork URL to the largest reliable raster size.
function hiResArtwork(url) {
  if (!url) return null;
  // SoundCloud serves -t500x500.jpg universally; -original can 404. Use 500.
  return url.replace(/-(large|t\d+x\d+|tiny|mini|max|original)\.(jpg|jpeg|png)/, "-t500x500.$2");
}

function firstTrackArt(tracks) {
  if (!Array.isArray(tracks)) return null;
  for (const t of tracks) {
    if (t && t.artwork_url) return hiResArtwork(t.artwork_url);
    if (t && t.user && t.user.avatar_url) return hiResArtwork(t.user.avatar_url);
  }
  return null;
}

async function fetchShareMeta(kind, id) {
  try {
    if (kind === "track") {
      const t = await scFetch(`https://api-v2.soundcloud.com/tracks/${id}`);
      if (!t) return null;
      const artist = (t.user && t.user.username) || "Unknown Artist";
      const album = (t.publisher_metadata && t.publisher_metadata.album_title) || null;
      const art = hiResArtwork(t.artwork_url || (t.user && t.user.avatar_url));
      const desc = "by " + artist + (album ? " · " + album : "") + " — Listen on Sonora";
      return {
        title: t.title || "Untitled",
        subtitle: artist,
        description: desc || "Listen on Sonora",
        artwork: art,
        ogType: "music.song",
        appPath: `/track/${id}`,
      };
    }
    if (kind === "playlist" || kind === "album") {
      const p = await scFetch(`https://api-v2.soundcloud.com/playlists/${id}`);
      if (!p) return null;
      const creator = (p.user && p.username) || "Various Artists";
      const art = hiResArtwork(p.artwork_url) || firstTrackArt(p.tracks);
      const count = p.track_count || (Array.isArray(p.tracks) ? p.tracks.length : 0);
      const desc = count ? `${count} track${count === 1 ? "" : "s"}${p.description ? " · " + String(p.description).slice(0, 120) : ""}` : "Listen on Sonora";
      return {
        title: p.title || "Untitled",
        subtitle: creator,
        description: desc,
        artwork: art,
        ogType: "music.playlist",
        appPath: kind === "album" ? `/album/${id}` : `/playlist/${id}`,
      };
    }
    if (kind === "artist") {
      const u = await scFetch(`https://api-v2.soundcloud.com/users/${id}`);
      if (!u) return null;
      const art = hiResArtwork(u.avatar_url);
      const count = u.track_count || 0;
      const desc = count ? `${count} track${count === 1 ? "" : "s"} on Sonora` : "Listen on Sonora";
      return {
        title: u.username || "Unknown Artist",
        subtitle: "Artist",
        description: desc,
        artwork: art,
        ogType: "profile",
        appPath: `/artist/${id}`,
      };
    }
  } catch { /* fall through to generic */ }
  return null;
}

// Artwork proxy — fetches a SoundCloud artwork URL server-side and streams it
// back with permissive CORS + long cache, so Discord / X / WhatsApp crawlers
// always receive the image even if the raw sndcdn.com URL blocks their UA.
async function shareArt(request, params) {
  const target = params && params.get("u");
  if (!target || typeof target !== "string") return json({ error: "Missing u" }, 400);
  let u;
  try { u = new URL(target); } catch { return json({ error: "Invalid url" }, 400); }
  if (u.protocol !== "https:") return json({ error: "https only" }, 400);
  const host = u.hostname;
  const allowed = /\.sndcdn\.com$/.test(host) || /\.soundcloud\.com$/.test(host) || host === "sonora-hub.base44.app";
  if (!allowed) return json({ error: "Host not allowed" }, 400);
  // Highest quality: try the full-resolution "original" raster first, fall
  // back to t500x500 when SoundCloud doesn't have an original. Discord caches
  // by URL, so each quality gets its own cache entry — no thrash.
  const originalUrl = new URL(u.toString());
  originalUrl.pathname = u.pathname.replace(/-(large|t\d+x\d+|tiny|mini|max|original)\.(jpg|jpeg|png)/, "-original.$2");
  const fallbackUrl = new URL(u.toString());
  fallbackUrl.pathname = u.pathname.replace(/-(large|t\d+x\d+|tiny|mini|max|original)\.(jpg|jpeg|png)/, "-t500x500.$2");
  const range = request.headers.get("Range");
  const fetchOpts = { redirect: "follow", headers: range ? { Range: range } : {} };

  let upstream = await fetch(originalUrl.toString(), fetchOpts).catch(() => null);
  if (!upstream || !upstream.ok) {
    upstream = await fetch(fallbackUrl.toString(), fetchOpts).catch(() => null);
  }
  if (!upstream || !upstream.ok) return json({ error: `Upstream error (${upstream ? upstream.status : "fetch failed"})` }, 502);
  const headers = {
    "Content-Type": upstream.headers.get("content-type") || "image/jpeg",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=86400, s-maxage=604800",
  };
  for (const h of ["content-length", "content-range"]) { const v = upstream.headers.get(h); if (v) headers[h] = v; }
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function sharePage(kind, rawId, q, origin) {
  const id = decodeURIComponent(String(rawId || "")).replace(/[^0-9a-zA-Z_-]/g, "");
  if (!id) return json({ error: "Invalid id" }, 400);

  // Query-param fallback (t/s/d/i) lets the app pass metadata for local content
  // the worker can't fetch from SoundCloud (e.g. user-created playlists).
  const qFallback = {
    title: q && q.get("t"),
    subtitle: q && q.get("s"),
    description: q && q.get("d"),
    artwork: q && q.get("i"),
  };

  const fetched = await fetchShareMeta(kind, id);
  const meta = {
    title: (fetched && fetched.title) || qFallback.title || "Sonora",
    subtitle: (fetched && fetched.subtitle) || qFallback.subtitle || "Premium music streaming",
    description: (fetched && fetched.description) || qFallback.description || "Listen on Sonora — high-fidelity music streaming with personalized discovery.",
    artwork: (fetched && fetched.artwork) || qFallback.artwork || null,
    ogType: (fetched && fetched.ogType) || "website",
    appPath: (fetched && fetched.appPath) || "/",
  };

  const appUrl = `${SONORA_APP}${meta.appPath}`;
  const title = meta.title;
  const description = meta.description;
  // Route artwork through our own proxy so Discord's crawler always receives it
  // (raw sndcdn.com URLs can be blocked by CDN UA filters). Falls back to the
  // app icon when there's no artwork.
  const image = meta.artwork ? `${origin}/share/art?u=${encodeURIComponent(meta.artwork)}` : `${SONORA_APP}/icon-512.png`;
  const siteName = "Sonora";
  const ogType = meta.ogType || "website";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Sonora</title>

<!-- Open Graph -->
<meta property="og:type" content="${escapeAttr(ogType)}">
<meta property="og:site_name" content="Sonora">
<meta property="og:title" content="${escapeAttr(title)}">
<meta property="og:description" content="${escapeAttr(description)}">
<meta property="og:image" content="${escapeAttr(image)}">
<meta property="og:image:secure_url" content="${escapeAttr(image)}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="500">
<meta property="og:image:height" content="500">
<meta property="og:image:alt" content="${escapeAttr(title)}">
<meta property="og:url" content="${escapeAttr(appUrl)}">
<meta property="og:locale" content="en_US">
<meta property="music:duration" content="1">
<meta property="music:musician" content="${escapeAttr(appUrl)}">

<!-- oEmbed discovery — platforms read this to render the playable Sonora embed -->
<link rel="alternate" type="application/json+oembed" href="${escapeAttr(`${origin}/oembed?url=${encodeURIComponent(appUrl)}&format=json`)}" title="${escapeAttr(title)} · Sonora">

<!-- Twitter / X -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@sonora">
<meta name="twitter:title" content="${escapeAttr(title)}">
<meta name="twitter:description" content="${escapeAttr(description)}">
<meta name="twitter:image" content="${escapeAttr(image)}">

<!-- Canonical + brand -->
<link rel="canonical" href="${escapeAttr(appUrl)}">
<meta name="application-name" content="Sonora">
<meta name="theme-color" content="#0a0a0f">
<meta name="description" content="${escapeAttr(description)}">

<!-- Redirect humans to the exact Sonora page. Crawlers don't execute JS,
     so they read the OG tags above without following this redirect. -->
<script>window.location.replace(${JSON.stringify(appUrl)});</script>
</head>
<body style="margin:0;background:#0a0a0f;color:#f4f1ff;font-family:Inter,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px">
<a href="${escapeAttr(appUrl)}" style="display:flex;flex-direction:column;align-items:center;gap:16px;text-decoration:none;color:inherit">
${meta.artwork ? `<img src="${escapeAttr(meta.artwork)}" alt="" width="160" height="160" style="border-radius:16px;box-shadow:0 20px 60px -20px rgba(0,0,0,.7)">` : ""}
<div>
<div style="font-size:13px;letter-spacing:.3em;text-transform:uppercase;color:#9d8eff;font-weight:600">Opening Sonora</div>
<div style="font-size:20px;font-weight:600;margin-top:6px">${escapeHtml(title)}</div>
<div style="font-size:14px;color:#aaa6c2;margin-top:4px">${escapeHtml(meta.subtitle || "")}</div>
<div style="margin-top:18px;font-size:13px;color:#6d74ff;font-weight:600">Tap to continue →</div>
</div>
</a>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
}

// ---------------------------------------------------------------------------
// Embeddable iframe player (/embed/track/:id) + stream data
// (/embed/stream/:id) + oEmbed discovery (/oembed). The embed is a
// self-contained, playable widget (like Spotify / SoundCloud embeds) for
// websites, blogs and Notion. The worker resolves the track's playable
// stream server-side and serves it through the /dl proxy (same origin,
// CORS + Range), so the widget plays anywhere an iframe is allowed.
// ---------------------------------------------------------------------------

// Resolve a track's playable stream URL server-side. Mirrors the app's
// playback.js ranking (progressive mp3 first, then any progressive, then
// HLS) and returns a proxied URL the embed page can play directly.
async function embedStreamData(id, origin) {
  const t = await scFetch(`https://api-v2.soundcloud.com/tracks/${id}`);
  if (!t) return null;
  const artist = (t.user && t.user.username) || "Unknown Artist";
  const rawArt = hiResArtwork(t.artwork_url || (t.user && t.user.avatar_url));
  const artwork = rawArt ? `${origin}/share/art?u=${encodeURIComponent(rawArt)}` : null;
  const title = t.title || "Untitled";
  const duration = t.duration || 0;
  const transcodings = (t.media && t.media.transcodings) || [];
  const auth = t.track_authorization || null;
  const isDrm = transcodings.some((x) => /encrypted/.test((x.format && x.format.protocol) || ""));

  let url = null, protocol = null;
  if (!isDrm && t.streamable !== false) {
    const progressive = transcodings
      .filter((x) => x.format && x.format.protocol === "progressive")
      .sort((a, b) => ((a.format.mime_type === "audio/mpeg" ? 0 : 1) - (b.format.mime_type === "audio/mpeg" ? 0 : 1)));
    for (const tr of progressive) {
      try {
        const data = await scFetch(tr.url, auth ? { track_authorization: auth } : {});
        if (data && data.url) { url = `${origin}/dl?url=${encodeURIComponent(data.url)}`; protocol = "progressive"; break; }
      } catch {}
    }
    if (!url) {
      const hls = transcodings.find((x) => x.format && x.format.protocol === "hls");
      if (hls) {
        try {
          const data = await scFetch(hls.url, auth ? { track_authorization: auth } : {});
          if (data && data.url) { url = data.url; protocol = "hls"; }
        } catch {}
      }
    }
  }
  return { title, artist, artwork, duration, url, protocol, playable: !!url, appUrl: `${SONORA_APP}/track/${id}` };
}

async function embedStream(rawId, origin) {
  const id = decodeURIComponent(String(rawId || "")).replace(/[^0-9a-zA-Z_-]/g, "");
  if (!id) return json({ error: "Invalid id" }, 400);
  const data = await embedStreamData(id, origin);
  if (!data) return json({ error: "Track not found" }, 404);
  return json(data, 200, { "Cache-Control": "no-store" });
}

function embedPage(kind, rawId, origin) {
  const id = decodeURIComponent(String(rawId || "")).replace(/[^0-9a-zA-Z_-]/g, "");
  if (!id) return json({ error: "Invalid id" }, 400);
  if (kind !== "track") return json({ error: "Only tracks are embeddable" }, 400);
  const stream = `${origin}/embed/stream/${id}`;
  const app = `${SONORA_APP}/track/${id}`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sonora Embed</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{background:#0a0a0f;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;color:#f4f1ff;overflow:hidden;-webkit-font-smoothing:antialiased}
.player{position:relative;display:flex;gap:14px;height:100%;padding:14px;align-items:center;overflow:hidden}
.bg{position:absolute;inset:0;background-size:cover;background-position:center;filter:blur(42px) saturate(1.5);opacity:.34;transform:scale(1.25);z-index:0}
.bg:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,10,15,.45),rgba(10,10,15,.88))}
.art{position:relative;z-index:1;width:124px;height:124px;border-radius:12px;overflow:hidden;flex-shrink:0;box-shadow:0 10px 30px -10px rgba(0,0,0,.75);background:#15151f}
.art img{width:100%;height:100%;object-fit:cover;display:block}
.right{position:relative;z-index:1;flex:1;min-width:0;display:flex;flex-direction:column;justify-content:space-between;height:100%;min-height:0}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.meta{min-width:0;padding-top:2px}
.title{font-size:15px;font-weight:600;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.01em}
.artist{font-size:12.5px;color:#aaa6c2;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.brand{display:inline-flex;align-items:center;gap:5px;font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#b3a6ff;text-decoration:none;white-space:nowrap;flex-shrink:0;padding:4px 9px;border-radius:999px;background:rgba(109,74,255,.14);border:1px solid rgba(109,74,255,.28);transition:background .2s}
.brand:hover{background:rgba(109,74,255,.24)}
.brand svg{width:11px;height:11px}
.controls{display:flex;align-items:center;gap:10px}
.play{width:42px;height:42px;border-radius:999px;border:none;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,#7c5cff,#2dd4ff);box-shadow:0 6px 18px -4px rgba(124,92,255,.6);transition:transform .12s,filter .2s}
.play:hover{filter:brightness(1.09)}
.play:active{transform:scale(.93)}
.play svg{width:18px;height:18px}
.seek{flex:1;display:flex;align-items:center;gap:8px;min-width:0}
.time{font-size:11px;color:#8a86a8;font-variant-numeric:tabular-nums;flex-shrink:0}
.bar{flex:1;height:6px;border-radius:999px;background:rgba(255,255,255,.13);cursor:pointer;position:relative;min-width:36px}
.bar .fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:linear-gradient(90deg,#7c5cff,#2dd4ff);width:0%}
.bar .knob{position:absolute;top:50%;width:12px;height:12px;border-radius:999px;background:#fff;transform:translate(-50%,-50%);left:0%;box-shadow:0 2px 6px rgba(0,0,0,.45);opacity:0;transition:opacity .15s}
.bar:hover .knob{opacity:1}
.vol{display:flex;align-items:center;gap:6px;flex-shrink:0}
.vol button{background:none;border:none;cursor:pointer;color:#8a86a8;padding:0;display:flex;align-items:center}
.vol button:hover{color:#f4f1ff}
.vol input{width:60px;height:4px;-webkit-appearance:none;appearance:none;background:rgba(255,255,255,.16);border-radius:999px;outline:none;cursor:pointer}
.vol input::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;border-radius:999px;background:#fff;cursor:pointer}
.vol input::-moz-range-thumb{width:11px;height:11px;border:none;border-radius:999px;background:#fff;cursor:pointer}
.state{position:absolute;inset:0;z-index:3;display:flex;align-items:center;justify-content:center;background:rgba(10,10,15,.55);backdrop-filter:blur(6px);font-size:12px;color:#aaa6c2}
.state.err{background:rgba(10,10,15,.85)}
.state.err a{color:#9d8eff;font-weight:600;text-decoration:none}
.state.err a:hover{text-decoration:underline}
.spinner{width:22px;height:22px;border:2px solid rgba(255,255,255,.18);border-top-color:#9d8eff;border-radius:999px;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:360px){.vol{display:none}.art{width:100px;height:100px}.title{font-size:14px}}
</style>
</head>
<body>
<div class="player">
  <div class="bg" id="bg"></div>
  <div class="art"><img id="artwork" alt="" src=""></div>
  <div class="right">
    <div class="top">
      <div class="meta"><div class="title" id="title">Loading…</div><div class="artist" id="artist"></div></div>
      <a class="brand" id="brand" href="#" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 12c2-3 5-3 8 0s6 3 8 0"/></svg>Sonora</a>
    </div>
    <div class="controls">
      <button class="play" id="play" aria-label="Play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
      <div class="seek"><span class="time" id="cur">0:00</span><div class="bar" id="bar"><div class="fill" id="fill"></div><div class="knob" id="knob"></div></div><span class="time" id="dur">0:00</span></div>
      <div class="vol"><button id="mute" aria-label="Mute"></button><input id="vol" type="range" min="0" max="100" value="100"></div>
    </div>
  </div>
  <div class="state" id="state"><div class="spinner"></div></div>
</div>
<audio id="audio" preload="metadata"></audio>
<script>
(function(){
  var S = ${JSON.stringify({ s: stream, a: app })};
  var audio=document.getElementById('audio'),play=document.getElementById('play'),cur=document.getElementById('cur'),dur=document.getElementById('dur'),bar=document.getElementById('bar'),fill=document.getElementById('fill'),knob=document.getElementById('knob'),art=document.getElementById('artwork'),bg=document.getElementById('bg'),titleEl=document.getElementById('title'),artistEl=document.getElementById('artist'),brand=document.getElementById('brand'),st=document.getElementById('state'),vol=document.getElementById('vol'),mute=document.getElementById('mute');
  var IP='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  var IPA='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
  var IV='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>';
  var IM='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>';
  mute.innerHTML=IV;brand.href=S.a;
  function fmt(s){s=Math.max(0,Math.floor(s||0));var m=Math.floor(s/60),x=s%60;return m+':'+(x<10?'0':'')+x;}
  function setP(p){play.innerHTML=p?IPA:IP;play.setAttribute('aria-label',p?'Pause':'Play');}
  function hide(){st.style.display='none';}
  function err(msg){st.className='state err';st.innerHTML='<div style="text-align:center;line-height:1.7">'+msg+'<br><a href="'+S.a+'" target="_blank" rel="noopener">Open in Sonora →</a></div>';st.style.display='flex';}
  function initHls(u){if(audio.canPlayType('application/vnd.apple.mpegurl')){audio.src=u;return;}if(window.Hls){var h=new Hls();h.loadSource(u);h.attachMedia(audio);h.on(Hls.Events.ERROR,function(e,d){if(d.fatal)err('Playback error');});}else{var sc=document.createElement('script');sc.src='https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.15/hls.min.js';sc.onload=function(){if(!window.Hls){err('Playback error');return;}var h=new Hls();h.loadSource(u);h.attachMedia(audio);h.on(Hls.Events.ERROR,function(e,d){if(d.fatal)err('Playback error');});};sc.onerror=function(){err('Playback error');};document.head.appendChild(sc);}}
  fetch(S.s).then(function(r){return r.json();}).then(function(d){
    if(!d||!d.playable){err('This track can’t be previewed.');return;}
    titleEl.textContent=d.title||'Untitled';artistEl.textContent=d.artist||'';
    if(d.artwork){art.src=d.artwork;bg.style.backgroundImage='url("'+d.artwork+'")';}
    if(d.protocol==='hls'){initHls(d.url);}else{audio.src=d.url;}
    hide();
  }).catch(function(){err('Couldn’t load this track.');});
  play.addEventListener('click',function(){if(audio.paused){audio.play().catch(function(){});}else{audio.pause();}});
  audio.addEventListener('play',function(){setP(true);});
  audio.addEventListener('pause',function(){setP(false);});
  audio.addEventListener('loadedmetadata',function(){dur.textContent=fmt(audio.duration);});
  audio.addEventListener('timeupdate',function(){var p=audio.duration?audio.currentTime/audio.duration*100:0;fill.style.width=p+'%';knob.style.left=p+'%';cur.textContent=fmt(audio.currentTime);});
  audio.addEventListener('waiting',function(){st.className='state';st.innerHTML='<div class="spinner"></div>';st.style.display='flex';});
  audio.addEventListener('playing',hide);
  audio.addEventListener('error',function(){err('Playback error');});
  function seek(x){var r=bar.getBoundingClientRect();var v=(x-r.left)/r.width;v=Math.max(0,Math.min(1,v));if(audio.duration)audio.currentTime=v*audio.duration;}
  var drag=false;bar.addEventListener('mousedown',function(e){drag=true;seek(e.clientX);});window.addEventListener('mousemove',function(e){if(drag)seek(e.clientX);});window.addEventListener('mouseup',function(){drag=false;});
  bar.addEventListener('touchstart',function(e){seek(e.touches[0].clientX);},{passive:true});bar.addEventListener('touchmove',function(e){seek(e.touches[0].clientX);},{passive:true});
  vol.addEventListener('input',function(){audio.volume=vol.value/100;mute.innerHTML=vol.value==0?IM:IV;});
  mute.addEventListener('click',function(){if(audio.volume>0){audio.dataset.v=audio.volume;audio.volume=0;vol.value=0;mute.innerHTML=IM;}else{var v=parseFloat(audio.dataset.v||1);audio.volume=v;vol.value=Math.round(v*100);mute.innerHTML=IV;}});
})();
</script>
</body>
</html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}

async function oembedJson(urlObj, origin) {
  const target = urlObj.searchParams.get("url");
  if (!target) return json({ error: "Missing url" }, 400);
  let kind = null, id = null;
  try {
    const u = new URL(target);
    const m = u.pathname.match(/\/share\/(track|playlist|album|artist)\/([0-9a-zA-Z_-]+)/) || u.pathname.match(/\/(track|playlist|album|artist)\/([0-9a-zA-Z_-]+)/);
    if (m) { kind = m[1]; id = m[2]; }
  } catch {}
  if (!kind || !id) return json({ error: "Unrecognized url" }, 400);
  const meta = await fetchShareMeta(kind, id);
  const title = (meta && meta.title) || "Sonora";
  const author = (meta && meta.subtitle) || "Sonora";
  const thumb = (meta && meta.artwork) ? `${origin}/share/art?u=${encodeURIComponent(meta.artwork)}` : `${SONORA_APP}/icon-512.png`;
  const embedUrl = kind === "track" ? `${origin}/embed/track/${id}` : null;
  const html = embedUrl
    ? `<iframe src="${escapeAttr(embedUrl)}" width="400" height="152" frameborder="0" allow="autoplay; encrypted-media" title="${escapeAttr(title)}"></iframe>`
    : `<a href="${escapeAttr(`${SONORA_APP}/${kind}/${id}`)}">${escapeHtml(title)}</a>`;
  return json({
    version: "1.0", type: "rich", provider_name: "Sonora", provider_url: SONORA_APP,
    title, author_name: author, author_url: `${SONORA_APP}/${kind}/${id}`,
    html, width: 400, height: 152,
    thumbnail_url: thumb, thumbnail_width: 500, thumbnail_height: 500,
  }, 200, { "Cache-Control": "public, max-age=300" });
}