import { describe, expect, it, vi } from "vitest";
import { openInSystemBrowser, systemBrowserUrl } from "./window-open.js";

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

it("opens the system browser after the window handler returns", async () => {
  const open = vi.fn();
  openInSystemBrowser(open, "https://botcamp.example/");
  expect(open).not.toHaveBeenCalled();
  await new Promise((resolve) => setImmediate(resolve));
  expect(open).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith("https://botcamp.example/");
});
