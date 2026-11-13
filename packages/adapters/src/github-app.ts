/** GitHub's hosted remote MCP. Connecting it is an account sign-in, not a catalog app. */
export const GITHUB_APP_NAME = "GitHub";
export const GITHUB_MCP_ENDPOINT = "https://api.githubcopilot.com/mcp";

const GITHUB_APP_KEYS = new Set(["github", "githubcom"]);

export function isGithubAppName(value: string): boolean {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s_.-]+/g, "");
  return GITHUB_APP_KEYS.has(key);
}
