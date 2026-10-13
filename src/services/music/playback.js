// Resolves a track's playable stream URL. SoundCloud serves audio via
// transcodings; we rank them (progressive mp3 first, then HLS) and resolve
// the best available one through the proxy to a signed CDN URL.
//
// Progressive URLs play directly via <audio>. HLS (.m3u8) URLs need hls.js
// on non-Safari browsers — PlayerContext handles that detection.
import { sc, audioProxyUrl } from "./soundcloud";
import { isWorkerBlocked } from "./workerHealth";
import { classifyMetadata, ERROR_CATEGORY } from "@/services/playback/errorClassifier";
import {
  isKnownPlayable, knownRestriction, inFailureCooldown,
  markPlayable, markRestricted, markTemporaryFailure,
} from "@/services/playback/availabilityCache";
import { markRegionUnavailable, clearRegionUnavailable } from "@/services/playback/regionUnavailable";

// Streaming quality preference — set from SettingsContext. Controls which
// transcodings are preferred when resolving a track's stream URL.
//   "high"      → HLS first (can deliver higher bitrates), then progressive
//   "standard"  → Progressive mp3 first (most reliable), then HLS (default)
//   "data_saver"→ Progressive only (drops HLS to save bandwidth)
//   "auto"      → resolved to "standard" or "data_saver" by the settings layer
let streamQuality = "standard";
export function setStreamQuality(q) { streamQuality = q || "standard"; }

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
export async function getStreamUrlsRaw(track, { allowAlternate = true, preferHq = false } = {}) {
  if (!track) return [];
  if (track.provider === "audius") {
    const { audiusStreamUrls } = await import("./providers/audius");
    return audiusStreamUrls(track);
  }
  // Set once a full search for another upload of this song came up empty.
  let altSearched = false;

  // ---- Availability cache: skip futile work + fast-path known-good tracks ----
  // A track confirmed playable recently doesn't need re-probing; a track with
  // a fresh confirmed restriction goes straight to the alternate search
  // (skipping resolution that would just fail the same way). Temporary
  // failures are NOT cached long enough to block a retry — see availabilityCache.
  if (track.id) {
    if (isKnownPlayable(track.id)) {
      // fall through to normal resolution (fast — no probe needed); the cache
      // only tells us the last attempt worked, not that this attempt will.
    } else {
      const restriction = knownRestriction(track.id);
      if (restriction && allowAlternate) {
        // Confirmed restriction — go straight to a legitimate alternate of the
        // same recording. If none exists, fall through to the normal path
        // (e.g. a SNIP track still has its licensed preview).
        const alt = await tryAlternate(track);
        if (alt.length) return alt;
        allowAlternate = false; // already searched — don't repeat below
        altSearched = true;
      }
    }
  }

  // ---- Metadata classification: detect source-level issues early ----
  // policy BLOCK is SoundCloud's own upstream confirmation that this upload
  // isn't available for the requester's region — the only signal Sonora
  // treats as REGION_RESTRICTED. Never bypassed; a legitimate alternate
  // upload of the same recording is searched instead.
  const metaIssue = classifyMetadata(track);
  if (metaIssue === ERROR_CATEGORY.NOT_STREAMABLE || metaIssue === ERROR_CATEGORY.REGION_RESTRICTED) {
    if (track.id) markRestricted(track.id, metaIssue);
    const alt = allowAlternate ? await tryAlternate(track) : [];
    if (alt.length) return alt;
    if (metaIssue === ERROR_CATEGORY.REGION_RESTRICTED && (allowAlternate || altSearched)) {
      markRegionUnavailable(track.id, "blocked");
    }
    return [];
  }
  // DRM-only and snippet-only are handled below (they try alternates).

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
  // Plain progressive/hls are the playable paths. Encrypted (DRM) ones are
  // only used to detect DRM-only tracks, which fall back to a playable
  // upload of the same recording.
  const isEnc = (t) => /encrypted/.test(t.format?.protocol || "");
  const plain = transcodings.filter((t) => !isEnc(t));
  const enc = transcodings.filter((t) => isEnc(t));
  if (!plain.length && !enc.length) return [];

  const progressive = plain.filter((t) => t.format?.protocol === "progressive");
  const hls = plain.filter((t) => t.format?.protocol === "hls");
  // Highest quality first (SoundCloud "hq" / higher-bitrate presets), then
  // progressive mp3 for compatibility.
  const qRank = (t) => (t.quality === "hq" || /160|256|320|hq/.test(t.preset || "") ? 0 : 1);
  progressive.sort((a, b) => {
    const q = qRank(a) - qRank(b);
    if (q) return q;
    const aMp3 = a.format?.mime_type === "audio/mpeg" ? 0 : 1;
    const bMp3 = b.format?.mime_type === "audio/mpeg" ? 0 : 1;
    return aMp3 - bMp3;
  });
  hls.sort((a, b) => qRank(a) - qRank(b));

  // Resolve progressive + HLS in parallel so adding the HLS safety net costs
  // no extra wall-clock latency on the happy path. Signed CDN URLs expire,
  // so never serve them from the request cache.
  const tq = (t) => (t.quality === "hq" || /160|256|320|hq/.test(t.preset || "")) ? "hq" : "standard";
  const resolveOne = async (t) => {
    try {
      const data = await sc.raw(t.url, auth ? { track_authorization: auth } : {}, { cache: false });
      const url = data?.url || null;
      return url ? { url, quality: tq(t) } : null;
    } catch {
      return null;
    }
  };
  const build = (prog, hlsArr, preferHq) => {
    const o = [];
    // When the Worker is blocked by a content blocker, the proxy URL is on
    // the blocked *.workers.dev domain and fails instantly. Put the direct
    // CDN URL first — the <audio> element plays cross-origin without CORS,
    // so playback works even when the proxy is unreachable. The proxy
    // becomes the fallback for networks that block the SoundCloud CDN.
    const blocked = isWorkerBlocked();
    const preferHls = streamQuality === "high";
    const dropHls = streamQuality === "data_saver";
    const progEntries = [];
    for (const u of prog) {
      if (!u) continue;
      const url = u.url || u;
      const q = u.quality || "standard";
      if (blocked) {
        progEntries.push({ url, protocol: "progressive", quality: q });
        progEntries.push({ url: audioProxyUrl(url), protocol: "progressive", quality: q });
      } else {
        progEntries.push({ url: audioProxyUrl(url), protocol: "progressive", quality: q });
        progEntries.push({ url, protocol: "progressive", quality: q });
      }
    }
    const hlsEntries = [];
    if (!dropHls) {
      for (const u of hlsArr) {
        if (!u) continue;
        const url = u.url || u;
        hlsEntries.push({ url, protocol: "hls", quality: u.quality || "standard" });
      }
    }
    // "high" quality prefers HLS (higher bitrate potential) over progressive;
    // everything else keeps progressive first for reliability.
    if (preferHls) o.push(...hlsEntries, ...progEntries);
    else o.push(...progEntries, ...hlsEntries);
    // Highest-quality-first (alternate-version resolution): sort hq entries to
    // the front regardless of protocol so the best available bitrate plays first.
    if (preferHq) o.sort((a, b) => (a.quality === "hq" ? 0 : 1) - (b.quality === "hq" ? 0 : 1));
    return o;
  };

  // Encrypted (DRM) streams can't be decrypted by a web player, so they are
  // never played directly — a DRM-only track is resolved to a playable upload
  // of the same original recording instead (see playableAlternate.js).
  // Label-monetized uploads carry DRM streams, and SoundCloud usually disables
  // their plain stream. Start the search for another playable upload of the
  // same song IN PARALLEL with resolving this one, so if it turns out to be
  // DRM-only the replacement is already ready — no waiting, no skip.
  const altPromise = enc.length && allowAlternate ? tryAlternate(track) : null;
  let [progUrls, hlsUrls] = await Promise.all([
    Promise.all(progressive.map(resolveOne)),
    Promise.all(hls.map(resolveOne)),
  ]);
  let out = build(progUrls, hlsUrls, preferHq);
  if (!out.length && enc.length) {
    // DRM-only for web players: go straight to the alternate (skip the slow
    // stale-URL / rate-limit recoveries — they can't help a disabled stream).
    if (track.id) markRestricted(track.id, ERROR_CATEGORY.DRM_ONLY);
    const alt = altPromise ? await altPromise : [];
    if (alt.length) return alt;
    if (allowAlternate || altSearched) markRegionUnavailable(track.id, "protected");
    return [];
  }
  // 30s preview-only (SNIP) tracks: prefer a full-length upload of the same
  // recording; keep the preview only if none exists.
  const previewOnly = plain.length > 0 && plain.every((t) => t.snipped);
  if (previewOnly) {
    // SoundCloud licenses only a 30s preview of this upload for the requester's
    // region (policy SNIP). Prefer a full upload of the same recording.
    if (track.id) markRestricted(track.id, ERROR_CATEGORY.SNIPPET_ONLY);
    if (allowAlternate) {
      const alt = await (altPromise || tryAlternate(track));
      if (alt.length) return alt;
      altSearched = true;
    }
    // No full version exists anywhere — show it as "Not available in your
    // country" (like SoundCloud) instead of playing a 30s preview and skipping.
    if (altSearched) markRegionUnavailable(track.id, "preview");
    return [];
  }

  // Stale-URL recovery: SoundCloud's signed CDN URLs expire after a while. If a
  // track sat in a rail/cache long enough for its transcodings to go stale,
  // every resolution above returns null and the player would skip a track
  // that's actually fine. Re-fetch fresh transcodings straight from
  // SoundCloud once and re-resolve — this turns a silent skip into a play.
  if (!out.length && track.id) {
    try {
      const fresh = await sc.getTrack(track.id);
      const ft = fresh?.media?.transcodings || [];
      const ftEnc = (t) => /encrypted/.test(t.format?.protocol || "");
      const ftPlain = ft.filter((t) => !ftEnc(t));
      const ftEncHls = ft.filter((t) => ftEnc(t));
      if (ftPlain.length || ftEncHls.length) {
        const fProg = ftPlain.filter((t) => t.format?.protocol === "progressive");
        const fHls = ftPlain.filter((t) => t.format?.protocol === "hls");
        fProg.sort((a, b) => (a.format?.mime_type === "audio/mpeg" ? 0 : 1) - (b.format?.mime_type === "audio/mpeg" ? 0 : 1));
        const fAuth = fresh?.track_authorization || auth;
        const fResolve = (t) => sc.raw(t.url, fAuth ? { track_authorization: fAuth } : {}, { cache: false }).then((d) => { const url = d?.url || null; return url ? { url, quality: (t.quality === "hq" || /160|256|320|hq/.test(t.preset || "")) ? "hq" : "standard" } : null; }).catch(() => null);
        const [fp, fh] = await Promise.all([
          Promise.all(fProg.map(fResolve)),
          Promise.all(fHls.map(fResolve)),
        ]);
        out = build(fp, fh, preferHq);
      }
    } catch {}
  }
  // Transient-recovery: the worker proxy can rate-limit under load, making
  // every resolve return null even for a playable track. Wait briefly for the
  // worker to recover and re-resolve once before giving up (which would skip).
  if (!out.length && (progressive.length || hls.length)) {
    await new Promise((r) => setTimeout(r, 1500));
    const [rp, rh] = await Promise.all([
      Promise.all(progressive.map(resolveOne)),
      Promise.all(hls.map(resolveOne)),
    ]);
    out = build(rp, rh);
  }
  // Final fallback: every resolution + recovery path returned nothing. Try a
  // playable upload of the same recording from another source before returning
  // empty (which would skip the track). Tries every possible way — no skips.
  if (!out.length && allowAlternate) {
    if (track.id) markTemporaryFailure(track.id, ERROR_CATEGORY.UNKNOWN);
    const alt = await tryAlternate(track);
    if (alt.length) return alt;
    // Nothing works for this song anywhere right now — show it as unavailable
    // instead of skipping (Try again re-checks).
    markRegionUnavailable(track.id, "unplayable");
  }
  return out;
}

async function tryAlternate(track) {
  try {
    // Candidates are tagged with the alternate track so the player shows what
    // is really playing ("another available version"), never the original.
    const { findPlayableAlternateWithStreams } = await import("./playableAlternate");
    const r = await findPlayableAlternateWithStreams(track);
    if (r) clearRegionUnavailable(track.id);
    return r ? r.urls.map((u) => ({ ...u, alternate: { ...r.track, _alternateOf: String(track.id) } })) : [];
  } catch {
    return [];
  }
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