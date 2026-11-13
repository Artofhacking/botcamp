import { createHash, timingSafeEqual } from "node:crypto";
import type { UserDevices } from "@botcamp/adapters";
import { COMPUTER_RELAY_PATH, validComputerRelayKey } from "@botcamp/core";
import type { PrismaClient } from "@botcamp/db";
import { runAsSystem } from "@botcamp/db";
import type { Hono } from "hono";

/** One TCP stream a computer sends through its owner's desktop. */
const HOST_PATTERN = /^[A-Za-z0-9.:[\]_-]{1,253}$/;
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)$/i;

export interface ComputerRelayRouteDeps {
  prisma: PrismaClient;
  devices: UserDevices;
  /** SANDBOX_SUPERVISOR_TOKEN; the supervisor derives each computer's key from it. */
  secret: string;
}

/**
 * The web service joins every computer's isolated Docker network and listens there, so a
 * computer can reach this relay without any inbound route to the API. The computer proves
 * itself with the key this server derives; the owner's desktop supplies the actual network.
 */
export function mountComputerRelayRoutes(app: Hono, deps: ComputerRelayRouteDeps) {
  // The supervisor asks before it gives a command a proxy, so a switch that is off changes
  // nothing for the bot's tools.
  app.get(`${COMPUTER_RELAY_PATH}/state`, async (c) => {
    const supplied = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const expected = createHash("sha256").update(deps.secret).digest();
    const given = createHash("sha256")
      .update(supplied ?? "")
      .digest();
    if (!supplied || !timingSafeEqual(expected, given))
      return c.json({ error: "Unauthorized" }, 401);
    const computerKey = c.req.query("key") ?? "";
    const computer = await runAsSystem("find a computer's relay state", () =>
      deps.prisma.computer.findUnique({
        where: { homeKey: computerKey },
        select: { userId: true, scope: true },
      }),
    );
    if (!computer || computer.scope !== "dedicated") return c.json({ relay: false });
    return c.json({ relay: await deps.devices.relaying(computer.userId) });
  });

  app.post(COMPUTER_RELAY_PATH, async (c) => {
    const computerKey = c.req.header("x-computer-relay-id") ?? "";
    const supplied = c.req.header("x-computer-relay-key");
    if (!validComputerRelayKey(deps.secret, computerKey, supplied))
      return c.json({ error: "Unauthorized" }, 401);
    const host = c.req.query("host") ?? "";
    const port = Number(c.req.query("port"));
    if (!HOST_PATTERN.test(host) || LOOPBACK.test(host))
      return c.json({ error: "Invalid address" }, 400);
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      return c.json({ error: "Invalid port" }, 400);
    // Only a private computer of the signed-in owner uses that owner's network.
    const computer = await runAsSystem("find a computer for its relay", () =>
      deps.prisma.computer.findUnique({
        where: { homeKey: computerKey },
        select: { userId: true, scope: true, state: true },
      }),
    );
    if (!computer || computer.scope !== "dedicated" || computer.state !== "running")
      return c.json({ error: "Not found" }, 404);
    if (!(await deps.devices.relaying(computer.userId)))
      return c.json({ error: "Relay is off" }, 409);
    const relay = await deps.devices.relay(computer.userId, { host, port }, c.req.raw.signal);
    return relayResponse(relay, c.req.raw);
  });
}

/** The relayed bytes as an HTTP body, with the caller's body written into the same stream. */
function relayResponse(
  relay: {
    data: AsyncIterable<Buffer>;
    write(chunk: Buffer): void;
    end(): void;
  },
  request: Request,
): Response {
  const iterator = relay.data[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      relay.end();
      await iterator.return?.();
    },
  });
  void (async () => {
    const reader = request.body?.getReader();
    if (!reader) {
      relay.end();
      return;
    }
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) relay.write(Buffer.from(value));
      }
    } catch {
      /* The caller went away; the response stream fails on its own. */
    }
    relay.end();
  })();
  return new Response(body, {
    headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
  });
}
