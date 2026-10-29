import { chromium } from 'playwright'
const executablePath = '/Users/phosa/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
await page.goto('http://127.0.0.1:4173/library/', { waitUntil: 'networkidle' })
await page.waitForSelector('.mr-library', { timeout: 15000 })
await page.screenshot({ path: 'preview/shots/06-standalone-mobile.png' })
await page.locator('.mr-lib-card').first().click()
await page.waitForSelector('.mr-page-title', { timeout: 10000 })
await page.screenshot({ path: 'preview/shots/07-standalone-doc-mobile.png' })
console.log('errors:', errors)
await browser.close()
