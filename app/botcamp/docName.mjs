/** Visible document title: no .md suffix, and never a raw timestamp. */

export function visibleDocName(name) {
  return String(name || '').replace(/\.md$/i, '')
}

export function isRawTimestampName(name) {
  return /\d{10,}/.test(visibleDocName(name))
}

function cleanTitle(raw) {
  return String(raw || '')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~`#]/g, '')
    .replace(/\$+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Heading, otherwise the first readable line, otherwise a short fallback. */
export function readableDocName(markdown, fallback = '笔记') {
  const text = String(markdown || '').replace(/\r\n/g, '\n')
  const heading = text.match(/^\s{0,3}#{1,6}[ \t]+(.+?)[ \t]*$/m)
  let raw = heading ? cleanTitle(heading[1]) : ''
  if (!raw || isRawTimestampName(raw)) {
    raw = ''
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('```') || trimmed.startsWith('~~~')) continue
      if (/^\[\^.+]:/.test(trimmed)) continue
      const inner = trimmed.replace(/^(?:>\s?)+/, '').trim()
      if (!inner || inner.startsWith('[!')) continue
      const cleaned = cleanTitle(inner)
      if (cleaned && !isRawTimestampName(cleaned)) {
        raw = cleaned
        break
      }
    }
  }
  if (!raw || isRawTimestampName(raw)) raw = cleanTitle(visibleDocName(fallback))
  if (!raw || isRawTimestampName(raw)) raw = '笔记'
  return raw.slice(0, 40)
}
