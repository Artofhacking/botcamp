import { randomBytes } from "node:crypto";
import type { TransactionalEmailProvider } from "@botcamp/adapter-kit";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@botcamp/core";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  sensitiveSessionMiddleware,
  sessionMiddleware,
} from "better-auth/api";
import { bearer } from "better-auth/plugins";
import { currentDirectoryProfile, isCurrentDirectoryAccount } from "./directory-login.js";
import type { EmailLocaleOf } from "./email.js";
import { accountDeletionEmail } from "./email.js";
import { isCurrentOidcAccount } from "./oidc.js";

export const oidcProofKey = (sessionId: string) => `oidc-reauth-${sessionId}`;

function passwordAuthDisabled() {
  return new APIError("FORBIDDEN", {
    message: "Password authentication is disabled",
    code: "PASSWORD_AUTH_DISABLED",
  });
}

export function accountSecurity(
  email: TransactionalEmailProvider | undefined,
  emailLocaleOf: EmailLocaleOf,
  ssoName?: string,
  ssoIssuer?: string,
  passwordChangeEnabled = true,
  directory?: { name: string; issuer: string },
): BetterAuthPlugin {
  return {
    id: "account-security",
    endpoints: {
      accountSecurity: createAuthEndpoint(
        "/account-security",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx) => {
          const credential = await ctx.context.internalAdapter.findCredentialAccount(
            ctx.context.session.user.id,
          );
          const proof = await ctx.context.internalAdapter.findVerificationValue(
            oidcProofKey(ctx.context.session.session.id),
          );
          const accounts = await ctx.context.internalAdapter.findAccounts(
            ctx.context.session.user.id,
          );
          const directoryProfile = (
            await Promise.all(
              accounts.map((account) =>
                currentDirectoryProfile(account, directory?.issuer, ctx.context.secretConfig),
              ),
            )
          ).find((profile) => profile !== null);
          return ctx.json({
            freshOidcAuth: Boolean(
              proof &&
                proof.value === ctx.context.session.user.id &&
                proof.expiresAt.getTime() > Date.now(),
            ),
            ssoLinked: (
              await Promise.all(
                accounts.map((account) =>
                  isCurrentOidcAccount(account, ssoIssuer, ctx.context.secretConfig),
                ),
              )
            ).some(Boolean),
            directoryLinked: (
              await Promise.all(
                accounts.map((account) =>
                  isCurrentDirectoryAccount(account, directory?.issuer, ctx.context.secretConfig),
                ),
              )
            ).some(Boolean),
            hasPassword: Boolean(credential?.password),
            passwordChangeEnabled,
            emailDeletion: Boolean(email),
            sso: ssoName ? { name: ssoName } : null,
            directory: directory
              ? { name: directory.name, profile: directoryProfile ?? null }
              : null,
          });
        },
      ),
      initialPassword: createAuthEndpoint(
        "/initial-password",
        { method: "POST", use: [sensitiveSessionMiddleware] },
        async (ctx) => {
          if (!passwordChangeEnabled) throw passwordAuthDisabled();
          const newPassword = typeof ctx.body?.newPassword === "string" ? ctx.body.newPassword : "";
          if (newPassword.length < MIN_PASSWORD_LENGTH) {
            throw new APIError("BAD_REQUEST", {
              message: "Password too short",
              code: "PASSWORD_TOO_SHORT",
            });
          }
          if (newPassword.length > MAX_PASSWORD_LENGTH) {
            throw new APIError("BAD_REQUEST", {
              message: "Password too long",
              code: "PASSWORD_TOO_LONG",
            });
          }
          const user = ctx.context.session.user;
          const account = await ctx.context.internalAdapter.findCredentialAccount(user.id);
          if (account?.password) {
            throw new APIError("BAD_REQUEST", {
              message: "User already has a password set",
              code: "PASSWORD_ALREADY_SET",
            });
          }
          const password = await ctx.context.password.hash(newPassword);
          if (!account) {
            await ctx.context.internalAdapter.linkAccount({
              userId: user.id,
              providerId: "credential",
              accountId: user.id,
              password,
            });
          } else {
            await ctx.context.internalAdapter.updateAccount(account.id, { password });
          }
          return ctx.json({ status: true });
        },
      ),
      unlinkDirectory: createAuthEndpoint(
        "/unlink-directory",
        { method: "POST", use: [sensitiveSessionMiddleware] },
        async (ctx) => {
          if (!passwordChangeEnabled) throw passwordAuthDisabled();
          const user = ctx.context.session.user;
          const credential = await ctx.context.internalAdapter.findCredentialAccount(user.id);
          if (!credential?.password) {
            throw new APIError("BAD_REQUEST", {
              message: "Set a password first",
              code: "PASSWORD_REQUIRED",
            });
          }
          const accounts = await ctx.context.internalAdapter.findAccounts(user.id);
          const linked = [];
          for (const account of accounts) {
            if (
              await isCurrentDirectoryAccount(account, directory?.issuer, ctx.context.secretConfig)
            ) {
              linked.push(account);
            }
          }
          if (!linked.length) {
            throw new APIError("BAD_REQUEST", {
              message: "Account not found",
              code: "ACCOUNT_NOT_FOUND",
            });
          }
          for (const account of linked) await ctx.context.internalAdapter.deleteAccount(account.id);
          return ctx.json({ status: true });
        },
      ),
      requestAccountDeletion: createAuthEndpoint(
        "/request-account-deletion",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const user = ctx.context.session.user;
          if (
            !email ||
            (await ctx.context.internalAdapter.findCredentialAccount(user.id))?.password
          ) {
            throw new APIError("BAD_REQUEST", {
              message: "Email deletion is not available",
              code: "EMAIL_DELETION_UNAVAILABLE",
            });
          }
          const token = randomBytes(16).toString("hex");
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: `delete-account-${token}`,
            value: user.id,
            expiresAt: new Date(Date.now() + 10 * 60_000),
          });
          const locale = await emailLocaleOf({ id: user.id }, ctx.headers);
          await email.send(await accountDeletionEmail(user.email, token, locale));
          return ctx.json({ success: true });
        },
      ),
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/delete-user" || ctx.path === "/delete-user/callback",
          handler: createAuthMiddleware(async (ctx) => {
            // Deletion codes are submitted through the CSRF-protected POST endpoint.
            // Never delete an account through a navigable GET callback.
            if (ctx.path === "/delete-user/callback") throw new APIError("FORBIDDEN");
            const session = await sessionForAuthHook(ctx);
            if (!session) throw new APIError("UNAUTHORIZED");
            const credential = await ctx.context.internalAdapter.findCredentialAccount(
              session.user.id,
            );
            if (credential?.password) {
              if (!ctx.body?.password) {
                throw new APIError("BAD_REQUEST", {
                  message: "Invalid password",
                  code: "INVALID_PASSWORD",
                });
              }
              return;
            }
            // Better Auth consumes and validates email deletion tokens against this user.
            if (ctx.body?.token) return;
            const proof = await ctx.context.internalAdapter.findVerificationValue(
              oidcProofKey(session.session.id),
            );
            if (
              !proof ||
              proof.value !== session.user.id ||
              proof.expiresAt.getTime() <= Date.now()
            ) {
              throw new APIError("FORBIDDEN", {
                code: "REAUTHENTICATION_REQUIRED",
                message: "Sign in again or use an email code to delete your account",
              });
            }
          }),
        },
      ],
    },
  };
}

/**
 * Session rows hold the raw token, so a raw bearer could be replayed from a database
 * copy. A bearer must carry the signature the session cookie has.
 */
export const signedBearer = bearer({ requireSignature: true });

/** Hook results are applied after all before hooks, so native bearer conversion is explicit here. */
export async function sessionForAuthHook(ctx: Parameters<typeof getSessionFromCtx>[0]) {
  const converted = await signedBearer.hooks.before[0]!.handler({ ...ctx, returnHeaders: false });
  return getSessionFromCtx(
    { ...ctx, headers: converted?.context.headers ?? ctx.headers },
    { disableCookieCache: true },
  );
}
