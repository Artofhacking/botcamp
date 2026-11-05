import { Trans, useLingui } from "@lingui/react/macro";
import type { DesktopUpdateState } from "@rakazo/contracts";
import { Button, toast } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { desktopBridge } from "../lib/desktop";
import { AboutBotCamp, clientPlatform, releaseVersion } from "./AboutBotCamp";
import type { ClientPlatform } from "./AboutBotCamp";
import { SettingsRow } from "./SettingsRows";

function useDesktopUpdates() {
  const { t } = useLingui();
  const bridge = desktopBridge()?.update;
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmedCheck, setConfirmedCheck] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    if (!bridge) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const started = revision.current;
      try {
        const next = await bridge!.state();
        if (!stopped && started === revision.current && !pending.current) {
          setState((current) =>
            current &&
            Object.entries(next).every(
              ([key, value]) => current[key as keyof DesktopUpdateState] === value,
            )
              ? current
              : next,
          );
        }
      } catch {
        // A disappearing bridge during shutdown should not interrupt the app.
      } finally {
        if (!stopped) timer = setTimeout(refresh, 2_000);
      }
    }
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [bridge]);

  async function act(action: "check" | "install") {
    if (!bridge || pending.current) return;
    pending.current = true;
    revision.current++;
    setBusy(true);
    setError(null);
    if (action === "check") setConfirmedCheck(null);
    try {
      const next = await bridge[action]();
      setState(next);
      if (
        action === "check" &&
        next.phase === "idle" &&
        !next.message &&
        next.checkedAt !== state?.checkedAt
      ) {
        setConfirmedCheck(next.checkedAt);
      }
      if (next.phase === "error" || action === "install") {
        setError(next.message);
      }
    } catch {
      setError(t`Could not complete the update. Try again.`);
    } finally {
      revision.current++;
      pending.current = false;
      setBusy(false);
    }
  }
  return { state, busy, error, act, confirmedCheck };
}

const UpdatesContext = createContext<ReturnType<typeof useDesktopUpdates> | null>(null);

const DESKTOP_UPDATE_TOAST = "desktop-update";

export function DesktopUpdatesProvider({ children }: { children: ReactNode }) {
  const updates = useDesktopUpdates();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const { state, error } = updates;
  useEffect(() => {
    if (error) setDismissed(null);
  }, [error]);
  const prompt = Boolean(
    state &&
      (state.phase === "ready" || (error && state.availableVersion)) &&
      dismissed !== state.availableVersion,
  );
  // Keep the toast up while a retry runs, so a quick failure reuses it instead of racing
  // its dismissal.
  const [shown, setShown] = useState(false);
  const visible = prompt || (shown && updates.busy);
  useEffect(() => {
    setShown(visible);
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    // The app's Toaster renders inside this provider, so the toast reads live state from context.
    toast.custom(() => <DesktopUpdatePrompt onLater={setDismissed} />, {
      id: DESKTOP_UPDATE_TOAST,
      duration: Number.POSITIVE_INFINITY,
      dismissible: false,
    });
    return () => {
      toast.dismiss(DESKTOP_UPDATE_TOAST);
    };
  }, [visible]);
  return <UpdatesContext.Provider value={updates}>{children}</UpdatesContext.Provider>;
}

function DesktopUpdatePrompt({ onLater }: { onLater: (version: string | null) => void }) {
  const { t } = useLingui();
  const updates = useContext(UpdatesContext);
  if (!updates?.state) return null;
  const { state, busy, error, act } = updates;
  return (
    <aside
      aria-label={t`Desktop update`}
      className="w-full rounded-xl border border-border bg-card p-3 text-card-foreground shadow-lg"
    >
      <div className="flex items-center gap-2">
        <Button
          disabled={busy}
          onClick={() => void act(state.phase === "ready" ? "install" : "check")}
        >
          {state.phase === "ready" ? (
            <Trans>Restart to update</Trans>
          ) : (
            <Trans>Check for updates</Trans>
          )}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => onLater(state.availableVersion)}>
          <Trans>Later</Trans>
        </Button>
      </div>
      {error || state.message ? (
        <p role="status" className="mt-2 text-sm">
          {error ?? state.message}
        </p>
      ) : null}
    </aside>
  );
}

export function useSidebarUpdate() {
  const updates = useContext(UpdatesContext);
  return {
    available: updates?.state?.phase === "ready",
    busy: updates?.busy ?? false,
    install: () => {
      void updates?.act("install");
    },
  };
}

const PLATFORM_LABEL: Record<ClientPlatform, string> = {
  android: "Android",
  mac: "macOS",
  windows: "Windows",
};

/**
 * Download and install inside the app. Used once the installed build has an
 * update feed; older builds fall through to the public installer link.
 */
function InstalledUpdate({ platform, version }: { platform: ClientPlatform; version: string }) {
  const updates = useContext(UpdatesContext);
  if (!updates?.state) return null;
  const { state, busy, error, act, confirmedCheck } = updates;
  const ready = state.phase === "ready";
  const downloading = state.phase === "available" || state.phase === "downloading";
  const checking = busy || state.phase === "checking";
  const upToDate =
    state.phase === "idle" &&
    confirmedCheck !== null &&
    state.checkedAt === confirmedCheck &&
    !state.message;
  const status = error ?? (state.phase === "error" ? state.message : null);
  return (
    <div className="space-y-3">
      <SettingsRow
        label={<span className="font-medium">BotCamp</span>}
        control={
          <span className="text-[13px] text-muted-foreground">
            {PLATFORM_LABEL[platform]} · {version}
          </span>
        }
      />
      <SettingsRow
        label={
          <div>
            <p>检查更新</p>
            {upToDate ? <p className="text-[13px] text-muted-foreground">已是最新版本</p> : null}
            {downloading ? (
              <p className="text-[13px] text-muted-foreground">{Math.round(state.percent ?? 0)}%</p>
            ) : null}
            {status ? (
              <p role="alert" className="text-[13px] text-destructive">
                {status}
              </p>
            ) : null}
          </div>
        }
        control={
          <Button
            variant="secondary"
            size="sm"
            disabled={checking || downloading}
            onClick={() => void act(ready ? "install" : "check")}
          >
            {ready ? "重启并更新" : downloading ? "下载中…" : checking ? "检查中…" : "检查更新"}
          </Button>
        }
      />
    </div>
  );
}

/**
 * One update control. A build with an update feed downloads and installs in
 * the app. An older build, which has no feed, links to that platform's installer.
 */
export function DesktopAbout() {
  const updates = useContext(UpdatesContext);
  const bridge = desktopBridge();
  const native = updates?.state ?? null;
  if (bridge?.update && !native) return null;
  const platform =
    clientPlatform(bridge?.platform) ?? clientPlatform(window.__BOTCAMP_APP__?.platform);
  const version = releaseVersion(native?.currentVersion || window.__BOTCAMP_APP__?.version);
  if (native && native.phase !== "unsupported" && platform && version) {
    return <InstalledUpdate platform={platform} version={version} />;
  }
  if (!platform || !version) return <AboutBotCamp />;
  return <AboutBotCamp client={{ platform, version }} />;
}
