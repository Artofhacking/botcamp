import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BotCampDesktop } from "@botcamp/contracts";
import type { ElectronApplication, Page } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";

const APP_MARKER = "Existing BotCamp instance ready";
/** Every launch without a server opens the hosted console; there is no server chooser. */
const CLOUD_CONSOLE_ORIGIN = "https://botcamp.demox.site";
const CLOUD_CONSOLE_PATH = "/console/";

let server: Server;
let serverUrl: string;
let userData: string;
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url?.startsWith("/redirect?")) {
      const target = new URL(request.url, serverUrl).searchParams.get("to") ?? "/";
      response.writeHead(302, { location: target });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>BotCamp</title></head><body><main>${APP_MARKER}</main></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub server has no port");
  serverUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test.beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "botcamp-desktop-e2e-"));
  // The app otherwise follows the machine's language; these specs read its English text.
  await writeFile(path.join(userData, "ui-locale.txt"), "en\n");
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(userData, { recursive: true, force: true });
});

/** Launches on a private profile, with the developer's own server and target cleared. */
function launch(extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    "BOTCAMP_WEB_URL",
    "RAKAZO_WEB_URL",
    "BOTCAMP_DEFAULT_SERVER_URL",
    "RAKAZO_DEFAULT_SERVER_URL",
  ]) {
    delete env[name];
  }
  // Both names keep the run off the developer's own profile, and off the system link handler.
  env.BOTCAMP_PERFORMANCE_USER_DATA = userData;
  env.RAKAZO_PERFORMANCE_USER_DATA = userData;
  return electron.launch({
    args: ["."],
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...env, ...extraEnv },
  });
}

/** The URL the app gave its window, which is set before the page finishes loading. */
function openedUrl(opened: ElectronApplication) {
  return opened.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    return window === undefined ? "" : window.webContents.getURL();
  });
}

test("an explicit server URL opens that server on a fresh profile", async () => {
  app = await launch({ RAKAZO_WEB_URL: serverUrl });
  const page = await app.firstWindow();
  await expect(page.getByText(APP_MARKER)).toBeVisible();
  expect(page.url()).toBe(`${serverUrl}/`);
});

test("BOTCAMP_WEB_URL wins over the older RAKAZO name", async () => {
  const older = encodeURIComponent("<!doctype html><main>older name</main>");
  app = await launch({
    BOTCAMP_WEB_URL: serverUrl,
    RAKAZO_WEB_URL: `data:text/html;charset=utf-8,${older}`,
  });
  const page = await app.firstWindow();
  await expect(page.getByText(APP_MARKER)).toBeVisible();
  expect(page.url()).toBe(`${serverUrl}/`);
});

test("a fresh profile with no server opens the hosted console", async () => {
  app = await launch();
  const launched = app;
  await expect.poll(() => openedUrl(launched)).not.toBe("");
  const url = new URL(await openedUrl(launched));
  expect(url.origin).toBe(CLOUD_CONSOLE_ORIGIN);
  expect(url.pathname).toBe(CLOUD_CONSOLE_PATH);
});

test("setup IPC is not reachable from the connected app window", async () => {
  app = await launch({ RAKAZO_WEB_URL: serverUrl });
  const appWindow = await app.firstWindow();
  await expect(appWindow.getByText(APP_MARKER)).toBeVisible();

  const exposed = await appWindow.evaluate(() =>
    Object.keys((window as typeof window & { botcampSetup?: unknown }).botcampSetup ?? {}),
  );
  expect(exposed).toEqual([]);
});

test("the app window stays on its server when a link redirects to another site", async () => {
  const elsewhere = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><main>Another site</main>");
  });
  await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
  const address = elsewhere.address();
  if (address === null || typeof address === "string") throw new Error("fixture has no port");
  const elsewhereUrl = `http://127.0.0.1:${address.port}/landing`;
  const signInUrl = "https://sign-in.invalid/authorize";
  const openSignIn = (page: Page) =>
    page.evaluate(
      (url) =>
        (window as typeof window & { botcampDesktop: BotCampDesktop }).botcampDesktop.oauth
          .open(url)
          .then(
            () => "opened",
            (error: Error) => error.message,
          ),
      signInUrl,
    );

  try {
    const launched = await launch({ RAKAZO_WEB_URL: serverUrl });
    app = launched;
    const appWindow = await launched.firstWindow();
    await expect(appWindow.getByText(APP_MARKER)).toBeVisible();
    await launched.evaluate(({ shell }) => {
      const opened: string[] = [];
      Object.assign(globalThis, { opened });
      shell.openExternal = async (url) => {
        opened.push(url);
      };
    });
    const openedUrls = () =>
      launched.evaluate(() => (globalThis as typeof globalThis & { opened: string[] }).opened);

    // Links to another site go to the system browser.
    await appWindow.evaluate((to) => window.location.assign(to), elsewhereUrl);
    await expect.poll(openedUrls).toEqual([elsewhereUrl]);
    // Playwright keeps waiting on a navigation cancelled before it starts, so ask the page itself.
    expect(await appWindow.evaluate(() => window.location.href)).toBe(`${serverUrl}/`);

    // So does a server redirect to another site.
    await appWindow.evaluate(
      (to) => window.location.assign(`/redirect?to=${encodeURIComponent(to)}`),
      elsewhereUrl,
    );
    await expect.poll(openedUrls).toEqual([elsewhereUrl, elsewhereUrl]);
    await expect(appWindow).toHaveURL(`${serverUrl}/`);
    await expect(appWindow.getByText(APP_MARKER)).toBeVisible();

    // Embedded frames may still follow redirects to other sites.
    await appWindow.evaluate((to) => {
      const frame = document.createElement("iframe");
      frame.src = `/redirect?to=${encodeURIComponent(to)}`;
      document.body.append(frame);
    }, elsewhereUrl);
    await expect(appWindow.frameLocator("iframe").getByText("Another site")).toBeVisible();

    // Redirects within the server still load in the app.
    await appWindow.evaluate(() => window.location.assign("/redirect?to=/after"));
    await expect(appWindow).toHaveURL(`${serverUrl}/after`);
    await expect(appWindow.getByText(APP_MARKER)).toBeVisible();
    expect(await openSignIn(appWindow)).toBe("opened");
    await expect.poll(openedUrls).toEqual([elsewhereUrl, elsewhereUrl, signInUrl]);

    // Another site in the app window cannot start a browser sign-in.
    await launched.evaluate(
      ({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0]?.webContents.loadURL(url),
      elsewhereUrl,
    );
    await expect(appWindow.getByText("Another site")).toBeVisible();
    expect(await openSignIn(appWindow)).toContain("Invalid sign-in request.");
    expect(await openedUrls()).toEqual([elsewhereUrl, elsewhereUrl, signInUrl]);
  } finally {
    await app?.close();
    app = undefined;
    await new Promise<void>((resolve, reject) => {
      elsewhere.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
