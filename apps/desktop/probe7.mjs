import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext();
const page = await context.newPage();
const problems = [];
page.on("response", (r) => {
  if (r.status() >= 400) problems.push(`http ${r.status()} ${r.url().slice(0, 80)}`);
});

// sign in as the admin account, then open the console page
await page.goto("https://botcamp.demox.site/console/sign-in", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForTimeout(3000);
const inputs = page.locator("input");
const n = await inputs.count();
for (let i = 0; i < n; i++) {
  const type = await inputs.nth(i).getAttribute("type");
  if (type === "email") await inputs.nth(i).fill("quota-test@example.com");
  else if (type === "password") await inputs.nth(i).fill("Test1234!pass");
}
const buttons = await page.locator("button").allInnerTexts();
console.log("BUTTONS:", buttons.join(" | ").slice(0, 160));
await page.waitForTimeout(6000);
console.log("after sign-in URL:", page.url());
console.log(
  "token:",
  (await page.evaluate(() => localStorage.getItem("bc_auth_token"))) ? "present" : "missing",
);

await page.goto("https://botcamp.demox.site/admin/", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForTimeout(5000);
console.log(
  "ADMIN BODY:",
  (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 260),
);
console.log("PROBLEMS:", problems.slice(0, 5).join(" | ") || "none");
await browser.close();
