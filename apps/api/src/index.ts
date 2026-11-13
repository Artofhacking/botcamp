import type { Socket } from "node:net";
import { unwrapEnvFromKeyManager } from "@botcamp/adapters";
import { loadRootEnv } from "@botcamp/core/node/load-root-env";
import { stopOnShutdownSignals } from "@botcamp/core/node/shutdown-signals";

loadRootEnv();
await unwrapEnvFromKeyManager();

import { SERVICE_NAMES } from "@botcamp/logging";
import { createRootLogger } from "@botcamp/logging/axiom";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { narrowDirectoryScopes } from "./directory-grant.js";
import { loadEnv } from "./env.js";

const logger = createRootLogger(SERVICE_NAMES.api);

try {
  const env = loadEnv();
  // The authorization page rejects every scope the app has not enabled, so ask only for the
  // ones it has. A failed lookup keeps the configured list and the login fails visibly.
  if (env.directory) {
    const scopes = await narrowDirectoryScopes({
      requested: env.directory.scopes,
      appId: env.directory.clientId,
      appSecret: env.directory.clientSecret,
      domain: env.directory.issuer.includes("larksuite.com") ? "lark" : "feishu",
    });
    if (scopes) env.directory.scopes = scopes;
    else
      logger.warn("directory login scopes were not narrowed; using the configured list", {
        "directory.name": env.directory.name,
      });
  }
  const { app, stop, handleUpgrade } = await createApp({ ...env, logger });
  const server = serve({ fetch: app.fetch, port: env.port, hostname: env.apiHost }, () => {
    logger.info("api listening", { "http.host": env.apiHost, "http.port": env.port });
  });
  // Desktop apps hold an outbound socket so bots can reach the user's own computer.
  if (handleUpgrade) server.on("upgrade", handleUpgrade);

  // SSE streams never end on their own, so server.close() alone would wait forever;
  // force-close sockets still open after a short grace period.
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const grace = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, 2_000);
    await closed;
    clearTimeout(grace);
    await stop();
    await logger.flush({ timeoutMs: 2_000 });
  };
  stopOnShutdownSignals(shutdown);
} catch (error) {
  logger.error("api startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  process.exit(1);
}
