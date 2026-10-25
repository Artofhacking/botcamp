// 自媒体账号开通时配好的三个职责。只说明各自做什么。
// 不规定用户跟谁聊，也不建群、不设主 bot、不发问候。

export const DEFAULT_TEAM = Object.freeze([
  {
    name: '总负责人',
    brief: '协调写手与运营。你进公司先看到团队；问某个号或全部号的状态，由我出报表与进度汇报。',
    color: 'blue',
    avatar: { shape: 'star' },
  },
  {
    name: '写手',
    brief: '负责生产。把定下来的选题写成标题、正文、口播和脚本。拍摄和剪辑写进脚本里。',
    color: 'green',
    avatar: { shape: 'moon' },
  },
  {
    name: '运营',
    brief: '负责经营。安排排期和发布，看互动和账号数据。还没有稳定的品牌合作时，商务也放在这里。',
    color: 'orange',
    avatar: { shape: 'wave' },
  },
])

function botId(value) {
  if (!value || typeof value !== 'object') return ''
  if (typeof value.id === 'string' && value.id) return value.id
  if (typeof value.bot?.id === 'string') return value.bot.id
  return ''
}

// 逐个创建。某一个失败不影响账号，也不影响已经创建成功的其他 bot。
export async function provisionDefaultTeam(callKernel, { kernelKey, sessionToken }) {
  const created = []
  const failed = []
  if (typeof kernelKey !== 'string' || !/^u_[A-Za-z0-9_-]{8,}$/.test(kernelKey)) {
    return { created, failed: DEFAULT_TEAM.map(member => member.name) }
  }
  for (const member of DEFAULT_TEAM) {
    // 内核把人设存在 instructions 里。brief 会被丢掉，页面上的说明是空的。
    const payload = {
      name: member.name,
      brief: member.brief,
      instructions: member.brief,
      color: member.color,
      avatar: member.avatar,
    }
    try {
      const upstream = await callKernel('/api/bot', {
        method: 'POST',
        body: JSON.stringify({ endpoint: 'create-bot', payload }),
        namespace: kernelKey,
        sessionToken,
      })
      const text = await upstream.text()
      let parsed = null
      try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
      const value = parsed?.value
      if (!upstream.ok || parsed?.ok === false || !botId(value)) {
        failed.push(member.name)
        continue
      }
      created.push({ name: member.name, value })
    } catch {
      failed.push(member.name)
    }
  }
  return { created, failed }
}
