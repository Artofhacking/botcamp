import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
const res = await fetch("https://botcamp.aigc.sx.cn/api/auth/sign-in/email", {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://botcamp.demox.site" },
  body: JSON.stringify({ email: "quota-test@example.com", password: "Test1234!pass" }),
});
const token = res.headers.get("set-auth-token");
await page.addInitScript((t) => localStorage.setItem("bc_auth_token", t), token);
await page.goto("https://botcamp.demox.site/console/", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForTimeout(6000);
await page.goto("https://botcamp.demox.site/console/settings/general", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForTimeout(5000);
const nav = await page
  .locator("nav, [role='tablist']")
  .first()
  .innerText()
  .catch(() => "");
console.log("NAV:", nav.replace(/\s+/g, " ").slice(0, 200));
console.log(
  "HAS Models:",
  /Models|模型/.test(nav),
  "| HAS Computer:",
  /Computer|电脑/.test(nav),
  "| HAS Billing:",
  /Billing|账单/.test(nav),
);
await browser.close();
