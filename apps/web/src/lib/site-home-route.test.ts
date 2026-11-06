import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = readFileSync(
  fileURLToPath(new URL("../../../../web/site/index.html", import.meta.url)),
  "utf8",
);
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

function redirect(
  pathname: string,
  options?: { search?: string; hash?: string; electron?: boolean },
): string {
  let next = "";
  const location = {
    pathname,
    search: options?.search ?? "",
    hash: options?.hash ?? "",
    replace(url: string) {
      next = url;
    },
  };
  const navigator = { userAgent: options?.electron ? "Electron/1.0" : "Mozilla/5.0" };
  new Function("location", "navigator", script ?? "")(location, navigator);
  return next;
}

describe("marketing host routes", () => {
  it("sends a shared page into the console", () => {
    expect(script).toBeTruthy();
    expect(redirect("/p/plan-token")).toBe("/console/#/p/plan-token");
    expect(redirect("/p/plan-token/", { search: "?x=1" })).toBe("/console/#/p/plan-token?x=1");
  });

  it("leaves the homepage in a browser and still forwards console routes", () => {
    expect(redirect("/")).toBe("");
    expect(redirect("/", { electron: true })).toBe("/console/");
    expect(redirect("/console/app/bot", { search: "?m=1" })).toBe("/console/#/app/bot?m=1");
    expect(redirect("/console/assets/index.js")).toBe("");
    expect(redirect("/mcp/oauth/callback", { search: "?code=1" })).toBe(
      "/console/#/mcp/oauth/callback?code=1",
    );
  });
});
