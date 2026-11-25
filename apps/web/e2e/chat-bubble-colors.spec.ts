import { contrastRatio } from "@botcamp/core";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("colored user bubbles keep white text in both themes", async ({ page }, testInfo) => {
  await signup(page, `bubble-colors-${Date.now()}@rakazo.test`, "password12", "Bubble Demo");
  await completeOnboarding(page);
  await rpc(page, "bots/update", { botId: activeBotId(page), color: "#A855F7" });
  await page.reload();

  const message = "Let's plan the week ahead.";
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill(message);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const bubble = page.getByTestId("message-user-bubble").filter({ hasText: message });
  await expect(bubble).toBeVisible();

  for (const theme of ["dark", "light"]) {
    await page.evaluate((theme) => localStorage.setItem("botcamp.uiAppearance", theme), theme);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(bubble).toHaveCSS("color", "rgb(255, 255, 255)");
    const background = await bubble.evaluate((node) => getComputedStyle(node).backgroundColor);
    const match = background.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
    if (!match) throw new Error(`Expected a solid RGB color, got ${background}`);
    const red = Number(match[1]);
    const green = Number(match[2]);
    const blue = Number(match[3]);
    expect(blue).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(green);
    const hex = `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
    expect(contrastRatio(hex, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    await captureScreenshot(page, testInfo, `chat-bubble-white-text-${theme}`);
  }
});
