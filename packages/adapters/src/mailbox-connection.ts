import type { SecretStore } from "@botcamp/adapter-kit";
import type { PrismaClient } from "@botcamp/db";

const KIND = "mailbox";

export type SavedMailbox = {
  address: string;
  authCode: string;
  scope: string;
};

function readStored(plaintext: string): SavedMailbox | null {
  try {
    const value: unknown = JSON.parse(plaintext);
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (typeof record.address !== "string" || typeof record.scope !== "string") return null;
    if (typeof record.authCode !== "string" || !record.authCode) return null;
    return { address: record.address, authCode: record.authCode, scope: record.scope };
  } catch {
    return null;
  }
}

/** The mailbox this person saved in this space, including the authorization code. */
export async function loadSavedMailbox(
  prisma: PrismaClient,
  secrets: SecretStore,
  owner: { userId: string; spaceId: string },
): Promise<SavedMailbox | null> {
  const row = await prisma.secret.findFirst({
    where: { userId: owner.userId, spaceId: owner.spaceId, kind: KIND },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;
  try {
    return readStored(await secrets.load(row.ciphertext, { recordId: row.id }));
  } catch {
    return null;
  }
}
