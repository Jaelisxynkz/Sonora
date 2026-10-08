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
// The user clicks → quitAndInstall → the app restarts on the new version.
export default function DesktopUpdateWatcher() {
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);

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
    // Dedupe identical update errors so a rapid sequence of failures (e.g.
    // multiple clicks on "Update Now") doesn't stack a wall of red toasts.
    const lastErr = { msg: "", t: 0 };
    desktopBridge.onUpdateError?.((msg) => {
      setDownloading(false);
      const now = Date.now();
      if (msg === lastErr.msg && now - lastErr.t < 4000) return;
      lastErr.msg = msg; lastErr.t = now;
      toast({ title: "Update failed", description: msg, variant: "destructive" });
    });
  }, []);

  if (!isDesktop || dismissed) return null;

  const newVersion = updateInfo?.version;
  // electron-updater passes releaseNotes as an array of strings when available
  const highlights = (updateInfo?.releaseNotes || []).slice(0, 3);

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
            <p className="text-xs text-muted-foreground mt-2">Installs automatically on restart.</p>
          </div>
        </div>
      </div>
    );
  }

  // Ready card
  if (!ready) return null;

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
            Restart to install the latest version with new features and improvements.
          </p>
          <Button
            size="sm"
            className="mt-3 w-full h-9"
            onClick={() => desktopBridge?.quitAndInstall?.()}
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            Restart &amp; install
          </Button>
        </div>
      </div>
    </div>
  );
}