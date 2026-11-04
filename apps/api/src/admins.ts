import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "./router.js";

type AdminDeps = Pick<RouterDeps, "prisma"> & {
  env: Pick<RouterDeps["env"], "adminEmails" | "adminUserIds">;
};

/**
 * Operators are listed either by verified email (RAKAZO_ADMIN_EMAILS) or by user id
 * (RAKAZO_ADMIN_USER_IDS). The id list exists for deployments without mail delivery, where
 * no account can ever verify its address.
 */
export async function isAdmin(deps: AdminDeps, userId: string): Promise<boolean> {
  if ((deps.env.adminUserIds ?? []).includes(userId)) return true;
  const admins = deps.env.adminEmails ?? [];
  if (admins.length === 0) return false;
  const user = await deps.prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  return Boolean(user?.emailVerified && admins.includes(user.email.toLowerCase()));
}

export async function requireAdmin(deps: AdminDeps, userId: string): Promise<void> {
  if (!(await isAdmin(deps, userId))) throw new ORPCError("FORBIDDEN", { message: "Admins only" });
}
