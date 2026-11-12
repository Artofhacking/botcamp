import { t } from "@lingui/core/macro";
import type { DesktopDeepLink } from "@rakazo/contracts";
import { ssoDesktopCallback } from "@rakazo/contracts";
import { setAuthToken } from "./auth-token";
import { desktopBridge } from "./desktop";
import { documentPath, routePathOfUrl, routeSearch } from "./static-host-route";

type SsoResult = {
  data: { url?: string } | null;
  error: { message?: string; code?: string } | null;
};

export const SSO_CALLBACK_PATH = "/sso/callback";
const SSO_CHANNEL = "rakazo-sso-oauth";
const SSO_TIMEOUT_MS = 5 * 60_000;
let cancelActiveAttempt: (() => void) | undefined;

/** The callback runs before session routing, including failed authentication. */
export function completeSsoCallback(): boolean {
  if (documentPath() !== SSO_CALLBACK_PATH) return false;
  const params = new URLSearchParams(routeSearch());
  const nonce = params.get("nonce");
  const returnTo = params.get("returnTo");
  if (!nonce || !returnTo) return true;
  let target: URL;
  try {
    target = new URL(returnTo);
  } catch {
    return true;
  }
  if (target.origin !== window.location.origin || routePathOfUrl(target) === SSO_CALLBACK_PATH)
    return true;
  const error = params.get("error");
  if (error) target.searchParams.set("error", error);
  const channel = new BroadcastChannel(`${SSO_CHANNEL}:${nonce}`);
  channel.postMessage({
    type: error ? "sso-error" : "sso-complete",
    nonce,
    url: target.href,
  });
  channel.close();
  window.close();
  return true;
}

type DesktopLinks = NonNullable<NonNullable<ReturnType<typeof desktopBridge>>["links"]>;

function acceptedReturn(returned: URL, callbacks: readonly URL[]): boolean {
  return (
    returned.origin === window.location.origin &&
    callbacks.some(
      (callback) => callback.origin === returned.origin && callback.pathname === returned.pathname,
    )
  );
}

/** Desktop SSO finishes in the system browser and comes back on rakazo://. */
async function runSystemBrowserSso(
  begin: (disableRedirect: boolean, callbackURL: (url: string) => string) => Promise<SsoResult>,
  callbackURLs: readonly string[],
  links: DesktopLinks,
): Promise<SsoResult> {
  const nonce = crypto.randomUUID();
  const callbacks = callbackURLs.map((url) => new URL(url, window.location.href));
  const callbackURL = (url: string) =>
    ssoDesktopCallback(nonce, new URL(url, window.location.href).href);
  let unsubscribe: () => void = () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let rejectCancellation: (error: Error) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = () => {
    cancelled = true;
    clearTimeout(timer);
    unsubscribe();
    rejectCancellation(new Error("SSO attempt replaced"));
  };
  cancelActiveAttempt?.();
  cancelActiveAttempt = cancel;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(t`Could not continue`)), SSO_TIMEOUT_MS);
    });
    const returned = new Promise<void>((resolve) => {
      unsubscribe = links.onUrl((link: DesktopDeepLink) => {
        if (link.kind !== "sso" || link.nonce !== nonce) return;
        let target: URL;
        try {
          target = new URL(link.returnTo);
        } catch {
          return;
        }
        if (link.error) target.searchParams.set("error", link.error);
        if (!acceptedReturn(target, callbacks)) return;
        if (!link.token && !link.error) return;
        if (link.token && !link.error) setAuthToken(link.token);
        window.location.assign(target.href);
        resolve();
      });
    });
    const result = await Promise.race([begin(true, callbackURL), cancellation, timeout]);
    if (result.error) return result;
    let target: URL;
    try {
      target = new URL(result.data?.url ?? "");
    } catch {
      throw new Error(t`Could not continue`);
    }
    if (target.protocol !== "https:" && target.origin !== window.location.origin) {
      throw new Error(t`Could not continue`);
    }
    await links.open(target.href);
    await Promise.race([returned, cancellation, timeout]);
    return result;
  } catch (error) {
    if (cancelled) return { data: null, error: null };
    throw error;
  } finally {
    if (cancelActiveAttempt === cancel) cancelActiveAttempt = undefined;
    clearTimeout(timer);
    unsubscribe();
  }
}

/** The system browser signs in; older desktops still use a same-session popup. */
export async function runSsoFlow(
  begin: (disableRedirect: boolean, callbackURL: (url: string) => string) => Promise<SsoResult>,
  callbackURLs: readonly string[],
): Promise<SsoResult> {
  const links = desktopBridge()?.links;
  if (links) return runSystemBrowserSso(begin, callbackURLs, links);
  if (!desktopBridge()) return begin(false, (url) => url);
  const nonce = crypto.randomUUID();
  const callbacks = callbackURLs.map((url) => new URL(url, window.location.href));
  const callbackURL = (url: string) => {
    const callback = new URL(SSO_CALLBACK_PATH, window.location.origin);
    callback.searchParams.set("nonce", nonce);
    callback.searchParams.set("returnTo", new URL(url, window.location.href).href);
    return callback.href;
  };
  // Subscribe before opening the popup, as completion can arrive immediately.
  // Like MCP OAuth, this channel survives provider COOP navigation.
  const channel = new BroadcastChannel(`${SSO_CHANNEL}:${nonce}`);
  let popup: Window | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let rejectCancellation: (error: Error) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = () => {
    cancelled = true;
    channel.onmessage = null;
    clearTimeout(timer);
    popup?.close();
    rejectCancellation(new Error("SSO attempt replaced"));
  };
  cancelActiveAttempt?.();
  cancelActiveAttempt = cancel;
  try {
    popup = window.open("about:blank", SSO_CHANNEL, "popup,width=560,height=720");
    if (!popup) throw new Error(t`Could not continue`);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(t`Could not continue`)), SSO_TIMEOUT_MS);
    });
    const result = await Promise.race([begin(true, callbackURL), cancellation, timeout]);
    if (result.error) return result;
    let target: URL;
    try {
      target = new URL(result.data?.url ?? "");
    } catch {
      throw new Error(t`Could not continue`);
    }
    if (target.protocol !== "https:" && target.origin !== window.location.origin)
      throw new Error(t`Could not continue`);
    popup.location.href = target.href;
    // COOP can sever the handle while authentication continues. Retrying
    // cancels this wait; a closed handle is never a success signal.
    await Promise.race([
      new Promise<void>((resolve) => {
        channel.onmessage = (event: MessageEvent) => {
          const message: unknown = event.data;
          if (!message || typeof message !== "object") return;
          if (!("nonce" in message) || message.nonce !== nonce) return;
          if (
            !("type" in message) ||
            (message.type !== "sso-complete" && message.type !== "sso-error") ||
            !("url" in message) ||
            typeof message.url !== "string"
          )
            return;
          let returned: URL;
          try {
            returned = new URL(message.url);
          } catch {
            return;
          }
          if (!acceptedReturn(returned, callbacks)) return;
          window.location.assign(returned.href);
          resolve();
        };
      }),
      cancellation,
      timeout,
    ]);
    return result;
  } catch (error) {
    if (cancelled) return { data: null, error: null };
    throw error;
  } finally {
    if (cancelActiveAttempt === cancel) cancelActiveAttempt = undefined;
    clearTimeout(timer);
    channel.onmessage = null;
    channel.close();
    if (!cancelled) popup?.close();
  }
}
