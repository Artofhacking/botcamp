import { connect as tlsConnect } from "node:tls";
import { MailboxLoginError } from "./qq-imap.js";

const HOST = "smtp.qq.com";
const PORT = 465;
const TIMEOUT_MS = 15_000;

type SmtpLines = {
  write(data: string): void;
  readLine(): Promise<string>;
  close(): void;
};

function openQqSmtp(): Promise<SmtpLines> {
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
      socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error("closed")));
      socket.setEncoding("utf8");
      let buffer = "";
      const queued: string[] = [];
      const waiters: Array<(line: string) => void> = [];
      let failed: Error | null = null;
      const failSocket = (error: Error) => {
        if (failed) return;
        failed = error;
        socket.destroy();
        while (waiters.length) waiters.shift()?.("");
      };
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf("\n");
        while (index !== -1) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
          const waiter = waiters.shift();
          if (waiter) waiter(line);
          else queued.push(line);
          index = buffer.indexOf("\n");
        }
      });
      socket.on("error", failSocket);
      socket.on("end", () => failSocket(new Error("closed")));
      socket.on("close", () => failSocket(new Error("closed")));
      resolve({
        write(data) {
          socket.write(data);
        },
        readLine() {
          if (failed && queued.length === 0) return Promise.reject(failed);
          const line = queued.shift();
          if (line !== undefined) return Promise.resolve(line);
          return new Promise((resolveLine, rejectLine) => {
            waiters.push((value) => {
              if (failed && !value) rejectLine(failed);
              else resolveLine(value);
            });
          });
        },
        close() {
          socket.destroy();
        },
      });
    });
    socket.on("error", fail);
  });
}

async function smtpReply(io: SmtpLines, code: string): Promise<void> {
  let line = "";
  do {
    line = await io.readLine();
  } while (line.startsWith(`${code[0]}`) && line[3] === "-");
  if (!line.startsWith(code)) throw new MailboxLoginError(code === "235" ? "rejected" : "unreachable");
}

function headerValue(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
}

/** Send one plain-text message. The caller already checked that sending is allowed. */
export async function sendMailboxMessage(
  input: { address: string; authCode: string; to: string; subject: string; text: string },
  open: () => Promise<SmtpLines> = openQqSmtp,
): Promise<void> {
  let io: SmtpLines | undefined;
  try {
    io = await open();
    await smtpReply(io, "220");
    io.write("EHLO botcamp\r\n");
    await smtpReply(io, "250");
    io.write("AUTH LOGIN\r\n");
    await smtpReply(io, "334");
    io.write(`${Buffer.from(input.address, "utf8").toString("base64")}\r\n`);
    await smtpReply(io, "334");
    io.write(`${Buffer.from(input.authCode, "utf8").toString("base64")}\r\n`);
    await smtpReply(io, "235");
    io.write(`MAIL FROM:<${input.address}>\r\n`);
    await smtpReply(io, "250");
    io.write(`RCPT TO:<${input.to}>\r\n`);
    await smtpReply(io, "250");
    io.write("DATA\r\n");
    await smtpReply(io, "354");
    const body = input.text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    io.write(
      `From: ${input.address}\r\nTo: ${input.to}\r\nSubject: ${headerValue(input.subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}\r\n.\r\n`,
    );
    await smtpReply(io, "250");
    io.write("QUIT\r\n");
  } catch (error) {
    if (error instanceof MailboxLoginError) throw error;
    throw new MailboxLoginError("unreachable");
  } finally {
    io?.close();
  }
}
