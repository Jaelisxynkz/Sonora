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
const APP_URL = "https://sonora-delectable-sonic-flow.base44.app";

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
    // No connection → branded offline screen with a retry button.
    mainWindow.webContents.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) mainWindow.loadFile(path.join(__dirname, "offline.html"));
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
    // Build a clean wire-format payload and force type 2 (Listening) so Discord
    // always shows "Listening to Sonora" with the live progress bar — exactly
    // like Spotify. The camelCase aliases (startTimestamp, largeImageKey, …)
    // are included for discord-rpc v3 compatibility; v4 reads the snake_case
    // nested objects. Extra fields like _meta are already stripped by the
    // manager, but we reconstruct here so nothing unexpected leaks through.
    const wire = {
      type: 2,
      name: activity.name || "Sonora",
      details: activity.details,
      state: activity.state,
      timestamps: activity.timestamps || undefined,
      assets: activity.assets || undefined,
      buttons: Array.isArray(activity.buttons) ? activity.buttons : undefined,
      instance: activity.instance !== false,
    };
    if (activity.timestamps) {
      wire.startTimestamp = activity.timestamps.start;
      if (activity.timestamps.end) wire.endTimestamp = activity.timestamps.end;
    }
    if (activity.assets) {
      wire.largeImageKey = activity.assets.large_image;
      wire.largeImageText = activity.assets.large_text;
      wire.smallImageKey = activity.assets.small_image;
      wire.smallImageText = activity.assets.small_text;
    }
    // Remove undefined keys so Discord doesn't receive nulls.
    Object.keys(wire).forEach((k) => wire[k] === undefined && delete wire[k]);
    await discordClient.setActivity(wire);
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