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

export async function exchangeDirectoryAuthorizationCode(input: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectURI: string;
  codeVerifier?: string;
}): Promise<{ accessToken: string; expiresIn?: number } | null> {
  const body = await postJson(input.tokenUrl, {
    grant_type: "authorization_code",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectURI,
    ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
  });
  if (body?.code !== 0 || !singleLine(body.access_token)) return null;
  const expiresIn = body.expires_in;
  return {
    accessToken: body.access_token,
    ...(typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? { expiresIn }
      : {}),
  };
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
