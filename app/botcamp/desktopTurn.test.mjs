import assert from 'node:assert/strict'
import test from 'node:test'
import { clipToolResult, hostAllowed, hostsForAccounts, parseDesktopTool } from './desktopTurn.mjs'

test('only a whole tool object is a desktop request', () => {
  assert.equal(parseDesktopTool('平台是小黑盒'), null)
  assert.equal(parseDesktopTool('请 browser_open 一下'), null)
  assert.equal(parseDesktopTool('{"tool":"browser_open","url":"https://www.xiaoheihe.cn/"}').tool, 'browser_open')
  assert.equal(parseDesktopTool('```json\n{"tool":"browser_read"}\n```').tool, 'browser_read')
  assert.equal(parseDesktopTool('{"tool":"shell","url":"https://www.xiaoheihe.cn/"}'), null)
})

test('the model may open only the signed-in account host', () => {
  assert.deepEqual(hostsForAccounts([{ platform: 'xiaoheihe' }, { platform: 'douyin' }]), ['xiaoheihe.cn', 'douyin.com'])
  assert.equal(hostAllowed('https://www.xiaoheihe.cn/creator', ['xiaoheihe.cn']), true)
  assert.equal(hostAllowed('https://example.com/', ['xiaoheihe.cn']), false)
  assert.equal(hostAllowed('http://www.xiaoheihe.cn/', ['xiaoheihe.cn']), false)
  assert.equal(hostAllowed('https://169.254.169.254/', ['xiaoheihe.cn']), false)
  assert.equal(clipToolResult({ text: 'x'.repeat(7000) }).length, 6000)
})
