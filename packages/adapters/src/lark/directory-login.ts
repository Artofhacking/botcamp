/**
 * Directory login through Feishu's authorization-code flow.
 *
 * The identity is the app-scoped open_id. Feishu says the contact email is
 * imported by an administrator and is not a verified mailbox, so callers must
 * not treat it as proof of the address.
 */

const FEISHU_ACCOUNTS = "https://accounts.feishu.cn";
const LARK_ACCOUNTS = "https://accounts.larksuite.com";
const FEISHU_OPEN = "https://open.feishu.cn";
const LARK_OPEN = "https://open.larksuite.com";

/** Permission that returns the contact email on the user-info response. */
export const DIRECTORY_LOGIN_EMAIL_SCOPE = "contact:user.email:readonly";

export {
  DIRECTORY_CLI_SCOPE_CATALOG_VERSION,
  directoryLoginScopes,
} from "./directory-cli-scopes.js";

export interface DirectoryLoginEndpoints {
  /** Identity authority. Included in the stored account subject. */
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
}

export interface DirectoryLoginProfile {
  /** Stable subject for one application. Changing the application changes it. */
  sub: string;
  email: string;
  name?: string;
  /** HTTPS picture from the directory. Omitted when the provider does not send one. */
  image?: string;
}

/** Button and product name for this directory, from the deployment's configured label. */
export function directoryDisplayName(name: string | undefined, domain: string | undefined): string {
  const configured = name?.trim();
  if (configured) return configured;
  return domain?.trim().toLowerCase() === "lark" ? "Lark" : "飞书";
}

/** Feishu and Lark use the same paths on different hosts. An unknown domain is refused. */
export function directoryLoginEndpoints(
  domain: string | undefined,
): DirectoryLoginEndpoints | null {
  const normalized = domain?.trim().toLowerCase() || "feishu";
  const international = normalized === "lark";
  if (normalized !== "feishu" && !international) return null;
  const accounts = international ? LARK_ACCOUNTS : FEISHU_ACCOUNTS;
  const open = international ? LARK_OPEN : FEISHU_OPEN;
  return {
    issuer: accounts,
    authorizationUrl: `${accounts}/open-apis/authen/v1/authorize`,
    // PKCE on the authorize endpoint is currently honored by this token endpoint.
    tokenUrl: `${open}/open-apis/authen/v2/oauth/token`,
    userInfoUrl: `${open}/open-apis/authen/v1/user_info`,
  };
}

export interface DirectoryTokenSet {
  accessToken: string;
  expiresIn?: number;
  /** Present when the consent included offline access. The provider rotates it. */
  refreshToken?: string;
  refreshExpiresIn?: number;
  /** Scopes the provider says this token holds. Omitted when the response has none. */
  scopes?: string[];
}

export async function exchangeDirectoryAuthorizationCode(input: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectURI: string;
  codeVerifier?: string;
}): Promise<DirectoryTokenSet | null> {
  const body = await postJson(input.tokenUrl, {
    grant_type: "authorization_code",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectURI,
    ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
  });
  return body ? tokenSet(body) : null;
}

/**
 * Exchanges a refresh token. The provider returns a new refresh token; callers
 * must store that one or the next refresh fails. A null body is a transport
 * failure. A body with a non-zero code is a rejected grant.
 */
export async function refreshDirectoryAccessToken(input: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<{ tokens: DirectoryTokenSet } | { rejected: true } | null> {
  if (!singleLine(input.refreshToken)) return { rejected: true };
  const body = await postJson(input.tokenUrl, {
    grant_type: "refresh_token",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
  });
  if (!body) return null;
  const tokens = tokenSet(body);
  return tokens ? { tokens } : { rejected: true };
}

function tokenSet(body: JsonRecord): DirectoryTokenSet | null {
  if (body.code !== 0 || !singleLine(body.access_token)) return null;
  const refreshToken = singleLine(body.refresh_token) ? body.refresh_token : undefined;
  const scopes = scopeList(body.scope);
  return {
    accessToken: body.access_token,
    ...positiveSeconds(body.expires_in, "expiresIn"),
    ...(refreshToken ? { refreshToken } : {}),
    ...positiveSeconds(body.refresh_token_expires_in, "refreshExpiresIn"),
    ...(scopes ? { scopes } : {}),
  };
}

function positiveSeconds(
  value: unknown,
  key: "expiresIn" | "refreshExpiresIn",
): { expiresIn: number } | { refreshExpiresIn: number } | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return { [key]: value } as { expiresIn: number } | { refreshExpiresIn: number };
}

function scopeList(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const scopes = value
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0 && scope.length <= 200 && !/[\r\n]/.test(scope));
  return scopes.length > 0 ? scopes : undefined;
}

/**
 * Loads the person who approved the authorization code.
 * `tenant` restricts the result to one organization. A missing email cannot sign in.
 */
export async function directoryLoginProfile(
  userInfoUrl: string,
  accessToken: string,
  tenant?: string,
): Promise<DirectoryLoginProfile | null> {
  if (!singleLine(accessToken)) return null;
  let response: Response;
  try {
    response = await fetch(userInfoUrl, {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return null;
  }
  const body = await readJson(response);
  if (!response.ok || !body || body.code !== 0 || !isRecord(body.data)) return null;
  const data = body.data;
  const sub = typeof data.open_id === "string" ? data.open_id.trim() : "";
  const email = contactEmail(data);
  if (!sub || !email) return null;
  const expectedTenant = tenant?.trim();
  if (expectedTenant && data.tenant_key !== expectedTenant) return null;
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const image = httpsPicture(data.avatar_url);
  return { sub, email, ...(name ? { name } : {}), ...(image ? { image } : {}) };
}

/** A directory picture is shown in the browser, so only a plain HTTPS URL is kept. */
function httpsPicture(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const image = value.trim();
  if (!image || image.length > 2_000 || /\s/.test(image)) return undefined;
  try {
    const url = new URL(image);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** Enterprise mailbox first; both are directory attributes, not mailbox proof. */
function contactEmail(data: Record<string, unknown>): string | null {
  for (const key of ["enterprise_email", "email"]) {
    const value = data[key];
    if (typeof value !== "string") continue;
    const email = value.trim();
    if (email.includes("@") && !/\s/.test(email)) return email;
  }
  return null;
}

/**
 * User scopes the login app has enabled, from its own application record. The authorization
 * page rejects every requested scope the app has not enabled, so requesting the whole command
 * catalog only works when an administrator enabled all of it. A failed lookup returns null and
 * the caller keeps its configured list.
 */
export async function enabledDirectoryUserScopes(input: {
  appId: string;
  appSecret: string;
  domain: string | undefined;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<Set<string> | null> {
  const endpoints = directoryLoginEndpoints(input.domain);
  if (!endpoints) return null;
  const openBase = new URL(endpoints.tokenUrl).origin;
  const http = input.fetchImpl ?? fetch;
  const signal = input.signal ?? AbortSignal.timeout(5_000);
  try {
    const tokenResponse = await http(`${openBase}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ app_id: input.appId, app_secret: input.appSecret }),
      signal,
    });
    if (!tokenResponse.ok) return null;
    const token = await readJson(tokenResponse);
    if (token?.code !== 0) return null;
    if (!singleLine(token.tenant_access_token)) return null;
    const infoResponse = await http(
      `${openBase}/open-apis/application/v6/applications/${encodeURIComponent(input.appId)}?lang=zh_cn`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token.tenant_access_token}`,
        },
        signal,
      },
    );
    if (!infoResponse.ok) return null;
    const info = await readJson(infoResponse);
    if (!info || (typeof info.code === "number" && info.code !== 0)) return null;
    const app = isRecord(info.data) && isRecord(info.data.app) ? info.data.app : undefined;
    const entries = app && Array.isArray(app.scopes) ? app.scopes : [];
    const enabled = new Set<string>();
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.scope !== "string") continue;
      const tokenTypes = Array.isArray(entry.token_types) ? entry.token_types : [];
      if (tokenTypes.includes("user")) enabled.add(entry.scope);
    }
    return enabled;
  } catch {
    return null;
  }
}

async function postJson(url: string, payload: Record<string, string>): Promise<JsonRecord | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return null;
  }
  return readJson(response);
}

async function readJson(response: Response): Promise<JsonRecord | null> {
  try {
    const body: unknown = await response.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function singleLine(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\r\n]/.test(value);
}
