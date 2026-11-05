import { connect as tlsConnect } from "node:tls";
import { MAILBOX_AUTH_REJECTED, MAILBOX_UNREACHABLE } from "@rakazo/contracts";

const HOST = "imap.qq.com";
const PORT = 993;
const TIMEOUT_MS = 10_000;

export class MailboxLoginError extends Error {
  constructor(readonly reason: "rejected" | "unreachable") {
    super(reason === "rejected" ? MAILBOX_AUTH_REJECTED : MAILBOX_UNREACHABLE);
    this.name = "MailboxLoginError";
  }
}

/** A line-oriented session. Lines have no trailing CR LF. */
export type ImapLines = {
  write(data: string): void;
  readLine(): Promise<string>;
  close(): void;
};

function quoted(value: string): string {
  if (!/^[\x21-\x7E]+$/.test(value) || /["\\]/.test(value)) {
    throw new MailboxLoginError("rejected");
  }
  return `"${value}"`;
}

/** Read until the tagged response, skipping untagged lines. */
async function tagged(io: ImapLines, tag: string): Promise<string> {
  for (;;) {
    const line = await io.readLine();
    if (line.startsWith(`${tag} `)) return line;
  }
}

/** Sign in and leave. The caller closes the session. */
export async function completeImapLogin(
  io: ImapLines,
  username: string,
  password: string,
): Promise<void> {
  const greeting = await io.readLine();
  if (!greeting.startsWith("* OK") && !greeting.startsWith("* PREAUTH")) {
    throw new MailboxLoginError("unreachable");
  }
  io.write('A1 ID ("name" "BotCamp" "version" "1.0")\r\n');
  await tagged(io, "A1");
  io.write(`A2 LOGIN ${quoted(username)} ${quoted(password)}\r\n`);
  const result = await tagged(io, "A2");
  if (!result.startsWith("A2 OK")) throw new MailboxLoginError("rejected");
  io.write("A3 LOGOUT\r\n");
}

export function openQqImap(): Promise<ImapLines> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: HOST, port: PORT, servername: HOST });
    let settled = false;
    const timer = setTimeout(fail, TIMEOUT_MS);
    function fail() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new MailboxLoginError("unreachable"));
    }
    socket.once("secureConnect", () => {
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.setTimeout(TIMEOUT_MS, () => {
        socket.destroy(new Error("closed"));
      });
      resolve(imapLines(socket));
    });
    socket.on("error", fail);
  });
}

type ImapSocket = NodeJS.ReadableStream &
  NodeJS.WritableStream & {
    destroy(error?: Error): void;
  };

/** Buffer a TLS socket into lines. An error rejects every outstanding read. */
export function imapLines(socket: ImapSocket): ImapLines {
  let buffer = "";
  const queued: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let failed: Error | null = null;
  const take = (line: string) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else queued.push(line);
  };
  const fail = (error: Error) => {
    if (failed) return;
    failed = error;
    socket.destroy();
    while (waiters.length) waiters.shift()?.("");
  };
  socket.setEncoding?.("utf8");
  socket.on("data", (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      take(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
      index = buffer.indexOf("\n");
    }
  });
  socket.on("error", (error: Error) => fail(error));
  socket.on("end", () => fail(new Error("closed")));
  socket.on("close", () => fail(new Error("closed")));
  return {
    write(data) {
      socket.write(data);
    },
    readLine() {
      if (failed && queued.length === 0) return Promise.reject(failed);
      const line = queued.shift();
      if (line !== undefined) return Promise.resolve(line);
      return new Promise((resolve, reject) => {
        waiters.push((value) => {
          if (failed && !value) reject(failed);
          else resolve(value);
        });
      });
    },
    close() {
      socket.destroy();
    },
  };
}

/** Check the authorization code against the mailbox. Nothing is saved here. */
export async function probeMailboxLogin(
  input: { address: string; authCode: string },
  open: () => Promise<ImapLines> = openQqImap,
): Promise<void> {
  let io: ImapLines | undefined;
  try {
    io = await open();
    await completeImapLogin(io, input.address, input.authCode);
  } catch (error) {
    if (error instanceof MailboxLoginError) throw error;
    throw new MailboxLoginError("unreachable");
  } finally {
    io?.close();
  }
}
