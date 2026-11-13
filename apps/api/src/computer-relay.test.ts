import { COMPUTER_RELAY_PATH, computerRelayKey } from "@botcamp/core/computer-relay";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountComputerRelayRoutes } from "./computer-relay.js";

const secret = "supervisor-secret";
const homeKey = "home-1";
const key = computerRelayKey(secret, homeKey);

function appWith(options: {
  computer?: { userId: string; scope: string; state: string } | null;
  relaying?: boolean;
  relay?: {
    data: AsyncIterable<Buffer>;
    write(chunk: Buffer): void;
    end(): void;
  };
}) {
  const app = new Hono();
  mountComputerRelayRoutes(app, {
    prisma: {
      computer: { findUnique: async () => options.computer ?? null },
    } as never,
    devices: {
      relaying: async () => options.relaying ?? true,
      relay: async () => options.relay ?? echoRelay(),
    } as never,
    secret,
  });
  return app;
}

function echoRelay() {
  return {
    data: (async function* () {
      yield Buffer.from("from-the-mac");
    })(),
    write: vi.fn(),
    end: vi.fn(),
  };
}

function request(
  app: Hono,
  options: { key?: string; host?: string; port?: string; body?: string } = {},
) {
  return app.request(
    `${COMPUTER_RELAY_PATH}?host=${encodeURIComponent(options.host ?? "example.com")}&port=${options.port ?? "443"}`,
    {
      method: "POST",
      headers: {
        "x-computer-relay-id": homeKey,
        "x-computer-relay-key": options.key ?? key,
        "content-type": "application/octet-stream",
      },
      body: options.body ?? "",
    },
  );
}

const computer = { userId: "user-1", scope: "dedicated", state: "running" };

describe("computer relay", () => {
  it("answers the supervisor's question about the owner's switch", async () => {
    const state = (app: Hono, key: string, bearer = secret) =>
      app.request(`${COMPUTER_RELAY_PATH}/state?key=${key}`, {
        headers: { authorization: `Bearer ${bearer}` },
      });
    expect((await state(appWith({ computer }), homeKey, "wrong")).status).toBe(401);
    expect(await (await state(appWith({ computer }), homeKey)).json()).toEqual({ relay: true });
    expect(await (await state(appWith({ computer, relaying: false }), homeKey)).json()).toEqual({
      relay: false,
    });
    expect(
      await (await state(appWith({ computer: { ...computer, scope: "team" } }), homeKey)).json(),
    ).toEqual({ relay: false });
  });

  it("refuses a computer that cannot prove itself", async () => {
    const app = appWith({ computer });
    expect((await request(app, { key: "0".repeat(64) })).status).toBe(401);
  });

  it("refuses addresses this relay must not reach", async () => {
    const app = appWith({ computer });
    expect((await request(app, { host: "127.0.0.1" })).status).toBe(400);
    expect((await request(app, { port: "0" })).status).toBe(400);
  });

  it("only relays for the owner's private, running computer", async () => {
    expect((await request(appWith({ computer: null }))).status).toBe(404);
    expect((await request(appWith({ computer: { ...computer, scope: "team" } }))).status).toBe(404);
    expect((await request(appWith({ computer: { ...computer, state: "stopped" } }))).status).toBe(
      404,
    );
  });

  it("refuses while the owner has traffic routing off", async () => {
    const app = appWith({ computer, relaying: false });
    expect((await request(app)).status).toBe(409);
  });

  it("streams the owner's bytes through the computer", async () => {
    const relay = echoRelay();
    const app = appWith({ computer, relay });
    const response = await request(app, { body: "from-the-bot" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("from-the-mac");
    expect(vi.mocked(relay.write).mock.calls[0]?.[0]?.toString()).toBe("from-the-bot");
    expect(relay.end).toHaveBeenCalled();
  });
});
