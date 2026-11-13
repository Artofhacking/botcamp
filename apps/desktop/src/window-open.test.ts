import { describe, expect, it, vi } from "vitest";
import {
  oauthPopupSessionPreferences,
  openInSystemBrowser,
  shouldOpenInAppPopup,
  systemBrowserUrl,
} from "./window-open.js";

const appOrigin = "https://rakazo.example.com";

describe("desktop child windows", () => {
  it("sends app routes and outside links to the system browser", () => {
    expect(systemBrowserUrl(`${appOrigin}/mcp/oauth/callback`)).toBe(
      `${appOrigin}/mcp/oauth/callback`,
    );
    expect(systemBrowserUrl(`${appOrigin}/console/`)).toBe(`${appOrigin}/console/`);
    expect(systemBrowserUrl(`${appOrigin}/`)).toBe(`${appOrigin}/`);
    expect(systemBrowserUrl("https://github.com/artofhacking/botcamp/pull/395")).toBe(
      "https://github.com/artofhacking/botcamp/pull/395",
    );
    expect(systemBrowserUrl("https://provider.example.com/authorize")).toBe(
      "https://provider.example.com/authorize",
    );
    expect(systemBrowserUrl("http://provider.example.com")).toBe("http://provider.example.com/");
  });

  it("ignores blank, malformed, and non-web targets", () => {
    expect(systemBrowserUrl("about:blank")).toBeNull();
    expect(systemBrowserUrl("not a url")).toBeNull();
    expect(systemBrowserUrl("rakazo://sso")).toBeNull();
  });
});

it("keeps SSO popups sandboxed in the parent session without a privileged preload", () => {
  expect(oauthPopupSessionPreferences("persist:test-server")).toEqual({
    partition: "persist:test-server",
    preload: "",
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  });
  expect(oauthPopupSessionPreferences(null)).not.toHaveProperty("partition");
  expect(shouldOpenInAppPopup(appOrigin, "http://provider.example.com", "rakazo-sso-oauth")).toBe(
    false,
  );
});
it("opens the system browser after the window handler returns", async () => {
  const open = vi.fn();
  openInSystemBrowser(open, "https://botcamp.example/");
  expect(open).not.toHaveBeenCalled();
  await new Promise((resolve) => setImmediate(resolve));
  expect(open).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith("https://botcamp.example/");
});

it("allows only the named SSO blank popup before provider navigation", () => {
  expect(shouldOpenInAppPopup(appOrigin, "about:blank", "rakazo-sso-oauth")).toBe(true);
  expect(shouldOpenInAppPopup(appOrigin, "about:blank", "botcamp-sso-oauth")).toBe(true);
  for (const name of ["_blank", "rakazo-mcp-oauth", "botcamp-mcp-oauth", ""])
    expect(shouldOpenInAppPopup(appOrigin, "about:blank", name)).toBe(false);
  expect(shouldOpenInAppPopup(appOrigin, "about:blank#unsafe", "rakazo-sso-oauth")).toBe(false);
  expect(
    shouldOpenInAppPopup(appOrigin, "https://provider.example.com/oauth", "botcamp-mcp-oauth"),
  ).toBe(true);
  expect(shouldOpenInAppPopup(appOrigin, `${appOrigin}/`, "botcamp-sso-oauth")).toBe(false);
});
