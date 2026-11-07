const OAUTH_POPUP_NAMES = new Set([
  "rakazo-app-connect",
  "rakazo-mcp-oauth",
  "rakazo-sso-oauth",
  "rakazo-model-oauth",
  "rakazo-plugin-connect",
]);

export function shouldOpenInAppPopup(
  appOrigin: string | null,
  childUrl: string,
  frameName: string,
) {
  let target: URL;
  try {
    target = new URL(childUrl);
  } catch {
    return false;
  }

  if (childUrl === "about:blank" && frameName === "rakazo-sso-oauth") return true;

  const isHttp = target.protocol === "http:" || target.protocol === "https:";
  // The public homepage is a different page. A new window for it opens in the
  // system browser, which does not carry the app's user agent.
  if (appOrigin !== null && target.origin === appOrigin) {
    if (target.pathname === "/" || target.pathname === "") return false;
    return isHttp;
  }
  return target.protocol === "https:" && OAUTH_POPUP_NAMES.has(frameName);
}

/**
 * Hand the URL to the OS after the caller returns.
 * On Windows, ShellExecute runs inside the window-open handler's turn and the
 * child window is created before that handler can deny it.
 */
export function openInSystemBrowser(open: (url: string) => void, url: string): void {
  setImmediate(() => {
    open(url);
  });
}

/** Keep auth cookies in the parent app's server-specific session. */
export function oauthPopupSessionPreferences(partition: string | null) {
  return {
    preload: "",
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    ...(partition === null ? {} : { partition }),
  };
}
