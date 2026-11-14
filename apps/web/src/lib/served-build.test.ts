import { describe, expect, it } from "vitest";
import { servedBuildUrl } from "./served-build";

describe("servedBuildUrl", () => {
  it("keeps the base path the app is mounted under, where the file sits", () => {
    const url = servedBuildUrl("/console/", "https://camp.test");
    expect(new URL(url).pathname).toBe("/console/build-id");
  });

  it("reads the origin root for a root-mounted app", () => {
    const url = servedBuildUrl("/", "https://camp.test");
    expect(new URL(url).pathname).toBe("/build-id");
  });
});
