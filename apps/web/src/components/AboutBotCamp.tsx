import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { apiOrigin } from "../lib/api-origin.js";
import { SettingsRow } from "./SettingsRows";

declare global {
  interface Window {
    /** Injected by a native shell (the Android app) so the page knows what wraps it. */
    __BOTCAMP_APP__?: { platform?: string; version?: string };
  }
}

/** One release as the download page advertises it. */
type Release = {
  version: string;
  android?: string;
  mac?: string;
  windows?: string;
  ios?: string;
};

const PLATFORM_LABEL: Record<string, string> = {
  android: "Android",
  mac: "macOS",
  windows: "Windows",
  ios: "iOS",
  web: "网页版",
};

function platform(): string {
  if (typeof window === "undefined") return "web";
  const injected = window.__BOTCAMP_APP__?.platform?.trim();
  if (injected) return injected;
  const agent = navigator.userAgent;
  if (/Android/i.test(agent)) return "android";
  if (/iPhone|iPad|iPod/i.test(agent)) return "ios";
  if (/Macintosh/i.test(agent)) return "mac";
  if (/Windows/i.test(agent)) return "windows";
  return "web";
}

/** Numeric parts only: `2.1.0` beats `2.0.49`, and a missing part counts as zero. */
function parts(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function isNewer(candidate: string, current: string): boolean {
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

/** The shell's own version when native, otherwise the web build this page came from. */
function currentVersion(): string {
  const injected = window.__BOTCAMP_APP__?.version?.trim();
  return injected || "";
}

export function AboutBotCamp() {
  const [version, setVersion] = useState(currentVersion);
  const [checking, setChecking] = useState(false);
  const [release, setRelease] = useState<Release | null>(null);
  const [upToDate, setUpToDate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A plain browser has no native version; its build id identifies what it is running.
  useEffect(() => {
    if (version) return;
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}build-id`, { cache: "no-store" })
      .then((response) => (response.ok ? response.text() : ""))
      .then((text) => {
        if (!cancelled && text.trim()) setVersion(text.trim());
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [version]);

  const platformId = platform();

  async function check() {
    if (checking) return;
    setChecking(true);
    setError(null);
    setUpToDate(false);
    setRelease(null);
    try {
      const response = await fetch(`${apiOrigin()}/downloads/latest.json`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as Release;
      if (!data?.version) throw new Error("no version");
      if (version && isNewer(data.version, version)) setRelease(data);
      else setUpToDate(true);
    } catch {
      setError("检查更新失败，请稍后再试");
    } finally {
      setChecking(false);
    }
  }

  const downloadUrl = release
    ? (release as unknown as Record<string, string | undefined>)[platformId] ??
      release.android ??
      release.mac ??
      release.windows
    : undefined;

  return (
    <div className="space-y-3">
      <SettingsRow
        label={<span className="font-medium">BotCamp</span>}
        control={
          <span className="text-[13px] text-muted-foreground">
            {version ? `${PLATFORM_LABEL[platformId] ?? platformId} · ${version}` : "…"}
          </span>
        }
      />
      <SettingsRow
        label={
          <div>
            <p>检查更新</p>
            {upToDate ? (
              <p className="text-[13px] text-muted-foreground">已是最新版本</p>
            ) : null}
            {error ? (
              <p role="alert" className="text-[13px] text-destructive">
                {error}
              </p>
            ) : null}
            {release ? (
              <p className="text-[13px] text-muted-foreground">
                有新版本 {release.version}
              </p>
            ) : null}
          </div>
        }
        control={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={checking} onClick={() => void check()}>
              {checking ? "检查中…" : "检查更新"}
            </Button>
            {downloadUrl ? (
              <a
                href={downloadUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center rounded-full bg-primary px-3 text-[13px] font-medium text-primary-foreground"
              >
                下载
              </a>
            ) : null}
          </div>
        }
      />
    </div>
  );
}
