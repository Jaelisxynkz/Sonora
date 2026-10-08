// Sonora application version — the single source of truth for the INSTALLED
// version. Used by the web app, the Electron desktop build, and the Capacitor
// mobile builds. The Cloudflare Worker's /version endpoint reports the LATEST
// release; this constant reports what is installed. The update checker
// compares the two.
//
// Bump this on every production publish. Semantic versioning: MAJOR.MINOR.PATCH.

export const APP_VERSION = "1.1.4";
export const APP_BUILD = 5;
export const APP_NAME = "Sonora";
export const APP_CODENAME = "Aurora";

// Compare two semantic version strings.
// Returns -1 if a < b, 1 if a > b, 0 if equal.
export function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

export function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0;
}