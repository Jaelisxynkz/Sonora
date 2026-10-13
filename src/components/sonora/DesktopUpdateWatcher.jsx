import { useEffect, useRef, useState } from "react";
import { desktopBridge, isDesktop } from "@/services/platform/platformAdapter";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Download, RefreshCw, X, Sparkles } from "lucide-react";

// DesktopUpdateWatcher — listens for electron-updater events from the native
// shell and surfaces them. On launch, electron-updater auto-checks GitHub; if
// a newer version exists it auto-downloads. This shows:
//  - A rich "update available" card with the new version + feature highlights
//    while downloading (with a live progress bar).
//  - A "Restart & install" card when the download is complete.
//
// AUTO-INSTALL: the moment the update is ready, Sonora automatically quits +
// restarts into the new version — so every desktop install moves to the
// latest release the instant it's opened, with no tap required. The only
// guard is a playing song: if audio is active, the restart is deferred until
// playback stops (or the user taps "Restart & install"), so a update never
// cuts the user's music. A session guard prevents any restart loop.

const AUTO_INSTALL_GRACE_MS = 2500; // let the app settle before restarting
const IDLE_POLL_MS = 3000; // while audio plays, re-check this often
const RESTART_KEY = "sonora:desktop:autoRestart";

function isAudioPlaying() {
  const a = document.querySelector("audio");
  return !!(a && !a.paused && !a.ended && a.readyState >= 2);
}

function alreadyRestarted(version) {
  try { return sessionStorage.getItem(`${RESTART_KEY}:${version}`) === "1"; } catch { return false; }
}
function markRestarted(version) {
  try { sessionStorage.setItem(`${RESTART_KEY}:${version}`, "1"); } catch {}
}

export default function DesktopUpdateWatcher() {
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const idleTimer = useRef(null);

  useEffect(() => {
    if (!isDesktop || !desktopBridge) return;
    desktopBridge.onUpdateAvailable?.((info) => {
      setUpdateInfo(info);
      setDownloading(true);
      setReady(false);
      setProgress(0);
      setDismissed(false);
      toast({
        title: `Sonora ${info?.version || ""} is available`,
        description: "Downloading the latest update…",
      });
    });
    desktopBridge.onUpdateProgress?.((pct) => {
      setProgress(typeof pct === "number" ? pct : 0);
    });
    desktopBridge.onUpdateReady?.(() => {
      setDownloading(false);
      setReady(true);
    });
    desktopBridge.onUpToDate?.(() => setDownloading(false));
    // Cap update-error toasts to ONE per session — electron-updater can fire
    // a different error message on every check (each carries a new request id
    // + timestamp), so a per-message dedup isn't enough to stop a flood.
    let errorShown = false;
    desktopBridge.onUpdateError?.((msg) => {
      setDownloading(false);
      if (errorShown) return;
      errorShown = true;
      toast({ title: "Update check failed", description: "Couldn't reach the update server. Sonora will retry automatically.", variant: "destructive", duration: 6000 });
    });
    return () => { if (idleTimer.current) clearInterval(idleTimer.current); };
  }, []);

  // AUTO-INSTALL: when the update is ready, restart into it automatically —
  // unless a song is playing, in which case defer until playback stops.
  useEffect(() => {
    if (!ready || dismissed) return;
    const version = updateInfo?.version || "unknown";
    if (alreadyRestarted(version)) return; // loop guard

    const doInstall = () => {
      if (alreadyRestarted(version)) return;
      markRestarted(version);
      toast({
        title: "Restarting Sonora…",
        description: `Installing version ${version}.`,
        duration: 3000,
      });
      // Small grace period so the toast renders + the app settles before quit.
      setTimeout(() => { try { desktopBridge?.installUpdate?.(); } catch {} }, 600);
    };

    if (!isAudioPlaying()) {
      const t = setTimeout(doInstall, AUTO_INSTALL_GRACE_MS);
      return () => clearTimeout(t);
    }

    // Audio is playing — defer until idle, keep the card visible with the
    // manual button so the user can restart sooner if they want.
    idleTimer.current = setInterval(() => {
      if (!isAudioPlaying()) {
        if (idleTimer.current) { clearInterval(idleTimer.current); idleTimer.current = null; }
        doInstall();
      }
    }, IDLE_POLL_MS);
    return () => { if (idleTimer.current) { clearInterval(idleTimer.current); idleTimer.current = null; } };
  }, [ready, dismissed, updateInfo]);

  if (!isDesktop || dismissed) return null;

  const newVersion = updateInfo?.version;
  // electron-updater delivers GitHub release notes as an HTML string (or an
  // array of {note}) — normalize to plain lines so the card can't crash.
  const rawNotes = updateInfo?.releaseNotes;
  const highlights = (Array.isArray(rawNotes)
    ? rawNotes.map((n) => (typeof n === "string" ? n : n?.note || ""))
    : String(rawNotes || "").split(/<\/li>|\n/))
    .map((s) => s.replace(/<[^>]*>/g, "").replace(/^[-*\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 3);

  // Downloading card with progress bar + feature highlights
  if (downloading && !ready) {
    return (
      <div className="fixed bottom-5 right-5 z-[200] sonora-glass-strong rounded-2xl p-4 max-w-[340px] sonora-player-enter">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-violet-400/15 flex items-center justify-center shrink-0">
            <Download className="w-5 h-5 text-violet-400 animate-pulse" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">
                {newVersion ? `Sonora ${newVersion}` : "Downloading update"}
              </p>
              <span className="text-xs tabular-nums text-muted-foreground">{Math.round(progress)}%</span>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-[width] duration-300 ease-linear"
                style={{ width: `${Math.max(2, progress)}%` }}
              />
            </div>
            {highlights.length > 0 && (
              <div className="mt-3 space-y-1">
                {highlights.map((h, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-[11px] text-muted-foreground leading-snug">
                    <Sparkles className="w-3 h-3 mt-0.5 shrink-0 text-violet-400/70" />
                    <span className="line-clamp-1">{h}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-2">Installs automatically when ready.</p>
          </div>
        </div>
      </div>
    );
  }

  if (!ready) return null;

  const playing = isAudioPlaying();

  return (
    <div className="fixed bottom-5 right-5 z-[200] sonora-glass-strong rounded-2xl p-4 max-w-[340px] sonora-player-enter">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-emerald-400/15 flex items-center justify-center shrink-0">
          <CheckCircle2 className="w-5 h-5 text-emerald-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-foreground">
              {newVersion ? `Sonora ${newVersion} ready` : "Update ready"}
            </p>
            <button
              onClick={() => setDismissed(true)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {highlights.length > 0 && (
            <div className="mt-2 space-y-1">
              {highlights.map((h, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[11px] text-muted-foreground leading-snug">
                  <Sparkles className="w-3 h-3 mt-0.5 shrink-0 text-violet-400/70" />
                  <span className="line-clamp-1">{h}</span>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
            {playing
              ? "Sonora will restart automatically when your song ends — or restart now to update immediately."
              : "Sonora is restarting to install the update…"}
          </p>
          <Button
            size="sm"
            className="mt-3 w-full h-9"
            onClick={() => {
              const v = updateInfo?.version || "unknown";
              if (!alreadyRestarted(v)) { markRestarted(v); try { desktopBridge?.installUpdate?.(); } catch {} }
            }}
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            Restart &amp; install
          </Button>
        </div>
      </div>
    </div>
  );
}