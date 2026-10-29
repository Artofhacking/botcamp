import { chromium } from 'playwright'

const executablePath = '/Users/phosa/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('response', (response) => { if (response.status() === 404) errors.push(`404: ${response.url()}`) })
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`)
})

await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' })
await page.waitForSelector('.mr-library', { timeout: 15000 })
await page.screenshot({ path: 'preview/shots/01-library-desktop.png', fullPage: false })

const cards = await page.locator('.mr-lib-card').count()
console.log('cards:', cards)
if (cards > 0) {
  await page.locator('.mr-lib-card').first().click()
  await page.waitForSelector('.mr-page-title', { timeout: 10000 })
  await page.screenshot({ path: 'preview/shots/02-doc-desktop.png', fullPage: false })
}

await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' })
await page.waitForSelector('.mr-library', { timeout: 15000 })
const videoCard = page.locator('.mr-lib-card', { hasText: '3 分钟讲清一个概念' })
if (await videoCard.count()) {
  await videoCard.first().click()
  await page.waitForSelector('.mr-doc video', { timeout: 10000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'preview/shots/03-video-desktop.png', fullPage: false })
}

await page.setViewportSize({ width: 390, height: 844 })
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' })
await page.waitForSelector('.mr-library', { timeout: 15000 })
await page.screenshot({ path: 'preview/shots/04-library-mobile.png', fullPage: false })
const mobCard = page.locator('.mr-lib-card').first()
if (await mobCard.count()) {
  await mobCard.click()
  await page.waitForSelector('.mr-page-title', { timeout: 10000 })
  await page.screenshot({ path: 'preview/shots/05-doc-mobile.png', fullPage: false })
}

console.log('errors:', errors.slice(0, 20))
await browser.close()
