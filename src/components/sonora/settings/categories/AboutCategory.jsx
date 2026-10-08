import React from "react";
import { Info, RefreshCw, Download, CheckCircle2, AlertCircle, Sparkles, Globe } from "lucide-react";
import { APP_VERSION, APP_BUILD, APP_CODENAME } from "@/services/platform/version";
import { platformLabel, isWeb, isDesktop, isAndroid, isIOS } from "@/services/platform/platformAdapter";
import { useUpdateCheck } from "@/hooks/useUpdateCheck";
import { SettingSection, SettingRow, InfoCard, ActionButton } from "../primitives";

export default function AboutCategory() {
  const { loading, result, check, applyUpdate, installing } = useUpdateCheck(true);

  const updateAvailable = result?.ok && result.updateAvailable;
  const upToDate = result?.ok && !result.updateAvailable;
  const error = result && !result.ok;
  const mandatory = result?.ok && result.mandatory;

  return (
    <>
      <SettingSection title="About Sonora" description="Version and release information">
        <SettingRow icon={Info} title="Version" description={`Sonora ${APP_VERSION} (${APP_CODENAME}) — Build ${APP_BUILD}`}>
          <span className="text-[12px] text-muted-foreground font-mono">{APP_VERSION}</span>
        </SettingRow>
        <SettingRow icon={Globe} title="Platform" description={platformLabel()}>
          <span className="text-[12px] text-muted-foreground">
            {isWeb && "Web"}
            {isDesktop && "Windows"}
            {isAndroid && "Android"}
            {isIOS && "iOS"}
          </span>
        </SettingRow>
      </SettingSection>

      <SettingSection title="Updates" description="Keep Sonora up to date">
        {loading && (
          <SettingRow icon={RefreshCw} title="Checking for updates…" description="Contacting the Sonora release service">
            <RefreshCw className="w-4 h-4 text-muted-foreground animate-spin" />
          </SettingRow>
        )}

        {!loading && upToDate && (
          <SettingRow icon={CheckCircle2} title="You're up to date" description={`Sonora ${APP_VERSION} is the latest version.`}>
            <ActionButton onClick={check} tone="default">Check again</ActionButton>
          </SettingRow>
        )}

        {!loading && updateAvailable && (
          <div className="px-4 py-4 rounded-xl border border-accent/30 bg-accent/5 space-y-4">
            <div className="flex items-start gap-3">
              <div className="shrink-0 w-10 h-10 rounded-full bg-accent/15 flex items-center justify-center">
                <Sparkles className="w-5 h-5 text-accent" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-foreground flex items-center gap-2">
                  Sonora Update Available
                  {mandatory && (
                    <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-destructive/20 text-destructive">
                      Required
                    </span>
                  )}
                </h3>
                <p className="text-[13px] text-muted-foreground mt-0.5">
                  Version {result.latest} is now available
                  {result.releaseDate && ` · released ${new Date(result.releaseDate).toLocaleDateString()}`}
                </p>
              </div>
            </div>

            {result.releaseNotes?.length > 0 && (
              <div className="space-y-1.5 pl-12">
                {result.releaseNotes.map((note, i) => (
                  <div key={i} className="flex items-start gap-2 text-[13px] text-muted-foreground">
                    <span className="text-accent mt-0.5">•</span>
                    <span>{note}</span>
                  </div>
                ))}
              </div>
            )}

            {result.size && (
              <p className="text-[12px] text-muted-foreground">
                Download size: {(result.size / 1024 / 1024).toFixed(1)} MB
              </p>
            )}

            <div className="flex items-center gap-2 pt-1">
              <ActionButton onClick={applyUpdate} tone="accent" disabled={installing}>
                {installing ? (
                  <><RefreshCw className="w-4 h-4 mr-1.5 animate-spin" /> Installing…</>
                ) : (
                  <><Download className="w-4 h-4 mr-1.5" /> Update Now</>
                )}
              </ActionButton>
              {!mandatory && !installing && (
                <ActionButton onClick={check} tone="default">Later</ActionButton>
              )}
            </div>
            {installing && (
              <p className="text-[12px] text-muted-foreground pt-1">
                Downloading the update — Sonora will restart automatically when ready.
              </p>
            )}
          </div>
        )}

        {!loading && error && (
          <SettingRow icon={AlertCircle} title="Couldn't check for updates" description={result.error || "The release service is unreachable."}>
            <ActionButton onClick={check} tone="default">Retry</ActionButton>
          </SettingRow>
        )}
      </SettingSection>

      <SettingSection title="Credits" description="The Sonora project">
        <InfoCard>
          Sonora is a premium, personalized music streaming experience. Built with a shared application
          core across Web, Windows, Android, and iOS — one account, one library, one player, one update
          architecture. Powered by the Sonora Cloudflare Worker for centralized updates and source resolution.
        </InfoCard>
      </SettingSection>
    </>
  );
}