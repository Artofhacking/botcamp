import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import 'katex/dist/katex.min.css'
import { renderLibraryMarkdown } from './libraryMarkdown.js'
import {
  createLibraryNode,
  deleteLibraryNode,
  getLibraryNode,
  listLibrary,
  updateLibraryNode,
  uploadLibraryAsset,
} from './libraryApi.js'

const MEDIA_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm'

function sniffType(file) {
  const type = String(file?.type || '').toLowerCase()
  if (type === 'image/jpg') return 'image/jpeg'
  if (type) return type
  const name = String(file?.name || '').toLowerCase()
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg'
  if (name.endsWith('.gif')) return 'image/gif'
  if (name.endsWith('.webp')) return 'image/webp'
  if (name.endsWith('.mp4')) return 'video/mp4'
  if (name.endsWith('.webm')) return 'video/webm'
  return ''
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result || '')
      const comma = text.indexOf(',')
      resolve(comma >= 0 ? text.slice(comma + 1) : text)
    }
    reader.onerror = () => reject(reader.error || new Error('读文件失败'))
    reader.readAsDataURL(file)
  })
}

function filesFromClipboard(data) {
  const found = []
  if (data?.files?.length) found.push(...data.files)
  if (data?.items) {
    for (const item of data.items) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file) found.push(file)
    }
  }
  const seen = new Set()
  return found.filter((file) => {
    const key = `${file.name}:${file.size}:${file.type}:${file.lastModified}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function LibraryPreview({ markdown }) {
  const html = useMemo(() => renderLibraryMarkdown(markdown || ''), [markdown])
  if (!String(markdown || '').trim()) return h('p', { className: 'lib-muted' }, '（空文档）')
  return h('div', {
    className: 'lib-md',
    onClick: (event) => {
      const link = event.target.closest?.('a')
      if (!link) return
      const href = link.getAttribute('href') || ''
      if (!href.startsWith('doc://')) return
      event.preventDefault()
      window.dispatchEvent(new CustomEvent('botcamp:doc-link', { detail: { href } }))
    },
    dangerouslySetInnerHTML: { __html: html },
  })
}

function childrenOf(nodes, parentId) {
  const parent = parentId || null
  return nodes
    .filter((node) => (node.parentId || null) === parent)
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
      return a.name.localeCompare(b.name, 'zh')
    })
}

function Tree({ nodes, parentId, depth, open, onToggle, selectedId, onSelect }) {
  const kids = childrenOf(nodes, parentId)
  if (kids.length === 0) return null
  return h('ul', { className: 'lib-tree' }, kids.map((node) => h('li', { key: node.id },
    h('button', {
      type: 'button',
      className: selectedId === node.id ? 'active' : undefined,
      style: { paddingLeft: `${8 + depth * 14}px` },
      onClick: () => {
        onSelect(node.id)
        if (node.kind === 'folder') onToggle(node.id)
      },
    }, `${node.kind === 'folder' ? (open.has(node.id) ? '▾ ' : '▸ ') : ''}${node.name}`),
    node.kind === 'folder' && open.has(node.id)
      ? h(Tree, { nodes, parentId: node.id, depth: depth + 1, open, onToggle, selectedId, onSelect })
      : null)))
}

export function LibraryPanel({ focusId, onClose, onConsumedFocus }) {
  const [nodes, setNodes] = useState([])
  const [selectedId, setSelectedId] = useState(focusId || null)
  const [open, setOpen] = useState(() => new Set())
  const [mode, setMode] = useState(focusId ? 'read' : 'edit')
  const [title, setTitle] = useState('')
  const [draft, setDraft] = useState('')
  const [kind, setKind] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [composer, setComposer] = useState(null)
  const [composerName, setComposerName] = useState('')
  const fileRef = useRef(null)
  const areaRef = useRef(null)
  const caretRef = useRef(null)

  const selected = useMemo(() => nodes.find((node) => node.id === selectedId) || null, [nodes, selectedId])

  const reload = async () => {
    const data = await listLibrary()
    const next = data.nodes || []
    setNodes(next)
    setOpen((prev) => {
      const merged = new Set(prev)
      for (const node of next) if (node.kind === 'folder') merged.add(node.id)
      return merged
    })
    return next
  }

  useEffect(() => {
    let stopped = false
    reload().catch((failure) => { if (!stopped) setError(failure?.message || '文档库打不开') })
    return () => { stopped = true }
  }, [])

  useEffect(() => {
    if (!focusId) return
    setSelectedId(focusId)
    setMode('read')
    onConsumedFocus?.()
  }, [focusId])

  useEffect(() => {
    if (!selectedId) {
      setKind(null)
      setTitle('')
      setDraft('')
      return undefined
    }
    let stopped = false
    getLibraryNode(selectedId).then((data) => {
      if (stopped) return
      const node = data.node
      if (!node) return
      setKind(node.kind)
      setTitle(node.name || '')
      setDraft(node.content || '')
    }).catch((failure) => { if (!stopped) setError(failure?.message || '打不开这篇文档') })
    return () => { stopped = true }
  }, [selectedId])

  const parentForCreate = () => {
    if (!selected) return null
    if (selected.kind === 'folder') return selected.id
    return selected.parentId || null
  }

  const create = async (event) => {
    event.preventDefault()
    const name = composerName.trim()
    if (!name || busy) return
    setBusy(true)
    setError('')
    try {
      const made = await createLibraryNode({
        kind: composer,
        parentId: parentForCreate(),
        name,
        content: composer === 'file' ? '' : undefined,
      })
      setComposer(null)
      setComposerName('')
      await reload()
      setSelectedId(made.node.id)
      if (made.node.kind === 'file') {
        setMode('edit')
        setKind('file')
        setTitle(made.node.name)
        setDraft(made.node.content || '')
      }
    } catch (failure) {
      setError(failure?.message || '创建失败')
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!selectedId || kind !== 'file' || busy) return
    setBusy(true)
    setError('')
    try {
      const updated = await updateLibraryNode({ id: selectedId, name: title, content: draft })
      setTitle(updated.node.name)
      setDraft(updated.node.content || '')
      await reload()
    } catch (failure) {
      setError(failure?.message || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!selectedId || busy) return
    if (!window.confirm('删除这篇文档？文件夹会连同里面的文件一起删除。')) return
    setBusy(true)
    setError('')
    try {
      await deleteLibraryNode(selectedId)
      setSelectedId(null)
      await reload()
    } catch (failure) {
      setError(failure?.message || '删除失败')
    } finally {
      setBusy(false)
    }
  }

  const insertFiles = async (files) => {
    if (!files.length || kind !== 'file' || busy) return
    setBusy(true)
    setError('')
    try {
      let next = draft
      const area = areaRef.current
      const placed = area && document.activeElement === area
        ? { start: area.selectionStart, end: area.selectionEnd }
        : caretRef.current
      let start = Number.isInteger(placed?.start) ? placed.start : next.length
      let end = Number.isInteger(placed?.end) ? placed.end : next.length
      for (const file of files) {
        const contentType = sniffType(file)
        const saved = await uploadLibraryAsset({ contentType, data: await readBase64(file) })
        const snippet = String(saved.contentType || contentType).startsWith('video/')
          ? `<video src="${saved.url}" controls></video>\n`
          : `![](${saved.url})\n`
        next = `${next.slice(0, start)}${snippet}${next.slice(end)}`
        start += snippet.length
        end = start
      }
      setDraft(next)
    } catch (failure) {
      setError(failure?.message || '上传失败')
    } finally {
      setBusy(false)
    }
  }

  const toggle = (id) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return h('section', { className: 'lib-panel', 'aria-label': '文档库' },
    h('header', { className: 'lib-head' },
      h('strong', null, '文档库'),
      h('div', { className: 'lib-head-actions' },
        h('button', { type: 'button', onClick: onClose }, '关闭'))),
    h('div', { className: 'lib-body' },
      h('nav', { className: 'lib-nav', 'aria-label': '文件夹' },
        composer
          ? h('form', { className: 'lib-create', onSubmit: create },
            h('input', {
              'aria-label': composer === 'folder' ? '文件夹名称' : '文档名称',
              value: composerName,
              placeholder: composer === 'folder' ? '文件夹名称' : '文档名称',
              onChange: (event) => setComposerName(event.target.value),
              autoFocus: true,
            }),
            h('div', { className: 'lib-tools' },
              h('button', { type: 'submit', className: 'lib-primary', disabled: busy }, '创建'),
              h('button', { type: 'button', onClick: () => { setComposer(null); setComposerName('') } }, '取消')))
          : h('div', { className: 'lib-tools' },
            h('button', { type: 'button', onClick: () => setComposer('folder') }, '新建文件夹'),
            h('button', { type: 'button', onClick: () => setComposer('file') }, '新建文档')),
        error ? h('p', { className: 'lib-error', role: 'alert' }, error) : null,
        nodes.length === 0
          ? h('p', { className: 'lib-muted' }, '还没有文档。可以新建文件夹或文档，正文没有固定格式。')
          : h(Tree, { nodes, parentId: null, depth: 0, open, onToggle: toggle, selectedId, onSelect: setSelectedId })),
      h('div', { className: 'lib-editor' },
        !selectedId
          ? h('p', { className: 'lib-muted' }, '选一篇文档，或新建一篇。')
          : kind === 'folder'
            ? h('p', { className: 'lib-muted' }, `文件夹「${title || selected?.name || ''}」。在这里新建的文档会放进这个文件夹。`)
            : h('div', { className: 'lib-editor-fill' },
              h('input', {
                'aria-label': '文档名称',
                value: title,
                onChange: (event) => setTitle(event.target.value),
              }),
              h('div', { className: 'lib-editor-bar' },
                h('button', { type: 'button', className: mode === 'edit' ? 'active' : undefined, onClick: () => setMode('edit') }, '编辑'),
                h('button', { type: 'button', className: mode === 'read' ? 'active' : undefined, onClick: () => setMode('read') }, '预览'),
                h('button', { type: 'button', onClick: () => fileRef.current?.click(), disabled: busy }, '上传图片或视频'),
                h('button', { type: 'button', className: 'lib-primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
                h('button', { type: 'button', onClick: remove, disabled: busy }, '删除'),
                h('input', {
                  ref: fileRef,
                  type: 'file',
                  accept: MEDIA_ACCEPT,
                  multiple: true,
                  hidden: true,
                  'aria-label': '选择图片或视频',
                  onChange: (event) => {
                    const files = [...(event.target.files || [])]
                    event.target.value = ''
                    void insertFiles(files)
                  },
                })),
              h('p', { className: 'lib-muted' }, '正文没有固定栏目。需要时可用引用式提示（内部、对外、待核实）、脚注、==高亮== 和 $公式$。图片和视频上传后是能直接打开的地址。'),
              mode === 'read'
                ? h('div', { className: 'lib-preview' }, h(LibraryPreview, { markdown: draft }))
                : h('textarea', {
                  ref: areaRef,
                  'aria-label': '正文',
                  value: draft,
                  onChange: (event) => setDraft(event.target.value),
                  onSelect: (event) => { caretRef.current = { start: event.target.selectionStart, end: event.target.selectionEnd } },
                  onPaste: (event) => {
                    const files = filesFromClipboard(event.clipboardData)
                    if (!files.length) return
                    event.preventDefault()
                    void insertFiles(files)
                  },
                  placeholder: '随便写。没有规定要写哪些小节。',
                })))))
}
