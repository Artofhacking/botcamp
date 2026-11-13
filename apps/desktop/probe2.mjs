import { chromium } from "playwright";

// Real Chrome, so third-party cookie policy matches what users will hit.
const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext();
const page = await context.newPage();
const log = [];
page.on("console", (m) => {
  if (m.type() === "error") log.push("console: " + m.text().slice(0, 160));
});
page.on("requestfailed", (r) =>
  log.push(`failed ${r.method()} ${r.url().slice(0, 100)} ${r.failure()?.errorText}`),
);
page.on("response", async (r) => {
  if (r.status() >= 400) log.push(`http ${r.status()} ${r.url()}`);
});

await page.goto("https://botcamp.demox.site/console/", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForTimeout(6000);
console.log("URL:", page.url());
console.log("BODY:", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 240));
console.log("PROBLEMS:", log.slice(0, 8).join(" | ") || "none");
await page.screenshot({ path: "/tmp/console.png" });
await browser.close();
