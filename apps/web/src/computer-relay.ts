import net from "node:net";
import { COMPUTER_RELAY_PATH } from "@botcamp/core/computer-relay";

export interface ComputerRelayServerOptions {
  /** The API origin that opens the stream through the user's desktop. */
  apiBase: string;
  /** The port computers reach; 0 binds a free one. */
  port?: number;
  log?: (message: string, detail?: unknown) => void;
}

/**
 * A SOCKS5 endpoint on the web service, which the supervisor joins to every computer's
 * isolated Docker network. A computer authenticates with the key derived for it; the API
 * checks it and routes the stream through the owner's desktop. When that computer's owner has
 * the switch off, the web service connects directly, so a computer keeps its normal egress.
 */
export function startComputerRelayServer(options: ComputerRelayServerOptions) {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    void handle(socket, options).catch((error) => {
      options.log?.("computer relay failed", { error });
      socket.destroy();
    });
  });
  server.on("error", (error) => options.log?.("computer relay listener failed", { error }));
  return new Promise<{ close(): Promise<void>; port: number }>((resolve) => {
    server.listen(options.port ?? 1080, "0.0.0.0", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : (options.port ?? 1080),
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

const GREETING_REPLY = Buffer.from([5, 2]);
const NO_METHOD_REPLY = Buffer.from([5, 0xff]);
const AUTH_OK = Buffer.from([1, 0]);
const GRANTED = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);

interface Reader {
  read(bytes: number): Promise<Buffer | null>;
  leftover(): Buffer;
  /** Stops the handshake reader; later bytes belong to the relayed stream. */
  detach(): void;
}

function reader(socket: net.Socket): Reader {
  let buffer = Buffer.alloc(0);
  let closed = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    notify();
  };
  const onGone = () => {
    closed = true;
    notify();
  };
  socket.on("data", onData);
  socket.on("end", onGone);
  socket.on("close", onGone);
  socket.on("error", onGone);
  return {
    async read(bytes) {
      while (buffer.length < bytes) {
        if (closed || socket.destroyed) return null;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const value = buffer.subarray(0, bytes);
      buffer = buffer.subarray(bytes);
      return value;
    },
    leftover() {
      return buffer;
    },
    detach() {
      socket.off("data", onData);
      socket.off("end", onGone);
      socket.off("close", onGone);
      socket.off("error", onGone);
    },
  };
}

async function handle(socket: net.Socket, options: ComputerRelayServerOptions) {
  const input = reader(socket);
  const greeting = await input.read(2);
  if (!greeting || greeting[0] !== 5) return socket.destroy();
  const methods = await input.read(greeting[1] ?? 0);
  if (!methods) return socket.destroy();
  // Username and password carry the computer's identity; no-auth would be an open proxy.
  if (!methods.includes(2)) return socket.end(NO_METHOD_REPLY);
  socket.write(GREETING_REPLY);

  const auth = await input.read(2);
  if (!auth || auth[0] !== 1) return socket.destroy();
  const username = await input.read(auth[1] ?? 0);
  const passwordLength = await input.read(1);
  if (!username || !passwordLength) return socket.destroy();
  const password = await input.read(passwordLength[0] ?? 0);
  if (!password) return socket.destroy();
  socket.write(AUTH_OK);

  const request = await input.read(4);
  if (!request || request[0] !== 5 || request[1] !== 1) return socket.destroy();
  let host: string;
  if (request[3] === 1) {
    const raw = await input.read(4);
    if (!raw) return socket.destroy();
    host = [...raw].join(".");
  } else if (request[3] === 4) {
    const raw = await input.read(16);
    if (!raw) return socket.destroy();
    const groups: string[] = [];
    for (let offset = 0; offset < 16; offset += 2)
      groups.push(raw.readUInt16BE(offset).toString(16));
    host = groups.join(":");
  } else if (request[3] === 3) {
    const length = await input.read(1);
    const raw = length ? await input.read(length[0] ?? 0) : null;
    if (!raw || raw.length === 0) return socket.destroy();
    host = raw.toString("utf8");
  } else {
    return socket.destroy();
  }
  const portBytes = await input.read(2);
  if (!portBytes) return socket.destroy();
  const port = portBytes.readUInt16BE(0);
  const pending = input.leftover();
  input.detach();
  socket.pause();

  const endpoint = new URL(COMPUTER_RELAY_PATH, options.apiBase);
  endpoint.searchParams.set("host", host);
  endpoint.searchParams.set("port", String(port));
  // Answer before the API replies: its stream starts when the target does, and the client
  // waits for this answer before sending anything the target would answer.
  if (!socket.write(GRANTED)) await drain(socket);
  const upstream = requestBody(socket, pending);
  const abort = new AbortController();
  socket.once("close", () => abort.abort());
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-computer-relay-id": username.toString("utf8"),
        "x-computer-relay-key": password.toString("utf8"),
        "content-type": "application/octet-stream",
      },
      body: upstream.body,
      duplex: "half",
      redirect: "error",
      signal: abort.signal,
    } as RequestInit);
  } catch {
    upstream.stop();
    return socket.destroy();
  }
  if (response.status === 409) {
    // The owner has the switch off: keep the computer's ordinary egress.
    await response.body?.cancel();
    upstream.stop();
    return direct(socket, host, port, true);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    upstream.stop();
    return socket.end();
  }
  const relayed = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await relayed.read();
      if (done) break;
      if (value && !socket.write(value)) await drain(socket);
    }
  } catch {
    /* The desktop or the target ended the stream. */
  } finally {
    await relayed.cancel().catch(() => undefined);
    socket.end();
  }
}

/** The client's bytes after the handshake, streamed into the API request body. */
function requestBody(socket: net.Socket, pending: Buffer) {
  let paused = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    try {
      controller?.close();
    } catch {
      /* Already closed. */
    }
  };
  const onData = (chunk: Buffer) => {
    if (closed || !controller) return;
    controller.enqueue(chunk);
    if (controller.desiredSize !== null && controller.desiredSize <= 0) {
      paused = true;
      socket.pause();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      if (pending.length) value.enqueue(pending);
      socket.on("data", onData);
      socket.on("end", done);
      socket.on("close", done);
      socket.on("error", done);
      socket.resume();
    },
    pull() {
      if (!paused) return;
      paused = false;
      socket.resume();
    },
    cancel() {
      socket.destroy();
    },
  });
  return {
    body,
    /** Stops feeding this stream and lets the same socket be used for a direct connection. */
    stop() {
      done();
      socket.off("data", onData);
      socket.off("end", done);
      socket.off("close", done);
      socket.off("error", done);
    },
  };
}

function direct(socket: net.Socket, host: string, port: number, granted = false) {
  const target = net.connect({ host, port });
  target.once("connect", () => {
    if (!granted) socket.write(GRANTED);
    socket.pipe(target);
    target.pipe(socket);
  });
  target.once("error", () => socket.destroy());
  socket.on("close", () => target.destroy());
  socket.on("error", () => target.destroy());
  socket.resume();
}

function drain(socket: net.Socket) {
  return new Promise<void>((resolve) => {
    socket.once("drain", resolve);
    socket.once("close", resolve);
    socket.once("error", resolve);
  });
}
