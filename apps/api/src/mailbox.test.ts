import type { SecretStore } from "@rakazo/adapter-kit";
import { MailboxLoginError } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { MAILBOX_AUTH_REJECTED } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { getMailbox, removeMailbox, saveMailbox } from "./mailbox.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};
const input = {
  address: "person@example.com",
  authCode: "abcdefghijklmnop",
  scope: "alias:read mail:read" as const,
};

function setup() {
  const rows = new Map<string, { id: string; ciphertext: string; createdAt: Date }>();
  const prisma = {
    secret: {
      findFirst: vi.fn(async () => [...rows.values()].at(-1) ?? null),
      create: vi.fn(async ({ data }: { data: { id: string; ciphertext: string } }) => {
        const row = { id: data.id, ciphertext: data.ciphertext, createdAt: new Date() };
        rows.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ data }: { data: { ciphertext: string } }) => {
        const row = [...rows.values()].at(-1);
        if (!row) throw new Error("missing");
        row.ciphertext = data.ciphertext;
        return row;
      }),
      deleteMany: vi.fn(async () => {
        const count = rows.size;
        rows.clear();
        return { count };
      }),
    },
  };
  const plaintext = new Map<string, string>();
  const put = vi.fn(async (value: string, _context: unknown, options?: { recordId?: string }) => {
    const id = options?.recordId ?? "secret-1";
    plaintext.set(id, value);
    return { id, ciphertext: `sealed:${id}`, ref: `sealed:${id}` };
  });
  const load = vi.fn(async (ciphertext: string) => {
    const id = ciphertext.replace("sealed:", "");
    const value = plaintext.get(id);
    if (!value) throw new Error("missing");
    return value;
  });
  const secrets = { put, load } as unknown as SecretStore;
  return { prisma, secrets, put, rows };
}

describe("saveMailbox", () => {
  it("stores the code only after the mailbox accepts it", async () => {
    const deps = setup();
    const probe = vi.fn(async () => undefined);
    const saved = await saveMailbox(
      deps as unknown as Parameters<typeof saveMailbox>[0],
      actor,
      input,
      probe,
    );
    expect(saved).toEqual({
      connected: true,
      address: input.address,
      scope: input.scope,
    });
    expect(probe).toHaveBeenCalledWith({ address: input.address, authCode: input.authCode });
    const stored = JSON.parse(String(deps.put.mock.calls[0]?.[0])) as { authCode: string };
    expect(stored.authCode).toBe(input.authCode);
    await expect(
      getMailbox(deps as unknown as Parameters<typeof getMailbox>[0], actor),
    ).resolves.toEqual(saved);
  });

  it("does not store a rejected code", async () => {
    const deps = setup();
    const probe = vi.fn(async () => {
      throw new MailboxLoginError("rejected");
    });
    await expect(
      saveMailbox(deps as unknown as Parameters<typeof saveMailbox>[0], actor, input, probe),
    ).rejects.toMatchObject({ message: MAILBOX_AUTH_REJECTED });
    expect(deps.put).not.toHaveBeenCalled();
    expect(deps.rows.size).toBe(0);
  });

  it("removes the saved mailbox", async () => {
    const deps = setup();
    await saveMailbox(
      deps as unknown as Parameters<typeof saveMailbox>[0],
      actor,
      input,
      async () => undefined,
    );
    await removeMailbox(deps as unknown as Parameters<typeof removeMailbox>[0], actor);
    await expect(
      getMailbox(deps as unknown as Parameters<typeof getMailbox>[0], actor),
    ).resolves.toEqual({
      connected: false,
      address: null,
      scope: null,
    });
  });
});
