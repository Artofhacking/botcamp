import { describe, expect, it } from "vitest";
import { mcpOAuthRedirectUri } from "./mcp-connect";

describe("mcpOAuthRedirectUri", () => {
  it("uses the origin callback the server allows", () => {
    expect(mcpOAuthRedirectUri("https://botcamp.example")).toBe(
      "https://botcamp.example/mcp/oauth/callback",
    );
  });
});
