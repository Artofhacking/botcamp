import { expect, it } from "vitest";
import { isNotionAppName, NOTION_APP_NAME, NOTION_MCP_ENDPOINT } from "./notion-app.js";

it("recognizes Notion and leaves other app names alone", () => {
  expect(NOTION_APP_NAME).toBe("Notion");
  expect(NOTION_MCP_ENDPOINT).toBe("https://mcp.notion.com/mcp");
  expect(isNotionAppName("Notion")).toBe(true);
  expect(isNotionAppName("notion.so")).toBe(true);
  expect(isNotionAppName(" QQ邮箱 ")).toBe(false);
  expect(isNotionAppName("note")).toBe(false);
});
