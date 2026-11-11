import { createHash, createHmac } from "node:crypto";
import type * as Db from "@botcamp/db";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DIRECTORY_PROVIDER_ID, isCurrentDirectoryAccount } from "./directory-login.js";
import type { Auth, AuthEnv } from "./index.js";
import { createAuth } from "./index.js";
import { oidcAccountSubject } from "./oidc.js";

const state = vi.hoisted(() => ({ db: {} as Record<string, Record<string, unknown>[]> }));
vi.mock("better-auth/adapters/prisma", () => ({ prismaAdapter: () => memoryAdapter(state.db) }));
vi.mock("@botcamp/db", async (original) => ({
  ...(await original<typeof Db>()),
  bootstrapUserSpace: vi.fn(),
}));

const issuer = "https://accounts.example.test";
const origin = "https://botcamp.example.test";
const secret = "offline-test-secret-with-at-least-32-characters";
let auth: Auth;
let cookies: string;
let sequence: number;
let profile: { sub: string; email: string; name?: string; image?: string } | null;
const challenges = new Map<string, string>();

function setup(options: Partial<AuthEnv> = {}) {
  const prisma: Record<string, unknown> = {
    deploymentSettings: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    spaceMember: { findFirst: vi.fn(async () => ({ id: "existing-space" })) },
    member: { findMany: vi.fn(async () => []) },
    messagingIdentity: { deleteMany: vi.fn(async () => ({})) },
    messagingLinkCode: { deleteMany: vi.fn(async () => ({})) },
    userDevice: { updateMany: vi.fn(async () => ({})) },
    passkey: { deleteMany: vi.fn(async () => ({})) },
    account: { deleteMany: vi.fn(async () => ({})) },
    organization: { deleteMany: vi.fn(async () => ({})) },
  };
  prisma.$transaction = vi.fn(async (operations: (tx: unknown) => Promise<unknown>) =>
    operations(prisma),
  );
  auth = createAuth(prisma as never, {
    secret,
    baseURL: origin,
    webOrigin: origin,
    signupsEnabled: "true",
    signupAllowlist: undefined,
    directory: {
      issuer,
      name: "Directory",
      clientId: "cli-test",
      clientSecret: "test-secret",
      authorizationUrl: `${issuer}/authorize`,
      tokenUrl: `${issuer}/token`,
      scopes: ["contact:user.email:readonly"],
      allowSignupBypass: false,
      exchange: async ({ code, codeVerifier }) => {
        const expected = challenges.get(code);
        const actual = createHash("sha256")
          .update(codeVerifier ?? "")
          .digest("base64url");
        challenges.delete(code);
        if (!expected || expected !== actual || !profile) return null;
        return { accessToken: `access-${code}`, expiresIn: 7200 };
      },
      profile: async () => profile,
    },
    ...options,
  });
}

function signedBearer(token: string) {
  if (token.includes(".")) return token;
  return `${token}.${createHmac("sha256", secret).update(token).digest("base64")}`;
}

async function request(path: string, body?: unknown, bearer?: string) {
  const headers = new Headers({
    origin,
    "content-type": "application/json",
    ...(cookies ? { cookie: cookies } : {}),
    ...(bearer ? { authorization: `Bearer ${signedBearer(bearer)}` } : {}),
  });
  const context = await auth.$context;
  context.skipOriginCheck = false;
  context.skipCSRFCheck = false;
  const response = await auth.handler(
    new Request(`${origin}/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const jar = new Map(
    cookies
      .split("; ")
      .filter(Boolean)
      .map((item) => item.split("=") as [string, string]),
  );
  for (const cookie of response.headers.getSetCookie()) {
    const [key, value] = cookie.split(";")[0]!.split("=");
    if (key) jar.set(key, value ?? "");
  }
  cookies = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  return response;
}

async function begin(reauthenticate = false) {
  const response = await request("/sign-in/social", {
    provider: DIRECTORY_PROVIDER_ID,
    callbackURL: `${origin}/app`,
    errorCallbackURL: `${origin}/sign-in`,
    disableRedirect: true,
    ...(reauthenticate ? { additionalData: { reauthenticate: true } } : {}),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const url = new URL(((await response.json()) as { url: string }).url);
  const code = `code-${++sequence}`;
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("prompt")).toBe(reauthenticate ? "consent" : null);
  challenges.set(code, url.searchParams.get("code_challenge")!);
  return `/callback/${DIRECTORY_PROVIDER_ID}?state=${url.searchParams.get("state")}&code=${code}`;
}

const rows = (model: string) => state.db[model] ?? [];

beforeEach(() => {
  state.db = {
    user: [],
    session: [],
    account: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
  };
  cookies = "";
  sequence = 0;
  profile = { sub: "ou-person", email: "person@company.test", name: "Person" };
  challenges.clear();
  setup();
});

afterEach(() => {
  auth?.disposeOidcDiscovery();
});

it("creates an unverified account bound to the directory subject", async () => {
  const response = await request(await begin());
  expect(response.headers.get("location")).toBe(`${origin}/app`);
  expect(rows("user")).toEqual([
    expect.objectContaining({ email: "person@company.test", emailVerified: false, name: "Person" }),
  ]);
  const account = rows("account")[0];
  expect(account).toMatchObject({
    providerId: DIRECTORY_PROVIDER_ID,
    accountId: oidcAccountSubject(issuer, "ou-person"),
  });
  await expect(
    isCurrentDirectoryAccount(
      account as { providerId: string; accountId: string; idToken?: string | null },
      issuer,
      secret,
    ),
  ).resolves.toBe(true);
  await expect(
    isCurrentDirectoryAccount(
      account as { providerId: string; accountId: string; idToken?: string | null },
      "https://other.example.test",
      secret,
    ),
  ).resolves.toBe(false);
});

it("signs the same person in again without marking the mailbox verified", async () => {
  await request(await begin());
  cookies = "";
  const response = await request(await begin());
  expect(response.headers.get("location")).toBe(`${origin}/app`);
  expect(rows("user")).toHaveLength(1);
  expect(rows("user")[0]?.emailVerified).toBe(false);
});

it("merges a directory identity into the existing account with the same email", async () => {
  await request("/sign-up/email", {
    email: "person@company.test",
    password: "test-password-123",
    name: "Local",
  });
  const userId = rows("user")[0]?.id;
  rows("user")[0]!.emailVerified = true;
  profile = { sub: "ou-person", email: "Person@company.test", name: "Directory" };
  cookies = "";
  const response = await request(await begin());
  expect(response.headers.get("location")).toBe(`${origin}/app`);
  expect(rows("user")).toEqual([
    expect.objectContaining({
      id: userId,
      email: "person@company.test",
      emailVerified: true,
      name: "Local",
    }),
  ]);
  expect(
    rows("account")
      .map((row) => row.providerId)
      .sort(),
  ).toEqual(["credential", "directory"]);
  expect(rows("session")[0]?.userId).toBe(userId);
});

it("merges an existing address when registration is closed", async () => {
  await request("/sign-up/email", {
    email: "person@company.test",
    password: "test-password-123",
    name: "Local",
  });
  auth.disposeOidcDiscovery();
  setup({ signupsEnabled: "false", signupAllowlist: "other@company.test" });
  cookies = "";
  const response = await request(await begin());
  expect(response.headers.get("location")).toBe(`${origin}/app`);
  expect(rows("user")).toHaveLength(1);
  expect(rows("account").map((row) => row.providerId)).toContain("directory");
});

it("does not merge a directory sign-in when the address differs", async () => {
  await request("/sign-up/email", {
    email: "local@company.test",
    password: "test-password-123",
    name: "Local",
  });
  const localId = rows("user")[0]?.id;
  profile = { sub: "ou-other", email: "other@company.test", name: "Other" };
  cookies = "";
  const response = await request(await begin());
  expect(response.headers.get("location")).toBe(`${origin}/app`);
  expect(rows("user")).toHaveLength(2);
  expect(rows("user").find((row) => row.id === localId)).toMatchObject({
    email: "local@company.test",
    name: "Local",
  });
  expect(
    rows("account")
      .filter((row) => row.userId === localId)
      .map((row) => row.providerId),
  ).toEqual(["credential"]);
});

it("links the signed-in account when the directory address differs", async () => {
  const created = await request("/sign-up/email", {
    email: "local@company.test",
    password: "test-password-123",
    name: "Local",
  });
  expect(created.status).toBe(200);
  const userId = rows("user")[0]?.id;
  const emailVerified = rows("user")[0]?.emailVerified;
  profile = {
    sub: "ou-person",
    email: "other@company.test",
    name: "Feishu Person",
    image: "https://cdn.example.test/person.png",
  };
  const started = await request("/link-social", {
    provider: DIRECTORY_PROVIDER_ID,
    callbackURL: `${origin}/account`,
    errorCallbackURL: `${origin}/account`,
    disableRedirect: true,
  });
  expect(started.status, await started.clone().text()).toBe(200);
  const url = new URL(((await started.json()) as { url: string }).url);
  const code = `code-${++sequence}`;
  challenges.set(code, url.searchParams.get("code_challenge")!);
  const linked = await request(
    `/callback/${DIRECTORY_PROVIDER_ID}?state=${url.searchParams.get("state")}&code=${code}`,
  );
  expect(linked.headers.get("location"), await linked.clone().text()).toBe(`${origin}/account`);
  expect(rows("user")).toEqual([
    expect.objectContaining({
      id: userId,
      email: "local@company.test",
      emailVerified,
      name: "Local",
    }),
  ]);
  expect(
    rows("account")
      .map((row) => row.providerId)
      .sort(),
  ).toEqual(["credential", "directory"]);
  expect(await (await request("/account-security")).json()).toMatchObject({
    directoryLinked: true,
    directory: {
      name: "Directory",
      profile: { name: "Feishu Person", image: "https://cdn.example.test/person.png" },
    },
  });
});

it("links the directory identity from the signed-in account when the address matches", async () => {
  const created = await request("/sign-up/email", {
    email: "person@company.test",
    password: "test-password-123",
    name: "Local",
  });
  expect(created.status).toBe(200);
  const started = await request("/link-social", {
    provider: DIRECTORY_PROVIDER_ID,
    callbackURL: `${origin}/account`,
    errorCallbackURL: `${origin}/account`,
    disableRedirect: true,
  });
  expect(started.status, await started.clone().text()).toBe(200);
  const url = new URL(((await started.json()) as { url: string }).url);
  const code = `code-${++sequence}`;
  challenges.set(code, url.searchParams.get("code_challenge")!);
  const linked = await request(
    `/callback/${DIRECTORY_PROVIDER_ID}?state=${url.searchParams.get("state")}&code=${code}`,
  );
  expect(linked.headers.get("location")).toBe(`${origin}/account`);
  expect(
    rows("account")
      .map((row) => row.providerId)
      .sort(),
  ).toEqual(["credential", "directory"]);
});

it("sets a password on the directory email, then removes only the directory link", async () => {
  await request(await begin());
  const before = rows("user")[0];
  expect(before).toMatchObject({
    email: "person@company.test",
    emailVerified: false,
    name: "Person",
  });
  const blocked = await request("/unlink-directory", {});
  expect(blocked.status).toBe(400);
  expect(await blocked.json()).toMatchObject({ code: "PASSWORD_REQUIRED" });
  expect(rows("account").map((row) => row.providerId)).toEqual(["directory"]);

  const short = await request("/initial-password", { newPassword: "short" });
  expect(short.status).toBe(400);
  expect(await short.json()).toMatchObject({ code: "PASSWORD_TOO_SHORT" });

  const set = await request("/initial-password", { newPassword: "test-password-123" });
  expect(set.status, await set.clone().text()).toBe(200);
  expect(rows("user")[0]).toMatchObject({
    id: before?.id,
    email: "person@company.test",
    emailVerified: false,
    name: "Person",
  });
  expect(
    rows("account")
      .map((row) => row.providerId)
      .sort(),
  ).toEqual(["credential", "directory"]);
  const again = await request("/initial-password", { newPassword: "another-password-123" });
  expect(again.status).toBe(400);
  expect(await again.json()).toMatchObject({ code: "PASSWORD_ALREADY_SET" });

  cookies = "";
  const signedIn = await request("/sign-in/email", {
    email: "person@company.test",
    password: "test-password-123",
  });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  expect(rows("user")[0]).toMatchObject({ emailVerified: false, email: "person@company.test" });

  const changed = await request("/change-password", {
    currentPassword: "test-password-123",
    newPassword: "another-password-123",
    revokeOtherSessions: false,
  });
  expect(changed.status, await changed.clone().text()).toBe(200);
  const removed = await request("/unlink-directory", {});
  expect(removed.status, await removed.clone().text()).toBe(200);
  expect(rows("account").map((row) => row.providerId)).toEqual(["credential"]);
  expect(rows("user")[0]).toMatchObject({
    id: before?.id,
    email: "person@company.test",
    emailVerified: false,
    name: "Person",
  });

  cookies = "";
  const later = await request("/sign-in/email", {
    email: "person@company.test",
    password: "another-password-123",
  });
  expect(later.status, await later.clone().text()).toBe(200);
  expect(rows("user")[0]).toMatchObject({ emailVerified: false });
});

it("still requires a verified mailbox for password sign-in when an allowlist is set", async () => {
  await request(await begin());
  const set = await request("/initial-password", { newPassword: "test-password-123" });
  expect(set.status, await set.clone().text()).toBe(200);
  expect(rows("user")[0]).toMatchObject({ email: "person@company.test", emailVerified: false });
  setup({ signupAllowlist: "person@company.test" });
  cookies = "";
  const signedIn = await request("/sign-in/email", {
    email: "person@company.test",
    password: "test-password-123",
  });
  expect(signedIn.status).toBeGreaterThanOrEqual(400);
  expect(await signedIn.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
  expect(rows("user")[0]).toMatchObject({ emailVerified: false, email: "person@company.test" });
});

it("refuses a directory password and unbind when password sign-in is off", async () => {
  setup({ passwordAuth: false });
  for (const path of ["/initial-password", "/unlink-directory"]) {
    const response = await request(path, { newPassword: "test-password-123" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.json()).toMatchObject({ code: "PASSWORD_AUTH_DISABLED" });
  }
});

it("records a fresh confirmation after the directory asks for consent again", async () => {
  await request(await begin());
  const userId = String(rows("user")[0]?.id);
  const token = String(rows("session")[0]?.token);
  const again = await request(await begin(true), undefined, token);
  expect(again.headers.get("location")).toBe(`${origin}/app`);
  const proof = rows("verification").find((row) =>
    String(row.identifier).startsWith("oidc-reauth-"),
  );
  expect(proof).toMatchObject({ value: userId });
  expect(new Date(String(proof?.expiresAt)).getTime()).toBeGreaterThan(Date.now());
});
