import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openBotPanelTab,
  signup,
} from "./helpers";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

/**
 * E2E has no Feishu access, so the chat app RPCs are fulfilled with fixture data.
 * The settings row and the code dialog render as they would against a live server.
 */
test("a bot that is not primary lists WeChat disabled, then opens its own Feishu code", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-feishu-${stamp}@rakazo.test`, "password12", "Feishu Link");
  await completeOnboarding(page);
  await createNamedBot(page, "Research");

  const json = (body: unknown) => ({
    contentType: "application/json",
    body: JSON.stringify({ json: body }),
  });
  let started: unknown;
  await page.route("**/rpc/messaging/chatTools/list", (route) => route.fulfill(json([])));
  await page.route("**/rpc/messaging/chatTools/start", (route) => {
    started = route.request().postDataJSON();
    return route.fulfill(
      json({
        loginId: "login-e2e",
        image: "https://open.feishu.cn/page/cli?user_code=e2e",
        url: "https://open.feishu.cn/page/cli?user_code=e2e",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    );
  });
  await page.route("**/rpc/messaging/chatTools/poll", (route) =>
    route.fulfill(json({ status: "wait" })),
  );

  await openBotPanelTab(page, "Advanced");
  const settings = page.getByTestId("bot-settings");
  const row = settings.getByTestId("chat-tool-link");
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Link", exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: /^WeChat/ })).toBeDisabled();
  await captureScreenshot(page, testInfo, "bot-chat-app-list");
  await dialog.getByRole("button", { name: "Feishu", exact: true }).click();
  await expect(dialog.getByRole("img", { name: "Chat app code" })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open in browser" })).toHaveAttribute(
    "href",
    "https://open.feishu.cn/page/cli?user_code=e2e",
  );
  expect(JSON.stringify(started)).toContain('"provider":"feishu"');

  await captureScreenshot(page, testInfo, "bot-feishu-link");
});
