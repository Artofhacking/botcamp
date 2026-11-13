import type { Socket } from "node:net";
import { connect as connectTcp } from "node:net";
import { USER_DEVICE_CONNECT_PATH } from "@botcamp/contracts";
import { secureHttpOrigin } from "@botcamp/contracts/network-host";
import WebSocket from "ws";
import type { HostComputerFrame } from "./host-computer-protocol.js";
import { HOST_COMPUTER_MAX_BYTES } from "./host-computer-protocol.js";
import type { HostComputerCall } from "./host-computer-runner.js";
import { createHostComputerRunner } from "./host-computer-runner.js";
import type { HostScreen } from "./host-screen.js";
import type { UserDeviceClientMessage, UserDeviceRevokeReason } from "./user-device-protocol.js";
import {
  USER_DEVICE_RELAY_BUFFER_BYTES,
  USER_DEVICE_RELAY_CHUNK_BYTES,
  USER_DEVICE_RELAY_LIMIT,
  USER_DEVICE_REVOKED_HEADER,
  userDeviceRevokeReason,
  userDeviceServerMessage,
} from "./user-device-protocol.js";

/** One frame or request plus its small envelope, in either direction. */
export const USER_DEVICE_MAX_MESSAGE_BYTES = HOST_COMPUTER_MAX_BYTES + 4096;
const PING_INTERVAL_MS = 30_000;
const RELAY_CONNECT_TIMEOUT_MS = 15_000;
const RELAY_DRAIN_POLL_MS = 25;
const BUSY_MESSAGE = "Local computer is busy. Try again shortly.";
const NOT_ALLOWED_MESSAGE = "Not allowed on this computer";
const RELAY_REFUSED_MESSAGE = "This computer is not sharing its network";
const RELAY_BUSY_MESSAGE = "This computer is relaying too much traffic";
const RELAY_UNREACHABLE_MESSAGE = "Could not reach that address from this computer";

export interface UserDeviceClientOptions {
  serverUrl: string;
  token: string;
  root: string;
  /** Drives this computer's apps. Owned by the caller, which closes it. */
  screen?: HostScreen;
  /** The server revoked the device or rejected its token. The client has already stopped. */
  onRevoked: (reason?: UserDeviceRevokeReason) => void;
  /** Whether this computer lets the server's bots run anything. Asked before every request. */
  authorize: () => Promise<boolean>;
  /** Whether this computer routes the bots' traffic through its own network. */
  relay?: () => boolean;
  retryMs?: { min: number; max: number };
}

/**
 * Connects outbound to a BotCamp server so its bots can use this computer. The server never
 * connects in. Runs only while started; `close` stops every command, every relayed connection,
 * and the socket, and `cancelAll` stops every command and refuses requests still waiting.
 */
export function startUserDeviceClient(options: UserDeviceClientOptions) {
  if (secureHttpOrigin(options.serverUrl) === null)
    throw new Error("Local computer access requires HTTPS or loopback");
  const retry = options.retryMs ?? { min: 1_000, max: 60_000 };
  const runner = createHostComputerRunner({ root: options.root, screen: options.screen });
  runner.setEnabled(true);
  const url = new URL(USER_DEVICE_CONNECT_PATH, options.serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let stopped = false;
  let attempt = 0;
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let refuseWaiting: (() => void) | undefined;
  let relayState = options.relay?.() ?? false;
  let setRelayOnSocket: ((enabled: boolean) => void) | undefined;

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(reconnectTimer);
    runner.close();
    socket?.terminate();
  }

  function cancelAll() {
    if (stopped) return;
    refuseWaiting?.();
    runner.setEnabled(false);
    runner.setEnabled(true);
  }

  function revoked(reason?: UserDeviceRevokeReason) {
    if (stopped) return;
    stop();
    options.onRevoked(reason);
  }

  function scheduleReconnect() {
    if (stopped) return;
    // Full jitter keeps many devices from reconnecting in lockstep after a server restart.
    const ceiling = Math.min(retry.max, retry.min * 2 ** attempt);
    attempt += 1;
    reconnectTimer = setTimeout(connect, retry.min / 2 + Math.random() * ceiling);
    reconnectTimer.unref();
  }

  function connect() {
    if (stopped) return;
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${options.token}` },
      maxPayload: USER_DEVICE_MAX_MESSAGE_BYTES,
      handshakeTimeout: 15_000,
      followRedirects: false,
      perMessageDeflate: false,
    });
    socket = ws;
    const calls = new Map<
      string,
      { call: HostComputerCall; cancelled: boolean; settled: boolean }
    >();
    const authorizing = new Set<string>();
    const relays = new Map<string, { socket: Socket; draining?: NodeJS.Timeout }>();
    let alive = true;
    let openedAt = 0;
    let ping: NodeJS.Timeout | undefined;
    refuseWaiting = () => {
      for (const id of authorizing)
        void send(id, { error: NOT_ALLOWED_MESSAGE }).catch(() => undefined);
      authorizing.clear();
    };

    const sendRaw = (body: string) =>
      new Promise<void>((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error("Local computer disconnected"));
          return;
        }
        ws.send(body, (error) => (error ? reject(error) : resolve()));
      });

    function sendRelayState() {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "relay-state", enabled: relayState }));
    }
    setRelayOnSocket = () => sendRelayState();

    function closeRelay(id: string, error?: string) {
      const face = relays.get(id);
      relays.delete(id);
      if (face?.draining) clearInterval(face.draining);
      face?.socket.destroy();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "relay-close", id, ...(error ? { error } : {}) }));
      }
    }

    function pauseWhileBuffered(face: { socket: Socket; draining?: NodeJS.Timeout }) {
      if (face.draining || ws.bufferedAmount < USER_DEVICE_RELAY_BUFFER_BYTES) return;
      face.socket.pause();
      face.draining = setInterval(() => {
        if (ws.bufferedAmount > USER_DEVICE_RELAY_BUFFER_BYTES / 4) return;
        const timer = face.draining;
        if (timer) clearInterval(timer);
        face.draining = undefined;
        face.socket.resume();
      }, RELAY_DRAIN_POLL_MS);
      face.draining.unref();
    }

    async function openRelay(id: string, host: string, port: number) {
      if (!(options.relay?.() ?? false)) return closeRelay(id, RELAY_REFUSED_MESSAGE);
      if (relays.size >= USER_DEVICE_RELAY_LIMIT) return closeRelay(id, RELAY_BUSY_MESSAGE);
      const target = connectTcp({ host, port });
      const face = { socket: target };
      relays.set(id, face);
      const timer = setTimeout(
        () => closeRelay(id, RELAY_UNREACHABLE_MESSAGE),
        RELAY_CONNECT_TIMEOUT_MS,
      );
      timer.unref();
      target.setNoDelay(true);
      target.once("connect", () => clearTimeout(timer));
      target.once("error", () => closeRelay(id, RELAY_UNREACHABLE_MESSAGE));
      target.on("data", (chunk: Buffer) => {
        if (relays.get(id) !== face) return;
        for (let offset = 0; offset < chunk.length; offset += USER_DEVICE_RELAY_CHUNK_BYTES) {
          const piece = chunk.subarray(offset, offset + USER_DEVICE_RELAY_CHUNK_BYTES);
          ws.send(
            JSON.stringify({
              type: "relay-data",
              id,
              data: piece.toString("base64"),
            } satisfies UserDeviceClientMessage),
          );
        }
        pauseWhileBuffered(face);
      });
      target.once("end", () => closeRelay(id));
      target.once("close", () => {
        if (relays.get(id) === face) closeRelay(id);
      });
    }

    ws.on("unexpected-response", (request, response) => {
      request.destroy();
      ws.terminate();
      if (response.statusCode === 401)
        revoked(
          userDeviceRevokeReason.safeParse(response.headers[USER_DEVICE_REVOKED_HEADER]).data,
        );
    });
    ws.on("open", () => {
      openedAt = Date.now();
      relayState = options.relay?.() ?? false;
      if (options.relay) sendRelayState();
      // A silent network drop otherwise leaves the device looking connected for hours.
      ping = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, PING_INTERVAL_MS);
      ping.unref();
    });
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("error", () => {
      /* "close" follows and reconnects. */
    });
    ws.on("close", () => {
      clearInterval(ping);
      // A lost response is never retried, so in-flight work stops with the connection.
      for (const { call } of calls.values()) call.abort();
      calls.clear();
      for (const face of relays.values()) {
        if (face.draining) clearInterval(face.draining);
        face.socket.destroy();
      }
      relays.clear();
      if (socket === ws) {
        socket = undefined;
        refuseWaiting = undefined;
        setRelayOnSocket = undefined;
      }
      if (openedAt && Date.now() - openedAt >= PING_INTERVAL_MS) attempt = 0;
      scheduleReconnect();
    });
    ws.on("message", (data, isBinary) => {
      alive = true;
      if (isBinary) return;
      let message: ReturnType<typeof userDeviceServerMessage.parse>;
      try {
        const parsed = userDeviceServerMessage.safeParse(JSON.parse(data.toString()));
        if (!parsed.success) return;
        message = parsed.data;
      } catch {
        return;
      }
      if (message.type === "revoked") {
        revoked(message.reason);
        return;
      }
      if (message.type === "cancel") {
        authorizing.delete(message.id);
        const entry = calls.get(message.id);
        if (entry) {
          entry.cancelled = true;
          entry.call.abort();
        }
        return;
      }
      if (message.type === "relay-open") {
        void openRelay(message.id, message.host, message.port);
        return;
      }
      if (message.type === "relay-data") {
        relays.get(message.id)?.socket.write(Buffer.from(message.data, "base64"));
        return;
      }
      if (message.type === "relay-close") {
        const face = relays.get(message.id);
        relays.delete(message.id);
        if (face?.draining) clearInterval(face.draining);
        face?.socket.end();
        return;
      }
      if (calls.has(message.id) || authorizing.has(message.id)) return;
      void handle(message.id, message.request);
    });

    function send(id: string, frame: HostComputerFrame<unknown>) {
      const entry = calls.get(id);
      let body = JSON.stringify({ type: "frame", id, frame } satisfies UserDeviceClientMessage);
      if (Buffer.byteLength(body) > USER_DEVICE_MAX_MESSAGE_BYTES) {
        frame = { error: "Local computer response is too large" };
        body = JSON.stringify({ type: "frame", id, frame } satisfies UserDeviceClientMessage);
        entry?.call.abort();
      }
      if (entry && ("done" in frame || "error" in frame)) entry.settled = true;
      return sendRaw(body);
    }

    async function handle(id: string, request: unknown) {
      authorizing.add(id);
      const allowed = await options.authorize().catch(() => false);
      if (!authorizing.delete(id) || socket !== ws) return;
      if (!allowed) {
        await send(id, { error: NOT_ALLOWED_MESSAGE }).catch(() => undefined);
        return;
      }
      const call = runner.begin();
      if (!call) {
        await send(id, { error: BUSY_MESSAGE }).catch(() => undefined);
        return;
      }
      const entry = { call, cancelled: false, settled: false };
      calls.set(id, entry);
      try {
        const outcome = await call.run(request, {
          open() {},
          write: (frame) => (call.signal.aborted ? undefined : send(id, frame)),
        });
        let refusal: string | undefined;
        if (outcome === "invalid") refusal = "Local computer request is invalid";
        else if (outcome === "busy") refusal = BUSY_MESSAGE;
        else if (outcome === "disabled" || call.signal.aborted)
          refusal = "Local computer operation stopped";
        if (refusal && !entry.cancelled && !entry.settled) await send(id, { error: refusal });
      } catch {
        /* The connection closed; the server fails the request. */
      } finally {
        call.end();
        if (calls.get(id) === entry) calls.delete(id);
      }
    }
  }

  connect();
  return {
    close: stop,
    cancelAll,
    /** Tells the server right away, so the switch takes effect on this connection. */
    setRelay(enabled: boolean) {
      relayState = enabled;
      setRelayOnSocket?.(enabled);
    },
  };
}

export type UserDeviceClient = ReturnType<typeof startUserDeviceClient>;
