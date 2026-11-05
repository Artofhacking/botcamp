import { randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import { MailboxLoginError, probeMailboxLogin } from "@rakazo/adapters";
import type { Actor, MailboxSaveInput, MailboxStatus } from "@rakazo/contracts";
import { MAILBOX_DISCONNECTED, MAILBOX_UNREACHABLE } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

const KIND = "mailbox";

type MailboxDeps = {
  prisma: PrismaClient;
  secrets: SecretStore;
};

function secretContext(actor: Actor, id: string): AdapterContext {
  return {
    operationId: id,
    traceId: id,
    userId: actor.userId,
    spaceId: actor.spaceId,
    signal: new AbortController().signal,
  };
}

function owned(actor: Actor) {
  return { userId: actor.userId, spaceId: actor.spaceId, kind: KIND };
}

function readStored(plaintext: string): { address: string; scope: string } | null {
  try {
    const value: unknown = JSON.parse(plaintext);
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (typeof record.address !== "string" || typeof record.scope !== "string") return null;
    if (typeof record.authCode !== "string" || !record.authCode) return null;
    return { address: record.address, scope: record.scope };
  } catch {
    return null;
  }
}

export async function getMailbox(deps: MailboxDeps, actor: Actor): Promise<MailboxStatus> {
  const row = await deps.prisma.secret.findFirst({
    where: owned(actor),
    orderBy: { createdAt: "desc" },
  });
  if (!row) return MAILBOX_DISCONNECTED;
  try {
    const stored = readStored(await deps.secrets.load(row.ciphertext, { recordId: row.id }));
    return stored ? { connected: true, ...stored } : MAILBOX_DISCONNECTED;
  } catch {
    return MAILBOX_DISCONNECTED;
  }
}

export async function saveMailbox(
  deps: MailboxDeps,
  actor: Actor,
  input: MailboxSaveInput,
  probe: (credentials: { address: string; authCode: string }) => Promise<void> = probeMailboxLogin,
): Promise<MailboxStatus> {
  try {
    await probe({ address: input.address, authCode: input.authCode });
  } catch (error) {
    const message = error instanceof MailboxLoginError ? error.message : MAILBOX_UNREACHABLE;
    throw new ORPCError("BAD_REQUEST", { message });
  }
  const existing = await deps.prisma.secret.findFirst({
    where: owned(actor),
    orderBy: { createdAt: "desc" },
  });
  const id = existing?.id ?? randomBytes(12).toString("hex");
  const stored = await deps.secrets.put(
    JSON.stringify({
      address: input.address,
      authCode: input.authCode,
      scope: input.scope,
    }),
    secretContext(actor, id),
    { recordId: id },
  );
  if (existing) {
    await deps.prisma.secret.update({ where: { id }, data: { ciphertext: stored.ciphertext } });
  } else {
    await deps.prisma.secret.create({
      data: {
        id,
        userId: actor.userId,
        spaceId: actor.spaceId,
        kind: KIND,
        ciphertext: stored.ciphertext,
      },
    });
  }
  return { connected: true, address: input.address, scope: input.scope };
}

export async function removeMailbox(deps: MailboxDeps, actor: Actor): Promise<void> {
  await deps.prisma.secret.deleteMany({ where: owned(actor) });
}
