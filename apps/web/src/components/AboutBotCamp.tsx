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
  version?: string;
  androidVersion?: string;
  desktopVersion?: string;
  /** Set when Windows and Mac are not on the same desktop release. */
  windowsVersion?: string;
  macVersion?: string;
  android?: string;
  mac?: string;
  windows?: string;
  ios?: string;
};

/** Clients that publish an installer. A browser is none of these, whatever its user agent says. */
export type ClientPlatform = "windows" | "mac" | "android";

const PLATFORM_LABEL: Record<ClientPlatform, string> = {
  android: "Android",
  mac: "macOS",
  windows: "Windows",
};

export function clientPlatform(value: string | undefined): ClientPlatform | null {
  switch (value?.trim().toLowerCase()) {
    case "win32":
    case "windows":
      return "windows";
    case "darwin":
    case "mac":
    case "macos":
      return "mac";
    case "android":
      return "android";
    default:
      return null;
  }
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

/** A published client release. A web build id is a timestamp and is not comparable to one. */
export function releaseVersion(value: string | undefined): string {
  const version = value?.trim().replace(/^v/i, "") ?? "";
  return /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version) ? version : "";
}

export function AboutBotCamp({
  client,
}: {
  /** Set only for an installed Windows, Mac, or Android app. */
  client?: { platform: ClientPlatform; version: string };
}) {
  const version = releaseVersion(client?.version);
  const [checking, setChecking] = useState(false);
  const [release, setRelease] = useState<Release | null>(null);
  const [upToDate, setUpToDate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRelease(null);
    setUpToDate(false);
    setError(null);
  }, [client?.platform, version]);

  async function check() {
    if (!client || !version || checking) return;
    setChecking(true);
    setError(null);
    setUpToDate(false);
    setRelease(null);
    try {
      const response = await fetch(`${apiOrigin()}/downloads/latest.json`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as Release;
      // Desktop and Android ship on separate version lines; older feeds only had `version`.
      const latest =
        client.platform === "android"
          ? (data.androidVersion ?? data.version)
          : client.platform === "windows"
            ? (data.windowsVersion ?? data.desktopVersion ?? data.version)
            : (data.macVersion ?? data.desktopVersion ?? data.version);
      const download = data[client.platform];
      if (!latest || !releaseVersion(latest) || !download) throw new Error("no release");
      if (isNewer(latest, version)) setRelease({ ...data, version: latest });
      else setUpToDate(true);
    } catch {
      setError("检查更新失败，请稍后再试");
    } finally {
      setChecking(false);
    }
  }

  const downloadUrl = client && release ? release[client.platform] : undefined;

  return (
    <div className="space-y-3">
      <SettingsRow
        label={<span className="font-medium">BotCamp</span>}
        control={
          <span className="text-[13px] text-muted-foreground">
            {client && version ? `${PLATFORM_LABEL[client.platform]} · ${version}` : "网页端"}
          </span>
        }
      />
      {client && version ? (
        <SettingsRow
          label={
            <div>
              <p>检查更新</p>
              {upToDate ? <p className="text-[13px] text-muted-foreground">已是最新版本</p> : null}
              {error ? (
                <p role="alert" className="text-[13px] text-destructive">
                  {error}
                </p>
              ) : null}
              {release ? (
                <p className="text-[13px] text-muted-foreground">有新版本 {release.version}</p>
              ) : null}
            </div>
          }
          control={
            downloadUrl ? (
              <a
                href={downloadUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center rounded-full bg-primary px-3 text-[13px] font-medium text-primary-foreground"
              >
                下载
              </a>
            ) : (
              <Button variant="secondary" size="sm" disabled={checking} onClick={() => void check()}>
                {checking ? "检查中…" : "检查更新"}
              </Button>
            )
          }
        />
      ) : null}
    </div>
  );
}
