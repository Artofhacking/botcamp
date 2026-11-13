import { connect as tlsConnect } from "node:tls";
import { MAILBOX_AUTH_REJECTED, MAILBOX_UNREACHABLE } from "@botcamp/contracts";

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
  write(data: string | Uint8Array): void;
  readLine(): Promise<string>;
  /** The next `bytes` octets, used when a response announces an IMAP literal. */
  readExact(bytes: number): Promise<string>;
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

/** Sign in and leave the session open. The caller closes it. */
export async function loginMailbox(
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
}

/** Sign in and leave. The caller closes the session. */
export async function completeImapLogin(
  io: ImapLines,
  username: string,
  password: string,
): Promise<void> {
  await loginMailbox(io, username, password);
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

/** Buffer a TLS socket. Reads pull lines or literal octets on demand, so a literal is not split. */
export function imapLines(socket: ImapSocket): ImapLines {
  let buffer = Buffer.alloc(0);
  const lineWaiters: Array<(line: string) => void> = [];
  const exactWaiters: Array<{ bytes: number; resolve: (value: string) => void }> = [];
  let failed: Error | null = null;
  const fail = (error: Error) => {
    if (failed) return;
    failed = error;
    socket.destroy();
    while (lineWaiters.length) lineWaiters.shift()?.("");
    while (exactWaiters.length) exactWaiters.shift()?.resolve("");
  };
  const pump = () => {
    if (failed) return;
    const exact = exactWaiters[0];
    if (exact) {
      if (buffer.length < exact.bytes) return;
      exactWaiters.shift();
      const chunk = buffer.subarray(0, exact.bytes);
      buffer = buffer.subarray(exact.bytes);
      exact.resolve(Buffer.from(chunk).toString("utf8"));
      pump();
      return;
    }
    const index = buffer.indexOf(0x0a);
    const waiter = lineWaiters[0];
    if (!waiter || index === -1) return;
    lineWaiters.shift();
    const raw = buffer.subarray(0, index);
    buffer = buffer.subarray(index + 1);
    const end = raw.at(-1) === 0x0d ? raw.length - 1 : raw.length;
    waiter(raw.subarray(0, end).toString("utf8"));
    pump();
  };
  socket.on("data", (chunk: string | Buffer) => {
    const next = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    buffer = Buffer.concat([buffer, next]);
    pump();
  });
  socket.on("error", (error: Error) => fail(error));
  socket.on("end", () => fail(new Error("closed")));
  socket.on("close", () => fail(new Error("closed")));
  return {
    write(data) {
      socket.write(data);
    },
    readLine() {
      if (failed) return Promise.reject(failed);
      const index = buffer.indexOf(0x0a);
      if (exactWaiters.length === 0 && index !== -1) {
        const raw = buffer.subarray(0, index);
        buffer = buffer.subarray(index + 1);
        const end = raw.at(-1) === 0x0d ? raw.length - 1 : raw.length;
        return Promise.resolve(raw.subarray(0, end).toString("utf8"));
      }
      return new Promise((resolve, reject) => {
        lineWaiters.push((value) => {
          if (failed && !value) reject(failed);
          else resolve(value);
        });
        pump();
      });
    },
    readExact(bytes) {
      if (failed) return Promise.reject(failed);
      if (lineWaiters.length === 0 && buffer.length >= bytes) {
        const chunk = buffer.subarray(0, bytes);
        buffer = buffer.subarray(bytes);
        return Promise.resolve(Buffer.from(chunk).toString("utf8"));
      }
      return new Promise((resolve, reject) => {
        exactWaiters.push({
          bytes,
          resolve: (value) => {
            if (failed && !value) reject(failed);
            else resolve(value);
          },
        });
        pump();
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

export type MailboxSummary = {
  uid: string;
  from: string;
  subject: string;
  date: string;
  unread: boolean;
};

export type MailboxMessage = MailboxSummary & {
  to: string;
  text: string;
  truncated: boolean;
};

const LIST_LIMIT = 20;
const BODY_OCTETS = 16_000;

/** Read one tagged response, including `{n}` literals. */
async function readTagged(
  io: ImapLines,
  tag: string,
): Promise<{ line: string; untagged: string[] }> {
  const untagged: string[] = [];
  for (;;) {
    let line = await io.readLine();
    for (;;) {
      const literal = /\{(\d+)\}$/.exec(line);
      if (!literal) break;
      const data = await io.readExact(Number(literal[1]));
      const rest = await io.readLine();
      line = `${line}\r\n${data}\r\n${rest}`;
    }
    if (line.startsWith(`${tag} `)) return { line, untagged };
    untagged.push(line);
  }
}

async function imapCommand(
  io: ImapLines,
  tag: string,
  command: string,
): Promise<{ line: string; untagged: string[] }> {
  io.write(`${tag} ${command}\r\n`);
  const response = await readTagged(io, tag);
  if (!response.line.startsWith(`${tag} OK`)) throw new MailboxLoginError("unreachable");
  return response;
}

function decodeHeaderWords(value: string): string {
  const unfolded = value.replace(/\r?\n[ \t]+/g, " ").trim();
  return unfolded.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_all, _charset: string, encoding: string, data: string) => {
      try {
        if (encoding.toUpperCase() === "B") return Buffer.from(data, "base64").toString("utf8");
        const bytes = data
          .replace(/_/g, " ")
          .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
            String.fromCharCode(Number.parseInt(hex, 16)),
          );
        return Buffer.from(bytes, "binary").toString("utf8");
      } catch {
        return data;
      }
    },
  );
}

function headerValue(block: string, name: string): string {
  const match = new RegExp(
    `(?:^|\\r?\\n)${name}:[ \\t]*([^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*)`,
    "i",
  ).exec(block);
  return match?.[1] ? decodeHeaderWords(match[1]) : "";
}

function summaryFromFetch(block: string): MailboxSummary | null {
  const uid = /\bUID (\d+)/.exec(block)?.[1];
  if (!uid) return null;
  const flags = /\bFLAGS \(([^)]*)\)/i.exec(block)?.[1] ?? "";
  return {
    uid,
    from: headerValue(block, "From"),
    subject: headerValue(block, "Subject"),
    date: headerValue(block, "Date"),
    unread: !/\\Seen\b/i.test(flags),
  };
}

function searchUids(lines: string[]): string[] {
  const found = lines.find((line) => line.startsWith("* SEARCH"));
  if (!found) return [];
  return found
    .slice("* SEARCH".length)
    .trim()
    .split(/\s+/)
    .filter((uid) => /^[0-9]+$/.test(uid));
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 15;
  return Math.max(1, Math.min(LIST_LIMIT, Math.floor(limit ?? 15)));
}

async function useMailbox<T>(
  credentials: { address: string; authCode: string },
  run: (io: ImapLines) => Promise<T>,
  open: () => Promise<ImapLines>,
): Promise<T> {
  let io: ImapLines | undefined;
  try {
    io = await open();
    await loginMailbox(io, credentials.address, credentials.authCode);
    return await run(io);
  } catch (error) {
    if (error instanceof MailboxLoginError) throw error;
    throw new MailboxLoginError("unreachable");
  } finally {
    try {
      io?.write("Z9 LOGOUT\r\n");
    } catch {
      // The session is finished either way.
    }
    io?.close();
  }
}

async function newestSummaries(
  io: ImapLines,
  uids: string[],
  limit: number,
): Promise<MailboxSummary[]> {
  const selected = uids.slice(-limit);
  if (selected.length === 0) return [];
  const fetched = await imapCommand(
    io,
    "A5",
    `UID FETCH ${selected.join(",")} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`,
  );
  const byUid = new Map<string, MailboxSummary>();
  for (const line of fetched.untagged) {
    const summary = summaryFromFetch(line);
    if (summary) byUid.set(summary.uid, summary);
  }
  return selected
    .flatMap((uid) => {
      const summary = byUid.get(uid);
      return summary ? [summary] : [];
    })
    .reverse();
}

/** Latest inbox messages, newest first. */
export async function listMailboxMessages(
  credentials: { address: string; authCode: string },
  limit?: number,
  open: () => Promise<ImapLines> = openQqImap,
): Promise<MailboxSummary[]> {
  const count = clampLimit(limit);
  return useMailbox(
    credentials,
    async (io) => {
      await imapCommand(io, "A3", "SELECT INBOX");
      const searched = await imapCommand(io, "A4", "UID SEARCH ALL");
      return newestSummaries(io, searchUids(searched.untagged), count);
    },
    open,
  );
}

/** Inbox messages whose headers or body contain the query, newest first. */
export async function searchMailboxMessages(
  credentials: { address: string; authCode: string },
  query: string,
  limit?: number,
  open: () => Promise<ImapLines> = openQqImap,
): Promise<MailboxSummary[]> {
  const count = clampLimit(limit);
  const text = query.replace(/\r?\n/g, " ").trim().slice(0, 200);
  if (!text) return [];
  return useMailbox(
    credentials,
    async (io) => {
      await imapCommand(io, "A3", "SELECT INBOX");
      const bytes = Buffer.from(text, "utf8");
      io.write(`A4 UID SEARCH CHARSET UTF-8 TEXT {${bytes.length}}\r\n`);
      const cont = await io.readLine();
      if (!cont.startsWith("+")) throw new MailboxLoginError("unreachable");
      io.write(bytes);
      io.write("\r\n");
      const searched = await readTagged(io, "A4");
      if (!searched.line.startsWith("A4 OK")) throw new MailboxLoginError("unreachable");
      return newestSummaries(io, searchUids(searched.untagged), count);
    },
    open,
  );
}

/** One inbox message. `uid` is the mailbox's UID. */
export async function readMailboxMessage(
  credentials: { address: string; authCode: string },
  uid: string,
  open: () => Promise<ImapLines> = openQqImap,
): Promise<MailboxMessage | null> {
  if (!/^[0-9]{1,20}$/.test(uid)) return null;
  return useMailbox(
    credentials,
    async (io) => {
      await imapCommand(io, "A3", "SELECT INBOX");
      const fetched = await imapCommand(
        io,
        "A4",
        `UID FETCH ${uid} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)] BODY.PEEK[TEXT]<0.${BODY_OCTETS}>)`,
      );
      const block = fetched.untagged.find((line) => line.includes(`UID ${uid}`));
      const summary = block ? summaryFromFetch(block) : null;
      if (!summary || !block) return null;
      const body = /BODY\[TEXT\](?:<0>)? \{\d+\}\r\n([\s\S]*)\r\n\)\s*$/i.exec(block)?.[1] ?? "";
      return {
        ...summary,
        to: headerValue(block, "To"),
        text: body,
        truncated: Buffer.byteLength(body, "utf8") >= BODY_OCTETS,
      };
    },
    open,
  );
}
