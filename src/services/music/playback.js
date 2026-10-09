// Resolves a track's playable stream URL. SoundCloud serves audio via
// transcodings; we rank them (progressive mp3 first, then HLS) and resolve
// the best available one through the proxy to a signed CDN URL.
//
// Progressive URLs play directly via <audio>. HLS (.m3u8) URLs need hls.js
// on non-Safari browsers — PlayerContext handles that detection.
import { sc, audioProxyUrl } from "./soundcloud";

// Resolve every available transcoding into an ordered list of playable
// candidates so the player can fall back through them if one fails at
// playback (e.g. a progressive stream that 404s or is ad-blocker blocked).
// Order: progressive-proxied (worker /dl) → progressive-direct (raw CDN) →
// HLS. The happy path still plays the first candidate; the rest are safety
// nets that only activate on deck error.
// Offline-first: if a validated local download exists, the player uses the
// local copy (works online and offline, saves bandwidth). Otherwise the
// normal streaming pipeline runs — completely unchanged. This is the ONLY
// touchpoint between the download system and playback; it never pauses,
// reloads or alters the player, queue, lyrics or transitions.
export async function getStreamUrls(track) {
  if (!track) return [];
  try {
    const { getLocalSource } = await import("@/services/download/playbackResolver");
    const local = await getLocalSource(track);
    if (local) return [{ url: local.url, protocol: "progressive" }];
  } catch {}
  return getStreamUrlsRaw(track);
}

// Raw streaming resolution (no local-source check) — used by the download
// engine so it never re-downloads its own offline copy.
export async function getStreamUrlsRaw(track) {
  if (!track) return [];
  if (track.streamable === false) return [];

  // Creator uploads (provider "sonora") carry a direct R2 stream URL — no
  // transcoding resolution needed. They play through the same player.
  if (track.streamUrl) return [{ url: track.streamUrl, protocol: "progressive" }];

  let transcodings = track.transcodings || [];
  let auth = track.trackAuthorization || null;
  if (!transcodings.length && track.id) {
    try {
      const fresh = await sc.getTrack(track.id);
      transcodings = fresh?.media?.transcodings || [];
      auth = fresh?.track_authorization || auth;
    } catch {
      transcodings = [];
    }
  }
  if (!transcodings.length) return [];
  // DRM-protected (encrypted-only) tracks can't play in a browser — bail out
  // fast so the player skips instead of waiting on streams that 404.
  if (transcodings.some((t) => /encrypted/.test(t.format?.protocol || ""))) return [];

  const progressive = transcodings.filter((t) => t.format?.protocol === "progressive");
  const hls = transcodings.filter((t) => t.format?.protocol === "hls");
  // Prefer progressive mp3 (most compatible), then any progressive, then HLS.
  progressive.sort((a, b) => {
    const aMp3 = a.format?.mime_type === "audio/mpeg" ? 0 : 1;
    const bMp3 = b.format?.mime_type === "audio/mpeg" ? 0 : 1;
    return aMp3 - bMp3;
  });

  // Resolve progressive + HLS in parallel so adding the HLS safety net costs
  // no extra wall-clock latency on the happy path. Signed CDN URLs expire,
  // so never serve them from the request cache.
  const resolveOne = async (t) => {
    try {
      const data = await sc.raw(t.url, auth ? { track_authorization: auth } : {}, { cache: false });
      return data?.url || null;
    } catch {
      return null;
    }
  };
  const build = (prog, hlsArr) => {
    const o = [];
    for (const u of prog) {
      if (!u) continue;
      // Proxied first (defeats audio-CDN blocking), then the raw CDN URL as a
      // direct fallback if the proxy itself is unreachable.
      o.push({ url: audioProxyUrl(u), protocol: "progressive" });
      o.push({ url: u, protocol: "progressive" });
    }
    for (const u of hlsArr) {
      if (u) o.push({ url: u, protocol: "hls" });
    }
    return o;
  };

  let [progUrls, hlsUrls] = await Promise.all([
    Promise.all(progressive.map(resolveOne)),
    Promise.all(hls.map(resolveOne)),
  ]);
  let out = build(progUrls, hlsUrls);

  // Stale-URL recovery: SoundCloud's signed CDN URLs expire after a while. If a
  // track sat in a rail/cache long enough for its transcodings to go stale,
  // every resolution above returns null and the player would skip a track
  // that's actually fine. Re-fetch fresh transcodings straight from
  // SoundCloud once and re-resolve — this turns a silent skip into a play.
  if (!out.length && track.id) {
    try {
      const fresh = await sc.getTrack(track.id);
      const ft = fresh?.media?.transcodings || [];
      if (ft.length && !ft.some((t) => /encrypted/.test(t.format?.protocol || ""))) {
        const fProg = ft.filter((t) => t.format?.protocol === "progressive");
        const fHls = ft.filter((t) => t.format?.protocol === "hls");
        fProg.sort((a, b) => (a.format?.mime_type === "audio/mpeg" ? 0 : 1) - (b.format?.mime_type === "audio/mpeg" ? 0 : 1));
        const fAuth = fresh?.track_authorization || auth;
        const fResolve = (t) => sc.raw(t.url, fAuth ? { track_authorization: fAuth } : {}, { cache: false }).then((d) => d?.url || null).catch(() => null);
        const [fp, fh] = await Promise.all([
          Promise.all(fProg.map(fResolve)),
          Promise.all(fHls.map(fResolve)),
        ]);
        out = build(fp, fh);
      }
    } catch {}
  }
  return out;
}

// First usable URL (for preloading / single-URL consumers). The player itself
// uses getStreamUrls so it can walk the full fallback chain.
export async function getStreamUrl(track) {
  const list = await getStreamUrls(track);
  return list[0]?.url || null;
}

// Preload the next track's stream URL so transitions feel instant.
export async function preloadStream(track) {
  if (!track) return null;
  try {
    return await getStreamUrl(track);
  } catch {
    return null;
  }
}