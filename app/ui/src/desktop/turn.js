import { hostAllowed } from '../../../botcamp/desktopTurn.mjs'

const STEPS = 3

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function pageBrief(page) {
  const url = typeof page?.url === 'string' ? page.url : ''
  const title = typeof page?.title === 'string' ? page.title : ''
  const text = typeof page?.text === 'string' ? page.text.trim() : ''
  const body = text.slice(0, 5000)
  if (!body) {
    return `打开了 ${url || '页面'}${title ? `（${title}）` : ''}。页面上没有读到正文。创作者后台需要这个号自己的登录 cookie。`
  }
  return [`页面 ${title}`.trim(), url, body].filter(Boolean).join('\n')
}

export function browserBotId(sessionId) {
  if (sessionId === 'co_writer' || sessionId === 'co_ops') return sessionId
  return 'co_chief'
}

/**
 * Runs one model tool on this machine. The server never receives cookie values.
 * @param {{ browsers: any, bridge: any, botId: string, tool: { tool: string, url?: string, path?: string, hosts?: string[] } }} job
 */
export async function runModelTool({ browsers, bridge, botId, tool }) {
  if (!tool || typeof tool.tool !== 'string') return { text: '没有这个本机工具。' }
  if (tool.tool === 'browser_open') {
    if (!hostAllowed(tool.url, tool.hosts)) {
      return { text: '没有打开。这个地址不属于当前用户自己的账号站点。' }
    }
    browsers.ensureTabs(botId)
    let tab = browsers.tabs.getSnapshot()[botId]?.active
    if (!tab) tab = browsers.openTab(botId)
    const opened = await browsers.navigate(tab, tool.url)
    if (!opened) return { text: '页面没有打开。' }
    await delay(300)
    try {
      return { text: pageBrief(await browsers.read(botId)) }
    } catch (error) {
      return { text: error instanceof Error ? error.message : '页面没有读到。' }
    }
  }
  if (tool.tool === 'browser_read') {
    try {
      return { text: pageBrief(await browsers.read(botId)) }
    } catch {
      return { text: '这台电脑上还没有打开的页面。' }
    }
  }
  if (tool.tool === 'computer_list') return { text: String(await bridge.workspaceList()) }
  if (tool.tool === 'computer_read') return { text: String(await bridge.workspaceRead(tool.path)) }
  return { text: '没有这个本机工具。' }
}

/** Ask the model, and when it requests a tool, run that tool here and ask again. */
export async function desktopCompanySend({ call, sessionId, text, runTool }) {
  let payload = { sessionId, text, desktop: true }
  for (let step = 0; step < STEPS; step += 1) {
    const value = await call('send', payload)
    if (!value?.tool) return value
    const result = await runTool(value.tool)
    payload = { sessionId, text, desktop: true, resume: true, toolResult: result }
  }
  const value = await call('send', {
    ...payload,
    toolResult: { text: '本机工具已经用过了。请根据已有结果直接回答，不要再要工具。' },
  })
  if (value?.tool) throw new Error('模型这次没有答上来。')
  return value
}
