import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import footnote from 'markdown-it-footnote'
import mark from 'markdown-it-mark'
import katexPluginModule from '@vscode/markdown-it-katex'
import katex from 'katex'

const katexPlugin = katexPluginModule.default || katexPluginModule
import sanitizeHtml from 'sanitize-html'

const CALLOUTS = {
  内部: 'lib-callout lib-callout-in',
  对外: 'lib-callout lib-callout-out',
  待核实: 'lib-callout lib-callout-check',
}

const mathBin = { slots: [], nonce: 'KATEX' }

function calloutPlugin(md) {
  md.core.ruler.after('inline', 'lib_callout', (state) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i].type !== 'blockquote_open') continue
      let inline = null
      for (let j = i + 1; j < tokens.length; j += 1) {
        if (tokens[j].type === 'blockquote_close') break
        if (tokens[j].type === 'inline') {
          inline = tokens[j]
          break
        }
      }
      if (!inline) continue
      const match = /^\[!(内部|对外|待核实)\]/.exec(inline.content || '')
      if (!match) continue
      const after = inline.content.slice(match[0].length)
      if (after !== '' && !/^[\t \r\n]/.test(after)) continue
      const kind = match[1]
      tokens[i].attrJoin('class', CALLOUTS[kind])
      const rest = after.replace(/^[\t ]*\r?\n/, '').replace(/^[\t ]+/, '')
      inline.content = rest
      inline.children = rest ? (md.parseInline(rest, state.env)[0]?.children || []) : []
      const label = new state.Token('html_inline', '', 0)
      label.content = `<span class="lib-callout-label">${kind}</span>`
      inline.children.unshift(label)
    }
  })
}

function safeMediaSrc(src) {
  if (typeof src !== 'string' || !src || src.length > 18 * 1024 * 1024) return false
  if (/^https?:\/\//i.test(src)) return true
  if (/^\/api\/library\/asset\/[a-f0-9]{32}$/.test(src)) return true
  if (/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src)) return true
  if (/^data:video\/(mp4|webm);base64,[a-z0-9+/=\s]+$/i.test(src)) return true
  return false
}

function mediaTag(tagName, attribs) {
  const src = attribs.src || ''
  if (!safeMediaSrc(src)) return { tagName: 'span', attribs: {} }
  if (tagName === 'img') {
    const next = { src }
    if (attribs.alt) next.alt = attribs.alt
    if (attribs.title) next.title = attribs.title
    return { tagName: 'img', attribs: next }
  }
  if (tagName === 'source') {
    const next = { src }
    if (attribs.type === 'video/mp4' || attribs.type === 'video/webm') next.type = attribs.type
    return { tagName: 'source', attribs: next }
  }
  return { tagName: 'video', attribs: { src, controls: 'controls' } }
}

const sanitizeOptions = {
  allowedTags: [
    'a', 'p', 'br', 'hr', 'blockquote', 'pre', 'code', 'em', 'strong', 's', 'del',
    'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'img', 'video', 'source', 'input', 'sup', 'section', 'span', 'mark',
  ],
  allowedAttributes: {
    a: ['href', 'name', 'id', 'class', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title'],
    video: ['src', 'controls'],
    source: ['src', 'type'],
    code: ['class'],
    pre: ['class'],
    span: ['class'],
    blockquote: ['class'],
    li: ['id', 'class'],
    ol: ['class', 'start'],
    ul: ['class'],
    section: ['class'],
    hr: ['class'],
    sup: ['class'],
    th: ['style', 'align'],
    td: ['style', 'align'],
    input: ['type', 'checked', 'disabled', 'class'],
  },
  allowedStyles: {
    th: { 'text-align': [/^(left|right|center)$/] },
    td: { 'text-align': [/^(left|right|center)$/] },
  },
  allowedSchemes: ['http', 'https', 'mailto', 'doc'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    img: mediaTag,
    video: mediaTag,
    source: mediaTag,
    input: (_tagName, attribs) => {
      if (attribs.type !== 'checkbox') return { tagName: 'span', attribs: {} }
      const next = { type: 'checkbox', disabled: 'disabled', class: 'task-list-item-checkbox' }
      if (Object.hasOwn(attribs, 'checked')) next.checked = 'checked'
      return { tagName: 'input', attribs: next }
    },
  },
}

function stashMath(rule) {
  return (...args) => {
    const html = rule(...args)
    const id = mathBin.slots.length
    mathBin.slots.push(html)
    return `${mathBin.nonce}${id}END`
  }
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
})
md.use(taskLists)
md.use(footnote)
md.use(mark)
md.use(katexPlugin, { katex, throwOnError: false, trust: false, output: 'html' })
md.use(calloutPlugin)

const renderLinkOpen = md.renderer.rules.link_open
  || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href') || ''
  if (/^https?:\/\//i.test(href)) {
    tokens[idx].attrSet('target', '_blank')
    tokens[idx].attrSet('rel', 'noreferrer')
  }
  if (href.startsWith('doc://')) tokens[idx].attrJoin('class', 'lib-doc-link')
  return renderLinkOpen(tokens, idx, options, env, self)
}

for (const name of ['math_inline', 'math_inline_block', 'math_block']) {
  const rule = md.renderer.rules[name]
  if (rule) md.renderer.rules[name] = stashMath(rule)
}

export function renderLibraryMarkdown(markdown) {
  const source = typeof markdown === 'string' ? markdown : ''
  mathBin.slots = []
  mathBin.nonce = `KATEX${Math.random().toString(36).slice(2, 10).toUpperCase().replace(/[^A-Z0-9]/g, 'A')}X`
  const raw = md.render(source)
  const clean = sanitizeHtml(raw, sanitizeOptions)
  return clean.replace(new RegExp(`${mathBin.nonce}(\\d+)END`, 'g'), (_all, id) => mathBin.slots[Number(id)] || '')
}
