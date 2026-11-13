/** The chat card for the built-in mailbox. It is not an entry in a connector catalog. */
export const MAILBOX_CONNECTOR_ID = "mailbox";
export const MAILBOX_PROVIDER = "mailbox";
export const MAILBOX_APP_NAME = "QQ邮箱";

const MAILBOX_APP_KEYS = new Set(["qq邮箱", "qqmail", "qqemail", "邮箱"]);

export function isMailboxAppName(value: string): boolean {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  return MAILBOX_APP_KEYS.has(key);
}

export function mailboxCanSend(scope: string): boolean {
  return scope.split(/\s+/).includes("mail:send");
}
