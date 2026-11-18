import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("the create menu only starts new things", async ({ page }, testInfo) => {
  await signup(page, `create-menu-${Date.now()}@rakazo.test`, "password12", "Create menu");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  for (const name of ["Helper 1", "Helper 2"]) {
    await rpc(page, "bots/create", {
      name,
      description: "",
      notifyOnFinish: true,
      computerMode: "team",
    });
  }
  await page.reload();
  await page.getByTestId("create-menu-trigger").click();
  const menu = page.getByTestId("create-menu");
  await expect(menu.getByTestId("create-new-bot")).toBeVisible();
  await expect(menu.getByTestId("create-new-group")).toBeVisible();
  await expect(menu.getByTestId("create-shared-group")).toBeVisible();
  // The menu creates things; it does not list or search the bots that already exist.
  await expect(menu.locator("input")).toHaveCount(0);
  await expect(menu.getByTestId("create-new-space")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "create-menu");
  await page.setViewportSize({ width: 900, height: 360 });
  await expect(menu.getByTestId("create-shared-group")).toBeInViewport({ ratio: 1 });
  await captureScreenshot(page, testInfo, "create-menu-short-window");
  await menu.getByTestId("create-new-group").click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "create-group");
});
