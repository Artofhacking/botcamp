import { chromium } from 'playwright'
const executablePath = '/Users/phosa/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
page.on('response', (r) => { if (r.url().includes('/desk/d1/')) console.log(r.status(), r.url()) })
await page.goto('http://127.0.0.1:4173/desk/d1/library/', { waitUntil: 'networkidle' })
await page.waitForSelector('.mr-library', { timeout: 15000 })
await page.locator('.mr-lib-card').first().click()
await page.waitForSelector('.mr-page-title', { timeout: 10000 })
await page.screenshot({ path: 'preview/shots/08-desk-prefix.png' })
console.log('errors:', errors)
await browser.close()
