import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import VditorModule from 'vditor'

const Vditor = VditorModule?.default || VditorModule
import 'vditor/dist/index.css'
import { isRawTimestampName, readableDocName, visibleDocName } from '../../botcamp/docName.mjs'
import {
  createLibraryNode,
  deleteLibraryNode,
  getLibraryNode,
  listLibrary,
  updateLibraryNode,
  uploadLibraryAsset,
} from './libraryApi.js'

function shownName(node) {
  if (!node) return ''
  if (node.kind === 'file' && isRawTimestampName(node.name)) return readableDocName(node.content || '', '')
  return visibleDocName(node.name)
}

const MEDIA_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm'
const MAX_IMAGE = 4 * 1024 * 1024
const MAX_VIDEO = 12 * 1024 * 1024

function vditorCdn() {
  return new URL('vditor/', document.baseURI).href.replace(/\/$/, '')
}

function isDark() {
  return document.body.hasAttribute('data-ds-dark-theme')
}

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

function escapeAttr(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;')
}

async function storeMedia(files) {
  const chunks = []
  for (const file of files) {
    const contentType = sniffType(file)
    if (!contentType) return { error: `不支持的文件：${file.name || '未命名'}` }
    const video = contentType.startsWith('video/')
    if (file.size <= 0 || file.size > (video ? MAX_VIDEO : MAX_IMAGE)) {
      return { error: video ? '视频太大或是空的。' : '图片太大或是空的。' }
    }
    const saved = await uploadLibraryAsset({ contentType, data: await readBase64(file) })
    const url = String(saved?.url || '')
    if (!/^https?:\/\//i.test(url)) return { error: '上传没有返回可用的地址。' }
    chunks.push(video
      ? `<video src="${escapeAttr(url)}" controls></video>\n\n`
      : `![](${url})\n\n`)
  }
  return { markdown: chunks.join('') }
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
      style: { paddingLeft: `${6 + depth * 12}px` },
      onClick: () => {
        onSelect(node.id)
        if (node.kind === 'folder') onToggle(node.id)
      },
    }, `${node.kind === 'folder' ? (open.has(node.id) ? '▾ ' : '▸ ') : ''}${visibleDocName(node.name)}`),
    node.kind === 'folder' && open.has(node.id)
      ? h(Tree, { nodes, parentId: node.id, depth: depth + 1, open, onToggle, selectedId, onSelect })
      : null)))
}

function DocEditor({ docId, markdown, editorRef, onChange, onFlush }) {
  const hostRef = useRef(null)
  const onChangeRef = useRef(onChange)
  const onFlushRef = useRef(onFlush)
  onChangeRef.current = onChange
  onFlushRef.current = onFlush

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    let dead = false
    const cdn = vditorCdn()
    const dark = isDark()
    let ready = false
    const editor = new Vditor(host, {
      value: markdown || '',
      mode: 'wysiwyg',
      lang: 'zh_CN',
      theme: dark ? 'dark' : 'classic',
      cdn,
      height: '100%',
      cache: { enable: false },
      outline: { enable: false, position: 'left' },
      placeholder: '随便写。没有规定要写哪些小节。',
      toolbar: [
        'headings', 'bold', 'italic', 'strike', '|',
        'list', 'ordered-list', 'check', 'quote', '|',
        'code', 'inline-code', 'link', 'table', '|',
        'upload', 'undo', 'redo',
      ],
      toolbarConfig: { pin: true },
      preview: {
        mode: 'editor',
        actions: [],
        theme: { current: dark ? 'dark' : 'light', path: `${cdn}/dist/css/content-theme` },
        hljs: { style: dark ? 'github-dark' : 'github', lineNumber: false },
        markdown: { mark: true, footnotes: true, callout: true, sanitize: true },
      },
      hint: { emojiPath: `${cdn}/dist/images/emoji` },
      link: {
        isOpen: false,
        click(anchor) {
          const href = anchor?.getAttribute?.('href') || ''
          if (href.startsWith('doc://')) {
            window.dispatchEvent(new CustomEvent('botcamp:doc-link', { detail: { href } }))
            return
          }
          if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener')
        },
      },
      upload: {
        accept: MEDIA_ACCEPT,
        multiple: true,
        max: MAX_VIDEO,
        handler: async (files) => {
          try {
            const stored = await storeMedia(files)
            if (stored.error) return stored.error
            if (stored.markdown && !dead) editor.insertValue(stored.markdown)
          } catch (failure) {
            return failure?.message || '上传失败'
          }
          return null
        },
      },
      input() {
        if (!dead) onChangeRef.current?.()
      },
      after() {
        if (dead) {
          try { editor.destroy() } catch { /* init lost the race with unmount */ }
          return
        }
        ready = true
        editorRef.current = editor
        onChangeRef.current?.()
      },
    })

    const slot = host.parentElement
    const fit = () => {
      const next = slot?.clientHeight || 0
      if (next > 0) host.style.height = `${next}px`
    }
    fit()
    const observer = new ResizeObserver(fit)
    if (slot) observer.observe(slot)

    const onColor = () => {
      if (dead || !editorRef.current) return
      const nextDark = isDark()
      editorRef.current.setTheme(
        nextDark ? 'dark' : 'classic',
        nextDark ? 'dark' : 'light',
        nextDark ? 'github-dark' : 'github',
        `${vditorCdn()}/dist/css/content-theme`,
      )
    }
    window.addEventListener('botcamp:color', onColor)

    return () => {
      dead = true
      window.removeEventListener('botcamp:color', onColor)
      observer.disconnect()
      if (!ready) return
      let value
      try { value = editor.getValue() } catch { value = undefined }
      editorRef.current = null
      if (value != null) onFlushRef.current?.(value)
      try { editor.destroy() } catch { /* already torn down */ }
    }
  }, [docId])

  return h('div', { className: 'lib-vditor-slot' },
    h('div', { ref: hostRef, 'data-doc-id': docId }))
}

export function LibraryPanel({ focusId, onClose, onConsumedFocus }) {
  const [nodes, setNodes] = useState([])
  const [selectedId, setSelectedId] = useState(focusId || null)
  const [open, setOpen] = useState(() => new Set())
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState(null)
  const [loaded, setLoaded] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [composer, setComposer] = useState(null)
  const [composerName, setComposerName] = useState('')
  const editorRef = useRef(null)
  const titleRef = useRef('')
  const selectedRef = useRef(selectedId)
  const savedRef = useRef({ id: null, name: '', content: '' })
  const timerRef = useRef(null)
  selectedRef.current = selectedId

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

  const persist = async () => {
    const saved = savedRef.current
    const id = saved.id
    if (!id || id !== selectedRef.current) return
    const editor = editorRef.current
    if (!editor) return
    const name = titleRef.current.trim()
    if (!name) return
    const content = editor.getValue()
    if (name === saved.name && content === saved.content) return
    try {
      const updated = await updateLibraryNode({ id, name, content })
      if (savedRef.current.id !== id || selectedRef.current !== id) return
      const returned = updated.node.content || ''
      const returnedName = visibleDocName(updated.node.name)
      const current = editorRef.current?.getValue?.()
      savedRef.current = { id, name: returnedName, content: returned }
      if (returnedName !== titleRef.current.trim()) {
        titleRef.current = returnedName
        setTitle(returnedName)
      }
      if (current === content && returned !== content && editorRef.current) {
        editorRef.current.setValue(returned)
        savedRef.current.content = editorRef.current.getValue()
      } else if (current != null && current !== content) {
        queueSave()
      }
      setError('')
      await reload()
    } catch (failure) {
      setError(failure?.message || '保存失败')
    }
  }

  const queueSave = () => {
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { void persist() }, 650)
  }

  const flush = (value) => {
    clearTimeout(timerRef.current)
    const saved = savedRef.current
    const name = titleRef.current.trim()
    if (!saved.id || !name || value == null) return
    if (name === saved.name && value === saved.content) return
    const id = saved.id
    void updateLibraryNode({ id, name, content: value }).then((updated) => {
      if (savedRef.current.id === id) {
        savedRef.current = { id, name: visibleDocName(updated.node.name), content: updated.node.content || '' }
      }
    }).catch((failure) => setError(failure?.message || '保存失败'))
  }

  useEffect(() => {
    let stopped = false
    reload().catch((failure) => { if (!stopped) setError(failure?.message || '文档库打不开') })
    return () => { stopped = true }
  }, [])

  useEffect(() => {
    if (!focusId) return
    setSelectedId(focusId)
    onConsumedFocus?.()
  }, [focusId])

  useEffect(() => {
    if (!selectedId) {
      setKind(null)
      setTitle('')
      titleRef.current = ''
      setLoaded(null)
      savedRef.current = { id: null, name: '', content: '' }
      return undefined
    }
    let stopped = false
    setLoaded(null)
    getLibraryNode(selectedId).then((data) => {
      if (stopped) return
      const node = data.node
      if (!node) return
      const label = shownName(node)
      setKind(node.kind)
      setTitle(label)
      titleRef.current = label
      savedRef.current = { id: node.id, name: visibleDocName(node.name), content: node.content || '' }
      setLoaded({ id: node.id, content: node.content || '' })
    }).catch((failure) => { if (!stopped) setError(failure?.message || '打不开这篇文档') })
    return () => { stopped = true }
  }, [selectedId])

  useEffect(() => () => { clearTimeout(timerRef.current) }, [])

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
    } catch (failure) {
      setError(failure?.message || '创建失败')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!selectedId || busy) return
    if (!window.confirm('删除这篇文档？文件夹会连同里面的文件一起删除。')) return
    clearTimeout(timerRef.current)
    savedRef.current = { id: null, name: '', content: '' }
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

  const toggle = (id) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const fileOpen = kind === 'file' && loaded?.id === selectedId

  return h('section', { className: 'lib-panel', 'aria-label': '文档库' },
    h('header', { className: 'lib-head' },
      h('strong', null, '文档库'),
      h('div', { className: 'lib-head-actions' },
        h('button', {
          type: 'button',
          className: 'lib-close',
          onClick: onClose,
          'aria-label': '关闭文档库',
          title: '关闭文档库',
        }, '关闭'))),
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
              h('button', { type: 'submit', disabled: busy }, '创建'),
              h('button', { type: 'button', onClick: () => { setComposer(null); setComposerName('') } }, '取消')))
          : h('div', { className: 'lib-tools' },
            h('button', { type: 'button', onClick: () => setComposer('folder') }, '新建文件夹'),
            h('button', { type: 'button', onClick: () => setComposer('file') }, '新建文档'),
            selectedId ? h('button', { type: 'button', onClick: remove, disabled: busy }, '删除') : null),
        error ? h('p', { className: 'lib-error', role: 'alert' }, error) : null,
        nodes.length === 0
          ? h('p', { className: 'lib-muted' }, '还没有文档。')
          : h(Tree, { nodes, parentId: null, depth: 0, open, onToggle: toggle, selectedId, onSelect: setSelectedId })),
      h('div', { className: 'lib-editor' },
        !selectedId
          ? h('p', { className: 'lib-muted lib-empty' }, '选一篇文档，或新建一篇。')
          : kind === 'folder'
            ? h('p', { className: 'lib-muted lib-empty' }, `文件夹「${title || visibleDocName(selected?.name)}」`)
            : !fileOpen
              ? h('p', { className: 'lib-muted lib-empty' }, '正在打开…')
              : h('div', { className: 'lib-editor-fill' },
                h('input', {
                  className: 'lib-name',
                  'aria-label': '文档名称',
                  value: title,
                  onChange: (event) => {
                    titleRef.current = event.target.value
                    setTitle(event.target.value)
                    queueSave()
                  },
                }),
                h(DocEditor, {
                  docId: loaded.id,
                  markdown: loaded.content,
                  editorRef,
                  onChange: queueSave,
                  onFlush: flush,
                })))))
}
