import { describe, expect, it } from "vitest";
import {
  desktopAppReturnUrl,
  parseDesktopDeepLink,
  sessionTokenFromSetCookie,
  ssoDesktopCallback,
} from "./desktop-link.js";

const nonce = "11111111-1111-4111-8111-111111111111";
const token = "session-token.signature";

describe("desktop deep links", () => {
  it("reads an SSO return and its session cookie", () => {
    const callback = ssoDesktopCallback(nonce, "https://app.example.test/app");
    const url = new URL(callback);
    url.searchParams.set("cookie", `better-auth.session_token=${token}; Path=/; HttpOnly`);
    expect(parseDesktopDeepLink(url.href)).toEqual({
      kind: "sso",
      nonce,
      returnTo: "https://app.example.test/app",
      token,
    });
  });

  it("rejects SSO links without a nonce or with a foreign scheme", () => {
    expect(parseDesktopDeepLink("https://app.example.test/sso")).toBeNull();
    expect(parseDesktopDeepLink("rakazo://sso?returnTo=https://app.example.test/app")).toBeNull();
    expect(parseDesktopDeepLink("rakazo://settings")).toBeNull();
    expect(
      parseDesktopDeepLink(
        `rakazo://sso?nonce=${nonce}&returnTo=javascript:alert(1)&cookie=better-auth.session_token=${token}`,
      ),
    ).toBeNull();
  });

  it("extracts only the session cookie", () => {
    expect(sessionTokenFromSetCookie(`__Secure-better-auth.session_token=${token}; Secure`)).toBe(
      token,
    );
    expect(sessionTokenFromSetCookie("other=1")).toBeNull();
  });

  it("builds the MCP and Slack handoff when a code is present", () => {
    const params = new URLSearchParams({ code: "ac", state: "st" });
    expect(desktopAppReturnUrl("mcp-oauth", params)).toBe("rakazo://mcp-oauth?state=st&code=ac");
    expect(parseDesktopDeepLink(desktopAppReturnUrl("slack-install", params)!)).toEqual({
      kind: "slack-install",
      state: "st",
      code: "ac",
    });
    expect(desktopAppReturnUrl("mcp-oauth", new URLSearchParams())).toBeNull();
  });
});
