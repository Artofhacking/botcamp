import {
  DIRECTORY_LOGIN_EMAIL_SCOPE,
  directoryDisplayName,
  directoryLoginEndpoints,
  enabledDirectoryUserScopes,
  refreshDirectoryAccessToken,
} from "@botcamp/adapters/lark-directory-login";
import type { TokenKey } from "@botcamp/auth";
import { DIRECTORY_PROVIDER_ID, openStoredOAuthToken, sealStoredOAuthToken } from "@botcamp/auth";
import type { PrismaClient } from "@botcamp/db";

/** How long before expiry a stored access token is refreshed. */
const REFRESH_SKEW_MS = 120_000;

export interface DirectoryGrantConfig {
  /** The button label, also the app name the bot's instructions use. */
  name: string;
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  brand: "feishu" | "lark";
}

/**
 * The login scopes this app enables. Requesting a scope the app does not enable makes the
 * authorization page fail, so keep only the enabled ones. Without the email scope the login
 * cannot identify the person, so that case keeps the configured list: the admin has to fix
 * the app either way.
 */
export function narrowDirectoryScopesForApp(
  requested: readonly string[],
  enabled: ReadonlySet<string>,
): string[] | null {
  if (!enabled.has(DIRECTORY_LOGIN_EMAIL_SCOPE)) return null;
  const narrowed = requested.filter((scope) => enabled.has(scope));
  return narrowed.length > 0 ? narrowed : null;
}

/** Looks up the app and narrows the requested scopes. Null keeps the configured list. */
export async function narrowDirectoryScopes(input: {
  requested: readonly string[];
  appId: string;
  appSecret: string;
  domain: string | undefined;
}): Promise<string[] | null> {
  const enabled = await enabledDirectoryUserScopes({
    appId: input.appId,
    appSecret: input.appSecret,
    domain: input.domain,
  });
  return enabled ? narrowDirectoryScopesForApp(input.requested, enabled) : null;
}

/** Login client from this process's environment. Absent when the secret is not set. */
export function directoryRuntime(source: NodeJS.ProcessEnv): DirectoryGrantConfig | undefined {
  const clientId = source.LARK_LOGIN_APP_ID?.trim();
  const clientSecret = source.LARK_LOGIN_APP_SECRET?.trim();
  if (!clientId || !clientSecret) return undefined;
  const endpoints = directoryLoginEndpoints(source.LARK_DOMAIN);
  if (!endpoints) return undefined;
  return {
    name: directoryDisplayName(source.LARK_LOGIN_NAME, source.LARK_DOMAIN),
    clientId,
    clientSecret,
    tokenUrl: endpoints.tokenUrl,
    brand: endpoints.issuer.includes("larksuite.com") ? "lark" : "feishu",
  };
}

export type DirectoryGrantResult =
  | { accessToken: string; appId: string; brand: "feishu" | "lark" }
  | { error: "needs_consent" | "unavailable" };

/**
 * Opens the signed-in person's directory token. The client secret is closed
 * over here, on the API, and is never read from the environment by shared code.
 * One refresh at a time per user so a rotated refresh token is not used twice.
 */
export function createDirectoryGrant(input: {
  prisma: PrismaClient;
  key: TokenKey;
  directory: DirectoryGrantConfig;
}) {
  const refreshing = new Map<string, Promise<DirectoryGrantResult>>();
  const open = (userId: string) => {
    const current = refreshing.get(userId);
    if (current) return current;
    const pending = openDirectoryGrant(input, userId).finally(() => {
      if (refreshing.get(userId) === pending) refreshing.delete(userId);
    });
    refreshing.set(userId, pending);
    return pending;
  };
  return {
    name: input.directory.name,
    linked: (userId: string) => directoryLinked(input.prisma, userId),
    openGrant: open,
  };
}

async function directoryLinked(prisma: PrismaClient, userId: string): Promise<boolean> {
  const row = await prisma.account.findFirst({
    where: { userId, providerId: DIRECTORY_PROVIDER_ID },
    select: { id: true },
  });
  return Boolean(row);
}

async function openDirectoryGrant(
  input: { prisma: PrismaClient; key: TokenKey; directory: DirectoryGrantConfig },
  userId: string,
): Promise<DirectoryGrantResult> {
  const row = await input.prisma.account.findFirst({
    where: { userId, providerId: DIRECTORY_PROVIDER_ID },
    select: {
      id: true,
      accessToken: true,
      refreshToken: true,
      accessTokenExpiresAt: true,
    },
  });
  if (!row) return { error: "needs_consent" };
  const accessToken = await openStoredOAuthToken(input.key, row.accessToken);
  if (accessToken && fresh(row.accessTokenExpiresAt)) {
    return granted(input.directory, accessToken);
  }
  const refreshToken = await openStoredOAuthToken(input.key, row.refreshToken);
  if (!refreshToken) return { error: "needs_consent" };
  const refreshed = await refreshDirectoryAccessToken({
    tokenUrl: input.directory.tokenUrl,
    clientId: input.directory.clientId,
    clientSecret: input.directory.clientSecret,
    refreshToken,
  });
  if (!refreshed) return { error: "unavailable" };
  if ("rejected" in refreshed) return { error: "needs_consent" };
  const nextRefresh = refreshed.tokens.refreshToken ?? refreshToken;
  const stored = await input.prisma.account.updateMany({
    where: { id: row.id, refreshToken: row.refreshToken },
    data: {
      accessToken: await sealStoredOAuthToken(input.key, refreshed.tokens.accessToken),
      refreshToken: await sealStoredOAuthToken(input.key, nextRefresh),
      accessTokenExpiresAt: expiresAt(refreshed.tokens.expiresIn),
      refreshTokenExpiresAt: expiresAt(refreshed.tokens.refreshExpiresIn),
      ...(refreshed.tokens.scopes ? { scope: refreshed.tokens.scopes.join(",") } : {}),
    },
  });
  if (stored.count === 0) {
    const winner = await input.prisma.account.findFirst({
      where: { id: row.id },
      select: { accessToken: true, accessTokenExpiresAt: true },
    });
    const winnerToken = await openStoredOAuthToken(input.key, winner?.accessToken);
    if (winnerToken && fresh(winner?.accessTokenExpiresAt))
      return granted(input.directory, winnerToken);
    return { error: "unavailable" };
  }
  return granted(input.directory, refreshed.tokens.accessToken);
}

function granted(directory: DirectoryGrantConfig, accessToken: string): DirectoryGrantResult {
  return { accessToken, appId: directory.clientId, brand: directory.brand };
}

function fresh(expiresAt: Date | null | undefined): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() - Date.now() > REFRESH_SKEW_MS;
}

function expiresAt(seconds: number | undefined): Date | undefined {
  return seconds !== undefined ? new Date(Date.now() + seconds * 1000) : undefined;
}
