import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { feedRetryDelay } from './src/api.js'

const root = fileURLToPath(new URL('../..', import.meta.url))

function read(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

test('a demox.site page does not redirect to camp', () => {
  const html = read('./index.html')
  const account = read('./src/account.js')
  const appJs = read('./src/app.js')
  assert.equal(html.includes('location.replace'), false)
  assert.equal(html.includes('camp.aigc.sx.cn'), false)
  assert.equal(account.includes('location.replace'), false)
  assert.equal(account.includes('camp.aigc.sx.cn'), false)
  assert.match(account, /botcamp\/login/)
  assert.equal(appJs.includes('location.replace'), false)
  assert.equal(appJs.includes('camp.aigc.sx.cn'), false)
  assert.match(html, /connect-src 'self'/)
  assert.match(html, /<title>DeepSeek Bot<\/title>/)
  const location = {
    hostname: 'botcamp.demox.site',
    href: 'https://botcamp.demox.site/',
    replace(url) { this.replaced = url },
  }
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  for (const match of scripts) {
    const run = new Function('location', match[1])
    run(location)
  }
  assert.equal(location.replaced, undefined)
  assert.equal(location.href, 'https://botcamp.demox.site/')
})

test('nginx serves camp as API-only', () => {
  const conf = readFileSync(`${root}/deploy/nginx/camp.conf`, 'utf8')
  assert.equal(conf.includes('botcamp.demox.site'), true)
  assert.equal(conf.includes('proxy_pass https://'), false)
  assert.equal(conf.includes('index.html'), false)
  assert.match(conf, /location \/api\//)
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:3080/)
  assert.match(conf, /Upgrade \$http_upgrade/)
  assert.match(conf, /API-only/)
  assert.match(conf, /不再提供网站/)
  assert.equal(conf.includes('浏览器入口仍是这个域名'), false)
})

test('a feed that ends immediately waits several seconds', () => {
  assert.equal(feedRetryDelay(200, true, 0), 5000)
  assert.equal(feedRetryDelay(3400, true, 3), 5000)
  assert.equal(feedRetryDelay(8000, true, 0), 500)
  assert.equal(feedRetryDelay(100, false, 1), 1000)
})
