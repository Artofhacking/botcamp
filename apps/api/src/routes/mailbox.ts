import { getMailbox, removeMailbox, saveMailbox } from "../mailbox.js";
import type { RouterContext } from "./context.js";

export function mailboxRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    mailbox: {
      get: authed.mailbox.get.handler(async ({ context }) => getMailbox(deps, context.actor)),
      save: authed.mailbox.save.handler(async ({ context, input }) =>
        saveMailbox(deps, context.actor, input),
      ),
      remove: authed.mailbox.remove.handler(async ({ context }) => {
        await removeMailbox(deps, context.actor);
        return { ok: true as const };
      }),
    },
  };
}
