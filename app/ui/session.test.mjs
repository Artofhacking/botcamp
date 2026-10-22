import assert from 'node:assert/strict'
import test from 'node:test'
import { apiBase, applyClientHeaders, clientMode, detectPlatform, endpointUrl, isBotcampApi } from './src/session.js'

test('client requests point at the api and name the platform', () => {
  assert.equal(clientMode({ VITE_BOTCAMP_CLIENT: '1' }), true)
  assert.equal(clientMode({}), false)
  assert.equal(apiBase({ VITE_BOTCAMP_API: 'https://botcamp.demox.site/' }), 'https://botcamp.demox.site')
  assert.equal(endpointUrl('https://botcamp.demox.site/', 'api/bot'), 'https://botcamp.demox.site/api/bot')
  assert.equal(endpointUrl('https://botcamp.demox.site', '/api/bot/feed'), 'https://botcamp.demox.site/api/bot/feed')
  assert.equal(endpointUrl('', 'api/bot'), 'api/bot')
  assert.equal(isBotcampApi('api/bot'), true)
  assert.equal(isBotcampApi('./api/bot/feed'), true)
  assert.equal(isBotcampApi('https://botcamp.demox.site/api/bot'), true)
  assert.equal(isBotcampApi('/assets/index.js'), false)
  const headers = applyClientHeaders({ 'content-type': 'application/json' }, 'session-token-value')
  assert.equal(headers.get('x-botcamp-client'), '1')
  assert.equal(headers.get('authorization'), 'Bearer session-token-value')
  assert.equal(detectPlatform({ userAgent: 'Windows NT 10.0', platform: 'Win32' }), 'windows')
  assert.equal(detectPlatform({ userAgent: 'Macintosh', platform: 'MacIntel' }), 'macos')
  assert.equal(detectPlatform({ userAgent: 'Mozilla Android', platform: 'Linux armv8l' }), 'android')
  assert.equal(detectPlatform({ userAgent: 'iPhone', platform: 'iPhone' }), 'ios')
})
