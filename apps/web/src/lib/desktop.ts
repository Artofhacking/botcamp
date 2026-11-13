import type { BotCampDesktop, BotCampDesktopOAuthCallback } from "@botcamp/contracts";
import { appMessageOrigin } from "@botcamp/core";

export type { BotCampDesktop, BotCampDesktopOAuthCallback } from "@botcamp/contracts";

declare global {
  interface Window {
    botcampDesktop?: BotCampDesktop;
    /** Shells built before the window was renamed. */
    rakazoDesktop?: BotCampDesktop;
    /** Injected by a native shell (the Android app) so the page knows what wraps it. */
    __BOTCAMP_APP__?: { platform?: string; version?: string };
  }
}

export function desktopBridge(): BotCampDesktop | undefined {
  if (typeof window === "undefined") return undefined;
  return window.botcampDesktop ?? window.rakazoDesktop;
}

/** The app this page is running in. A browser is the web app. */
export function currentAppOrigin() {
  const shell = typeof window === "undefined" ? undefined : window.__BOTCAMP_APP__?.platform;
  return appMessageOrigin(desktopBridge()?.platform, shell);
}

/** Opens a page in the OS browser. False on the web and on older desktop releases. */
export async function openDefaultBrowser(url: string): Promise<boolean> {
  const open = desktopBridge()?.links?.open;
  if (!open) return false;
  await open(url);
  return true;
}

/** The compact `code#state` form the manual paste flow already accepts. */
export function desktopOAuthCode(callback: BotCampDesktopOAuthCallback) {
  return callback.state === undefined ? callback.code : `${callback.code}#${callback.state}`;
}

/**
 * The authorize URL carries the attempt's PKCE state, so a captured code whose
 * state differs belongs to a different attempt — a popup left open by a
 * cancelled sign-in, say — and must not be spent on the current one.
 */
export function oauthStateOf(verificationUri: string): string | undefined {
  try {
    return new URL(verificationUri).searchParams.get("state") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Desktop sign-in redirects to a loopback URL the renderer never sees, so the main process
 * captures the code there and the copy-and-paste step can be skipped. No-ops in a browser.
 * Providers whose authorize URL carries no state cannot be correlated, so their codes are
 * always accepted.
 */
export function onDesktopOAuthCallback(
  listener: (code: string) => void,
  expectedState?: string,
): () => void {
  const oauth = desktopBridge()?.oauth;
  if (!oauth) return () => undefined;
  return oauth.onCallback((callback) => {
    if (expectedState !== undefined && callback.state !== expectedState) return;
    listener(desktopOAuthCode(callback));
  });
}

export function windowChromeKind(desktop?: BotCampDesktop): "spacer" | "darwin" | "controls" {
  if (!desktop) return "spacer";
  if (desktop.platform === "darwin") return "darwin";
  if (desktop.nativeWindowFrame) return "spacer";
  return "controls";
}
