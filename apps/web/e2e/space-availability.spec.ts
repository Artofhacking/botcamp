import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("a skill in the one workspace has no space availability choice", async ({ page }, testInfo) => {
  await signup(page, `availability-${Date.now()}@rakazo.test`, "password12", "Space Owner");
  await completeOnboarding(page);
  await rpc(page, "agentSkills/create", {
    content: [
      "---",
      "name: weekly-review",
      "description: Summarize the week's progress and blockers.",
      "---",
      "",
      "List what shipped, what slipped, and what is blocked.",
    ].join("\n"),
  });

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  const skills = page.getByRole("dialog", { name: "Skills", exact: true });
  const yours = skills.getByTestId("your-skills");
  await yours.getByRole("button", { name: /weekly-review/ }).click();
  await expect(yours.getByTestId("availability")).toHaveCount(0);
  await expect(skills.getByText("Available in")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "skill-no-space-availability");
});
