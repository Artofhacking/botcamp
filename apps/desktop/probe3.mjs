import { chromium } from "playwright";

const email = `cross-test-${Date.now()}@example.com`;
const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext();
const page = await context.newPage();
const problems = [];
page.on("requestfailed", (r) =>
  problems.push(`failed ${r.method()} ${r.url().slice(0, 90)} ${r.failure()?.errorText}`),
);
page.on("response", (r) => {
  if (r.status() >= 400) problems.push(`http ${r.status()} ${r.url().slice(0, 90)}`);
});

await page.goto("https://botcamp.demox.site/console/", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForTimeout(4000);

// fill the sign-up form generically
const inputs = page.locator("input");
const count = await inputs.count();
for (let i = 0; i < count; i++) {
  const type = await inputs.nth(i).getAttribute("type");
  const name = (await inputs.nth(i).getAttribute("name")) || "";
  if (name === "name" || type === "text") await inputs.nth(i).fill("Cross Test");
  else if (type === "email") await inputs.nth(i).fill(email);
  else if (type === "password") await inputs.nth(i).fill("Test1234!pass");
}
await page
  .getByRole("button", { name: /创建账户|Create account/i })
  .first()
  .click();
await page.waitForTimeout(8000);

console.log("EMAIL:", email);
console.log("URL:", page.url());
console.log("BODY:", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200));
const cookies = await context.cookies();
console.log("COOKIES:", cookies.map((c) => `${c.name}(sameSite=${c.sameSite})`).join(", "));
console.log("PROBLEMS:", problems.slice(0, 6).join(" | ") || "none");
await page.screenshot({ path: "/tmp/after-signup.png" });
await browser.close();
