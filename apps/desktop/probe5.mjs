import { chromium } from "playwright";

const email = `tokonly-${Date.now()}@example.com`;
const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext();
const page = await context.newPage();
const problems = [];
page.on("response", (r) => {
  if (r.status() >= 400) problems.push(`http ${r.status()} ${r.url().slice(0, 80)}`);
});

await page.goto("https://botcamp.demox.site/console/", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForTimeout(3500);
const inputs = page.locator("input");
const n = await inputs.count();
for (let i = 0; i < n; i++) {
  const type = await inputs.nth(i).getAttribute("type");
  const name = (await inputs.nth(i).getAttribute("name")) || "";
  if (name === "name" || type === "text") await inputs.nth(i).fill("Tok Only");
  else if (type === "email") await inputs.nth(i).fill(email);
  else if (type === "password") await inputs.nth(i).fill("Test1234!pass");
}
await page
  .getByRole("button", { name: /创建账户|Create account/i })
  .first()
  .click();
await page.waitForTimeout(7000);

// Drop every cookie: from here on only the stored token can identify this session.
await context.clearCookies();
await page.goto("https://botcamp.demox.site/console/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);

const token = await page.evaluate(() => localStorage.getItem("bc_auth_token"));
const cookies = await context.cookies();
console.log("EMAIL:", email);
console.log("URL after reload:", page.url());
console.log("TOKEN:", token ? "present" : "missing");
console.log("COOKIES:", cookies.length ? cookies.map((c) => c.name).join(",") : "none");
console.log("BODY:", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 120));
console.log("PROBLEMS:", problems.slice(0, 5).join(" | ") || "none");
await browser.close();
