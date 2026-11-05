import { expect, test } from "@playwright/test";
import { completeOnboarding, signup } from "./helpers";

test("the workspace is not a personal space and another space cannot be created", async ({
  page,
}) => {
  await signup(page, `spaces-gone-${Date.now()}@rakazo.test`, "password12", "Space Owner");
  await completeOnboarding(page);

  const sidebar = page.locator("aside").first();
  await expect(sidebar.getByText("Personal", { exact: true })).toHaveCount(0);
  await page.getByTestId("create-menu-trigger").click();
  const picker = page.getByTestId("bot-create-picker");
  await expect(picker.getByTestId("create-new-bot")).toBeVisible();
  await expect(picker.getByTestId("create-new-group")).toBeVisible();
  await expect(picker.getByTestId("create-new-space")).toHaveCount(0);
  await expect(picker.getByText("New private space")).toHaveCount(0);

  const created = await page.request.post("/rpc/spaces/create", {
    data: { json: { name: "Side" } },
  });
  expect(created.ok()).toBe(false);
  expect(created.status()).toBe(400);
});
