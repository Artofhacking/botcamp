import { describe, expect, it } from "vitest";
import {
  adoptHashRoute,
  brandIconSrc,
  directShareUrl,
  documentPath,
  hashRouteReplacement,
  routeSearch,
  siteHomeHref,
  toAppDocument,
  withRouteSearch,
} from "./static-host-route";

const CONSOLE = "/console/";

describe("site home", () => {
  it("opens the host root and the console's own icon", () => {
    expect(siteHomeHref("https://botcamp.example")).toBe("https://botcamp.example/");
    expect(siteHomeHref("https://botcamp.example/console/")).toBe("https://botcamp.example/");
    expect(brandIconSrc("/")).toBe("/icon-192.png");
    expect(brandIconSrc("/console/")).toBe("/console/icon-192.png");
    expect(brandIconSrc("/console")).toBe("/console/icon-192.png");
  });
});

describe("static host routes", () => {
  it("leaves a root deploy on path routing", () => {
    const loc = { pathname: "/app/bot", search: "?m=1", hash: "" };
    expect(hashRouteReplacement(loc, "/")).toBeNull();
    expect(documentPath(loc, "/")).toBe("/app/bot");
    expect(routeSearch(loc, "/")).toBe("?m=1");
    expect(toAppDocument("/sign-in", "/")).toBe("/sign-in");
    expect(toAppDocument("https://pay.example/checkout", "/")).toBe("https://pay.example/checkout");
  });

  it("moves a deep path into the hash and leaves the entry and files alone", () => {
    expect(
      hashRouteReplacement({ pathname: "/console/app/bot", search: "?m=1", hash: "" }, CONSOLE),
    ).toBe("/console/#/app/bot?m=1");
    expect(
      hashRouteReplacement({ pathname: "/console/app/g/group", search: "", hash: "" }, CONSOLE),
    ).toBe("/console/#/app/g/group");
    for (const pathname of ["/console", "/console/", "/console/index.html"]) {
      expect(hashRouteReplacement({ pathname, search: "", hash: "" }, CONSOLE)).toBeNull();
    }
    expect(
      hashRouteReplacement({ pathname: "/console/assets/index.js", search: "", hash: "" }, CONSOLE),
    ).toBeNull();
    expect(
      hashRouteReplacement({ pathname: "/console/app/bot.name", search: "", hash: "" }, CONSOLE),
    ).toBe("/console/#/app/bot.name");
    expect(
      hashRouteReplacement(
        { pathname: "/console/app/bot", search: "", hash: "#/app/bot" },
        CONSOLE,
      ),
    ).toBeNull();
  });

  it("rewrites the address once, before a cache-bypassing reload", () => {
    let replaced = "";
    adoptHashRoute(
      CONSOLE,
      { pathname: "/console/app/bot", search: "?settings=models", hash: "" },
      (url) => {
        replaced = url;
      },
    );
    expect(replaced).toBe("/console/#/app/bot?settings=models");
    adoptHashRoute(CONSOLE, { pathname: "/console/", search: "", hash: "#/app/bot" }, () => {
      throw new Error("already a hash route");
    });
  });

  it("reads the route from the hash and still understands a path the shell served", () => {
    expect(documentPath({ pathname: "/console/", hash: "#/app/bot" }, CONSOLE)).toBe("/app/bot");
    expect(documentPath({ pathname: "/console/app/bot", hash: "" }, CONSOLE)).toBe("/app/bot");
    expect(documentPath({ pathname: "/console/index.html", hash: "" }, CONSOLE)).toBe("/");
    expect(routeSearch({ search: "", hash: "#/app/bot?m=1" }, CONSOLE)).toBe("?m=1");
    expect(routeSearch({ search: "?ref=abc", hash: "#/app/bot?m=1" }, CONSOLE)).toBe("?m=1");
    expect(routeSearch({ search: "?ref=abc", hash: "" }, CONSOLE)).toBe("?ref=abc");
  });

  it("gives a shared page the console address, with no hop through the homepage", () => {
    const token = "a".repeat(43);
    expect(directShareUrl(`https://app.example/p/plan-${token}`, "/")).toBe(
      `https://app.example/p/plan-${token}`,
    );
    expect(directShareUrl(`https://app.example/p/plan-${token}?x=1`, CONSOLE)).toBe(
      `https://app.example/console/#/p/plan-${token}?x=1`,
    );
    expect(directShareUrl(`https://app.example/console/#/p/plan-${token}`, CONSOLE)).toBe(
      `https://app.example/console/#/p/plan-${token}`,
    );
    expect(directShareUrl("not a url", CONSOLE)).toBe("not a url");
  });

  it("keeps a full navigation on the entry document", () => {
    expect(toAppDocument("/app/bot?m=1", CONSOLE)).toBe("/console/#/app/bot?m=1");
    expect(toAppDocument("/sign-in", CONSOLE)).toBe("/console/#/sign-in");
    expect(toAppDocument("https://pay.example/checkout", CONSOLE)).toBe(
      "https://pay.example/checkout",
    );
    expect(toAppDocument("//cdn.example/app", CONSOLE)).toBe("//cdn.example/app");
    expect(toAppDocument("/console/#/app", CONSOLE)).toBe("/console/#/app");
  });

  it("rewrites only the route query on the way back from a redirect", () => {
    const loc = {
      href: "https://app.example/console/#/app/bot?settings=models&error=denied",
      origin: "https://app.example",
      pathname: "/console/",
      search: "",
      hash: "#/app/bot?settings=models&error=denied",
    };
    expect(
      withRouteSearch(
        (params) => {
          params.delete("error");
          params.set("sso-link", "1");
        },
        loc,
        CONSOLE,
      ),
    ).toBe("https://app.example/console/#/app/bot?settings=models&sso-link=1");
  });
});
