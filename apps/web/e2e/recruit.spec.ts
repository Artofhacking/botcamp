import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("recruit adds a ready-made bot and opens it", async ({ page }, testInfo) => {
  await signup(page, `recruit-${Date.now()}@rakazo.test`, "password12", "Recruiter");
  await completeOnboarding(page);

  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("create-recruit").click();
  const dialog = page.getByTestId("recruit-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Software Engineer", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Gold-Medal Editor", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "recruit-window");

  await dialog.getByTestId("recruit-add-software-engineer").click();
  await expect(page.getByPlaceholder("Message Software Engineer")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page).toHaveURL(/\/app\/[^/]+$/);
  await expect(page.getByTestId("recruit-dialog")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "recruited-bot");
});
