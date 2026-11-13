/**
 * Deployment switches for what the app shows. A host sets them in `config.js` next to the
 * build, so trimming the UI never needs a rebuild:
 *
 *   window.__BOTCAMP_UI__ = {
 *     hiddenSections: ["computer", "models", "billing"],
 *     apps: [{ name: "Mail", endpoint: "https://mail.example.com/mcp" }],
 *     oauthClients: ["https://api.githubcopilot.com/mcp"],
 *   };
 *
 * `oauthClients` names endpoints whose OAuth client the deployment registered in
 * `MCP_OAUTH_CLIENTS`; Connect then skips the client prompt.
 *
 * A deployment that lists `apps` shows only those in Integrations, opened by name rather
 * than found in a catalog, and hides the catalog, plugins and custom-source entries.
 */

/** One scope a user can grant an app; the label is the deployment's own wording. */
export type DeploymentAppScope = { label: string; scope: string };

/** An app this deployment offers, reachable only at this endpoint. */
export type DeploymentApp = {
  name: string;
  endpoint: string;
  /** Empty when the app takes no OAuth scope choice; the first entry is the default. */
  scopes: DeploymentAppScope[];
  /** The provider cannot register a client, so Connect asks for one first. */
  oauthClientRequired?: boolean;
};

declare global {
  interface Window {
    __BOTCAMP_UI__?: { hiddenSections?: string[]; apps?: unknown; oauthClients?: unknown };
    /** Previous name for `__BOTCAMP_UI__`, still read when the new one is unset or empty. */
    __RAKAZO_UI__?: { hiddenSections?: string[]; apps?: unknown; oauthClients?: unknown };
  }
}

/** RFC 6749 scope-tokens, space separated. Anything else would only break the request. */
const SCOPE_LIST = /^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/;

function hasEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function deploymentUi(): NonNullable<Window["__BOTCAMP_UI__"]> {
  if (typeof window === "undefined") return {};
  const next = window.__BOTCAMP_UI__;
  if (
    next &&
    (hasEntries(next.hiddenSections) || hasEntries(next.apps) || hasEntries(next.oauthClients))
  )
    return next;
  return window.__RAKAZO_UI__ ?? next ?? {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseEndpoint(value: unknown): string | undefined {
  const text = stringField(value);
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" && !url.username && !url.password && !url.hash
    ? url.href
    : undefined;
}

function parseScopes(value: unknown): DeploymentAppScope[] {
  if (!Array.isArray(value)) return [];
  const scopes: DeploymentAppScope[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const label = stringField(record.label);
    const scope = stringField(record.scope);
    if (label && scope && SCOPE_LIST.test(scope)) scopes.push({ label, scope });
  }
  return scopes;
}

/** The apps a deployment offers, in config order; malformed entries are dropped. */
export function parseDeploymentApps(value: unknown): DeploymentApp[] {
  if (!Array.isArray(value)) return [];
  const apps: DeploymentApp[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = stringField(record.name);
    const endpoint = parseEndpoint(record.endpoint);
    if (!name || !endpoint) continue;
    apps.push({
      name,
      endpoint,
      scopes: parseScopes(record.scopes),
      ...(record.oauthClientRequired === true ? { oauthClientRequired: true } : {}),
    });
  }
  return apps;
}

/** Endpoints whose OAuth client the deployment registered, so Connect does not ask for one. */
export function deploymentSuppliesOAuthClient(endpoint: string): boolean {
  const raw = deploymentUi().oauthClients;
  if (!Array.isArray(raw)) return false;
  return raw.some((value) => parseEndpoint(value) === endpoint);
}

export function deploymentApps(): readonly DeploymentApp[] {
  return parseDeploymentApps(deploymentUi().apps);
}

/**
 * The apps this build offers. A deployment may replace them in `config.js`, but the
 * product ships with its own apps, so nothing else can appear in Integrations.
 */
export const BUILTIN_APPS: readonly DeploymentApp[] = [
  {
    name: "QQ邮箱",
    endpoint: "https://api.mail.qq.com/mcp",
    scopes: [
      { label: "只读", scope: "alias:read mail:read" },
      { label: "可发信", scope: "alias:read mail:read mail:send" },
    ],
  },
  {
    name: "Notion",
    endpoint: "https://mcp.notion.com/mcp",
    scopes: [],
  },
  {
    name: "GitHub",
    endpoint: "https://api.githubcopilot.com/mcp",
    scopes: [],
    oauthClientRequired: true,
  },
];

export function offeredApps(): readonly DeploymentApp[] {
  const configured = deploymentApps();
  return configured.length > 0 ? configured : BUILTIN_APPS;
}

/** True when this deployment hides the section from the settings navigation. */
export function sectionHidden(id: string): boolean {
  return new Set(deploymentUi().hiddenSections ?? []).has(id);
}
