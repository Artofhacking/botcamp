import type * as Db from "@botcamp/db";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Auth, AuthEnv } from "./index.js";
import { createAuth } from "./index.js";

const state = vi.hoisted(() => ({ db: {} as Record<string, Record<string, unknown>[]> }));
vi.mock("better-auth/adapters/prisma", () => ({ prismaAdapter: () => memoryAdapter(state.db) }));
vi.mock("@botcamp/db", async (original) => ({
  ...(await original<typeof Db>()),
  bootstrapUserSpace: vi.fn(),
}));

const origin = "https://botcamp.example.test";
const secret = "offline-test-secret-with-at-least-32-characters";
const nonce = "00000000-0000-4000-8000-000000000001";
const pollSecret = "00000000-0000-4000-8000-000000000002";
let auth: Auth;
let cookies: string;

function setup() {
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
  auth = createAuth(
    prisma as never,
    {
      secret,
      baseURL: origin,
      webOrigin: origin,
      signupsEnabled: "true",
      signupAllowlist: undefined,
    } satisfies Partial<AuthEnv> as AuthEnv,
  );
}

async function request(path: string, body?: unknown, init?: { origin?: string | null }) {
  const headers = new Headers({
    "content-type": "application/json",
    ...(cookies ? { cookie: cookies } : {}),
  });
  if (init?.origin !== null) headers.set("origin", init?.origin ?? origin);
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
  setup();
});

afterEach(() => {
  auth?.disposeOidcDiscovery();
});

it("gives the desktop one session after the browser finishes, then forgets it", async () => {
  expect(
    (
      await request("/sign-up/email", {
        email: "person@example.test",
        password: "test-password-123",
        name: "Person",
      })
    ).status,
  ).toBe(200);
  const returnTo = `${origin}/app`;
  expect(
    (
      await request("/desktop-handoff/start", {
        nonce,
        pollSecret,
        returns: { app: returnTo, "sign-in": `${origin}/sign-in` },
      })
    ).status,
  ).toBe(200);
  expect((await request("/desktop-handoff/poll", { nonce, pollSecret })).status).toBe(204);
  const page = await request(`/desktop-handoff?nonce=${nonce}&to=app`, undefined, { origin: null });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  const html = await page.text();
  expect(html).toContain("打开 BotCamp");
  expect(html).toContain("botcamp://sso?");
  expect(html).not.toContain("better-auth.session_token");
  const polled = await request("/desktop-handoff/poll", { nonce, pollSecret });
  expect(polled.status).toBe(200);
  const body = (await polled.json()) as { returnTo: string; token: string };
  expect(body.returnTo).toBe(returnTo);
  expect(body.token).toContain(".");
  const session = await auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${body.token}` }),
  });
  expect(session?.user.email).toBe("person@example.test");
  expect((await request("/desktop-handoff/poll", { nonce, pollSecret })).status).toBe(404);
});

it("rejects a handoff for another site or another secret", async () => {
  expect(
    (
      await request("/desktop-handoff/start", {
        nonce,
        pollSecret,
        returns: { app: "https://other.example.test/app" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("/desktop-handoff/start", {
        nonce,
        pollSecret,
        returns: { app: `${origin}/app` },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request("/desktop-handoff/start", {
        nonce,
        pollSecret: "00000000-0000-4000-8000-000000000003",
        returns: { app: `${origin}/app` },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await request("/desktop-handoff/poll", {
        nonce,
        pollSecret: "00000000-0000-4000-8000-000000000003",
      })
    ).status,
  ).toBe(404);
});
