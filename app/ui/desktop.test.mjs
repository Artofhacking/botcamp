import assert from 'node:assert/strict'
import test from 'node:test'
import { withComputer } from './src/desktop/computer.js'
import { cookiePreview, cookiesForHosts, parseCookieExport } from './src/desktop/cookies.js'
import { dshBrowser } from './src/desktop/host.js'
import { browserBotId, pageBrief, runModelTool } from './src/desktop/turn.js'

test('cookie files, JSON, and Playwright storageState stay scoped to the account', () => {
  const netscape = parseCookieExport([
    '# Netscape HTTP Cookie File',
    '.xiaoheihe.cn\tTRUE\t/\tTRUE\t1893456000\tsession\tok',
    '.example.com\tTRUE\t/\tFALSE\t0\tother\tno',
  ].join('\n'))
  assert.equal(netscape.cookies.length, 2)
  assert.equal(netscape.cookies[0].secure, true)

  const json = parseCookieExport(JSON.stringify([
    { name: 'a', value: '1', domain: '.xiaoheihe.cn', path: '/', expires: 1893456000 },
  ]))
  assert.equal(json.cookies[0].name, 'a')

  const storage = parseCookieExport(JSON.stringify({
    cookies: [{ name: 'b', value: '2', domain: 'www.xiaoheihe.cn', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
    origins: [{ origin: 'https://www.xiaoheihe.cn', localStorage: [{ name: 'k', value: 'v' }] }],
  }))
  assert.deepEqual(storage.notes, ['local-storage-left'])
  const preview = cookiePreview(storage, 'state.json')
  assert.equal(preview.cookies, 1)
  assert.equal(preview.sites[0].session, 1)
  assert.equal(JSON.stringify(preview).includes('"2"'), false)

  const { kept, dropped } = cookiesForHosts(
    [...netscape.cookies, ...storage.cookies],
    ['xiaoheihe.cn'],
  )
  assert.equal(kept.every((cookie) => cookie.domain.includes('xiaoheihe')), true)
  assert.equal(dropped.some((row) => row.name === 'other' && row.reason === 'not this account'), true)
})

test('主编 uses DSH Desktop browser and computer, not a Tauri bridge', async () => {
  globalThis.dsBotApp = { browser: { views: { navigate() {} }, workspaceList() { return 'tauri-files' } } }
  delete globalThis.dshDesktop
  assert.equal(dshBrowser(), null)

  const browser = {
    acquire(key) { return Promise.resolve({ lease: key, partition: 'persist' }) },
    release() { return Promise.resolve() },
    onOpenRequested() { return () => {} },
  }
  globalThis.dshDesktop = {
    protocolVersion: 1,
    browser,
    computer: {
      list() { return Promise.resolve({ entries: [{ path: '稿/标题.md' }] }) },
      read(file) { return Promise.resolve({ text: `正文 ${file}` }) },
    },
  }
  assert.equal(dshBrowser(), browser)
  const bridge = withComputer(browser, async () => { throw new Error('host') })
  assert.match(await bridge.workspaceList(), /稿\/标题\.md/)
  assert.match(await bridge.workspaceRead('稿/标题.md'), /正文 稿\/标题\.md/)
  assert.match(await bridge.workspaceRead('../secret'), /路径不在本机工作区里/)
  const listed = await runModelTool({
    browsers: null,
    bridge,
    botId: 'co_chief',
    tool: { tool: 'computer_list' },
  })
  assert.match(listed.text, /稿\/标题\.md/)
  assert.equal(listed.text.includes('tauri-files'), false)

  delete globalThis.dshDesktop
  delete globalThis.dsBotApp
})

test('主编 owns the room browser, and an empty page does not invent figures', () => {
  assert.equal(browserBotId('co_room_mac_01'), 'co_chief')
  assert.equal(browserBotId('co_writer'), 'co_writer')
  const brief = pageBrief({ url: 'https://www.xiaoheihe.cn/', title: '登录', text: '' })
  assert.match(brief, /登录 cookie/)
  assert.doesNotMatch(brief, /粉丝/)
})
