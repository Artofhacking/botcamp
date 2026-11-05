import { describe, expect, it } from "vitest";
import type { ImapLines } from "./qq-imap.js";
import { completeImapLogin, MailboxLoginError, probeMailboxLogin } from "./qq-imap.js";

const CODE = "abcdefghijklmnop";

function script(lines: string[]): ImapLines & { sent: string[] } {
  const sent: string[] = [];
  const queue = [...lines];
  return {
    sent,
    write(data) {
      sent.push(data);
    },
    readLine() {
      const line = queue.shift();
      if (line === undefined) return Promise.reject(new Error("closed"));
      return Promise.resolve(line);
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
