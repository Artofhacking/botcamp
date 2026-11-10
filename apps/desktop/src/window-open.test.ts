import { describe, expect, it, vi } from "vitest";
import {
  oauthPopupSessionPreferences,
  openInSystemBrowser,
  shouldOpenInAppPopup,
} from "./window-open.js";

const appOrigin = "https://rakazo.example.com";

describe("desktop child windows", () => {
  it("keeps same-origin app routes in Electron", () => {
    expect(shouldOpenInAppPopup(appOrigin, `${appOrigin}/mcp/oauth/callback`, "_blank")).toBe(true);
    expect(shouldOpenInAppPopup(appOrigin, `${appOrigin}/console/`, "_blank")).toBe(true);
  });

  it("sends the public homepage to the system browser", () => {
    expect(shouldOpenInAppPopup(appOrigin, `${appOrigin}/`, "_blank")).toBe(false);
    expect(shouldOpenInAppPopup(appOrigin, `${appOrigin}/#how`, "_blank")).toBe(false);
  });

  it("opens ordinary external links outside Electron", () => {
    expect(
      shouldOpenInAppPopup(appOrigin, "https://github.com/artofhacking/botcamp/pull/395", "_blank"),
    ).toBe(false);
  });

  it.each([
    "rakazo-model-oauth",
    "rakazo-mcp-oauth",
    "rakazo-sso-oauth",
    "rakazo-app-connect",
    "rakazo-plugin-connect",
  ])("keeps the intentional %s flow in an Electron popup", (frameName) => {
    expect(
      shouldOpenInAppPopup(appOrigin, "https://provider.example.com/authorize", frameName),
    ).toBe(true);
  });

  it("rejects malformed URLs and non-HTTPS third-party targets", () => {
    expect(shouldOpenInAppPopup(appOrigin, "not a url", "rakazo-model-oauth")).toBe(false);
    expect(
      shouldOpenInAppPopup(appOrigin, "http://provider.example.com", "rakazo-model-oauth"),
    ).toBe(false);
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
  for (const name of ["_blank", "rakazo-mcp-oauth", ""])
    expect(shouldOpenInAppPopup(appOrigin, "about:blank", name)).toBe(false);
  expect(shouldOpenInAppPopup(appOrigin, "about:blank#unsafe", "rakazo-sso-oauth")).toBe(false);
});
