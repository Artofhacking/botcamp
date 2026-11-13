// @vitest-environment jsdom

import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { usePageDocument } from "./pages";
import { queryClient } from "./query";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: String.raw }),
}));

afterEach(() => {
  delete window.__RAKAZO_API_ORIGIN__;
  vi.unstubAllGlobals();
  queryClient.clear();
  document.body.replaceChildren();
});

it("asks the server for the page runtime again each time a page opens", async () => {
  window.__RAKAZO_API_ORIGIN__ = "https://api.example.test";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("window.BotCampPage={};/*kit-v1*/"))
    .mockResolvedValueOnce(new Response("window.BotCampPage={};/*kit-v2*/"));
  vi.stubGlobal("fetch", fetcher);
  let shown: string | null = null;
  function Page() {
    shown = usePageDocument("export default () => null;").document;
    return null;
  }
  const open = async () => {
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <Page />
        </QueryClientProvider>,
      ),
    );
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    return root;
  };
  (await open()).unmount();
  expect(shown).toContain("kit-v1");
  // The browser revalidates the runtime's no-cache response, so a server upgrade shows here.
  await open();
  expect(shown).toContain("kit-v2");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]?.[0]).toBe(new URL("/page-runtime.js", window.location.origin).href);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit" });
});

it("asks the API for the runtime when the app and the API share an origin", async () => {
  window.__RAKAZO_API_ORIGIN__ = window.location.origin;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("window.BotCampPage={};/*same*/"));
  vi.stubGlobal("fetch", fetcher);
  function Page() {
    usePageDocument("export default () => null;");
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <Page />
      </QueryClientProvider>,
    ),
  );
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
  root.unmount();
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    `${window.location.origin}/api/v1/assets/page-runtime.js`,
  );
});
