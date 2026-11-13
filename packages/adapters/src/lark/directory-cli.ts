/**
 * Runs the directory command line as the signed-in person.
 * The child receives the application id and the user access token only.
 * The application secret stays in the process that refreshes the token.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIRECTORY_CLI_DOMAINS } from "./directory-cli-scopes.js";

const COMMAND = "lark-cli";
const OUTPUT_LIMIT = 60_000;
const TIMEOUT_MS = 45_000;

const BLOCKED_COMMANDS = new Set([
  "auth",
  "config",
  "update",
  "install",
  "profile",
  "doctor",
  "skill",
  "logout",
  "login",
  "completion",
]);

const SECRET_FLAGS = new Set([
  "--client-secret",
  "--app-secret",
  "--app-id",
  "--user-access-token",
  "--access-token",
  "--refresh-token",
  "--config",
  "--config-dir",
]);

const WRITE_VERB =
  /(send|create|update|delete|write|post|put|patch|add|remove|move|copy|upload|import|reply|recall|modify|grant|revoke|invite|join|transfer|approve|reject|submit|publish|set|enable|disable|insert|append|overwrite|replace)/i;
const READ_VERB =
  /(get|list|search|read|query|find|view|show|agenda|export|download|status|info|meta|preview|transcript|freebusy|retrieve|fetch)/i;

const DOMAINS = new Set<string>([...DIRECTORY_CLI_DOMAINS, "api"]);

export type DirectoryCliEffect = "read" | "write";

/** Checks a command and forces it to run as the signed-in person. */
export function prepareDirectoryCliArgs(
  argv: readonly string[],
): { argv: string[]; effect: DirectoryCliEffect } | { error: string } {
  if (argv.length < 1 || argv.length > 16) return { error: "Provide one directory command." };
  const args: string[] = [];
  for (const value of argv) {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 4_000 ||
      /[\r\n\0]/.test(value)
    ) {
      return { error: "A directory command argument is not valid." };
    }
    args.push(value);
  }
  const command = args[0] ?? "";
  if (!DOMAINS.has(command) || BLOCKED_COMMANDS.has(command)) {
    return { error: "That directory command is not available." };
  }
  let identity: "user" | "other" | "missing" = "missing";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (SECRET_FLAGS.has(flag)) {
      return { error: "That directory command is not available." };
    }
    if (arg === "--as") {
      const value = args[index + 1];
      identity = value === "user" ? "user" : "other";
      index += 1;
      continue;
    }
    if (arg.startsWith("--as=")) identity = arg === "--as=user" ? "user" : "other";
  }
  if (identity === "other")
    return { error: "The directory command runs only as the signed-in person." };
  if (identity === "missing") args.push("--as", "user");
  return { argv: args, effect: commandEffect(args) };
}

function commandEffect(args: readonly string[]): DirectoryCliEffect {
  if (args[0] === "api") {
    const method = (args[1] ?? "").toUpperCase();
    if (method !== "GET" && method !== "HEAD") return "write";
    if (args.some((arg) => ["--data", "--data-raw", "-d", "--body", "--form"].includes(arg))) {
      return "write";
    }
    return "read";
  }
  let sawRead = false;
  for (const arg of args) {
    if (!arg.startsWith("+") || arg.length < 2) continue;
    const verb = arg.slice(1);
    if (WRITE_VERB.test(verb)) return "write";
    if (READ_VERB.test(verb)) sawRead = true;
    else return "write";
  }
  return sawRead ? "read" : "write";
}

export async function runDirectoryCli(input: {
  appId: string;
  accessToken: string;
  brand: "feishu" | "lark";
  argv: readonly string[];
  signal?: AbortSignal;
}): Promise<{ exitCode: number; output: string; truncated: boolean } | { error: string }> {
  const home = await mkdtemp(join(tmpdir(), "directory-cli-"));
  const configDir = join(home, "config");
  try {
    await mkdir(configDir, { recursive: true });
    return await spawnCli(input, home, configDir);
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}

function spawnCli(
  input: {
    appId: string;
    accessToken: string;
    brand: "feishu" | "lark";
    argv: readonly string[];
    signal?: AbortSignal;
  },
  home: string,
  configDir: string,
): Promise<{ exitCode: number; output: string; truncated: boolean } | { error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      result: { exitCode: number; output: string; truncated: boolean } | { error: string },
    ) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(COMMAND, input.argv, {
      cwd: home,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        TMPDIR: home,
        LANG: "C.UTF-8",
        LARKSUITE_CLI_APP_ID: input.appId,
        LARKSUITE_CLI_USER_ACCESS_TOKEN: input.accessToken,
        LARKSUITE_CLI_BRAND: input.brand,
        LARKSUITE_CLI_CONFIG_DIR: configDir,
        LARKSUITE_CLI_FORCE_LOCAL: "1",
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const take = (chunk: Buffer) => {
      if (size >= OUTPUT_LIMIT) {
        truncated = true;
        return;
      }
      const room = OUTPUT_LIMIT - size;
      chunks.push(chunk.subarray(0, room));
      size += Math.min(chunk.length, room);
      if (chunk.length > room) truncated = true;
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ error: "The directory command timed out." });
    }, TIMEOUT_MS);
    timer.unref?.();
    const onAbort = () => child.kill("SIGKILL");
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      finish({
        error:
          error.code === "ENOENT"
            ? "The directory command line is not installed on this server."
            : "The directory command could not start.",
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      if (input.signal?.aborted) {
        finish({ error: "The directory command was cancelled." });
        return;
      }
      finish({
        exitCode: code ?? 1,
        output: Buffer.concat(chunks).toString("utf8"),
        truncated,
      });
    });
  });
}
