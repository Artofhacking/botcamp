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
await page.waitForTimeout(6000);
const box = page.locator("textarea, [contenteditable='true']").first();
await box.click();
await box.fill("say ok");
await page.keyboard.press("Enter");
await page.waitForTimeout(20000);
console.log("BODY:", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 260));
await browser.close();
