// SonoraPlatform — the platform adapter.
//
// The shared Sonora core never branches on platform directly. It calls this
// adapter, which detects the runtime (web, Electron, Android Capacitor, iOS
// Capacitor) and exposes a uniform capability surface. Each native shell
// injects a bridge before the React app boots:
//   - Electron: window.sonoraDesktop (from preload.js)
//   - Capacitor: window.Capacitor (from @capacitor/core)
// On the web, neither is present, so the web adapter is the default.
//
// This is the ONE place platform-specific logic lives. Everything else —
// auth, player, library, downloads, settings, themes, Music DNA — runs on
// the shared core and calls through here.

import { APP_VERSION } from "./version";

function detect() {
  if (typeof window === "undefined") return "web";
  if (window.sonoraDesktop) return "electron";
  if (window.Capacitor) {
    const plat = window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : "web";
    return plat; // "android" | "ios" | "web"
  }
  return "web";
}

export const PLATFORM = detect();

export const isDesktop = PLATFORM === "electron";
export const isAndroid = PLATFORM === "android";
export const isIOS = PLATFORM === "ios";
export const isMobile = isAndroid || isIOS;
export const isWeb = PLATFORM === "web";

// Native bridge — null on web. Electron's preload sets window.sonoraDesktop.
export const desktopBridge = (typeof window !== "undefined" && window.sonoraDesktop) || null;

// ---- Capability queries ---------------------------------------------------

// Can the app self-update without a manual download? Electron uses
// electron-updater; mobile uses the platform store; web uses SW refresh.
export function supportsAutoUpdate() {
  return isDesktop && !!desktopBridge?.updater;
}

// Can the app be installed as a PWA? Only on web with service worker support.
export function canInstallPWA() {
  return isWeb && "serviceWorker" in navigator;
}

// Does the platform allow audio to keep playing in the background?
export function supportsBackgroundAudio() {
  if (isDesktop) return true;
  if (isMobile) return true; // Capacitor background-audio plugin
  return false; // web browsers suspend audio when the tab is hidden
}

// Does the platform expose native media controls (lock screen / media keys)?
export function supportsNativeMediaControls() {
  if (isDesktop) return true;
  if (isMobile) return true; // Capacitor media-session plugin
  return typeof navigator !== "undefined" && "mediaSession" in navigator;
}

// Does the platform have native filesystem access for downloads?
export function supportsNativeFS() {
  return isDesktop && !!desktopBridge?.getDownloadsDirectory;
}

// ---- Platform info --------------------------------------------------------

export function getPlatform() {
  return PLATFORM;
}

export function getVersion() {
  if (desktopBridge?.version) return desktopBridge.version;
  return APP_VERSION;
}

export function platformLabel() {
  if (isDesktop) return "Windows Desktop";
  if (isAndroid) return "Android";
  if (isIOS) return "iOS";
  return "Web";
}

// ---- Actions --------------------------------------------------------------

// Open an external URL in the platform's native handler (system browser on
// desktop, external browser on mobile). Falls back to window.open on web.
export function openExternal(url) {
  if (isDesktop && desktopBridge?.openExternal) {
    desktopBridge.openExternal(url);
    return;
  }
  if (typeof window !== "undefined" && window.Capacitor?.Plugins?.Browser?.openUrl) {
    window.Capacitor.Plugins.Browser.openUrl({ url });
    return;
  }
  if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
}

// Trigger a native update install if the platform supports it.
// Returns true if the update was handed off to the native updater.
export async function installNativeUpdate() {
  // Prefer the download-then-install flow: calling quitAndInstall before a
  // download exists throws "No update filepath provided". installUpdate
  // downloads first (idempotent) and only then quits + installs.
  if (supportsAutoUpdate() && desktopBridge?.installUpdate) {
    try { return await desktopBridge.installUpdate(); } catch { return false; }
  }
  if (supportsAutoUpdate() && desktopBridge?.quitAndInstall) {
    desktopBridge.quitAndInstall();
    return true;
  }
  return false;
}

// Show a native notification (desktop / mobile). Falls back to the web
// Notification API on web.
export async function showNotification(title, options = {}) {
  if (isDesktop && desktopBridge?.showNotification) {
    desktopBridge.showNotification(title, options);
    return;
  }
  if (typeof window !== "undefined" && "Notification" in window) {
    if (Notification.permission === "granted") {
      new Notification(title, options);
    } else if (Notification.permission !== "denied") {
      const perm = await Notification.requestPermission();
      if (perm === "granted") new Notification(title, options);
    }
  }
}

// Native share sheet (mobile). No-op on desktop/web where the caller falls back.
export async function share(data) {
  if (typeof window !== "undefined" && window.Capacitor?.Plugins?.Share) {
    try {
      await window.Capacitor.Plugins.Share.share(data);
      return true;
    } catch { return false; }
  }
  if (typeof navigator !== "undefined" && navigator.share) {
    try {
      await navigator.share(data);
      return true;
    } catch { return false; }
  }
  return false;
}

// Open a Sonora deep link (sonora://track/123). On native, the shell handles
// the scheme; on web we navigate to the equivalent route.
export function openDeepLink(path) {
  if (typeof window === "undefined") return;
  const clean = path.replace(/^sonora:\/\//, "").replace(/^\//, "");
  if (isDesktop && desktopBridge?.openDeepLink) {
    desktopBridge.openDeepLink(`sonora://${clean}`);
    return;
  }
  // Web: navigate to the route (deep links are just URL paths here).
  window.location.href = `/${clean}`;
}

// The native downloads directory (desktop only). The download engine uses
// IndexedDB on web/mobile; on desktop it can optionally use the filesystem.
export async function getDownloadsDirectory() {
  if (supportsNativeFS() && desktopBridge?.getDownloadsDirectory) {
    try {
      return await desktopBridge.getDownloadsDirectory();
    } catch { return null; }
  }
  return null;
}

// Backward-compatible aliases (older code may import these names).
export { canAutoUpdate as canAutoUpdate };
function canAutoUpdate() {
  return supportsAutoUpdate();
}