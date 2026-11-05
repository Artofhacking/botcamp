import { createHash } from "node:crypto";
import type { DesktopSetup, DesktopStackProbeResponse } from "@rakazo/contracts";
import { parseServerHeaders } from "@rakazo/contracts";
import { isLoopbackHost, isPrivateNetworkHost } from "@rakazo/contracts/network-host";
import { t } from "./i18n.js";

/** Managed desktop origin; development keeps its usual web/API ports. */
export const DEFAULT_LOCAL_WEB_URL = "http://127.0.0.1:45173";
/** Hosted BotCamp page origin, saved as an `existing` server when chosen. */
export const BOTCAMP_CLOUD_URL = "https://botcamp.demox.site";
/** Hosted BotCamp API origin; the page at `/console/` calls it directly. */
export const BOTCAMP_CLOUD_API_URL = "https://botcamp.aigc.sx.cn";
/** The console page the desktop opens for the hosted instance. */
export const BOTCAMP_CLOUD_PAGE_URL = "https://botcamp.demox.site/console/";
export const PROBE_RESPONSE_LIMIT_BYTES = 64 * 1024;

export const SETUP_FILE_NAME = "setup.json";

export type StartupTarget =
  | { kind: "app"; url: string; source: "env" | "saved" | "cloud" }
  | { kind: "setup" };

/** The hosted instance a fresh install opens, stored like a chosen existing server. */
export function botcampCloudSetup(): DesktopSetup {
  return {
    mode: "existing",
    serverUrl: BOTCAMP_CLOUD_URL,
    apiUrl: BOTCAMP_CLOUD_API_URL,
    pageUrl: BOTCAMP_CLOUD_PAGE_URL,
  };
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Accepts what a person would actually type ("localhost:5173", "rakazo.example.com")
 * and returns a canonical http(s) origin, or null when the input can never
 * securely address a BotCamp server.
 */
export function normalizeServerUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  let url: URL;
  try {
    if (SCHEME.test(trimmed)) {
      url = new URL(trimmed);
    } else {
      const candidate = new URL(`http://${trimmed}`);
      url = isPrivateNetworkHost(candidate.hostname) ? candidate : new URL(`https://${trimmed}`);
    }
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname === "") return null;
  // Embedded credentials would be written to disk in cleartext.
  if (url.username !== "" || url.password !== "") return null;
  // Public login cookies and API traffic must never cross a cleartext connection.
  if (url.protocol === "http:" && !isPrivateNetworkHost(url.hostname)) return null;

  // BotCamp serves its RPC and auth routes from one API origin. Keeping a
  // user-supplied path would make the setup probe and the loaded app disagree.
  return url.origin;
}

/** A page may live under a path on the same origin as its API, but never on another origin. */
export function normalizePageUrl(input: string, serverUrl: string): string | null {
  try {
    const page = new URL(input);
    if (page.origin !== new URL(serverUrl).origin) return null;
    if (page.protocol !== "http:" && page.protocol !== "https:") return null;
    if (page.username !== "" || page.password !== "") return null;
    return page.href;
  } catch {
    return null;
  }
}

/**
 * Managed ("new") setups may only open the configured local stack origin.
 * A saved or IPC URL that normalizes to a different loopback host/port is rejected.
 */
export function managedLocalOpenUrl(requestedUrl: string, localWebUrl: string): string | null {
  const managed = normalizeServerUrl(localWebUrl);
  const requested = normalizeServerUrl(requestedUrl);
  if (managed === null || requested === null || requested !== managed) return null;
  return managed;
}

/**
 * The private managed-stack token may travel over HTTPS anywhere, or over HTTP
 * only to loopback. Private-network and .local HTTP stay cleartext on a LAN, so
 * they must not receive the token.
 */
export function maySendDesktopStackToken(serverUrl: string): boolean {
  try {
    const url = new URL(serverUrl);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") return isLoopbackHost(url.hostname);
    return false;
  } catch {
    return false;
  }
}

/** Validates an untrusted value (saved file or IPC payload) into a usable setup. */
export function parseSetupInput(value: unknown): DesktopSetup | null {
  if (typeof value !== "object" || value === null) return null;

  const { mode, serverUrl, apiUrl, pageUrl, headers } = value as Record<string, unknown>;
  if (mode !== "new" && mode !== "existing") return null;
  if (typeof serverUrl !== "string") return null;

  const normalized = normalizeServerUrl(serverUrl);
  if (normalized === null) return null;
  if (mode === "new" && !isLoopbackHost(new URL(normalized).hostname)) return null;

  const normalizedApi = apiUrl === undefined ? undefined : normalizeServerUrl(String(apiUrl));
  if (normalizedApi === null) return null;
  const normalizedPage =
    pageUrl === undefined ? undefined : normalizePageUrl(String(pageUrl), normalized);
  if (normalizedPage === null) return null;
  if (mode === "new" && (normalizedApi !== undefined || normalizedPage !== undefined)) return null;

  const setup: DesktopSetup = { mode, serverUrl: normalized };
  if (normalizedApi !== undefined && normalizedApi !== normalized) setup.apiUrl = normalizedApi;
  if (normalizedPage !== undefined && normalizedPage !== `${normalized}/`) {
    setup.pageUrl = normalizedPage;
  }

  if (headers === undefined) return setup;
  const parsed = parseServerHeaders(headers);
  if (parsed === null || (mode === "new" && Object.keys(parsed).length > 0)) return null;
  if (Object.keys(parsed).length > 0) setup.headers = parsed;
  return setup;
}

/**
 * Where a desktop pairs this computer. A split host checks the sign-in on the API, not on the
 * site that serves the page.
 */
export function deviceServerOrigin(pageOrigin: string | null, apiUrl?: string): string | null {
  if (pageOrigin === null) return null;
  if (apiUrl === undefined || apiUrl === "") return pageOrigin;
  return normalizeServerUrl(apiUrl) ?? pageOrigin;
}

/** Adds the page's session bearer without replacing a device token the caller already set. */
export function deviceSessionHeaders(
  init: Record<string, string> | undefined,
  sessionToken: string | null,
  proxyHeaders: Record<string, string> = {},
): Record<string, string> {
  const headers = { ...proxyHeaders, ...init };
  const names = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  if (
    sessionToken !== null &&
    sessionToken.length > 0 &&
    sessionToken.length <= 8192 &&
    /^[\x21-\x7E]+$/.test(sessionToken) &&
    !names.has("authorization")
  ) {
    headers.authorization = `Bearer ${sessionToken}`;
  }
  return headers;
}

/** Configured headers for a request to the saved server, including its websockets; none elsewhere. */
export function serverHeadersFor(url: string, setup: DesktopSetup | null): Record<string, string> {
  if (!setup?.headers) return {};
  try {
    const target = new URL(url);
    if (target.protocol === "ws:") target.protocol = "http:";
    if (target.protocol === "wss:") target.protocol = "https:";
    const origins = [setup.serverUrl, setup.apiUrl, setup.pageUrl]
      .filter((value): value is string => value !== undefined)
      .map((value) => new URL(value).origin);
    return origins.includes(target.origin) ? setup.headers : {};
  } catch {
    return {};
  }
}

export function parseStoredSetup(raw: string): DesktopSetup | null {
  try {
    return parseSetupInput(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function serializeSetup(setup: DesktopSetup): string {
  return `${JSON.stringify(setup, null, 2)}\n`;
}

/**
 * Replaces BotCamp Cloud when nothing is saved. `RAKAZO_WEB_URL` and a saved setup still win.
 */
export const DEFAULT_SERVER_URL = (process.env.RAKAZO_DEFAULT_SERVER_URL ?? "").trim();

/**
 * Decides between the server chooser and the app window.
 * `RAKAZO_WEB_URL` still wins over saved configuration so test and performance
 * harnesses can point the shell anywhere without touching a user's real setup.
 * `RAKAZO_FORCE_SETUP` shows the chooser. A fresh install opens BotCamp Cloud's
 * console. A saved choice is reopened at its page when it has one. An unusable
 * saved address shows the chooser.
 */
export function resolveStartupTarget(input: {
  envUrl?: string;
  saved?: DesktopSetup | null;
  forceSetup?: boolean;
}): StartupTarget {
  if (input.forceSetup === true) return { kind: "setup" };

  const envUrl = input.envUrl?.trim();
  if (envUrl !== undefined && envUrl !== "") return { kind: "app", url: envUrl, source: "env" };

  if (DEFAULT_SERVER_URL !== "" && input.saved == null) {
    return { kind: "app", url: DEFAULT_SERVER_URL, source: "env" };
  }

  if (input.saved != null) {
    const saved = parseSetupInput(input.saved);
    if (saved !== null) {
      return { kind: "app", url: saved.pageUrl ?? saved.serverUrl, source: "saved" };
    }
    return { kind: "setup" };
  }

  const cloud = botcampCloudSetup();
  return { kind: "app", url: cloud.pageUrl ?? cloud.serverUrl, source: "cloud" };
}

/** Turns a network failure into something a person can act on. */
export function probeFailureMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return t("Timed out reaching that address.");
  }

  const detail = error instanceof Error ? error.message : String(error);
  if (detail.includes("CONNECTION_REFUSED") || detail.includes("ECONNREFUSED")) {
    return t("Nothing is listening at that address yet.");
  }
  if (detail.includes("NAME_NOT_RESOLVED") || detail.includes("ENOTFOUND")) {
    return t("That host could not be found.");
  }
  if (detail.includes("CERT_") || detail.includes("SSL")) {
    return t("The server's HTTPS certificate was rejected.");
  }
  return t("Could not reach that address.");
}

/** Packaged shell overlays its web bundle only on the managed loopback stack. */
export function servesBundledRenderer(targetUrl: string, managedLocalStack: boolean): boolean {
  try {
    if (!managedLocalStack) return false;
    const url = new URL(targetUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/** Each BotCamp origin gets its own persistent cookie and storage partition. */
export function sessionPartitionForServerUrl(targetUrl: string): string | null {
  try {
    const url = new URL(targetUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const digest = createHash("sha256").update(url.origin).digest("hex").slice(0, 24);
    return `persist:rakazo-${digest}`;
  } catch {
    return null;
  }
}

/** External pages are opened by the OS, never in a privileged Electron child window. */
export function safeExternalUrl(targetUrl: string): string | null {
  try {
    const url = new URL(targetUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function isBotCampHealth(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const json = (value as { json?: unknown }).json;
  return (
    typeof json === "object" &&
    json !== null &&
    (json as { ok?: unknown }).ok === true &&
    typeof (json as { version?: unknown }).version === "string"
  );
}

export function desktopStackImageTag(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const { ok, imageTag } = value as Partial<DesktopStackProbeResponse>;
  return ok === true && typeof imageTag === "string" && imageTag !== "" ? imageTag : null;
}

/** Reads a small probe response without letting an untrusted stream stall on cleanup. */
export async function readProbeJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > PROBE_RESPONSE_LIMIT_BYTES) {
    cancelResponse(response);
    return null;
  }
  if (response.body === null) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PROBE_RESPONSE_LIMIT_BYTES) {
        cancelReader(reader);
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    cancelReader(reader);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already cancelled or released
    }
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

function cancelResponse(response: Response): void {
  try {
    void Promise.resolve(response.body?.cancel()).catch(() => undefined);
  } catch {
    // Probe cleanup is best-effort.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void Promise.resolve(reader.cancel()).catch(() => undefined);
  } catch {
    // Probe cleanup is best-effort.
  }
}
