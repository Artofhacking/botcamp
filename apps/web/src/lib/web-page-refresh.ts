import { compareBuilds, isBuildId } from "@botcamp/contracts";
import { CLIENT_BUILD } from "./client-build";
import { desktopBridge } from "./desktop";
import { servedBuildUrl } from "./served-build";

/** This page's build id; empty on a dev server, which carries none to compare. */
export function pageBuild(build: string = CLIENT_BUILD): string {
  return isBuildId(build) ? build : "";
}

/**
 * Whether a reload would gain anything. A page that cannot name its build, or a server that cannot
 * name what it serves, gets the reload anyway: it is the only thing left to try, and the button
 * promises one.
 */
export function reloadsOntoServed(page: string, served: string | null): boolean {
  if (!page || !isBuildId(served)) return true;
  return (compareBuilds(page, served) ?? 0) < 0;
}

export type WebPageRefreshDeps = {
  page: string;
  /** The build the web server serves right now. */
  served: () => Promise<string | null>;
  /** The shell's reload, which ignores the HTTP cache a plain reload keeps using. */
  shellReload?: () => Promise<void>;
  browserReload: () => void;
};

/**
 * Moves the open page onto the build the server serves. Unlike the idle reload that follows API
 * replies, this runs the moment the user asks, so it must not come back on the same bundle: the
 * served build is read first, and an unchanged one leaves the page alone with `current`.
 */
export async function refreshWebPage(deps: WebPageRefreshDeps): Promise<"reloaded" | "current"> {
  const served = await deps.served().catch(() => null);
  if (!reloadsOntoServed(deps.page, served)) return "current";
  if (deps.shellReload) await deps.shellReload();
  else deps.browserReload();
  return "reloaded";
}

/** The build id the web server ships beside the page, from the `/build-id` file. */
export async function servedWebPageBuild(): Promise<string | null> {
  try {
    const response = await fetch(servedBuildUrl(), { cache: "no-store", credentials: "omit" });
    if (!response.ok) return null;
    const build = (await response.text()).trim();
    return isBuildId(build) ? build : null;
  } catch {
    return null;
  }
}

/** The page's own refresh: the desktop shell reloads through the main process, a tab reloads itself. */
export function refreshWebPageInApp(page: string = pageBuild()) {
  const shellReload = desktopBridge()?.page?.reload;
  return refreshWebPage({
    page,
    served: servedWebPageBuild,
    ...(shellReload ? { shellReload } : {}),
    browserReload: () => window.location.reload(),
  });
}
