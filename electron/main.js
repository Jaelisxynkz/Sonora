// Sonora Desktop — Electron main process.
//
// This is the real Windows application entry point. It creates the native
// window, loads the Sonora web build, wires up auto-update (electron-updater),
// deep links (sonora://), window-state persistence, single-instance locking,
// and a secure preload bridge.
//
// Build:  npm run build:windows  →  produces Sonora Setup.exe (NSIS installer)
// Dev:    npm run electron:dev   →  loads the Vite dev server in the window
//
// DATA SEPARATION (so updates never destroy user content):
//   - Application files:  the NSIS install directory (managed by the installer)
//   - User data:          app.getPath("userData") — localStorage, settings,
//                         IndexedDB (downloaded music metadata). The NSIS
//                         uninstaller does NOT touch this (deleteAppDataOnUninstall: false).
//   - Downloaded music:   stored in IndexedDB inside userData — preserved across updates.
// The same React codebase runs here and on the web.

const { app, BrowserWindow, shell, Menu, ipcMain, session } = require("electron");
const path = require("path");
const fs = require("fs");
const { autoUpdater } = require("electron-updater");

// The live Sonora app — same accounts, backend and library as the web.
const APP_URL = "https://sonora-hub.base44.app";

let mainWindow = null;

// ---- Window state persistence --------------------------------------------
// Remember the window's bounds + maximized state across launches.
const stateFile = path.join(app.getPath("userData"), "window-state.json");
function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch { return null; }
}
function saveWindowState(win) {
  try {
    const state = { ...win.getBounds(), maximized: win.isMaximized() };
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch { /* non-fatal */ }
}

// ---- Deep links -----------------------------------------------------------
// Register the sonora:// scheme so OS-level links open Sonora directly.
const PROTOCOL = "sonora";
function handleDeepLink(url) {
  if (!mainWindow || !url.startsWith(`${PROTOCOL}://`)) return;
  // Strip the scheme and send the path to the renderer, which routes it.
  const deepPath = url.slice(`${PROTOCOL}://`.length);
  mainWindow.webContents.send("sonora:deep-link", `/${deepPath}`);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

// ---- Single instance ------------------------------------------------------
// Prevent multiple Sonora windows; route second launches to the existing one.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    // On Windows, deep links arrive as a command-line argument.
    const link = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (link) handleDeepLink(link);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  const saved = loadWindowState();
  mainWindow = new BrowserWindow({
    width: saved?.width || 1440,
    height: saved?.height || 900,
    x: saved?.x,
    y: saved?.y,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#0a0a0f",
    title: "Sonora",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    autoHideMenuBar: true,
    show: false,
  });

  if (saved?.maximized) mainWindow.maximize();
  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Persist window state on move/resize/close.
  const save = () => saveWindowState(mainWindow);
  mainWindow.on("resize", save);
  mainWindow.on("move", save);
  mainWindow.on("close", save);

  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadURL(APP_URL);
    const showOffline = () => mainWindow.loadFile(path.join(__dirname, "offline.html"));
    // No connection → branded offline screen with a retry button.
    mainWindow.webContents.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) showOffline();
    });
    // Server error on the app itself (e.g. 404/5xx) → same retry screen
    // instead of a raw JSON error page.
    mainWindow.webContents.on("did-navigate", (_e, url, httpCode) => {
      if (httpCode >= 400 && url.startsWith(APP_URL)) showOffline();
    });
  }

  // External links open in the system browser, not inside Sonora.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (!isDev) Menu.setApplicationMenu(null);
}

// ---- IPC handlers ---------------------------------------------------------
ipcMain.on("sonora:quit-and-install", () => {
  autoUpdater.quitAndInstall();
});
ipcMain.on("sonora:open-external", (_e, url) => {
  if (typeof url === "string") shell.openExternal(url);
});
ipcMain.handle("sonora:get-downloads-dir", () => {
  // Downloads live in userData/sonora-downloads — separated from app files,
  // preserved across updates and uninstall.
  const dir = path.join(app.getPath("userData"), "sonora-downloads");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
});

// Discord Rich Presence — the renderer drives these via the preload bridge.
ipcMain.handle("sonora:discord:init", (_e, clientId) => discordInit(clientId));
ipcMain.handle("sonora:discord:set-activity", (_e, activity) => discordSetActivity(activity));
ipcMain.handle("sonora:discord:clear-activity", () => discordClearActivity());
ipcMain.handle("sonora:discord:disconnect", () => discordDisconnect());

// ---- Discord Rich Presence ------------------------------------------------
// Real Discord RPC via the discord-rpc package (main process only). The
// renderer sends the user's Discord Client ID + activity payloads through
// the preload bridge; this opens the local IPC pipe to the running Discord
// desktop client and sets/clears the "Listening to Sonora" activity.
let discordClient = null;
let discordReady = false;

async function discordInit(clientId) {
  if (!clientId || typeof clientId !== "string") return false;
  if (discordClient && discordReady) return true;
  try { await discordDisconnect(); } catch {}
  try {
    const DiscordRPC = require("discord-rpc");
    DiscordRPC.register(clientId);
    discordClient = new DiscordRPC.Client({ transport: "ipc" });
    await discordClient.login({ clientId });
    discordReady = true;
    return true;
  } catch (e) {
    discordClient = null;
    discordReady = false;
    return false;
  }
}

async function discordSetActivity(activity) {
  if (!discordClient || !discordReady) return false;
  try {
    // ROOT CAUSE OF "Playing" vs "Listening to":
    // discord-rpc v4's setActivity() builds the activity from a HARDCODED field
    // list (state, details, timestamps, assets, party, secrets, buttons,
    // instance) — it does NOT forward `type`. So even though we pass type:2,
    // the library silently drops it and Discord defaults to type 0 (Playing),
    // showing "Playing Sonora" with a game-controller icon.
    //
    // FIX: bypass setActivity() and call the raw SET_ACTIVITY command via the
    // client's request() method, building the wire-format activity ourselves
    // so `type: 2` (ActivityType.LISTENING) actually reaches Discord. This is
    // the same workaround used by other music apps (e.g. Music Presence) to
    // get "Listening to <app>" with the live progress bar — exactly like
    // Spotify. Discord has supported type 2 + timestamps for third-party RPC
    // since mid-2024.
    const act = {
      type: 2, // ActivityType.LISTENING → "Listening to" + progress bar
      state: activity.state,
      details: activity.details,
      // instance:false = a listening activity, not a joinable game instance.
      // true makes Discord treat it as a game and suppresses the progress bar.
      instance: false,
    };
    if (activity.timestamps) {
      // Both start + end → Discord renders the live progress bar (elapsed /
      // remaining), the same way Spotify's presence does.
      act.timestamps = {
        start: activity.timestamps.start,
        ...(activity.timestamps.end != null ? { end: activity.timestamps.end } : {}),
      };
    }
    if (activity.assets) {
      act.assets = {
        large_image: activity.assets.large_image,
        large_text: activity.assets.large_text,
        small_image: activity.assets.small_image,
        small_text: activity.assets.small_text,
      };
    }
    if (Array.isArray(activity.buttons) && activity.buttons.length) {
      act.buttons = activity.buttons.slice(0, 2);
    }
    // Strip undefined keys so Discord doesn't receive nulls.
    Object.keys(act).forEach((k) => act[k] === undefined && delete act[k]);
    await discordClient.request("SET_ACTIVITY", { pid: process.pid, activity: act });
    return true;
  } catch {
    return false;
  }
}

async function discordClearActivity() {
  if (!discordClient || !discordReady) return false;
  try { await discordClient.clearActivity(); return true; } catch { return false; }
}

async function discordDisconnect() {
  if (discordClient) { try { await discordClient.destroy(); } catch {} }
  discordClient = null;
  discordReady = false;
}

// ---- Auto-update ----------------------------------------------------------
function setupAutoUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Allow pre-release versions to be picked up by the auto-updater so the
  // latest pre-release channel installs on existing desktop builds.
  autoUpdater.allowPrerelease = true;

  autoUpdater.on("update-available", (info) => {
    if (mainWindow) mainWindow.webContents.send("sonora:update-available", info);
  });
  autoUpdater.on("update-not-available", () => {
    if (mainWindow) mainWindow.webContents.send("sonora:up-to-date");
  });
  autoUpdater.on("download-progress", (p) => {
    if (mainWindow) mainWindow.webContents.send("sonora:update-progress", Math.round(p.percent));
  });
  autoUpdater.on("update-downloaded", () => {
    if (mainWindow) mainWindow.webContents.send("sonora:update-ready");
  });
  autoUpdater.on("error", (err) => {
    console.error("[Sonora] Auto-update error:", err);
    if (mainWindow) mainWindow.webContents.send("sonora:update-error", err?.message || "Update error");
  });

  autoUpdater.checkForUpdates();
  setInterval(() => autoUpdater.checkForUpdates(), 60 * 60 * 1000);
}

// ---- App lifecycle --------------------------------------------------------
// Present a standard Chrome user agent so Google sign-in isn't blocked as an
// "embedded browser".
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|sonora|Sonora)\/\S+/g, "");

app.whenReady().then(() => {
  // Register the deep-link protocol (Windows).
  if (process.platform === "win32") app.setAsDefaultProtocolClient(PROTOCOL);

  createWindow();
  setupAutoUpdater();

  // Handle a deep link that launched the app.
  const launchLink = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (launchLink) {
    setTimeout(() => handleDeepLink(launchLink), 1500);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// macOS deep-link events
app.on("open-url", (e, url) => {
  e.preventDefault();
  handleDeepLink(url);
});

app.on("window-all-closed", () => {
  discordDisconnect();
  if (process.platform !== "darwin") app.quit();
});