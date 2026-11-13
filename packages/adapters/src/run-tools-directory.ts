import { redactSecrets } from "@botcamp/core";
import { prepareDirectoryCliArgs, runDirectoryCli } from "./lark/directory-cli.js";
import type { RunContext } from "./run-context.js";
import type { ToolHandlers } from "./run-tool-gate.js";

const UNAVAILABLE = "The directory connector is not available for this run.";
const NEEDS_CONSENT =
  "Sign in with the directory account again so this connector can act as that person.";
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
  const grant = await ctx.deps.directory.openGrant(ctx.run.userId);
  if ("error" in grant) {
    return {
      error:
        grant.error === "needs_consent"
          ? NEEDS_CONSENT
          : "The directory connector could not refresh its sign-in. Try again.",
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
