import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("language picker offers Simplified Chinese and English", async ({ page }, testInfo) => {
  await signup(page, `ui-locale-zh-${Date.now()}@rakazo.test`, "password12", "Locale QA");
  await completeOnboarding(page, testInfo);
  const settings = await openUserSettings(page);
  const picker = settings.getByTestId("ui-locale-select");
  await picker.click();
  // The timezone picker's native options share the "option" role, so look only in the open menu.
  const languages = page.getByRole("listbox");
  await expect(languages.getByRole("option")).toHaveText(["简体中文", "English"]);
  await page.getByRole("option", { name: "简体中文", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "通用", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "账户", exact: true })).toBeVisible();
  await expect(settings.getByText("语言", { exact: true })).toBeVisible();
  await expect(picker).toHaveText("简体中文");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await captureScreenshot(page, testInfo, "ui-locale-settings-zh-cn");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByTestId("ui-locale-select")).toHaveText("简体中文");
  await page.getByTestId("ui-locale-select").click();
  await expect(languages.getByRole("option")).toHaveText(["简体中文", "English"]);
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
});
