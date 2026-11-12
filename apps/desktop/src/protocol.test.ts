import { describe, expect, it } from "vitest";
import { deepLinkFromArgv, desktopProtocolRegistration } from "./protocol.js";

describe("desktop protocol", () => {
  it("registers the packaged app for the return scheme", () => {
    expect(desktopProtocolRegistration(true, "/app", [])).toEqual({ scheme: "rakazo" });
  });

  it("points an unpackaged launch at the script", () => {
    expect(desktopProtocolRegistration(false, "/electron", ["electron", "main.js"])).toEqual({
      scheme: "rakazo",
      exec: "/electron",
      args: ["main.js"],
    });
    expect(desktopProtocolRegistration(false, "/electron", ["electron"])).toBeNull();
  });

  it("finds the return link in a launch's arguments", () => {
    expect(deepLinkFromArgv(["app.exe", "--allow", "rakazo://mcp-oauth?code=1&state=s"])).toBe(
      "rakazo://mcp-oauth?code=1&state=s",
    );
    expect(deepLinkFromArgv(["app.exe"])).toBeNull();
  });
});
