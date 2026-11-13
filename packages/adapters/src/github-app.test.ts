import { expect, it } from "vitest";
import { GITHUB_APP_NAME, GITHUB_MCP_ENDPOINT, isGithubAppName } from "./github-app.js";

it("recognizes GitHub and leaves other app names alone", () => {
  expect(GITHUB_APP_NAME).toBe("GitHub");
  expect(GITHUB_MCP_ENDPOINT).toBe("https://api.githubcopilot.com/mcp");
  expect(isGithubAppName("GitHub")).toBe(true);
  expect(isGithubAppName("github.com")).toBe(true);
  expect(isGithubAppName(" QQ邮箱 ")).toBe(false);
  expect(isGithubAppName("Notion")).toBe(false);
  expect(isGithubAppName("gist")).toBe(false);
});
