import { redactSecrets } from "@botcamp/core";
import { prepareDirectoryCliArgs, runDirectoryCli } from "./lark/directory-cli.js";
import type { RunContext } from "./run-context.js";
import type { ToolHandlers } from "./run-tool-gate.js";

/**
 * The tool description names the account the person connected, the way a connector's tools
 * name their app. That is what lets the model answer a request about messages or documents
 * with this tool instead of a separate instruction that special-cases the app.
 */
export function directoryToolDescription(
  name: "directory_read" | "directory_write",
  account: string,
): string {
  if (name === "directory_write") {
    return `Change the connected ${account} account. The person approves each call. argv is the command, for example ["im","+messages-send"] to send a message or ["calendar","+create"] to create an event. The call always runs as that person. A command the account still marks as needing its own confirmation is not confirmed for you.`;
  }
  return `Read the connected ${account} account: its messages and chats, documents, drive, calendar, mail, tasks, approvals, bases, sheets, slides, wiki, minutes, and contacts. argv is the command, for example ["im","+chat-list"] to list chats, ["im","+chat-messages-list"] with a chat id to read its messages, ["docs","+search"] to find documents, and ["calendar","+agenda"] for the calendar. A read uses a +command that gets, lists, searches, or reads, or api with GET. Anything that changes data is rejected.`;
}

const UNAVAILABLE = "The directory connector is not available for this run.";
const NOT_READ = "This command can change data. Use directory_write.";
const CONFIRMATION =
  "The directory refused to run this until it is confirmed. This connector does not confirm it.";

async function runDirectoryCommand(
  ctx: RunContext,
  args: Record<string, unknown>,
  effect: "read" | "write",
) {
  const name = effect === "read" ? "directory_read" : "directory_write";
  if (!ctx.tools.builtins.some((tool) => tool.name === name) || !ctx.deps.directory) {
    return { error: UNAVAILABLE };
  }
  if (!Array.isArray(args.argv) || args.argv.some((item) => typeof item !== "string")) {
    return { error: "Provide one directory command." };
  }
  const prepared = prepareDirectoryCliArgs(args.argv);
  if ("error" in prepared) return prepared;
  if (effect === "read" && prepared.effect !== "read") return { error: NOT_READ };
  const appName = ctx.deps.directory.name;
  const grant = await ctx.deps.directory.openGrant(ctx.run.userId);
  if ("error" in grant) {
    return {
      error:
        grant.error === "needs_consent"
          ? `The ${appName} connection needs to be signed in again. Ask the person to connect ${appName} under Connect apps.`
          : `The ${appName} connection could not refresh its sign-in. Try again.`,
    };
  }
  if (prepared.argv.some((arg) => arg.includes(grant.accessToken))) {
    return { error: "That directory command is not available." };
  }
  ctx.secrets.push(grant.accessToken);
  const result = await runDirectoryCli({
    appId: grant.appId,
    accessToken: grant.accessToken,
    brand: grant.brand,
    argv: prepared.argv,
    signal: ctx.abortController.signal,
  });
  if ("error" in result) return { error: redactSecrets(result.error, ctx.secrets) };
  const output = redactSecrets(result.output, ctx.secrets);
  return {
    exitCode: result.exitCode,
    output,
    ...(result.truncated ? { truncated: true } : {}),
    ...(result.exitCode === 10 ? { needsConfirmation: true, note: CONFIRMATION } : {}),
  };
}

export const directoryTools: ToolHandlers = {
  async directory_read(ctx, call) {
    return call.finish(await runDirectoryCommand(ctx, call.args, "read"));
  },
  async directory_write(ctx, call) {
    return call.finish(await runDirectoryCommand(ctx, call.args, "write"));
  },
};
