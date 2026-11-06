import { describe, expect, it } from "vitest";
import type { ImapLines } from "./qq-imap.js";
import {
  completeImapLogin,
  listMailboxMessages,
  MailboxLoginError,
  probeMailboxLogin,
  readMailboxMessage,
  searchMailboxMessages,
} from "./qq-imap.js";

const CODE = "abcdefghijklmnop";

function script(lines: string[]): ImapLines & { sent: string[] } {
  const sent: string[] = [];
  const queue = [...lines];
  return {
    sent,
    write(data) {
      sent.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    },
    readLine() {
      const line = queue.shift();
      if (line === undefined) return Promise.reject(new Error("closed"));
      return Promise.resolve(line);
    },
    readExact() {
      return Promise.reject(new Error("closed"));
    },
    close() {},
  };
}

describe("completeImapLogin", () => {
  it("signs in and logs out when the mailbox accepts the code", async () => {
    const io = script(["* OK ready", "* ID NIL", "A1 OK ID", "A2 OK [CAPABILITY IMAP4] LOGIN"]);
    await completeImapLogin(io, "person@example.com", CODE);
    expect(io.sent[1]).toBe(`A2 LOGIN "person@example.com" "${CODE}"\r\n`);
    expect(io.sent[2]).toBe("A3 LOGOUT\r\n");
  });

  it("rejects a refused code", async () => {
    const io = script(["* OK ready", "A1 OK ID", "A2 NO Login fail"]);
    await expect(completeImapLogin(io, "person@example.com", CODE)).rejects.toMatchObject({
      reason: "rejected",
    });
  });

  it("reports a missing greeting as unreachable", async () => {
    const io = script(["* BYE"]);
    await expect(completeImapLogin(io, "person@example.com", CODE)).rejects.toBeInstanceOf(
      MailboxLoginError,
    );
  });
});

describe("probeMailboxLogin", () => {
  it("reports a dropped connection as unreachable", async () => {
    await expect(
      probeMailboxLogin({ address: "person@example.com", authCode: CODE }, async () => {
        throw new Error("closed");
      }),
    ).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("closes the session after a refusal", async () => {
    let closed = false;
    const io = script(["* OK ready", "A1 OK ID", "A2 NO Login fail"]);
    const close = io.close;
    io.close = () => {
      closed = true;
      close();
    };
    await expect(
      probeMailboxLogin({ address: "person@example.com", authCode: CODE }, async () => io),
    ).rejects.toMatchObject({ reason: "rejected" });
    expect(closed).toBe(true);
  });
});

type Step = { line: string } | { exact: string };

function playback(steps: Step[]): ImapLines & { sent: string[] } {
  const sent: string[] = [];
  const queue = [...steps];
  return {
    sent,
    write(data) {
      sent.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    },
    readLine() {
      const step = queue.shift();
      if (!step || !("line" in step)) return Promise.reject(new Error("closed"));
      return Promise.resolve(step.line);
    },
    readExact(bytes) {
      const step = queue.shift();
      if (!step || !("exact" in step) || Buffer.byteLength(step.exact) !== bytes) {
        return Promise.reject(new Error(`exact ${bytes}`));
      }
      return Promise.resolve(step.exact);
    },
    close() {},
  };
}

function signedIn(rest: Step[]): Step[] {
  return [{ line: "* OK ready" }, { line: "A1 OK ID" }, { line: "A2 OK LOGIN" }, ...rest];
}

const header =
  "From: Ada <ada@example.com>\r\nSubject: =?UTF-8?B?5L2g5aW9?=\r\nDate: Tue, 1 Jan 2024 00:00:00 +0000\r\n\r\n";

describe("mailbox session", () => {
  it("reads a header literal and lists the newest message first", async () => {
    const io = playback(
      signedIn([
        { line: "A3 OK SELECT" },
        { line: "* SEARCH 8" },
        { line: "A4 OK SEARCH" },
        {
          line: `* 1 FETCH (UID 8 FLAGS () BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${Buffer.byteLength(header)}}`,
        },
        { exact: header },
        { line: ")" },
        { line: "A5 OK FETCH" },
      ]),
    );
    const messages = await listMailboxMessages(
      { address: "person@example.com", authCode: CODE },
      undefined,
      async () => io,
    );
    expect(messages).toEqual([
      {
        uid: "8",
        from: "Ada <ada@example.com>",
        subject: "你好",
        date: "Tue, 1 Jan 2024 00:00:00 +0000",
        unread: true,
      },
    ]);
    expect(io.sent.at(-1)).toBe("Z9 LOGOUT\r\n");
  });

  it("sends a Chinese search as a byte literal after the continuation", async () => {
    const query = "你好";
    const io = playback(
      signedIn([
        { line: "A3 OK SELECT" },
        { line: "+ go" },
        { line: "* SEARCH 8" },
        { line: "A4 OK SEARCH" },
        {
          line: `* 1 FETCH (UID 8 FLAGS (\\Seen) BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${Buffer.byteLength(header)}}`,
        },
        { exact: header },
        { line: ")" },
        { line: "A5 OK FETCH" },
      ]),
    );
    const messages = await searchMailboxMessages(
      { address: "person@example.com", authCode: CODE },
      query,
      undefined,
      async () => io,
    );
    expect(io.sent).toContain(`A4 UID SEARCH CHARSET UTF-8 TEXT {${Buffer.byteLength(query)}}\r\n`);
    expect(Buffer.byteLength(query)).toBe(6);
    expect(io.sent).toContain(query);
    expect(io.sent.join("")).not.toContain(`TEXT "${query}"`);
    expect(messages[0]?.subject).toBe("你好");
  });

  it("stops when the mailbox refuses the search literal", async () => {
    const io = playback(signedIn([{ line: "A3 OK SELECT" }, { line: "A4 BAD" }]));
    await expect(
      searchMailboxMessages(
        { address: "person@example.com", authCode: CODE },
        "你好",
        undefined,
        async () => io,
      ),
    ).rejects.toMatchObject({ reason: "unreachable" });
    expect(io.sent.join("")).not.toContain("你好");
  });

  it("reads a message body from its own literal", async () => {
    const readHeader =
      "From: Ada <ada@example.com>\r\nTo: Bo <bo@example.com>\r\nSubject: =?UTF-8?B?5L2g5aW9?=\r\nDate: Tue, 1 Jan 2024 00:00:00 +0000\r\n\r\n";
    const body = "你好\nnext";
    const io = playback(
      signedIn([
        { line: "A3 OK SELECT" },
        {
          line: `* 1 FETCH (UID 8 FLAGS (\\Seen) BODY[HEADER.FIELDS (FROM TO SUBJECT DATE)] {${Buffer.byteLength(readHeader)}}`,
        },
        { exact: readHeader },
        { line: ` BODY[TEXT]<0> {${Buffer.byteLength(body)}}` },
        { exact: body },
        { line: ")" },
        { line: "A4 OK FETCH" },
      ]),
    );
    const message = await readMailboxMessage(
      { address: "person@example.com", authCode: CODE },
      "8",
      async () => io,
    );
    expect(message).toMatchObject({
      uid: "8",
      to: "Bo <bo@example.com>",
      subject: "你好",
      text: body,
      truncated: false,
      unread: false,
    });
  });
});
