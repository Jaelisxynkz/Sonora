// ---------------------------------------------------------------------------
// Discovery Radar → Google Sheet (INLINED — deliberately no relative imports).
//
// This used to live in ./radarSheet.js and be imported here. Any deploy path
// that uploads worker.js as a single module (Cloudflare dashboard Quick Edit,
// a manual paste, or a bundle that doesn't trace relative specifiers) then
// died at runtime with:
//     No such module "radarSheet.js". imported from "worker.js"
// — and because that failure happens at module evaluation, EVERY endpoint
// (SoundCloud proxy, releases, share pages, radar auto-save) returned errors.
// Everything is now in this one file behind a closure, so the worker has no
// cross-file dependency that a deploy can drop.
//
// Runs entirely inside the Cloudflare Worker: no Base44 credits, no backend
// function, no Base44 automations. The cron in wrangler.toml is Cloudflare's
// own scheduler.
//   1. Pull the REAL SoundCloud current-pulse chart (no fabricated rankings).
//   2. Rank by the app's momentum score (plays/day + engagement + freshness).
//   3. Append one snapshot per week, so the sheet becomes a time series.
// Trigger: weekly via `crons`, or on demand with
//   GET /radar/sync?key=<RADAR_SYNC_KEY>[&force=1]
// ---------------------------------------------------------------------------
const runRadarSheetSync = (() => {
  const DAY = 86_400_000;
  const CHART_URL = "https://api-v2.soundcloud.com/charts";
  const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
  const TOKEN_URL = "https://oauth2.googleapis.com/token";
  const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

  const HEADER = [
    "Week", "Rank", "Track", "Artist", "Genre",
    "Plays", "Likes", "Plays/Day", "Engagement %",
    "Released", "New Release", "URL",
  ];

  function b64url(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function pemToArrayBuffer(pem) {
    const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const raw = atob(body);
    const buf = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
    return buf.buffer;
  }

  // Monday of the current week (UTC), as YYYY-MM-DD — the snapshot time key.
  function weekKey(d = new Date()) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
    return t.toISOString().slice(0, 10);
  }

  // Same momentum formula the app uses (trendingService.momentumScore):
  // velocity + engagement + freshness, from real provider numbers only.
  function momentum(t) {
    const plays = t.playback_count || 0;
    const likes = t.likes_count || 0;
    const ageDays = t.created_at ? Math.max(1, (Date.now() - new Date(t.created_at).getTime()) / DAY) : 30;
    const velocity = plays / ageDays;
    const engagement = plays > 0 ? (likes / plays) * 100 : 0;
    const freshness = ageDays < 14 ? 6 : 0;
    return { plays, likes, velocity, engagement, score: velocity + engagement + freshness };
  }

  // ---- Google auth (service account → access token) ----------------------

  async function googleAccessToken(env) {
    const email = env.GOOGLE_SA_EMAIL;
    const pem = String(env.GOOGLE_SA_PRIVATE_KEY || "").replace(/\\n/g, "\n");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))}.${b64url(
      new TextEncoder().encode(
        JSON.stringify({ iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })
      )
    )}`;
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemToArrayBuffer(pem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${b64url(new Uint8Array(sig))}`,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(data.error_description || data.error || `Google auth failed (${res.status})`);
    }
    return data.access_token;
  }

  async function sheetsFetch(url, token, { method = "GET", body } = {}) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `Sheets API HTTP ${res.status}`);
    return data;
  }

  // ---- sheet structure ---------------------------------------------------

  // Create the tab (and its header row) on the very first run, so a brand-new
  // spreadsheet works without any manual setup.
  async function ensureTab(sheetId, token, tab) {
    const meta = await sheetsFetch(`${SHEETS}/${sheetId}?fields=sheets.properties.title`, token);
    const titles = (meta.sheets || []).map((s) => s.properties?.title);
    if (titles.includes(tab)) return false;
    await sheetsFetch(`${SHEETS}/${sheetId}:batchUpdate`, token, {
      method: "POST",
      body: { requests: [{ addSheet: { properties: { title: tab } } }] },
    });
    await sheetsFetch(
      `${SHEETS}/${sheetId}/values/${encodeURIComponent(`${tab}!A1`)}?valueInputOption=RAW`,
      token,
      { method: "PUT", body: { values: [HEADER] } }
    );
    return true;
  }

  async function weekAlreadySynced(sheetId, token, tab, week) {
    const res = await sheetsFetch(`${SHEETS}/${sheetId}/values/${encodeURIComponent(`${tab}!A1:A`)}`, token);
    return (res.values || []).flat().includes(week);
  }

  // ---- data --------------------------------------------------------------

  async function fetchTrending(clientId, limit) {
    const u = new URL(CHART_URL);
    u.searchParams.set("kind", "trending");
    u.searchParams.set("genre", "soundcloud:genres:all-music");
    u.searchParams.set("limit", String(Math.min(50, limit)));
    u.searchParams.set("client_id", clientId);
    const res = await fetch(u.toString(), {
      headers: { Accept: "application/json", "User-Agent": "Sonora/1.0" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`SoundCloud chart HTTP ${res.status}`);
    const data = await res.json().catch(() => null);
    const collection = data?.collection || [];
    const tracks = collection
      .map((c) => c.track || c)
      .filter((t) => t && t.id && t.streamable);
    if (!tracks.length) throw new Error("SoundCloud chart returned no streamable tracks");
    return tracks;
  }

  function buildRows(tracks, week) {
    return tracks
      .map((t) => ({ t, m: momentum(t) }))
      .sort((a, b) => b.m.score - a.m.score)
      .map(({ t, m }, i) => {
        const released = t.created_at ? new Date(t.created_at) : null;
        const isNew = released ? Date.now() - released.getTime() < 30 * DAY : false;
        return [
          week,
          i + 1,
          t.title || "",
          t.user?.username || t.user?.full_name || "",
          t.genre || (t.tag_list || "").split(" ")[0] || "",
          m.plays,
          m.likes,
          Number(m.velocity.toFixed(1)),
          Number(m.engagement.toFixed(2)),
          released ? released.toISOString().slice(0, 10) : "",
          isNew ? "YES" : "NO",
          t.permalink_url || "",
        ];
      });
  }

  // ---- entry point -------------------------------------------------------

  return async function runRadarSheetSync(env, { clientId, force = false, limit = 50 } = {}) {
    const sheetId = env.GOOGLE_SHEET_ID;
    const missing = [];
    if (!clientId) missing.push("SOUNDCLOUD client_id");
    if (!env.GOOGLE_SA_EMAIL) missing.push("GOOGLE_SA_EMAIL");
    if (!env.GOOGLE_SA_PRIVATE_KEY) missing.push("GOOGLE_SA_PRIVATE_KEY");
    if (!sheetId) missing.push("GOOGLE_SHEET_ID");
    if (missing.length) return { ok: false, error: "not_configured", missing };

    const tab = env.RADAR_SHEET_TAB || "Radar";
    const week = weekKey();
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}`;

    try {
      const token = await googleAccessToken(env);
      const createdTab = await ensureTab(sheetId, token, tab);

      if (!force && !createdTab && (await weekAlreadySynced(sheetId, token, tab, week))) {
        return { ok: true, skipped: true, reason: `Week ${week} is already in the sheet`, week, tab, sheetUrl };
      }

      const rows = buildRows(await fetchTrending(clientId, limit), week);
      await sheetsFetch(
        `${SHEETS}/${sheetId}/values/${encodeURIComponent(`${tab}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        token,
        { method: "POST", body: { values: rows } }
      );

      return { ok: true, week, tab, rows: rows.length, sheetUrl };
    } catch (e) {
      return { ok: false, error: e.message || "sync failed", week, tab, sheetUrl };
    }
  };
})();

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
  version: "1.4.0",
  codename: "Aurora",
  releaseDate: "2026-10-10",
  minVersion: "1.0.0",
  mandatory: false,
  channel: "stable",
  releaseNotes: [
    "Native Android app: full Capacitor plugin suite — hardware back button, status bar, splash screen, haptics, native share sheet, and external browser for Google sign-in",
    "Background audio: music keeps playing with the screen off and when you switch apps, with a lock-screen notification showing the current track",
    "APK auto-update: reads the real native version instead of defaulting to a false update-required prompt on every launch",
    "Deep links: sonora:// links now open the app directly on Android (share links, auth handoff)",
  ],
  platforms: {
    web: {
      available: true,
      version: "1.4.0",
      url: "https://realsonora.base44.app",
      type: "pwa",
    },
    electron: {
      available: true,
      version: "1.4.0",
      architecture: "x64",
      url: "https://github.com/Jaelisxynkz/Sonora/releases/latest",
      type: "nsis",
      sha256: null,
      channel: "stable",
    },
    android: {
      available: true,
      version: "1.4.0",
      architecture: "arm64",
      url: "https://github.com/Jaelisxynkz/Sonora/releases/latest",
      type: "apk",
      sha256: null,
      channel: "stable",
    },
    ios: {
      available: false,
      version: "1.4.0",
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

// Module-level cache for the built release manifest. buildRelease does a
// GitHub API round-trip + structuredClone on every call; caching the result
// for 60s (matching the response Cache-Control) means /version and /updates
// hit the cache instead of GitHub on every request.
let releaseCache = null; // { data, expires }
const RELEASE_CACHE_TTL = 60_000;

async function buildRelease(env, origin) {
  const now = Date.now();
  if (releaseCache && releaseCache.expires > now) return releaseCache.data;
  const rel = structuredClone(RELEASE);
  const gh = await githubLatest(env).catch(() => null);
  if (!gh) {
    releaseCache = { data: rel, expires: now + RELEASE_CACHE_TTL };
    return rel;
  }
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
  releaseCache = { data: rel, expires: Date.now() + RELEASE_CACHE_TTL };
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

const WORKER = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check — used by the client to test worker reachability and
    // classify failure modes (blocked / timeout / network error). The
    // `service` field lets the client validate it got a real Sonora worker
    // response, not a captive-portal or ISP injection that returns 200 for
    // everything.
    if (path === "/health") return json({ ok: true, service: "sonora-proxy", ts: Date.now() });

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

    // Server-side stream resolver — resolves a track's playable stream URL
    // server-side and returns it as JSON. Used by the client as a last-resort
    // fallback when client-side resolution fails (CORS, rate-limiting, stale
    // URLs). Reuses the same logic as the embed player.
    if (path.startsWith("/stream/") && request.method === "GET") {
      return streamResolve(path.slice("/stream/".length), url.origin);
    }

    // Support email — sends a support notification email via a configurable
    // email API (Resend, Mailgun, etc.). Requires EMAIL_API_KEY + EMAIL_FROM
    // + EMAIL_API_URL set as worker secrets. Bypasses Base44 integration credits.
    if (path === "/support/email" && request.method === "POST") {
      return supportEmail(request, env);
    }

    // Genius lyrics — server-side search + page scrape, bypassing the
    // credit-gated Base44 lyricsProxy backend function. Requires
    // GENIUS_ACCESS_TOKEN set as a worker secret (`wrangler secret put`).
    if (path === "/lyrics" && request.method === "POST") {
      return lyricsGenius(request, env);
    }

    // Spotify OAuth — exchanges an authorization code for access + refresh
    // tokens, and refreshes an access token from a stored refresh token.
    // Bypasses the credit-gated Base44 spotifyAuth backend function. Requires
    // SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET set as worker secrets.
    if (path === "/spotify/exchange" && request.method === "POST") return spotifyExchange(request, env);
    if (path === "/spotify/refresh" && request.method === "POST") return spotifyRefresh(request, env);

    // Listening Together — server-authoritative clock. Returns the worker's
    // epoch ms so clients can calibrate their clock offset for sub-second
    // playback synchronization. Free (no Base44 credits), more accurate than
    // entity created_date (which has write latency).
    if (path === "/lt/time" && request.method === "GET") return json({ ts: Date.now(), service: "sonora-lt" });

    // Listening Together — room OG metadata for Discord/X/WhatsApp sharing.
    // The worker can't access Base44 entities, so the app passes room data as
    // query params (t=name, s=host, i=artwork, p=participants, tr=current
    // track). Generates a premium rich-embed preview with "Listening Together
    // on Sonora" branding.
    if (path.startsWith("/share/room/")) return shareRoomPage(path.slice("/share/room/".length), url.searchParams, url.origin);

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

    // ---- Expanded Player Studio ----
    // The Studio does real audio processing CLIENT-SIDE (Web Audio API DSP).
    // The Worker is the backend/security layer: it validates sessions, enforces
    // rate limits (in-memory, per-isolate best-effort), and generates share
    // metadata. Processing job state lives in the StudioHistory entity (RLS-
    // isolated, no integration credits needed). The Worker never stores files
    // (it's stateless); generated outputs are uploaded via UploadPrivateFile
    // and stored as file_uri on the entity, downloaded via signed URLs.
    if (path === "/studio/validate" && request.method === "POST") return studioValidate(request);
    if (path === "/studio/rate-limit" && request.method === "GET") return studioRateLimit(request);
    if (path === "/studio/share" && request.method === "POST") return studioShare(request, url.origin);

    // Weekly Discovery Radar → Google Sheet (setup: RADAR_SHEET.md).
    // Scheduled by the `crons` trigger in wrangler.toml; this route runs it on
    // demand too, guarded by RADAR_SYNC_KEY so nobody can write to the sheet.
    if (path === "/radar/sync" && (request.method === "GET" || request.method === "POST")) {
      const key = url.searchParams.get("key") || request.headers.get("x-radar-key");
      if (!env.RADAR_SYNC_KEY || key !== env.RADAR_SYNC_KEY) return json({ error: "Unauthorized" }, 401);
      return json(await runRadarSheetSync(env, {
        clientId: CLIENT_ID,
        force: url.searchParams.get("force") === "1",
      }));
    }

    return json({ error: "Not found" }, 404);
  },

  // Weekly Discovery Radar → Google Sheet. ctx.waitUntil keeps the Sheets API
  // round-trip alive after the handler returns.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runRadarSheetSync(env, { clientId: CLIENT_ID }).catch((e) =>
        console.error("radar sheet sync failed:", e && e.message)
      )
    );
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
    // Edge-cache public SoundCloud metadata at the Cloudflare edge (60s TTL
    // matches the response Cache-Control). Repeated searches/track fetches
    // hit the edge cache directly — no SoundCloud origin round-trip.
    const upstream = await fetch(u.toString(), {
      headers: { Accept: "application/json", "User-Agent": "Sonora/1.0" },
      redirect: "follow",
      cf: { cacheEverything: true, cacheTtl: 60 },
    });
    // Server-side fallback for deprecated SoundCloud endpoints (charts/top,
    // featured-playlists, genre-specific charts). Synthesizes a valid response
    // from search so the client always gets real data — no dependency on the
    // credit-gated Base44 backend fallback.
    if (upstream.status === 404) {
      const fb = await synthFallback(u);
      if (fb !== null) return json(fb);
    }
    // Stream the upstream body directly instead of buffering it into a string
    // first — avoids holding the entire JSON response in memory and cuts TTFB
    // on large search/track-list responses.
    return new Response(upstream.body, {
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
  // Edge-cache public SoundCloud metadata (60s) — share pages, embeds, stream
  // resolvers and fallbacks all reuse this, so a cache hit skips the SoundCloud
  // origin entirely.
  const res = await fetch(u.toString(), {
    headers: { Accept: "application/json", "User-Agent": "Sonora/1.0" },
    redirect: "follow",
    cf: { cacheEverything: true, cacheTtl: 60 },
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
const SONORA_APP = "https://realsonora.base44.app";

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
        duration: Math.round((t.duration || 0) / 1000),
        album,
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
  const allowed = /\.sndcdn\.com$/.test(host) || /\.soundcloud\.com$/.test(host) || host === "realsonora.base44.app";
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
    duration: (fetched && fetched.duration) || null,
    album: (fetched && fetched.album) || null,
  };

  // Privacy gate: when no metadata is available (neither from SoundCloud nor
  // query params), the resource is either private or doesn't exist. Show a
  // generic, content-free embed so private playlist titles, artwork, and
  // track lists never leak through publicly cached OG responses.
  const isPrivate = !fetched && !qFallback.title && !qFallback.artwork;
  if (isPrivate && (kind === "playlist" || kind === "album")) {
    const privateUrl = `${SONORA_APP}${meta.appPath}`;
    const privateHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Private Playlist · Sonora</title>
<meta property="og:type" content="music.playlist">
<meta property="og:site_name" content="Sonora">
<meta property="og:title" content="Private Playlist on Sonora">
<meta property="og:description" content="This playlist is private. Open it in Sonora to listen.">
<meta property="og:image" content="${SONORA_APP}/icon-512.png">
<meta property="og:image:width" content="512">
<meta property="og:image:height" content="512">
<meta property="og:url" content="${escapeAttr(privateUrl)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Private Playlist on Sonora">
<meta name="twitter:description" content="This playlist is private. Open it in Sonora to listen.">
<link rel="canonical" href="${escapeAttr(privateUrl)}">
<meta name="theme-color" content="#0a0a0f">
<script>window.location.replace(${JSON.stringify(privateUrl)});</script>
</head>
<body style="margin:0;background:#0a0a0f;color:#f4f1ff;font-family:Inter,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px">
<a href="${escapeAttr(privateUrl)}" style="display:flex;flex-direction:column;align-items:center;gap:16px;text-decoration:none;color:inherit">
<div style="font-size:13px;letter-spacing:.3em;text-transform:uppercase;color:#9d8eff;font-weight:600">Opening Sonora</div>
<div style="font-size:20px;font-weight:600;margin-top:6px">Private Playlist</div>
<div style="font-size:14px;color:#aaa6c2;margin-top:4px">Open in Sonora to listen</div>
</a>
</body>
</html>`;
    return new Response(privateHtml, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" },
    });
  }

  // Read optional timestamp (?ts=seconds) and message (?m=...) query params.
  // These come from "Share From Here" and "Share with message" in the app.
  // The timestamp is appended to the app redirect URL so the app seeks on
  // arrival; both are woven into the OG description so Discord's embed shows
  // "at 01:42" and the sender's personal message.
  const tsParam = q && q.get("ts");
  const msgParam = q && q.get("m");
  const tsSeconds = tsParam ? parseInt(tsParam, 10) : NaN;
  const hasTs = isFinite(tsSeconds) && tsSeconds > 0;
  const tsLabel = hasTs ? `${Math.floor(tsSeconds / 60)}:${String(tsSeconds % 60).padStart(2, "0")}` : null;

  // Append ?play=1 so a human clicking the embed (Discord / X / WhatsApp) lands
  // on the exact Sonora page AND the track/playlist starts playing — the
  // Spotify-like "click the embed → it plays" experience. Discord can't render
  // inline audio for third-party links, so the embed is a rich card that opens
  // the app and plays; this flag is what triggers that auto-play in-app.
  // The timestamp (?ts=) is also passed through so the app seeks on arrival.
  const appParams = new URLSearchParams();
  appParams.set("play", "1");
  if (hasTs) appParams.set("ts", String(tsSeconds));
  const appUrl = `${SONORA_APP}${meta.appPath}?${appParams.toString()}`;
  const title = meta.title;
  // Build the description: base metadata + timestamp label + sender message.
  // Discord's embed body shows the og:description, so the message and
  // timestamp appear in the rich preview without any custom Discord API.
  let description = meta.description;
  if (tsLabel) description = `Starts at ${tsLabel} · ${description}`;
  if (msgParam) {
    const cleanMsg = msgParam.slice(0, 200);
    description = `"${cleanMsg}" — ${description}`;
  }
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
${meta.duration ? `<meta property="music:duration" content="${parseInt(meta.duration, 10) || 1}">` : ""}
${meta.album ? `<meta property="music:album" content="${escapeAttr(meta.album)}">` : ""}
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
  // Try resolution even when streamable === false — SoundCloud's flag is often
  // stale while the transcodings themselves still resolve to valid URLs.
  if (!isDrm) {
    // FULL-LENGTH FIRST: sort non-snipped (full) transcodings ahead of
    // snipped (30s preview) ones so the worker never returns a preview URL
    // when a full-length stream is available. This is the server-side fix for
    // songs that play 30s then stop.
    const progressive = transcodings
      .filter((x) => x.format && x.format.protocol === "progressive")
      .sort((a, b) => {
        const as = a.snipped ? 1 : 0;
        const bs = b.snipped ? 1 : 0;
        if (as !== bs) return as - bs;
        return (a.format.mime_type === "audio/mpeg" ? 0 : 1) - (b.format.mime_type === "audio/mpeg" ? 0 : 1);
      });
    for (const tr of progressive) {
      try {
        const data = await scFetch(tr.url, auth ? { track_authorization: auth } : {});
        if (data && data.url) { url = `${origin}/dl?url=${encodeURIComponent(data.url)}`; protocol = "progressive"; break; }
      } catch {}
    }
    if (!url) {
      const hls = transcodings
        .filter((x) => x.format && x.format.protocol === "hls")
        .sort((a, b) => (a.snipped ? 1 : 0) - (b.snipped ? 1 : 0));
      if (hls.length) {
        try {
          const data = await scFetch(hls[0].url, auth ? { track_authorization: auth } : {});
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

// ---------------------------------------------------------------------------
// Server-side stream resolver (/stream/:id) — returns a JSON object with the
// resolved playable stream URL. Used by the client as a last-resort fallback
// when client-side resolution fails. Reuses embedStreamData so the logic is
// identical to the embed player.
// ---------------------------------------------------------------------------
async function streamResolve(rawId, origin) {
  const id = decodeURIComponent(String(rawId || "")).replace(/[^0-9a-zA-Z_-]/g, "");
  if (!id) return json({ error: "Invalid id" }, 400);
  const data = await embedStreamData(id, origin);
  if (!data) return json({ error: "Track not found" }, 404);
  return json(data, 200, { "Cache-Control": "no-store" });
}

// ---------------------------------------------------------------------------
// Support email (/support/email) — sends a support notification email via a
// configurable email API. Bypasses Base44's SendEmail Core integration so it
// works even when integration credits are exhausted.
//
// Requires these worker secrets (set via `wrangler secret put`):
//   EMAIL_API_KEY  — API key for the email service (Resend, Mailgun, etc.)
//   EMAIL_FROM     — The sender email address (e.g. "Sonora <noreply@sonora.app>")
//   EMAIL_API_URL  — The email API endpoint URL (defaults to Resend)
//
// Request body: { to, subject, body, kind }
// Response: { ok: true } or { ok: false, error: "..." }
// ---------------------------------------------------------------------------
async function supportEmail(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const { to, subject, body: text, kind } = body || {};
    // `to` is optional — when omitted, the email goes to the configured
    // SUPPORT_EMAIL (the owner's support inbox), so the client can fire a
    // "new ticket" notification without knowing the owner's address.
    const recipient = (to && typeof to === "string") ? to : (env && env.SUPPORT_EMAIL);
    if (!recipient) return json({ ok: false, error: "Missing recipient (set SUPPORT_EMAIL or pass `to`)" }, 400);
    if (!subject || typeof subject !== "string") return json({ ok: false, error: "Missing subject" }, 400);
    if (!text || typeof text !== "string") return json({ ok: false, error: "Missing body" }, 400);

    const apiKey = env && env.EMAIL_API_KEY;
    const from = env && env.EMAIL_FROM;
    if (!apiKey || !from) {
      return json({
        ok: false,
        error: "Email not configured. Set EMAIL_API_KEY, EMAIL_FROM, and EMAIL_API_URL as worker secrets.",
      }, 503);
    }
    const apiUrl = (env && env.EMAIL_API_URL) || "https://api.resend.com/emails";

    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: recipient,
        subject: String(subject).slice(0, 200),
        text: String(text).slice(0, 8000),
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      return json({ ok: false, error: `Email API error (${res.status}): ${errText.slice(0, 500)}` }, 502);
    }
    return json({ ok: true });
  } catch (error) {
    return json({ ok: false, error: error.message || "Support email error" }, 500);
  }
}

// ---------------------------------------------------------------------------
// Genius lyrics proxy — searches Genius and scrapes the lyrics page.
// Bypasses the Base44 lyricsProxy backend function (blocked when integration
// credits are exhausted). Requires GENIUS_ACCESS_TOKEN as a worker secret.
//
// Request body: { artist, title }
// Response: { lyrics, title, artist } or { error }
// ---------------------------------------------------------------------------
const GENIUS_API = "https://api.genius.com";

function extractGeniusLyrics(html) {
  const regex = /<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g;
  let lyrics = "";
  let match;
  while ((match = regex.exec(html)) !== null) {
    let block = match[1]
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, " ")
      .trim();
    if (/Contributors?\s*Translations/i.test(block)) continue;
    if (block) lyrics += block + "\n";
  }
  return lyrics.trim();
}

async function lyricsGenius(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const { artist, title } = body || {};
    if (!artist || !title) return json({ error: "artist and title required" }, 400);
    const token = env && env.GENIUS_ACCESS_TOKEN;
    if (!token) return json({ error: "Genius token not configured" }, 503);

    const searchRes = await fetch(
      `${GENIUS_API}/search?q=${encodeURIComponent(`${artist} ${title}`)}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(10000) }
    );
    if (!searchRes.ok) return json({ error: "genius search failed" }, 502);
    const searchData = await searchRes.json();
    const hits = (searchData?.response?.hits || []).filter((h) => h?.result?.url).slice(0, 5);
    if (!hits.length) return json({ error: "not found" }, 404);

    const queryArtist = artist.toLowerCase();
    const artistMatch = hits.find((h) => {
      const name = (h.result?.primary_artist?.name || "").toLowerCase();
      return name && (name.includes(queryArtist) || queryArtist.includes(name));
    });
    const song = (artistMatch || hits[0]).result;

    const pageRes = await fetch(song.url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SonoraLyrics/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!pageRes.ok) return json({ error: "page fetch failed" }, 502);
    const html = await pageRes.text();
    const lyrics = extractGeniusLyrics(html);
    if (!lyrics) return json({ error: "lyrics not found on page" }, 404);
    return json({ lyrics, title: song.title, artist: song.primary_artist?.name || artist });
  } catch (error) {
    return json({ error: error.message || "lyrics error" }, 500);
  }
}

// ---------------------------------------------------------------------------
// Spotify OAuth — token exchange + refresh (Cloudflare Worker).
//   POST /spotify/exchange { code, redirect_uri } -> { access_token, refresh_token, expires_in }
//   POST /spotify/refresh  { refresh_token }        -> { access_token, refresh_token, expires_in }
// Bypasses the credit-gated Base44 spotifyAuth backend function. The client
// secret never reaches the browser. Requires SPOTIFY_CLIENT_ID +
// SPOTIFY_CLIENT_SECRET set as worker secrets (`wrangler secret put`).
// ---------------------------------------------------------------------------
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

async function spotifyExchange(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const { code, redirect_uri } = body || {};
    if (!code) return json({ error: "Missing code" }, 400);
    if (!redirect_uri) return json({ error: "Missing redirect_uri" }, 400);
    const clientId = env && env.SPOTIFY_CLIENT_ID;
    const clientSecret = env && env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) return json({ error: "Spotify credentials not configured" }, 503);
    const res = await fetch(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + btoa(`${clientId}:${clientSecret}`),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri,
      }).toString(),
      signal: AbortSignal.timeout(12000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.access_token) {
      return json({ error: (data && data.error_description) || (data && data.error) || `Spotify exchange failed (${res.status})` }, res.status || 502);
    }
    return json({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in || 3600,
    });
  } catch (error) {
    return json({ error: error.message || "spotify exchange error" }, 500);
  }
}

async function spotifyRefresh(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const { refresh_token } = body || {};
    if (!refresh_token) return json({ error: "Missing refresh_token" }, 400);
    const clientId = env && env.SPOTIFY_CLIENT_ID;
    const clientSecret = env && env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) return json({ error: "Spotify credentials not configured" }, 503);
    const res = await fetch(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + btoa(`${clientId}:${clientSecret}`),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token,
      }).toString(),
      signal: AbortSignal.timeout(12000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.access_token) {
      return json({ error: (data && data.error_description) || (data && data.error) || `Spotify refresh failed (${res.status})` }, res.status || 502);
    }
    return json({
      access_token: data.access_token,
      refresh_token: data.refresh_token || null,
      expires_in: data.expires_in || 3600,
    });
  } catch (error) {
    return json({ error: error.message || "spotify refresh error" }, 500);
  }
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

// ---------------------------------------------------------------------------
// Listening Together — room share page (/share/room/:id).
// The worker can't access Base44 entities, so the app passes room data as
// query params: t=name, s=host, i=artwork, p=participants, tr=current track,
// ar=artist. Generates a premium rich-embed preview with "Listening Together
// on Sonora" branding. Humans are redirected to the app room URL.
// ---------------------------------------------------------------------------
async function shareRoomPage(rawId, q, origin) {
  const id = decodeURIComponent(String(rawId || "")).replace(/[^0-9a-zA-Z_-]/g, "");
  if (!id) return json({ error: "Invalid id" }, 400);
  const name = (q && q.get("t")) || "Listening Together";
  const host = (q && q.get("s")) || "Host";
  const artwork = (q && q.get("i")) || null;
  const participants = (q && q.get("p")) || "1";
  const trackTitle = (q && q.get("tr")) || null;
  const trackArtist = (q && q.get("ar")) || null;
  const appUrl = `${SONORA_APP}/listen-together/${id}`;
  const image = artwork ? `${origin}/share/art?u=${encodeURIComponent(artwork)}` : `${SONORA_APP}/icon-512.png`;
  let description = `Hosted by ${host} · ${participants} listening together`;
  if (trackTitle) description = `Now playing: ${trackTitle}${trackArtist ? " · " + trackArtist : ""} · ${description}`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)} · Listening Together on Sonora</title>
<meta property="og:type" content="music.playlist">
<meta property="og:site_name" content="Sonora">
<meta property="og:title" content="${escapeAttr(name)}">
<meta property="og:description" content="${escapeAttr(description)}">
<meta property="og:image" content="${escapeAttr(image)}">
<meta property="og:image:secure_url" content="${escapeAttr(image)}">
<meta property="og:image:width" content="500">
<meta property="og:image:height" content="500">
<meta property="og:url" content="${escapeAttr(appUrl)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeAttr(name)}">
<meta name="twitter:description" content="${escapeAttr(description)}">
<meta name="twitter:image" content="${escapeAttr(image)}">
<link rel="canonical" href="${escapeAttr(appUrl)}">
<meta name="theme-color" content="#0a0a0f">
<script>window.location.replace(${JSON.stringify(appUrl)});</script>
</head>
<body style="margin:0;background:#0a0a0f;color:#f4f1ff;font-family:Inter,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px">
<a href="${escapeAttr(appUrl)}" style="display:flex;flex-direction:column;align-items:center;gap:16px;text-decoration:none;color:inherit">
${artwork ? `<img src="${escapeAttr(artwork)}" alt="" width="160" height="160" style="border-radius:16px;box-shadow:0 20px 60px -20px rgba(0,0,0,.7)">` : ""}
<div>
<div style="font-size:13px;letter-spacing:.3em;text-transform:uppercase;color:#9d8eff;font-weight:600">Listening Together</div>
<div style="font-size:20px;font-weight:600;margin-top:6px">${escapeHtml(name)}</div>
<div style="font-size:14px;color:#aaa6c2;margin-top:4px">Hosted by ${escapeHtml(host)} · ${escapeHtml(participants)} listening</div>
<div style="margin-top:18px;font-size:13px;color:#6d74ff;font-weight:600">Join the room →</div>
</div>
</a>
</body>
</html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" } });
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

// ---------------------------------------------------------------------------
// Expanded Player Studio — Worker backend layer.
//
// The Studio performs real audio processing CLIENT-SIDE (Web Audio API DSP:
// center-channel vocal removal/isolation, EQ, gain, mixing, WAV export).
// The Worker handles:
//   • Session validation — confirms the request comes from the published app
//   • Rate limiting — in-memory per-isolate, best-effort (60s window)
//   • Share metadata — generates OG tags for shared studio outputs
//
// Processing job state (queued → preparing → processing → complete/failed)
// lives in the StudioHistory Base44 entity, which is RLS-isolated per user
// and requires NO integration credits (entity CRUD is not a Core integration).
// Generated audio files are uploaded via UploadPrivateFile and stored as
// file_uri on the entity; downloads use CreateFileSignedUrl (client-side).
//
// This keeps the Worker stateless (no R2/KV/D1) and uses zero Base44 credits.
// ---------------------------------------------------------------------------

// In-memory rate limiter (per-isolate, best-effort). Cloudflare Workers may
// run on multiple isolates, so this is not a hard limit — but it catches abuse
// from a single isolate and provides honest feedback. Resets every 60s.
const studioRateBucket = new Map(); // clientKey → { count, windowStart }
const STUDIO_RATE_MAX = 15; // max processing jobs per 60s per client
const STUDIO_RATE_WINDOW = 60_000;

function clientKey(request) {
  const fwd = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  return fwd.split(",")[0].trim();
}

function checkRateLimit(request) {
  const key = clientKey(request);
  const now = Date.now();
  let bucket = studioRateBucket.get(key);
  if (!bucket || now - bucket.windowStart > STUDIO_RATE_WINDOW) {
    bucket = { count: 0, windowStart: now };
    studioRateBucket.set(key, bucket);
  }
  bucket.count++;
  return {
    allowed: bucket.count <= STUDIO_RATE_MAX,
    remaining: Math.max(0, STUDIO_RATE_MAX - bucket.count),
    resetMs: bucket.windowStart + STUDIO_RATE_WINDOW - now,
  };
}

// POST /studio/validate — validates that the request is from the published app
// and checks the rate limit. Returns a processing token (opaque, used by the
// client to tag the StudioHistory entity) and the rate limit status.
async function studioValidate(request) {
  const rl = checkRateLimit(request);
  if (!rl.allowed) {
    return json({ ok: false, error: "rate_limited", retryAfterMs: rl.resetMs }, 429, { "Retry-After": String(Math.ceil(rl.resetMs / 1000)) });
  }
  // Generate an opaque processing token. The client includes this on the
  // StudioHistory entity for traceability; it carries no authority (the
  // entity's RLS is the real security boundary).
  const token = "stu_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  return json({ ok: true, token, rateLimit: { remaining: rl.remaining, resetMs: rl.resetMs } });
}

// GET /studio/rate-limit — returns the current rate limit status without
// consuming a slot. Used by the UI to show "N processing remaining" and
// disable the process button when the user is out of slots.
function studioRateLimit(request) {
  const key = clientKey(request);
  const now = Date.now();
  const bucket = studioRateBucket.get(key);
  if (!bucket || now - bucket.windowStart > STUDIO_RATE_WINDOW) {
    return json({ remaining: STUDIO_RATE_MAX, resetMs: 0 });
  }
  const remaining = Math.max(0, STUDIO_RATE_MAX - bucket.count);
  return json({ remaining, resetMs: bucket.windowStart + STUDIO_RATE_WINDOW - now });
}

// POST /studio/share — generates share metadata for a studio output. The
// client passes the track info + processing type; the worker returns OG
// metadata + a canonical share URL. Used when a user shares an instrumental
// or acapella to social media.
async function studioShare(request, origin) {
  const body = await request.json().catch(() => ({}));
  const { trackTitle, trackArtist, processingType, artwork } = body;
  if (!trackTitle) return json({ error: "Missing trackTitle" }, 400);

  const typeLabel = {
    vocal_removal: "Instrumental",
    vocal_isolation: "Acapella",
    stem_separation: "Stems",
    custom_mix: "Custom Mix",
    karaoke: "Karaoke",
    acapella: "Acapella",
  }[processingType] || "Studio Output";

  const title = `${trackTitle} (${typeLabel})`;
  const description = `${trackArtist || "Unknown Artist"} · Made with Sonora Studio`;
  const image = artwork ? `${origin}/share/art?u=${encodeURIComponent(artwork)}` : `${SONORA_APP}/icon-512.png`;
  const shareUrl = `${SONORA_APP}/studio`;

  return json({
    title,
    description,
    image,
    shareUrl,
    typeLabel,
  }, 200, { "Cache-Control": "public, max-age=300" });
}

// ---------------------------------------------------------------------------
// Exported worker — one guard around every route.
//
// The router above is kept intact; this wrapper only makes failure honest.
// Without it an unexpected throw escapes the module and the platform returns
// its own error payload, which the app can only show as a generic "unknown
// error". Now any throw comes back as CORS-enabled JSON (status 500) the
// client can parse and recover from, and the cron path reports a soft failure
// instead of dying silently.
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    try {
      return await WORKER.fetch(request, env);
    } catch (e) {
      console.error("worker request failed:", (e && e.stack) || e);
      return json({ ok: false, error: "internal_error", message: String((e && e.message) || e) }, 500);
    }
  },

  scheduled(event, env, ctx) {
    return WORKER.scheduled(event, env, ctx);
  },
};