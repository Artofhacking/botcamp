// @vitest-environment node
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startComputerRelayServer } from "./computer-relay.js";

const open: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

/** Stands in for the API relay endpoint: echoes what the computer sends. */
async function fakeApi() {
  const received: Array<{ id: string; key: string; host: string; port: string }> = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://relay");
    received.push({
      id: request.headers["x-computer-relay-id"] as string,
      key: request.headers["x-computer-relay-key"] as string,
      host: url.searchParams.get("host") ?? "",
      port: url.searchParams.get("port") ?? "",
    });
    response.writeHead(200, { "content-type": "application/octet-stream" });
    request.on("data", (chunk: Buffer) => response.write(chunk));
    request.on("end", () => response.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(() => new Promise<void>((done) => server.close(() => done())));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
  };
}

async function socksClient(port: number) {
  const socket = new Socket();
  socket.connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  open.push(() => {
    socket.destroy();
  });
  let buffered = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    wake?.();
    wake = undefined;
  });
  const read = async (bytes: number) => {
    while (buffered.length < bytes) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    const value = buffered.subarray(0, bytes);
    buffered = buffered.subarray(bytes);
    return value;
  };
  return { socket, read };
}

describe("computer relay SOCKS endpoint", () => {
  it("carries one SOCKS stream to the API relay with the computer's key", async () => {
    const api = await fakeApi();
    const relay = await startComputerRelayServer({ apiBase: api.url, port: 0 });
    open.push(() => relay.close());
    const { socket, read } = await socksClient(relay.port);

    socket.write(Buffer.from([5, 1, 2]));
    expect([...(await read(2))]).toEqual([5, 2]);
    const user = Buffer.from("home-1");
    const pass = Buffer.from("a".repeat(64));
    socket.write(
      Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]),
    );
    expect([...(await read(2))]).toEqual([1, 0]);

    const host = Buffer.from("example.com");
    socket.write(
      Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([0x01, 0xbb])]),
    );
    expect([...(await read(10))]).toEqual([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);

    socket.write(Buffer.from("hello"));
    expect((await read(5)).toString()).toBe("hello");
    expect(api.received[0]).toEqual({
      id: "home-1",
      key: "a".repeat(64),
      host: "example.com",
      port: "443",
    });
  });

  it("refuses a client that offers no credentials", async () => {
    const api = await fakeApi();
    const relay = await startComputerRelayServer({ apiBase: api.url, port: 0 });
    open.push(() => relay.close());
    const { socket, read } = await socksClient(relay.port);
    socket.write(Buffer.from([5, 1, 0]));
    expect([...(await read(2))]).toEqual([5, 0xff]);
  });
});
