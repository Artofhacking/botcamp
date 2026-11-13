import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
// 未登录时应显示"登录"，而不是旧系统残留的邮箱
await page.goto("https://botcamp.demox.site/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4000);
console.log(
  "GUEST:",
  (await page.locator("#account").innerText()).replace(/\s+/g, " ").slice(0, 60),
);

// 注入一个有效 token 后，应显示邮箱
const res = await fetch("https://botcamp.aigc.sx.cn/api/auth/sign-in/email", {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://botcamp.demox.site" },
  body: JSON.stringify({ email: "quota-test@example.com", password: "Test1234!pass" }),
});
const token = res.headers.get("set-auth-token");
const page2 = await browser.newPage();
await page2.addInitScript((t) => localStorage.setItem("bc_auth_token", t), token);
await page2.goto("https://botcamp.demox.site/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page2.waitForTimeout(4000);
console.log(
  "SIGNED IN:",
  (await page2.locator("#account").innerText()).replace(/\s+/g, " ").slice(0, 60),
);
await browser.close();
