import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
const problems = [];
page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text().slice(0, 200)); });
page.on("requestfailed", (r) => problems.push(`failed: ${r.method()} ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
page.on("response", (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url().slice(0, 120)}`); });

await page.goto("https://botcamp.demox.site/console/", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(3000);
console.log("title:", await page.title());
console.log("body:", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300));
console.log("--- problems");
console.log(problems.slice(0, 12).join("\n") || "none");
await page.screenshot({ path: "/tmp/console.png", fullPage: false });
await browser.close();
