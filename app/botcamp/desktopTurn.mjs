/**
 * Desktop clients run the browser and the local workspace.
 * The server only notices when the model asks for one of those tools.
 * It never opens a page and never stores a cookie.
 */

const TOOLS = new Set(['browser_open', 'browser_read', 'computer_list', 'computer_read'])

const PLATFORM_HOSTS = {
  xiaoheihe: ['xiaoheihe.cn'],
  douyin: ['douyin.com'],
  kuaishou: ['kuaishou.com'],
  xiaohongshu: ['xiaohongshu.com'],
  bilibili: ['bilibili.com'],
  weibo: ['weibo.com'],
  weixin: ['weixin.qq.com'],
}

export function hostsForAccounts(accounts) {
  const hosts = []
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const list = PLATFORM_HOSTS[account?.platform] || []
    for (const host of list) {
      if (!hosts.includes(host)) hosts.push(host)
    }
  }
  return hosts
}

export function hostAllowed(url, hosts) {
  let parsed
  try { parsed = new URL(url) } catch { return false }
  if (parsed.protocol !== 'https:') return false
  const name = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (!name || name === 'localhost' || name.endsWith('.localhost') || name === 'metadata.google.internal') return false
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[)/.test(name)) return false
  return (Array.isArray(hosts) ? hosts : []).some((host) => name === host || name.endsWith(`.${host}`))
}

/** A model reply that is only a tool request. Prose, even with the word tool in it, is an answer. */
export function parseDesktopTool(reply) {
  let text = typeof reply === 'string' ? reply.trim() : ''
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  if (fenced) text = fenced[1].trim()
  if (!text.startsWith('{') || !text.endsWith('}')) return null
  let body
  try { body = JSON.parse(text) } catch { return null }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  if (!TOOLS.has(body.tool)) return null
  return {
    tool: body.tool,
    url: typeof body.url === 'string' ? body.url.trim() : '',
    path: typeof body.path === 'string' ? body.path.trim() : '',
  }
}

export function desktopToolNote(hosts) {
  const where = Array.isArray(hosts) && hosts.length > 0 ? hosts.join('、') : '（还没有绑定这个用户的站点）'
  return [
    '用户正在自己的 BotCamp 桌面客户端里。浏览器和本机工作区只在这台电脑上。',
    '要不要打开页面由你判断。需要时只回复一行 JSON，不要加别的字：',
    `{"tool":"browser_open","url":"https://..."} 打开这个用户自己的创作者后台，域名只限 ${where}。`,
    '{"tool":"browser_read"} 读取当前页上看得见的文字。',
    '{"tool":"computer_list"} 列出用户在这台电脑上选过的工作区文件。',
    '{"tool":"computer_read","path":"相对路径"} 读取其中一份文本。',
    '不需要工具就直接回答。没有登录态时说明还缺这个号的 cookie，不要编造后台里才看得到的数字。',
  ].join('\n')
}

export function clipToolResult(value) {
  const text = typeof value === 'string' ? value : typeof value?.text === 'string' ? value.text : ''
  return text.replace(/\s+$/g, '').slice(0, 6000)
}
