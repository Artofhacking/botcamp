import { t } from "@lingui/core/macro";
import type { DesktopDeepLink } from "@rakazo/contracts";
import { ssoDesktopCallback } from "@rakazo/contracts";
import { setAuthToken } from "./auth-token";
import { desktopBridge } from "./desktop";
import { documentPath, routePathOfUrl, routeSearch, toAppDocument } from "./static-host-route";

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
  const channel = new BroadcastChannel(`${SSO_CHANNEL}:${nonce}`);
  channel.postMessage({
    type: error ? "sso-error" : "sso-complete",
    nonce,
    url: ssoReturnHref(target.href, error),
  });
  channel.close();
  window.close();
  return true;
}

/**
 * Where the browser should land after the provider returns. A relative path is resolved by the
 * API host, which does not serve the app, so the address is absolute and stays on this document
 * when routes live in the hash.
 */
export function ssoBrowserURL(
  url: string,
  loc: { origin: string } = window.location,
  base = import.meta.env.BASE_URL,
): string {
  return new URL(toAppDocument(url, base), loc.origin).href;
}

/** An error stays in the hash query on a subpath deploy, and in the search on a root deploy. */
export function ssoReturnHref(href: string, error?: string | null): string {
  const target = new URL(href);
  if (!error) return target.href;
  if (target.hash.startsWith("#/")) {
    const body = target.hash.slice(1);
    const queryAt = body.indexOf("?");
    const path = queryAt === -1 ? body : body.slice(0, queryAt);
    const params = new URLSearchParams(queryAt === -1 ? "" : body.slice(queryAt + 1));
    params.set("error", error);
    target.hash = `#${path}?${params.toString()}`;
    return target.href;
  }
  target.searchParams.set("error", error);
  return target.href;
}

type DesktopLinks = NonNullable<NonNullable<ReturnType<typeof desktopBridge>>["links"]>;

function acceptedReturn(returned: URL, callbacks: readonly URL[]): boolean {
  if (returned.origin !== window.location.origin) return false;
  const path = routePathOfUrl(returned);
  return callbacks.some((callback) => routePathOfUrl(callback) === path);
}

function returnTargets(callbackURLs: readonly string[]): URL[] {
  return callbackURLs.map((url) => new URL(ssoBrowserURL(url), window.location.href));
}

/** Desktop SSO finishes in the system browser and comes back on rakazo://. */
async function runSystemBrowserSso(
  begin: (disableRedirect: boolean, callbackURL: (url: string) => string) => Promise<SsoResult>,
  callbackURLs: readonly string[],
  links: DesktopLinks,
): Promise<SsoResult> {
  const nonce = crypto.randomUUID();
  const callbacks = returnTargets(callbackURLs);
  const callbackURL = (url: string) => ssoDesktopCallback(nonce, ssoBrowserURL(url));
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
        if (!acceptedReturn(target, callbacks)) return;
        if (!link.token && !link.error) return;
        if (link.token && !link.error) setAuthToken(link.token);
        window.location.assign(ssoReturnHref(target.href, link.error));
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
  if (!desktopBridge()) return begin(false, (url) => ssoBrowserURL(url));
  const nonce = crypto.randomUUID();
  const callbacks = returnTargets(callbackURLs);
  const callbackURL = (url: string) => {
    const callback = new URL(SSO_CALLBACK_PATH, window.location.origin);
    callback.searchParams.set("nonce", nonce);
    callback.searchParams.set("returnTo", ssoBrowserURL(url));
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
