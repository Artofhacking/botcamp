import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * An empty BOTCAMP_* name must still resolve to a non-empty RAKAZO_* value, and a non-empty
 * BOTCAMP_* value must win, with nothing appended. These assertions shell out to Compose itself.
 * Parsing the YAML only shows the expression, which is how a spare closing brace shipped.
 */

const composeDir = path.resolve(import.meta.dirname, "../../compose");
const FILES = ["docker-compose.prod.yml", "docker-compose.yml"] as const;

const REQUIRED = [
  "BOTCAMP_ADMIN_EMAILS",
  "BOTCAMP_ADMIN_USER_IDS",
  "BOTCAMP_QUOTA_TIME_ZONE",
  "BOTCAMP_LIVE_MODEL_CATALOG",
  "BOTCAMP_LOCAL_MODELS",
  "BOTCAMP_LOCAL_MODELS_URL",
  "BOTCAMP_LOCAL_VISION_MODELS",
  "BOTCAMP_LOCAL_REASONING_MODELS",
  "BOTCAMP_OPENAI_COMPATIBLE_VISION_MODELS",
  "BOTCAMP_NAV_LINKS",
  "BOTCAMP_FIXED_MONTHLY_YUAN",
  "BOTCAMP_DESKTOP_STACK_TOKEN",
] as const;

/** The spare `}` Compose kept on the end of a resolved value. Two closing braces is balanced. */
const BROKEN = /\$\{BOTCAMP_[A-Z0-9_]+:-\$\{RAKAZO_[A-Z0-9_]+-\}\}\}/;

const VALUELESS =
  /^[ \t]*(BOTCAMP_[A-Z0-9_]+):[ \t]*\$\{(BOTCAMP_[A-Z0-9_]+):-\$\{(RAKAZO_[A-Z0-9_]+)-\}\}$/gm;
const EMPTY_DEFAULT =
  /^[ \t]*(BOTCAMP_[A-Z0-9_]+):[ \t]*\$\{(BOTCAMP_[A-Z0-9_]+):-\$\{(RAKAZO_[A-Z0-9_]+):-\}\}$/gm;

const FIXTURES = [
  "POSTGRES_USER=rakazo",
  "POSTGRES_DB=rakazo",
  "POSTGRES_PASSWORD=fixture-owner-password",
  "POSTGRES_APP_PASSWORD=fixture-app-password",
  "SCREEN_PROXY_SECRET=fixture-screen-proxy-secret-000000",
  "SANDBOX_SUPERVISOR_TOKEN=fixture-supervisor-token",
] as const;

type Mode = "legacy" | "empty-new" | "new" | "unset";

interface FallbackKey {
  botcamp: string;
  rakazo: string;
}

interface RenderedService {
  environment?: Record<string, unknown> | string[];
}

interface RenderedCompose {
  services?: Record<string, RenderedService>;
}

function fallbackKeys(source: string): FallbackKey[] {
  const found = new Map<string, string>();
  const add = (declared: string, botcamp: string, rakazo: string) => {
    const sameSetting =
      declared === botcamp && botcamp.slice("BOTCAMP_".length) === rakazo.slice("RAKAZO_".length);
    if (!sameSetting) throw new Error(`fallback names disagree: ${declared} ${botcamp} ${rakazo}`);
    const previous = found.get(botcamp);
    if (previous !== undefined && previous !== rakazo) {
      throw new Error(`${botcamp} falls back to both ${previous} and ${rakazo}`);
    }
    found.set(botcamp, rakazo);
  };
  for (const pattern of [VALUELESS, EMPTY_DEFAULT]) {
    for (const match of source.matchAll(pattern)) {
      add(match[1] ?? "", match[2] ?? "", match[3] ?? "");
    }
  }
  return [...found.entries()].map(([botcamp, rakazo]) => ({ botcamp, rakazo }));
}

function token(kind: "legacy" | "new", name: string): string {
  return `${kind}-${name.slice("BOTCAMP_".length).toLowerCase().replaceAll("_", "-")}`;
}

function expectedValue(mode: Mode, name: string): string {
  if (mode === "new") return token("new", name);
  if (mode === "unset") return "";
  return token("legacy", name);
}

function writeEnv(directory: string, keys: readonly FallbackKey[], mode: Mode): string {
  const lines: string[] = [...FIXTURES];
  if (mode !== "unset") {
    for (const key of keys) {
      if (mode !== "legacy")
        lines.push(`${key.botcamp}=${mode === "new" ? token("new", key.botcamp) : ""}`);
      lines.push(`${key.rakazo}=${token("legacy", key.botcamp)}`);
    }
  }
  const file = path.join(directory, `${mode}.env`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/**
 * The parent shell overrides `--env-file`, and the test process pins other product settings.
 * Keep the login and the real home, and drop every name this render is trying to prove.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "USER",
    "LOGNAME",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_CERT_PATH",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

let composeCommand: { command: string; prefix: string[] } | undefined;

function composeBin(): { command: string; prefix: string[] } {
  if (composeCommand) return composeCommand;
  // This machine's `docker` CLI has no compose plugin. The standalone binary is Compose itself.
  if (spawnSync("docker-compose", ["version"], { encoding: "utf8" }).status === 0) {
    composeCommand = { command: "docker-compose", prefix: [] };
    return composeCommand;
  }
  if (spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0) {
    composeCommand = { command: "docker", prefix: ["compose"] };
    return composeCommand;
  }
  throw new Error("docker-compose config is required to render the shipped Compose files");
}

function render(composeFile: string, envFile: string): RenderedCompose {
  const { command, prefix } = composeBin();
  let stdout = "";
  try {
    stdout = execFileSync(
      command,
      [
        ...prefix,
        "--env-file",
        envFile,
        "--profile",
        "updater",
        "-f",
        composeFile,
        "config",
        "--format",
        "json",
      ],
      {
        cwd: path.dirname(composeFile),
        env: childEnv(),
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
    );
  } catch (error) {
    const failure = error as { stderr?: string | Buffer; message: string };
    const stderr =
      typeof failure.stderr === "string" ? failure.stderr : failure.stderr?.toString("utf8");
    throw new Error(stderr?.trim() || failure.message);
  }
  return JSON.parse(stdout) as RenderedCompose;
}

/** The verification run sets this to record the values just asserted. CI leaves it unset. */
function recordRendered(line: string) {
  const target = process.env.COMPOSE_CONFIG_LOG;
  if (target) appendFileSync(target, `${line}\n`);
}

function valuesFor(rendered: RenderedCompose, key: string): string[] {
  const values: string[] = [];
  for (const service of Object.values(rendered.services ?? {})) {
    const environment = service.environment;
    if (Array.isArray(environment)) {
      for (const entry of environment) {
        if (typeof entry !== "string") continue;
        const split = entry.indexOf("=");
        if (split === -1 || entry.slice(0, split) !== key) continue;
        values.push(entry.slice(split + 1));
      }
      continue;
    }
    if (!environment || typeof environment !== "object" || !(key in environment)) continue;
    const value = environment[key];
    if (typeof value !== "string") throw new Error(`${key} rendered as ${typeof value}`);
    values.push(value);
  }
  return values;
}

describe.each(FILES)("%s legacy fallback", (file) => {
  const composeFile = path.join(composeDir, file);
  const source = readFileSync(composeFile, "utf8");
  const keys = fallbackKeys(source);

  it("names every passed-through setting without a spare brace", () => {
    expect(source).not.toMatch(BROKEN);
    expect(keys.map((key) => key.botcamp)).toEqual(expect.arrayContaining([...REQUIRED]));
  });

  it.each(["legacy", "empty-new", "new", "unset"] as const)(
    "renders a %s value exactly",
    (mode) => {
      const directory = mkdtempSync(path.join(tmpdir(), "compose-fallback-"));
      try {
        const rendered = render(composeFile, writeEnv(directory, keys, mode));
        recordRendered(`## ${file} ${mode}`);
        for (const key of keys) {
          const values = valuesFor(rendered, key.botcamp);
          const expected = expectedValue(mode, key.botcamp);
          expect(values.length, key.botcamp).toBeGreaterThan(0);
          for (const value of values) {
            expect(value, key.botcamp).toBe(expected);
            expect(value.endsWith("}"), key.botcamp).toBe(false);
          }
          recordRendered(`${key.botcamp}: ${JSON.stringify(values)}`);
        }
        const appUrls = valuesFor(rendered, "DATABASE_URL");
        const migrationUrls = valuesFor(rendered, "DATABASE_MIGRATION_URL");
        for (const url of appUrls) {
          expect(url).toBe("postgres://botcamp_app:fixture-app-password@postgres:5432/rakazo");
          expect(url.endsWith("}")).toBe(false);
        }
        for (const url of migrationUrls) {
          expect(url).toBe("postgres://rakazo:fixture-owner-password@postgres:5432/rakazo");
        }
        expect(appUrls.length).toBeGreaterThan(0);
        expect(migrationUrls.length).toBeGreaterThan(0);
        recordRendered(`DATABASE_URL: ${JSON.stringify(appUrls)}`);
        recordRendered(`DATABASE_MIGRATION_URL: ${JSON.stringify(migrationUrls)}`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
