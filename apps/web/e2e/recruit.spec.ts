import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("recruit searches the catalog, adds a bot, and opens it", async ({ page }, testInfo) => {
  await signup(page, `recruit-${Date.now()}@rakazo.test`, "password12", "Recruiter");
  await completeOnboarding(page);

  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("create-recruit").click();
  const dialog = page.getByTestId("recruit-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Software Engineer", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Gold-Medal Editor", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "recruit-window");

  const search = dialog.getByPlaceholder("Search bots");
  await search.fill("editor");
  await expect(dialog.getByTestId("recruit-software-engineer")).toHaveCount(0);
  await expect(dialog.getByTestId("recruit-gold-medal-editor")).toBeVisible();
  await search.fill("no such role");
  await expect(dialog.getByText("No bots match")).toBeVisible();
  await search.fill("");
  await expect(dialog.getByTestId("recruit-software-engineer")).toBeVisible();

  await dialog.getByTestId("recruit-add-software-engineer").click();
  await expect(page.getByPlaceholder("Message Software Engineer")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page).toHaveURL(/\/app\/[^/]+$/);
  await expect(page.getByTestId("recruit-dialog")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "recruited-bot");
});
