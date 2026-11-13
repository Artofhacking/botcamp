/** Notion's hosted remote MCP. Connecting it is a workspace sign-in, not a catalog app. */
export const NOTION_APP_NAME = "Notion";
export const NOTION_MCP_ENDPOINT = "https://mcp.notion.com/mcp";

const NOTION_APP_KEYS = new Set(["notion", "notionso"]);

export function isNotionAppName(value: string): boolean {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s_.-]+/g, "");
  return NOTION_APP_KEYS.has(key);
}
