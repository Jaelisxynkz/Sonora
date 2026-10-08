// Sonora Desktop — Electron preload bridge.
//
// Exposes a minimal, secure API (window.sonoraDesktop) to the shared React
// core so it can check for updates, trigger install/restart, open external
// links, access the native downloads directory, and receive deep links —
// all without direct Node access. This is the bridge platformAdapter.js
// detects on the desktop build.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sonoraDesktop", {
  platform: "electron",
  updater: true,
  // Read the real app version from the main process (app.getVersion()). The
  // npm_package_version env var is undefined in packaged builds, so a static
  // fallback would always report "1.0.0".
  version: ipcRenderer.sendSync("sonora:get-version") || "1.0.0",

  // Hand off to electron-updater: quit, install the downloaded update, restart.
  quitAndInstall: () => ipcRenderer.send("sonora:quit-and-install"),

  // Open a URL in the system browser.
  openExternal: (url) => ipcRenderer.send("sonora:open-external", url),

  // Native downloads directory (for filesystem-based offline music).
  getDownloadsDirectory: () => ipcRenderer.invoke("sonora:get-downloads-dir"),

  // Listen for update events from the main process.
  onUpdateAvailable: (cb) => ipcRenderer.on("sonora:update-available", (_e, info) => cb(info)),
  onUpdateReady: (cb) => ipcRenderer.on("sonora:update-ready", () => cb()),
  onUpToDate: (cb) => ipcRenderer.on("sonora:up-to-date", () => cb()),
  onUpdateProgress: (cb) => ipcRenderer.on("sonora:update-progress", (_e, pct) => cb(pct)),
  onUpdateError: (cb) => ipcRenderer.on("sonora:update-error", (_e, msg) => cb(msg)),

  // Deep-link routing: the main process sends a path, the renderer routes it.
  onDeepLink: (cb) => ipcRenderer.on("sonora:deep-link", (_e, p) => cb(p)),

  // Discord Rich Presence — real IPC to the discord-rpc handler in the main
  // process. Selected automatically by adapters/index.js on the desktop build.
  discord: {
    init: (clientId) => ipcRenderer.invoke("sonora:discord:init", clientId),
    setActivity: (activity) => ipcRenderer.invoke("sonora:discord:set-activity", activity),
    clearActivity: () => ipcRenderer.invoke("sonora:discord:clear-activity"),
    disconnect: () => ipcRenderer.invoke("sonora:discord:disconnect"),
    status: () => ipcRenderer.invoke("sonora:discord:status"),
    reset: (clientId) => ipcRenderer.invoke("sonora:discord:reset", clientId),
  },
});