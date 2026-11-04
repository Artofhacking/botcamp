import { chromium } from "playwright";
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
const res = await fetch("https://botcamp.aigc.sx.cn/api/auth/sign-in/email", {
  method: "POST", headers: { "content-type": "application/json", origin: "https://botcamp.demox.site" },
  body: JSON.stringify({ email: "quota-test@example.com", password: "Test1234!pass" }),
});
const token = res.headers.get("set-auth-token");
await page.addInitScript((t) => localStorage.setItem("bc_auth_token", t), token);
await page.goto("https://botcamp.demox.site/console/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(7000);
const buttons = await page.locator("button").evaluateAll((els) =>
  els.map((e) => (e.getAttribute("aria-label") || e.textContent || "").trim()).filter(Boolean).slice(0, 25),
);
await page.getByRole("button", { name: "Quota Test 的账户菜单" }).click();
await page.waitForTimeout(1500);
const items = await page.locator("body").innerText();
console.log("MENU:", items.replace(/\s+/g, " ").slice(0, 220));
await page.getByText("设置 / Settings / Settings").first().click().catch(() => {});
await page.waitForTimeout(2500);
const navText = await page.locator("body").innerText();
console.log("SETTINGS:", navText.replace(/\s+/g, " ").slice(0, 260));
await page.screenshot({ path: "/tmp/app.png" });
await browser.close();
