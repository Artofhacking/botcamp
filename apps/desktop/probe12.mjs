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

const box = page.locator("textarea, [contenteditable='true']").first();
await box.click();
await box.fill("请回复 ok 两个字");
await page.keyboard.press("Enter");
await page.waitForTimeout(25000);
console.log("BODY:", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300));
await browser.close();
