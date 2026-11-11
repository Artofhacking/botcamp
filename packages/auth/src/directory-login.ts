import type { BetterAuthPlugin } from "better-auth";
import { APIError, getOAuthState } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins";
import { oidcAccountSubject } from "./oidc.js";
import type { TokenKey } from "./token-storage.js";
import { openIdToken } from "./token-storage.js";

/** Neutral provider id. The button label comes from configuration. */
export const DIRECTORY_PROVIDER_ID = "directory";

const FRESH_MS = 5 * 60 * 1000;

export interface DirectoryLoginProfile {
  sub: string;
  email: string;
  name?: string;
  image?: string;
}

export interface DirectoryLoginConfig {
  /** Identity authority. Part of the stored account subject. */
  issuer: string;
  name: string;
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  allowSignupBypass: boolean;
  exchange: (input: {
    code: string;
    redirectURI: string;
    codeVerifier?: string;
  }) => Promise<{ accessToken: string; expiresIn?: number } | null>;
  profile: (accessToken: string) => Promise<DirectoryLoginProfile | null>;
}

/**
 * Authorization-code login for a directory that does not issue ID tokens.
 * A reauthentication asks the directory to show its consent screen again.
 * The directory has no authentication-time claim, so the proof lasts five
 * minutes from this callback and only covers the same linked subject.
 */
export function directoryLogin(config: DirectoryLoginConfig) {
  const profiles = new Map<
    string,
    { profile: DirectoryLoginProfile; timer: ReturnType<typeof setTimeout> }
  >();
  const remember = (token: string, profile: DirectoryLoginProfile) => {
    const timer = setTimeout(() => profiles.delete(token), 60_000);
    timer.unref?.();
    profiles.set(token, { profile, timer });
  };
  const take = (token: string) => {
    const hit = profiles.get(token);
    if (!hit) return undefined;
    clearTimeout(hit.timer);
    profiles.delete(token);
    return hit.profile;
  };
  const generic = genericOAuth({
    config: [
      {
        providerId: DIRECTORY_PROVIDER_ID,
        name: config.name,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        authorizationUrl: config.authorizationUrl,
        tokenUrl: config.tokenUrl,
        scopes: config.scopes,
        pkce: true,
        getToken: async ({ code, redirectURI, codeVerifier }) => {
          const tokens = await config.exchange({ code, redirectURI, codeVerifier });
          const profile = tokens ? await config.profile(tokens.accessToken) : null;
          // A thrown exchange becomes an invalid code. The provider error stays in the adapter.
          if (!tokens || !profile) throw new Error("directory login token exchange failed");
          remember(tokens.accessToken, profile);
          return {
            accessToken: tokens.accessToken,
            idToken: directoryIdentityToken(config.issuer, profile.sub, profile),
            accessTokenExpiresAt:
              tokens.expiresIn !== undefined
                ? new Date(Date.now() + tokens.expiresIn * 1000)
                : undefined,
            tokenType: "bearer",
          };
        },
        getUserInfo: async (tokens) => {
          const profile =
            (tokens.accessToken ? take(tokens.accessToken) : undefined) ??
            (tokens.accessToken ? await config.profile(tokens.accessToken) : null);
          if (!profile?.sub.trim()) return null;
          const email = profile.email.trim();
          if (!email.includes("@")) return null;
          return {
            sub: profile.sub.trim(),
            email,
            name: profile.name?.trim() || email.split("@")[0] || "User",
            emailVerified: false,
          };
        },
        accountSubject: ({ profile }) => {
          if (typeof profile.sub !== "string" || !profile.sub.trim()) return "";
          return oidcAccountSubject(config.issuer, profile.sub.trim());
        },
        mapProfileToUser: () => ({ emailVerified: false }),
      },
    ],
  });
  type Provider = Awaited<ReturnType<typeof generic.init>>["context"]["socialProviders"][number];
  const unavailable = () =>
    new APIError("SERVICE_UNAVAILABLE", {
      code: "SSO_UNAVAILABLE",
      message: "SSO is temporarily unavailable. Try again.",
    });
  const plugin: BetterAuthPlugin = {
    id: "directory-login",
    init(ctx) {
      const getProvider = async () => {
        const result = await generic.init({
          ...ctx,
          socialProviders: ctx.socialProviders.filter((item) => item.id !== DIRECTORY_PROVIDER_ID),
          logger: { ...ctx.logger, error: () => undefined },
        });
        const built = result.context.socialProviders.find(
          (item) => typeof item !== "function" && item.id === DIRECTORY_PROVIDER_ID,
        );
        if (!built || typeof built === "function") throw unavailable();
        return built;
      };
      const lazy: Provider = {
        id: DIRECTORY_PROVIDER_ID,
        name: config.name,
        issuer: config.issuer,
        createAuthorizationURL: async (data) => {
          const url = await (await getProvider()).createAuthorizationURL(data);
          const expectedUser = (await getOAuthState())?.serverContext?.reauthUserId;
          if (typeof expectedUser === "string") url.searchParams.set("prompt", "consent");
          await ctx.internalAdapter.createVerificationValue({
            identifier: `directory-callback-${data.state}`,
            value: data.state,
            expiresAt: new Date(Date.now() + 10 * 60_000),
          });
          return url;
        },
        validateAuthorizationCode: async (data) => {
          const state = await getOAuthState();
          const marker = await ctx.internalAdapter.consumeVerificationValue(
            `directory-callback-${state?.oauthState}`,
          );
          if (!marker || marker.value !== state?.oauthState) return null;
          return (await getProvider()).validateAuthorizationCode(data);
        },
        getUserInfo: async (tokens) => {
          const info = await (await getProvider()).getUserInfo(tokens);
          const sub = info?.data && "sub" in info.data ? info.data.sub : undefined;
          if (!info?.data || typeof sub !== "string" || !sub.trim()) return null;
          const context = (await getOAuthState())?.serverContext;
          if (typeof context?.reauthUserId === "string") {
            const accountId = oidcAccountSubject(config.issuer, sub.trim());
            const account = await ctx.internalAdapter.findAccountByKey({
              providerId: DIRECTORY_PROVIDER_ID,
              accountId,
            });
            const session =
              typeof context.reauthSessionToken === "string"
                ? await ctx.internalAdapter.findSession(context.reauthSessionToken)
                : null;
            if (
              !Array.isArray(context.reauthAccountIds) ||
              !context.reauthAccountIds.includes(accountId) ||
              account?.userId !== context.reauthUserId ||
              session?.user.id !== context.reauthUserId ||
              session.session.expiresAt.getTime() <= Date.now()
            )
              return null;
            context.reauthExpiresAt = Date.now() + FRESH_MS;
          }
          return info;
        },
        accountSubject: async (data) => {
          const resolved = await getProvider();
          if (!resolved.accountSubject) throw unavailable();
          return resolved.accountSubject(data);
        },
      };
      return { context: { socialProviders: [lazy, ...ctx.socialProviders] } };
    },
  };
  return {
    plugin,
    isAuthorizationURL: (value: string) => {
      const expected = URL.parse(config.authorizationUrl);
      const url = URL.parse(value);
      return Boolean(
        expected && url && url.origin === expected.origin && url.pathname === expected.pathname,
      );
    },
    dispose: () => {
      for (const entry of profiles.values()) clearTimeout(entry.timer);
      profiles.clear();
    },
  };
}

/** Sealed with the other ID tokens because the value contains a dot. */
export function directoryIdentityToken(
  issuer: string,
  subject: string,
  display?: { name?: string; image?: string },
) {
  const name = display?.name?.trim().slice(0, 80);
  const image = display?.image?.trim();
  return `dir.${Buffer.from(
    JSON.stringify({
      iss: issuer,
      sub: subject,
      ...(name ? { name } : {}),
      ...(image ? { image } : {}),
    }),
  ).toString("base64url")}`;
}

interface DirectoryClaims {
  iss: string;
  sub: string;
  name?: string;
  image?: string;
}

async function directoryClaims(
  account: { providerId: string; accountId: string; idToken?: string | null },
  issuer: string | undefined,
  key: TokenKey,
): Promise<DirectoryClaims | null> {
  if (!issuer || account.providerId !== DIRECTORY_PROVIDER_ID) return null;
  const token = await openIdToken(key, account.idToken);
  if (!token?.startsWith("dir.")) return null;
  try {
    const claims = JSON.parse(Buffer.from(token.slice("dir.".length), "base64url").toString()) as {
      iss?: unknown;
      sub?: unknown;
      name?: unknown;
      image?: unknown;
    };
    const sub = typeof claims.sub === "string" ? claims.sub.trim() : "";
    if (claims.iss !== issuer || !sub || account.accountId !== oidcAccountSubject(issuer, sub))
      return null;
    const name = typeof claims.name === "string" ? claims.name.trim().slice(0, 80) : "";
    const image = typeof claims.image === "string" ? claims.image.trim() : "";
    return {
      iss: issuer,
      sub,
      ...(name ? { name } : {}),
      ...(image.startsWith("https://") && !/\s/.test(image) ? { image } : {}),
    };
  } catch {
    return null;
  }
}

/** The stored token binds this account to the configured directory. */
export async function isCurrentDirectoryAccount(
  account: { providerId: string; accountId: string; idToken?: string | null },
  issuer: string | undefined,
  key: TokenKey,
) {
  return (await directoryClaims(account, issuer, key)) !== null;
}

/** Name and picture saved when this directory identity was last linked or used. */
export async function currentDirectoryProfile(
  account: { providerId: string; accountId: string; idToken?: string | null },
  issuer: string | undefined,
  key: TokenKey,
): Promise<{ name: string; image?: string } | null> {
  const claims = await directoryClaims(account, issuer, key);
  if (!claims?.name) return null;
  return { name: claims.name, ...(claims.image ? { image: claims.image } : {}) };
}
