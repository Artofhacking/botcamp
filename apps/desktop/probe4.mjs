import { chromium } from "playwright";

const email = `token-${Date.now()}@example.com`;
const browser = await chromium.launch({ channel: "chrome" });
// Block third-party cookies outright: the app must work with the token alone.
const context = await browser.newContext({ permissions: [] });
const page = await context.newPage();
const problems = [];
page.on("requestfailed", (r) => problems.push(`failed ${r.method()} ${r.url().slice(0, 80)} ${r.failure()?.errorText}`));
page.on("response", (r) => { if (r.status() >= 400) problems.push(`http ${r.status()} ${r.url().slice(0, 80)}`); });

await page.goto("https://botcamp.demox.site/console/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4000);
const inputs = page.locator("input");
const n = await inputs.count();
for (let i = 0; i < n; i++) {
  const type = await inputs.nth(i).getAttribute("type");
  const name = (await inputs.nth(i).getAttribute("name")) || "";
  if (name === "name" || type === "text") await inputs.nth(i).fill("Token Test");
  else if (type === "email") await inputs.nth(i).fill(email);
  else if (type === "password") await inputs.nth(i).fill("Test1234!pass");
}
await page.getByRole("button", { name: /创建账户|Create account/i }).first().click();
await page.waitForTimeout(8000);

const token = await page.evaluate(() => localStorage.getItem("bc_auth_token"));
const cookies = await context.cookies();
console.log("EMAIL:", email);
console.log("URL:", page.url());
console.log("TOKEN stored:", token ? token.slice(0, 18) + "…" : "none");
console.log("COOKIES:", cookies.filter((c) => c.name.includes("session")).map((c) => c.name).join(",") || "none");
console.log("BODY:", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 140));
console.log("PROBLEMS:", problems.slice(0, 5).join(" | ") || "none");
await browser.close();
