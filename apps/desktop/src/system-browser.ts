import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

export interface ChromeOpenContext {
  platform: NodeJS.Platform;
  home: string;
  defaultHttpsBundleId: string | null;
  commands: readonly string[];
}

interface LaunchServicesHandlers {
  LSHandlers?: readonly {
    LSHandlerURLScheme?: string;
    LSHandlerRoleAll?: string;
  }[];
}

const CHROME_BUNDLE_ID = "com.google.chrome";
const EPHEMERAL_CHROME =
  /(?:^|\s)--(?:enable-automation|remote-debugging-pipe|remote-debugging-port)(?:\s|=|$)/;

/**
 * The bundle id registered for https, or null when the user has not chosen one.
 */
export function httpsBundleIdFromLaunchServices(payload: LaunchServicesHandlers): string | null {
  const bundleId = payload.LSHandlers?.find(
    (handler) => handler.LSHandlerURLScheme === "https",
  )?.LSHandlerRoleAll;
  if (bundleId === undefined || bundleId.length === 0 || bundleId === "-") return null;
  return bundleId;
}

/**
 * True when this process is an automated Chrome, not the signed-in profile.
 * macOS delivers a link to whichever copy of the app is running.
 */
export function isEphemeralChromeCommand(command: string): boolean {
  return command.includes("/Google Chrome") && EPHEMERAL_CHROME.test(command);
}

/**
 * Args for macOS `open` that reach the signed-in Chrome, or null for the ordinary handoff.
 */
export function preferredChromeOpenArgs(context: ChromeOpenContext, url: string): string[] | null {
  if (context.platform !== "darwin") return null;
  if (context.defaultHttpsBundleId?.toLowerCase() !== CHROME_BUNDLE_ID) return null;
  if (!isWebUrl(url)) return null;
  if (!context.commands.some(isEphemeralChromeCommand)) return null;
  const userDataDir = path.join(context.home, "Library", "Application Support", "Google", "Chrome");
  return ["-na", "Google Chrome", "--args", `--user-data-dir=${userDataDir}`, url];
}

/**
 * Open a web URL in the signed-in browser.
 * An automated Chrome is a second copy of the same app and can take the link.
 */
export async function openSystemBrowser(
  url: string,
  openExternal: (url: string) => Promise<unknown>,
  io: {
    discover?: () => Promise<ChromeOpenContext>;
    launch?: (args: string[]) => Promise<unknown>;
  } = {},
): Promise<void> {
  const discover = io.discover ?? discoverChromeOpenContext;
  const launch = io.launch ?? ((args: string[]) => run("open", args));
  // End-to-end launches must keep using the handoff the test replaced.
  if (process.env.RAKAZO_E2E_EXECUTABLE || process.env.RAKAZO_PERFORMANCE_USER_DATA) {
    await openExternal(url);
    return;
  }
  let args: string[] | null = null;
  try {
    args = preferredChromeOpenArgs(await discover(), url);
  } catch {
    args = null;
  }
  if (args === null) {
    await openExternal(url);
    return;
  }
  try {
    await launch(args);
  } catch {
    await openExternal(url);
  }
}

function run(file: string, args: string[], maxBuffer = 1024 * 1024): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout) });
    });
  });
}

function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function discoverChromeOpenContext(): Promise<ChromeOpenContext> {
  const platform = process.platform;
  const home = os.homedir();
  if (platform !== "darwin") {
    return { platform, home, defaultHttpsBundleId: null, commands: [] };
  }
  const defaultHttpsBundleId = await readMacHttpsBundleId(home);
  if (defaultHttpsBundleId?.toLowerCase() !== CHROME_BUNDLE_ID) {
    return { platform, home, defaultHttpsBundleId, commands: [] };
  }
  return { platform, home, defaultHttpsBundleId, commands: await readChromeCommands() };
}

async function readMacHttpsBundleId(home: string): Promise<string | null> {
  const plist = path.join(
    home,
    "Library",
    "Preferences",
    "com.apple.LaunchServices",
    "com.apple.launchservices.secure.plist",
  );
  try {
    const { stdout } = await run("plutil", ["-convert", "json", "-o", "-", plist], 4 * 1024 * 1024);
    return httpsBundleIdFromLaunchServices(JSON.parse(stdout) as LaunchServicesHandlers);
  } catch {
    return null;
  }
}

async function readChromeCommands(): Promise<string[]> {
  const { stdout } = await run("ps", ["-ax", "-o", "command="], 8 * 1024 * 1024);
  return stdout.split("\n").filter((line) => line.includes("Google Chrome"));
}
