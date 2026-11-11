import type { AccountSecurity } from "@botcamp/contracts";
import { accountSecuritySchema, legacyAccountSecurity } from "@botcamp/contracts";
import { readBoundedJsonResponse } from "@botcamp/core";
import { t } from "@lingui/core/macro";
import { apiUrl } from "./api-origin.js";
import { authHeaders } from "./auth-token.js";
import { authErrorText } from "./user-error";

/** The linked directory or SSO identity that can confirm this session again. */
export function linkedSignInProvider(security: AccountSecurity): "oidc" | "directory" | null {
  if (security.sso && security.ssoLinked) return "oidc";
  if (security.directory && security.directoryLinked) return "directory";
  return null;
}

/** A configured directory or SSO button, preferring one this account has linked. */
export function configuredSignInProvider(security: AccountSecurity): "oidc" | "directory" | null {
  if (security.directory && !security.sso) return "directory";
  if (security.sso && !security.directory) return "oidc";
  if (security.directoryLinked && !security.ssoLinked) return "directory";
  if (security.sso) return "oidc";
  if (security.directory) return "directory";
  return null;
}

export async function fetchAccountSecurity() {
  const response = await fetch(apiUrl("/api/auth/account-security"), {
    headers: authHeaders(),
    signal: AbortSignal.timeout(8_000),
  });
  // Electron ships this client independently of the connected API version.
  if (response.status === 404) return legacyAccountSecurity;
  if (!response.ok) throw new Error(t`Could not load sign-in options`);
  try {
    return accountSecuritySchema.parse(await readBoundedJsonResponse<unknown>(response, 64 * 1024));
  } catch {
    throw new Error(t`Could not load sign-in options`);
  }
}

async function postAuth(path: string, body?: Record<string, string>) {
  const response = await fetch(`/api/auth${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(8_000),
    ...(body
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  if (!response.ok) {
    let error: unknown;
    try {
      error = await readBoundedJsonResponse<unknown>(response, 64 * 1024);
    } catch {
      // Gateways may return HTML or an empty body.
    }
    throw new Error(authErrorText(error, t`Could not continue`));
  }
}

export const requestAccountDeletionCode = () => postAuth("/request-account-deletion");

/** Emails a confirmation code to an account without a password. */
export const requestIdentityCode = () => postAuth("/request-identity-code");

/** Confirms this session's identity for the next few minutes. */
export const confirmIdentity = (proof: { password: string } | { code: string }) =>
  postAuth("/confirm-identity", proof);
