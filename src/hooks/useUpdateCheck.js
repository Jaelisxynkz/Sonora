import { useState, useEffect, useCallback } from "react";
import { checkForUpdate } from "@/services/platform/releaseService";
import { canAutoUpdate, installNativeUpdate, openExternal } from "@/services/platform/platformAdapter";

// Checks for a Sonora update on mount and exposes the result + a manual
// re-check. On desktop (Electron), an available update can be installed via
// the native auto-updater; on web/mobile the UI links to the download URL.
export function useUpdateCheck(auto = true) {
  const [state, setState] = useState({ loading: true, result: null });
  const [lastCheck, setLastCheck] = useState(null);
  const [installing, setInstalling] = useState(false);

  const check = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    const result = await checkForUpdate();
    setState({ loading: false, result });
    setLastCheck(Date.now());
    return result;
  }, []);

  useEffect(() => {
    if (auto) check();
  }, [auto, check]);

  // Install the update via the platform-appropriate mechanism.
  // Returns "installed" if the native updater took over, "opened" if we
  // opened a download URL, or "unsupported".
  const applyUpdate = useCallback(async () => {
    const { result } = state;
    if (!result?.ok || !result.updateAvailable) return "unsupported";

    // Desktop: hand off to electron-updater (downloads + installs + restarts).
    if (canAutoUpdate()) {
      setInstalling(true);
      try {
        const ok = await installNativeUpdate();
        if (ok) return "installed";
      } finally {
        setInstalling(false);
      }
    }

    // Web / mobile: open the platform's download URL in the system browser.
    if (result.downloadUrl) {
      openExternal(result.downloadUrl);
      return "opened";
    }

    return "unsupported";
  }, [state]);

  return { ...state, lastCheck, check, applyUpdate, installing };
}