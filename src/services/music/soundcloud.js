// Low-level SoundCloud client. Requests go through a free Cloudflare Worker
// proxy (CORS bypass + client_id kept server-side). If that worker is
// unreachable (ad-blockers/privacy browsers commonly block *.workers.dev,
// or the worker is over its free quota), every request transparently falls
// back to the app's own Base44 `soundcloud` backend function — a pure-fetch
// proxy that uses no Core integration (so it is never credit-gated) and is
// same-origin, so ad-blockers leave it alone. Either path returns identical
// SoundCloud JSON.
//
// - In-memory TTL cache (60s default)
// - In-flight request de-duplication: identical concurrent requests share one
//   network call (Home rails often ask for the same seed simultaneously).
export const PROXY_URL = "https://sonora-proxy.mohamedkadry8722.workers.dev";
// Give the worker a short leash: a blocked worker rejects instantly, but a
// hung one shouldn't stall the whole app — fall back to the backend function.
const WORKER_TIMEOUT = 7000;

const memCache = new Map();
const inflight = new Map();
const TTL = 60_000;
const MAX_CACHE = 400;

async function fetchViaWorker(url, params) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WORKER_TIMEOUT);
  try {
    const res = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, params }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      const err = new Error(data?.error || `Music service error (${res.status})`);
      err.isHttpError = true;
      throw err;
    }
    if (data.error) throw new Error(data.error);
    return data;
  } catch (e) {
    if (e.isHttpError) throw e;
    // Network error (worker blocked / timed out / unreachable) — mark so the
    // caller knows to try the backend fallback rather than re-throwing an
    // HTTP error that the backend would just get again from SoundCloud.
    e.isNetworkError = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function raw(url, params, { cache = true, ttl = TTL } = {}) {
  const key = url + JSON.stringify(params || {});
  if (cache) {
    const hit = memCache.get(key);
    if (hit && Date.now() - hit.t < ttl) return hit.v;
    if (inflight.has(key)) return inflight.get(key);
  }
  const p = (async () => {
    let data;
    try {
      data = await fetchViaWorker(url, params);
    } catch (workerErr) {
      // The worker is the only music backend. On a transient network error
      // retry it once; HTTP errors (SoundCloud 404/403) are final.
      if (workerErr.isNetworkError) {
        data = await fetchViaWorker(url, params);
      } else {
        throw workerErr;
      }
    }
    if (cache) {
      if (memCache.size > MAX_CACHE) memCache.delete(memCache.keys().next().value);
      memCache.set(key, { v: data, t: Date.now() });
    }
    return data;
  })();
  if (cache) inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

const API = "https://api-v2.soundcloud.com";

// Wrap a resolved media-CDN URL through the worker's /dl byte-stream proxy so
// audio loads from the same origin as track data (defeats audio-CDN blocking).
export function audioProxyUrl(mediaUrl) {
  try { return `${PROXY_URL}/dl?url=${encodeURIComponent(mediaUrl)}`; } catch { return mediaUrl; }
}
// Inverse: pull the raw CDN URL back out of a /dl proxy URL (used as the
// fallback if the proxy itself ever fails).
export function directUrlFromProxy(proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    if (u.pathname === "/dl") return u.searchParams.get("url") || proxyUrl;
    return proxyUrl;
  } catch { return proxyUrl; }
}

export const sc = {
  raw,
  searchTracks: (q, limit = 20, offset = 0, filters = {}) =>
    raw(`${API}/search/tracks`, { q, limit, offset, ...filters }),
  searchUsers: (q, limit = 20) => raw(`${API}/search/users`, { q, limit }),
  searchPlaylists: (q, limit = 20) => raw(`${API}/search/playlists`, { q, limit }),
  getTrack: (id) => raw(`${API}/tracks/${id}`),
  getArtist: (id) => raw(`${API}/users/${id}`, null, { ttl: 10 * 60_000 }),
  getArtistTracks: (id, limit = 30) => raw(`${API}/users/${id}/tracks`, { limit }),
  getArtistTop: (id, limit = 20) => raw(`${API}/users/${id}/toptracks`, { limit }),
  getArtistPlaylists: (id, limit = 20) => raw(`${API}/users/${id}/playlists`, { limit }),
  getRelatedArtists: (id, limit = 12) =>
    raw(`${API}/users/${id}/relatedartists`, { limit }, { ttl: 10 * 60_000 }),
  getRelatedTracks: (id, limit = 20) => raw(`${API}/tracks/${id}/related`, { limit }),
  getCharts: (genre = "soundcloud:genres:all-music", kind = "top", limit = 50, locale) =>
    raw(`${API}/charts`, { kind, genre, limit, ...(locale ? { locale } : {}) }),
  getPlaylist: (id) => raw(`${API}/playlists/${id}`),
  getFeaturedPlaylists: (limit = 20) => raw(`${API}/featured-playlists`, { limit }),
  resolve: (permalink) => raw(`${API}/resolve`, { url: permalink }),
};

// Diagnostics + maintenance for the Advanced / Performance panels.
export function cacheStats() {
  return { entries: memCache.size, inflight: inflight.size, max: MAX_CACHE };
}
export function clearCache() {
  memCache.clear();
  inflight.clear();
}