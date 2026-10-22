import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { feedRetryDelay } from './src/api.js'
import { earlierBanner, visiblePending } from './src/chatSync.js'

const root = fileURLToPath(new URL('../..', import.meta.url))

function read(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

test('a demox.site page does not redirect to camp', () => {
  const html = read('./index.html')
  assert.equal(html.includes('location.replace'), false)
  assert.equal(html.includes('camp.aigc.sx.cn'), false)
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

test('nginx serves camp as API-only and requires the same session', () => {
  const conf = readFileSync(`${root}/deploy/nginx/camp.conf`, 'utf8')
  assert.equal(conf.includes('botcamp.demox.site'), true)
  assert.equal(conf.includes('proxy_pass https://'), false)
  assert.equal(conf.includes('index.html'), false)
  assert.equal(conf.includes('location ^~ /assets/'), false)
  assert.match(conf, /location \/api\//)
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:3080/)
  assert.match(conf, /Upgrade \$http_upgrade/)
  assert.match(conf, /\$cookie_botcamp_session/)
  assert.match(conf, /return 401/)
  assert.match(conf, /API-only/)
  assert.equal(conf.includes('浏览器入口仍是这个域名'), false)
})

test('a sent message already on the page is not drawn again', () => {
  const sent = { kind: 'user', text: '你好', time: 10 }
  const pending = [{ kind: 'user', text: '你好', time: 99 }, { kind: 'user', text: '还在路上', time: 100 }]
  assert.deepEqual(visiblePending(pending, [sent]).map(entry => entry.text), ['还在路上'])
  assert.deepEqual(visiblePending(pending, []).map(entry => entry.text), ['你好', '还在路上'])
  const twice = [{ kind: 'user', text: '好', time: 1 }, { kind: 'user', text: '好', time: 2 }]
  assert.equal(visiblePending(twice, [{ kind: 'user', text: '好', time: 3 }]).length, 1)
})

test('refreshing the latest page does not say it is loading earlier messages', () => {
  assert.equal(earlierBanner({ loadingEarlier: false, failed: false, cursor: 'p1' }), 'more')
  assert.equal(earlierBanner({ loadingEarlier: true, failed: false, cursor: 'p1' }), 'loading')
  assert.equal(earlierBanner({ loadingEarlier: false, failed: true, cursor: 'p1' }), 'failed')
  assert.equal(earlierBanner({ loadingEarlier: false, failed: false, cursor: null }), 'none')
})

test('a feed that ends immediately waits several seconds', () => {
  assert.equal(feedRetryDelay(200, true, 0), 5000)
  assert.equal(feedRetryDelay(3400, true, 3), 5000)
  assert.equal(feedRetryDelay(8000, true, 0), 500)
  assert.equal(feedRetryDelay(100, false, 1), 1000)
})
