import * as z from "zod";

/** The grants this mailbox connection can store. */
export const MAILBOX_SCOPES = ["alias:read mail:read", "alias:read mail:read mail:send"] as const;
export type MailboxScope = (typeof MAILBOX_SCOPES)[number];

/** Shown when the mailbox rejects the authorization code. */
export const MAILBOX_AUTH_REJECTED = "Authorization code was rejected";
/** Shown when the mailbox cannot be reached. */
export const MAILBOX_UNREACHABLE = "Could not reach the mailbox";

const AUTH_CODE = /^[A-Za-z0-9]{16}$/;

/** The 16-character authorization code, ignoring spaces and dashes people copy with it. */
export function mailboxAuthCode(value: string): string | null {
  const code = value.replace(/[\s-]/g, "");
  return AUTH_CODE.test(code) ? code : null;
}

export const MailboxSaveInput = z.object({
  address: z.string().trim().toLowerCase().max(254).email(),
  authCode: z
    .string()
    .max(64)
    .transform((value) => value.replace(/[\s-]/g, ""))
    .refine((value) => AUTH_CODE.test(value), "Enter the 16-character authorization code"),
  scope: z.enum(MAILBOX_SCOPES),
});
export type MailboxSaveInput = z.output<typeof MailboxSaveInput>;

/** A saved mailbox, without the authorization code. */
export const MailboxStatusSchema = z.object({
  connected: z.boolean(),
  address: z.string().nullable(),
  scope: z.string().nullable(),
});
export type MailboxStatus = z.infer<typeof MailboxStatusSchema>;

export const MAILBOX_DISCONNECTED: MailboxStatus = {
  connected: false,
  address: null,
  scope: null,
};
