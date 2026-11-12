import { safeExternalUrl } from "./setup-config.js";

/**
 * The URL the OS should open, or null when this child window is not a web page.
 * The app never keeps a browser window of its own.
 */
export function systemBrowserUrl(childUrl: string): string | null {
  return safeExternalUrl(childUrl);
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
