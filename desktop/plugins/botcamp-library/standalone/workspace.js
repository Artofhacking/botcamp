/* BotCamp Library workspace: file tree + create/edit/save on top of Vditor. */
(() => {
  'use strict'

  const PREFIX = (window.location.pathname.match(/^\/desk\/d\d+/) || [''])[0]
  const API = `${PREFIX}/md-reader`
  const CDN = `${PREFIX}/library/vditor`

  const $ = (id) => document.getElementById(id)
  const sidebar = $('sidebar')
  const pageParams = new URLSearchParams(location.search)
  const embedMode = pageParams.get('embed')
  const embedEditor = embedMode === 'editor'
  const embedRight = embedMode === 'right'
  if (embedEditor) document.body.classList.add('embed-editor')
  if (embedRight) {
    document.body.classList.add('embed-right')
    const treeToggle = $('docs-sidebar-toggle')
    if (treeToggle !== null) {
      let collapsed = false
      try { collapsed = localStorage.getItem('botcamp-docs-tree-collapsed') === '1' } catch {}
      const syncTree = () => {
        sidebar.classList.toggle('collapsed', collapsed)
        treeToggle.textContent = collapsed ? '»' : '«'
        treeToggle.title = collapsed ? '展开文档树' : '收起文档树'
        treeToggle.setAttribute('aria-label', collapsed ? '展开文档树' : '收起文档树')
        treeToggle.setAttribute('aria-expanded', String(!collapsed))
      }
      treeToggle.addEventListener('click', () => {
        collapsed = !collapsed
        try { localStorage.setItem('botcamp-docs-tree-collapsed', collapsed ? '1' : '0') } catch {}
        syncTree()
      })
      document.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'b') {
          event.preventDefault()
          treeToggle.click()
        }
      })
      syncTree()
    }
  }

  const treeEl = $('tree')
  const searchEl = $('search')
  const pathEl = $('doc-path')
  const statusEl = $('status')
  const saveBtn = $('save')
  const imageBtn = $('image')
  const imageInput = $('image-input')
  const renameBtn = $('rename')
  const deleteBtn = $('delete')
  const editorEl = $('editor')
  const emptyEl = $('empty')
  const toastEl = $('toast')
  const mediaViewEl = $('media-view')
  const mediaImageEl = $('media-image')
  const mediaVideoEl = $('media-video')
  const mediaCaptionEl = $('media-caption')
  const ctxMenuEl = $('ctx-menu')

  let docs = []
  let media = []
  let folders = []
  let folderInfo = {}
  let renaming = null
  let activeMediaPath = ''
  const expandedFolders = new Set([''])
  let activePath = ''
  let activeTitle = ''
  let dirty = false
  let vditor = null
  let editorReady = null
  let loadingValue = false
  let toastTimer = null
  let autoSaveTimer = null

  function toast(message) {
    toastEl.textContent = message
    toastEl.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200)
  }

  async function api(path, options = {}) {
    const init = { ...options, headers: { ...(options.headers || {}) } }
    if (init.body !== undefined) init.headers['content-type'] = 'application/json'
    const response = await fetch(`${API}${path}`, init)
    const payload = await response.json().catch(() => ({ ok: false, error: { message: `HTTP ${response.status}` } }))
    if (!response.ok || payload.ok !== true) {
      throw new Error(payload?.error?.message || `HTTP ${response.status}`)
    }
    return payload.value
  }

  function setStatus(text, isDirty = false) {
    if (statusEl === null) return
    statusEl.textContent = text
    statusEl.classList.toggle('dirty', isDirty)
  }

  function setDirty(next) {
    dirty = next
    setStatus(next ? '未保存' : activePath ? '已保存' : '', next)
  }

  function scheduleAutoSave() {
    if (autoSaveTimer !== null) clearTimeout(autoSaveTimer)
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null
      if (dirty && activePath !== '') void saveDoc({ silent: true })
    }, 1000)
  }

  function setActiveButtons(enabled) {
    for (const button of [saveBtn, imageBtn, renameBtn, deleteBtn]) {
      if (button !== null) button.disabled = !enabled
    }
  }

  function pathDirname(value) {
    const index = value.lastIndexOf('/')
    return index === -1 ? '' : value.slice(0, index)
  }

  function pathBasename(value) {
    return value.slice(value.lastIndexOf('/') + 1)
  }

  function docName(value) {
    const file = pathBasename(value)
    return file === 'index.md' ? pathBasename(pathDirname(value)) : file
  }

  /** Parent folder shown in the tree for one document path. */
  function folderOfDoc(docPath) {
    const directory = pathDirname(docPath)
    if (pathBasename(docPath) === 'index.md') {
      const parent = pathDirname(directory)
      return parent === 'docs' ? '' : parent
    }
    return directory === 'docs' ? '' : directory
  }

  function sortTree(node) {
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
      return String(a.name).localeCompare(String(b.name), 'zh')
    })
    for (const child of node.children) if (child.kind === 'folder') sortTree(child)
  }

  /** Build a Notion-like tree from the flat docs/folders payload. */
  function buildTree() {
    const root = { kind: 'folder', path: '', name: 'BotCamp 文档库', children: [] }
    const folderMap = new Map([['', root]])
    const docDirs = new Set(docs.filter((doc) => pathBasename(doc.path) === 'index.md').map((doc) => pathDirname(doc.path)))
    const ensureFolder = (path) => {
      if (path === '' || path === 'docs') return root
      if (folderMap.has(path)) return folderMap.get(path)
      const parent = ensureFolder(pathDirname(path))
      const node = { kind: 'folder', path, name: pathBasename(path), children: [], meta: folderInfo[path] }
      parent.children.push(node)
      folderMap.set(path, node)
      return node
    }
    for (const folder of folders) {
      if (!folder.startsWith('docs/') || folder.endsWith('/assets') || docDirs.has(folder)) continue
      ensureFolder(folder)
    }
    for (const doc of docs) {
      const parent = ensureFolder(folderOfDoc(doc.path))
      parent.children.push({
        kind: 'doc',
        path: doc.path,
        name: docName(doc.path),
        icon: doc.icon || '📄',
        meta: doc,
      })
    }
    for (const item of media) {
      root.children.push({
        kind: 'media',
        path: item.path,
        name: item.name,
        icon: item.type === 'video' ? '🎬' : '🖼️',
        meta: item,
      })
    }
    sortTree(root)
    return root
  }

  function pruneTree(node, query) {
    const own = `${node.name} ${node.path}`.toLowerCase()
    if (node.kind === 'folder' && own.includes(query)) return node
    if (node.kind !== 'folder' && own.includes(query)) return node
    const children = node.children.map((child) => pruneTree(child, query)).filter((child) => child !== null)
    if (children.length === 0) return null
    return { ...node, children }
  }

  function renderTreeNode(node, depth, parts) {
    const padding = 2 + depth * 14
    const isRoot = node.path === ''
    if (renaming !== null && renaming.path === node.path) {
      parts.push(`<div class="tree-node" data-path="${escapeAttr(node.path)}" data-kind="${node.kind}">
        <div class="tree-row" style="padding-left:${padding}px">
          <span class="tree-spacer"></span><span class="tree-icon">${node.kind === 'folder' ? '📁' : escapeHtml(node.icon || '📄')}</span>
          <input class="tree-rename" value="${escapeAttr(renaming.value)}" spellcheck="false">
        </div>
      </div>`)
      return
    }
    if (node.kind === 'folder') {
      const expanded = expandedFolders.has(node.path)
      parts.push(`<div class="tree-node" data-path="${escapeAttr(node.path)}" data-kind="folder">
        <div class="tree-row" style="padding-left:${padding}px">
          <button type="button" class="tree-twisty" data-act="toggle" aria-label="${expanded ? '收起' : '展开'}">${expanded ? '▾' : '▸'}</button>
          <span class="tree-icon">📁</span>
          <span class="tree-title">${escapeHtml(node.name)}</span>
          <span class="tree-actions">
            ${isRoot ? '' : '<button type="button" class="tree-act" data-act="add" title="新建">＋</button><button type="button" class="tree-act" data-act="more" title="更多">⋯</button>'}
          </span>
        </div>
      </div>`)
      if (expanded) for (const child of node.children) renderTreeNode(child, depth + 1, parts)
      return
    }
    if (node.kind === 'media') {
      parts.push(`<div class="tree-node${node.path === activeMediaPath ? ' active' : ''}" data-path="${escapeAttr(node.path)}" data-kind="media">
        <div class="tree-row doc-row" style="padding-left:${padding}px">
          <span class="tree-spacer"></span>
          <span class="tree-icon">${node.icon}</span>
          <span class="tree-title" title="${escapeAttr(node.path)}">${escapeHtml(node.name)}</span>
        </div>
      </div>`)
      return
    }
    parts.push(`<div class="tree-node${node.path === activePath ? ' active' : ''}" data-path="${escapeAttr(node.path)}" data-kind="doc">
      <div class="tree-row doc-row" style="padding-left:${padding}px">
        <span class="tree-spacer"></span>
        <span class="tree-icon">${escapeHtml(node.icon || '📄')}</span>
        <span class="tree-title" title="${escapeAttr(node.path)}">${escapeHtml(node.name)}</span>
        <span class="tree-actions"><button type="button" class="tree-act" data-act="more" title="更多">⋯</button></span>
      </div>
    </div>`)
  }

  function stopMediaPlayback() {
    mediaVideoEl.pause()
    mediaVideoEl.removeAttribute('src')
    mediaVideoEl.load()
  }

  async function openMedia(item) {
    if (dirty) await saveDoc({ silent: true })
    if (autoSaveTimer !== null) { clearTimeout(autoSaveTimer); autoSaveTimer = null }
    activePath = ''
    activeMediaPath = item.path
    dirty = false
    if (mediaVideoEl !== null) stopMediaPlayback()
    mediaViewEl.hidden = false
    editorEl.hidden = true
    emptyEl.hidden = true
    mediaCaptionEl.textContent = item.name
    mediaImageEl.hidden = true
    mediaVideoEl.hidden = true
    const src = `${PREFIX}/md-reader/raw?root=library&path=${encodeURIComponent(item.path)}`
    if (item.type === 'video') {
      mediaVideoEl.src = src
      mediaVideoEl.hidden = false
      mediaVideoEl.autoplay = false
    } else {
      mediaImageEl.src = src
      mediaImageEl.alt = item.name
      mediaImageEl.hidden = false
    }
    document.title = `${item.name} · BotCamp 文档库`
    renderTree()
  }

  function renderTree() {
    const query = searchEl.value.trim().toLowerCase()
    let tree = buildTree()
    if (query !== '') tree = pruneTree(tree, query) ?? { ...tree, children: [] }
    const parts = ['<div class="tree-section-row"><span class="tree-section">团队协作区</span><button type="button" class="tree-section-add" data-act="root-add" title="新建">＋</button></div>']
    renderTreeNode(tree, 0, parts)
    if ((tree.children ?? []).length === 0 && renaming === null) {
      parts.push(`<div class="tree-empty">${query ? '没有匹配的文档' : '还没有内容，点「新建」开始。'}</div>`)
    }
    treeEl.innerHTML = parts.join('')
    const input = treeEl.querySelector('.tree-rename')
    if (input !== null) {
      input.focus()
      input.select()
      let done = false
      const commit = () => {
        if (done) return
        done = true
        void commitRename(input.value)
      }
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); commit() }
        else if (event.key === 'Escape') { event.preventDefault(); done = true; renaming = null; renderTree() }
      })
      input.addEventListener('blur', commit)
    }
  }

  async function loadTree() {
    try {
      const value = await api('/tree')
      docs = Array.isArray(value.docs) ? value.docs : []
      media = Array.isArray(value.media) ? value.media : []
      folders = Array.isArray(value.folders) ? value.folders : []
      folderInfo = value.folderInfo !== null && typeof value.folderInfo === 'object' ? value.folderInfo : {}
      renderTree()
    } catch (error) {
      toast(`读取文档树失败：${error.message}`)
    }
  }

  function nextDefaultNumber(parent, kind) {
    const names = new Set()
    for (const doc of docs) {
      if (folderOfDoc(doc.path) === parent) names.add(docName(doc.path))
    }
    for (const folder of folders) {
      const folderParent = pathDirname(folder) === 'docs' ? '' : pathDirname(folder)
      if (folderParent === parent) names.add(pathBasename(folder))
    }
    const base = kind === 'doc' ? '新文档' : '新文件夹'
    for (let number = 1; number < 1000; number += 1) {
      if (!names.has(`${base} ${number}`) && !names.has(`${base}-${number}`)) return number
    }
    return Date.now()
  }

  async function createNode(parent, kind) {
    const number = nextDefaultNumber(parent, kind)
    const apiParent = parent === '' ? 'docs' : parent
    try {
      let value
      let title
      if (kind === 'doc') {
        title = `新文档 ${number}`
        value = await api('/create', { method: 'POST', body: JSON.stringify({ title, parent: apiParent }) })
      } else {
        title = `新文件夹 ${number}`
        value = await api('/mkdir', { method: 'POST', body: JSON.stringify({ name: title, parent: apiParent }) })
      }
      if (parent !== '') expandedFolders.add(parent)
      await loadTree()
      const actualName = kind === 'doc' ? docName(value.path) : pathBasename(value.path)
      renaming = { path: value.path, kind, value: actualName, openAfter: kind === 'doc' }
      renderTree()
    } catch (error) {
      toast(`新建失败：${error.message}`)
    }
  }

  function beginRename(node) {
    renaming = {
      path: node.path,
      kind: node.kind,
      value: node.kind === 'folder' ? node.name : node.name,
      openAfter: false,
    }
    renderTree()
  }

  async function commitRename(value) {
    const current = renaming
    if (current === null) return
    const clean = String(value ?? '').trim()
    renaming = null
    let nextPath = current.path
    if (clean !== '' && clean !== current.value) {
      try {
        const result = current.kind === 'doc'
          ? await api('/rename', { method: 'POST', body: JSON.stringify({ path: current.path, title: clean }) })
          : await api('/rename-folder', { method: 'POST', body: JSON.stringify({ path: current.path, name: clean }) })
        nextPath = result.path
      } catch (error) {
        toast(`重命名失败：${error.message}`)
      }
    }
    await loadTree()
    if (current.openAfter && current.kind === 'doc') {
      await openDoc(nextPath).catch((error) => toast(error.message))
    }
  }

  function resetEditor() {
    activePath = ''
    activeTitle = ''
    dirty = false
    if (vditor !== null) {
      loadingValue = true
      vditor.setValue('', true)
      loadingValue = false
    }
    editorEl.hidden = true
    emptyEl.hidden = false
    if (pathEl !== null) pathEl.textContent = '未选择文档'
    activeMediaPath = ''
    if (mediaViewEl !== null) mediaViewEl.hidden = true
    if (mediaVideoEl !== null) stopMediaPlayback()
    document.title = 'BotCamp 文档库'
    setActiveButtons(false)
    setStatus('')
  }

  async function deleteNode(node) {
    const folder = node.kind === 'folder'
    if (!window.confirm(`删除「${node.name}」？${folder ? '文件夹里的内容会一起移入 .trash。' : '会移入 .trash。'}`)) return
    try {
      if (folder) await api('/delete-folder', { method: 'POST', body: JSON.stringify({ path: node.path }) })
      else await api('/delete', { method: 'POST', body: JSON.stringify({ path: node.path }) })
      if (activePath === node.path || activePath.startsWith(`${node.path}/`)) resetEditor()
      await loadTree()
      toast('已移入 .trash')
    } catch (error) {
      toast(`删除失败：${error.message}`)
    }
  }

  function libraryBase() {
    return /^https?:$/u.test(location.protocol) ? location.origin : 'http://127.0.0.1:8765'
  }

  function documentLink(path) {
    return `botcamp://doc?path=${encodeURIComponent(path)}`
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      area.style.cssText = 'position:fixed;left:-9999px;top:0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    }
  }

  function formatDate(value) {
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) return '未知'
    return new Date(number).toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  }

  function hideContextMenu() {
    ctxMenuEl.hidden = true
    ctxMenuEl.innerHTML = ''
    ctxMenuEl._picker = undefined
  }

  function showContextMenu(anchor, items, onPick) {
    ctxMenuEl.innerHTML = items.map((item, index) => {
      if (item.separator === true) return '<div class="ctx-sep"></div>'
      if (item.info === true) return `<div class="ctx-info">${escapeHtml(item.label)}</div>`
      return `<button type="button" data-idx="${index}">${escapeHtml(item.label)}</button>`
    }).join('')
    ctxMenuEl.hidden = false
    ctxMenuEl.style.left = '0px'
    ctxMenuEl.style.top = '0px'
    const rect = anchor.getBoundingClientRect()
    const menu = ctxMenuEl.getBoundingClientRect()
    let left = rect.left
    let top = rect.bottom + 4
    if (left + menu.width > window.innerWidth - 8) left = window.innerWidth - menu.width - 8
    if (top + menu.height > window.innerHeight - 8) top = rect.top - menu.height - 4
    ctxMenuEl.style.left = `${Math.max(8, left)}px`
    ctxMenuEl.style.top = `${Math.max(8, top)}px`
    ctxMenuEl._picker = (index) => { hideContextMenu(); onPick(items[index]) }
  }

  function currentDoc() {
    return docs.find((doc) => doc.path === activePath)
  }

  function ensureEditor() {
    if (editorReady !== null) return editorReady
    if (typeof window.Vditor !== 'function') {
      editorReady = Promise.reject(new Error('Vditor 未加载'))
      return editorReady
    }
    editorEl.hidden = false
    emptyEl.hidden = true
    editorReady = new Promise((resolve, reject) => {
      try {
        vditor = new window.Vditor('editor', {
          cdn: CDN,
          lang: 'zh_CN',
          mode: 'ir',
          height: '100%',
          value: '',
          cache: { enable: false },
          counter: { enable: true },
          outline: { enable: !embedEditor && !embedRight, position: 'left' },
          preview: {
            theme: { current: 'light' },
            hljs: { enable: true, style: 'github' },
            math: { engine: 'KaTeX' },
            mermaid: { enable: true },
          },
          toolbar: [
            'headings', 'bold', 'italic', 'strike', '|',
            'list', 'ordered-list', 'check', 'quote', '|',
            'code', 'inline-code', 'link', 'table', '|',
            'undo', 'redo',
            ...(embedEditor || embedRight ? [] : ['|', 'outline']),
          ],
          toolbarConfig: { pin: true },
          input: () => {
            if (!loadingValue) {
              setDirty(true)
              scheduleAutoSave()
            }
          },
          after: () => {
            resolve(vditor)
          },
        })
      } catch (error) {
        reject(error)
      }
    })
    return editorReady
  }

  async function openDoc(path) {
    if (!path || path === activePath) return
    if (dirty && !window.confirm('当前文档还没有保存，切换会丢失修改。继续？')) return
    try {
      const value = await api('/read', { method: 'POST', body: JSON.stringify({ path }) })
      await ensureEditor()
      editorEl.hidden = false
      emptyEl.hidden = true
      // Resolve relative images/links against the document folder while the
      // source stays unchanged (raw host route, same /desk/dN prefix).
      const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
      const linkBase = `${PREFIX}/md-reader/raw?root=library&path=${encodeURIComponent(directory)}`
      vditor.vditor.options.preview.markdown.linkBase = linkBase
      vditor.vditor.lute.SetLinkBase?.(linkBase)
      loadingValue = true
      vditor.setValue(expandVideoBlocks(value.content || ''), true)
      loadingValue = false
      if (autoSaveTimer !== null) { clearTimeout(autoSaveTimer); autoSaveTimer = null }
      activeMediaPath = ''
      mediaViewEl.hidden = true
      stopMediaPlayback()
      activePath = path
      activeTitle = docName(path)
      if (pathEl !== null) pathEl.textContent = path
      document.title = `${activeTitle} · BotCamp 文档库`
      setActiveButtons(true)
      setDirty(false)
      renderTree()
      const source = vditor.vditor?.sv?.element
      if (source) {
        source.setSelectionRange?.(0, 0)
        source.scrollTop = 0
      }
      vditor.focus()
      if (value.truncated) toast('文件超过 4MB，编辑器只载入了前半部分')
    } catch (error) {
      loadingValue = false
      toast(`打开失败：${error.message}`)
    }
  }

  async function saveDoc(options = {}) {
    if (!activePath || vditor === null) return
    try {
      const content = collapseVideoBlocks(vditor.getValue())
      await api('/write', { method: 'POST', body: JSON.stringify({ path: activePath, content }) })
      setDirty(false)
      if (options.silent !== true) toast('已保存')
      await loadTree()
    } catch (error) {
      toast(`保存失败：${error.message}`)
    }
  }

  async function newDoc() {
    await createNode('', 'doc')
  }

  function pastedMediaFile(event) {
    const items = event.clipboardData?.items
    if (!items) return null
    for (const item of items) {
      if (item.kind !== 'file' || (!item.type.startsWith('image/') && !item.type.startsWith('video/'))) continue
      const blob = item.getAsFile()
      if (blob === null) continue
      const type = blob.type || 'image/png'
      const ext = type === 'image/jpeg' ? 'jpg' : (type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')
      return new File([blob], `pasted-${Date.now()}.${ext}`, { type })
    }
    return null
  }

  async function onPaste(event) {
    const file = pastedMediaFile(event)
    if (file === null) return
    event.preventDefault()
    event.stopPropagation()
    await uploadMedia(file)
  }

  /** Expand :::video blocks outside fenced code into playable HTML for Vditor. */
  function expandVideoBlocks(text) {
    const lines = String(text).split('\n')
    const out = []
    let fence = false
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (/^\s*```/.test(line)) {
        fence = !fence
        out.push(line)
        continue
      }
      if (!fence && line.trim() === ':::video') {
        const source = (lines[index + 1] || '').trim()
        const closing = lines[index + 2]
        if (source !== '' && closing !== undefined && closing.trim() === ':::') {
          const safe = source.replace(/"/g, '&quot;')
          out.push(`<video controls src="${safe}" style="max-width:100%;border-radius:8px"></video>`)
          index += 2
          continue
        }
      }
      out.push(line)
    }
    return out.join('\n')
  }

  /** Save playable HTML videos back as portable :::video blocks. */
  function collapseVideoBlocks(text) {
    return String(text).replace(/<video\b[^>]*\bsrc="([^"]+)"[^>]*>(?:\s*<\/video>)?/gi, (_match, src) => {
      return `:::video\n${src.replace(/&quot;/g, '"')}\n:::`
    })
  }

  async function uploadMedia(file) {
    if (!activePath || file === undefined) return
    if (file.size > 20 * 1024 * 1024) {
      toast('文件不能超过 20MB')
      return
    }
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error('读取图片失败'))
        reader.readAsDataURL(file)
      })
      const value = await api('/upload', { method: 'POST', body: JSON.stringify({ path: activePath, name: file.name, data }) })
      const current = vditor.getValue().replace(/\s*$/, '')
      const video = file.type.startsWith('video/') || /\.(?:mp4|webm|ogg|mov)$/i.test(file.name)
      const block = video
        ? `<video controls src="${value.path}" style="max-width:100%;border-radius:8px"></video>`
        : `![${file.name}](${value.path})`
      vditor.setValue(`${current}\n\n${block}\n`, true)
      setDirty(true)
      scheduleAutoSave()
      toast(video ? '视频已插入' : '图片已插入')
    } catch (error) {
      toast(`上传失败：${error.message}`)
    } finally {
      imageInput.value = ''
    }
  }

  async function renameDoc() {
    if (!activePath) return
    const doc = currentDoc()
    const title = window.prompt('新的标题', doc?.title || activeTitle)
    if (title === null) return
    const clean = title.trim()
    if (clean === '') return
    try {
      if (dirty) await saveDoc()
      const value = await api('/rename', { method: 'POST', body: JSON.stringify({ path: activePath, title: clean }) })
      activePath = ''
      await loadTree()
      await openDoc(value.path)
      toast('已重命名')
    } catch (error) {
      toast(`重命名失败：${error.message}`)
    }
  }

  async function deleteDoc() {
    if (!activePath) return
    if (!window.confirm(`把「${activeTitle}」移到 .trash？`)) return
    try {
      await api('/delete', { method: 'POST', body: JSON.stringify({ path: activePath }) })
      activePath = ''
      activeTitle = ''
      dirty = false
      if (vditor !== null) {
        loadingValue = true
        vditor.setValue('', true)
        loadingValue = false
      }
      editorEl.hidden = true
      emptyEl.hidden = false
      if (pathEl !== null) pathEl.textContent = '未选择文档'
      document.title = 'BotCamp 文档库'
      setActiveButtons(false)
      setStatus('')
      await loadTree()
      toast('已移到 .trash')
    } catch (error) {
      toast(`删除失败：${error.message}`)
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;')
  }

  // Wire controls.
  const openCreateMenu = (anchor, parent) => {
    showContextMenu(anchor, [
      { label: '📄 文档', value: 'doc' },
      { label: '📁 文件夹', value: 'folder' },
    ], (item) => { void createNode(parent, item.value) })
  }
  ctxMenuEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-idx]')
    if (button === null || typeof ctxMenuEl._picker !== 'function') return
    ctxMenuEl._picker(Number(button.dataset.idx))
  })
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#ctx-menu') && !event.target.closest('.tree-act') && !event.target.closest('.tree-section-add')) hideContextMenu()
  })
  window.addEventListener('resize', hideContextMenu)
  treeEl.addEventListener('click', (event) => {
    const sectionAdd = event.target.closest('.tree-section-add')
    if (sectionAdd !== null) {
      event.stopPropagation()
      openCreateMenu(sectionAdd, '')
      return
    }
    const nodeEl = event.target.closest('.tree-node')
    if (nodeEl === null) return
    const path = nodeEl.dataset.path ?? ''
    const kind = nodeEl.dataset.kind ?? 'folder'
    const title = nodeEl.querySelector('.tree-title')?.textContent?.trim()
    const node = { path, kind, name: title || pathBasename(path) }
    const actionEl = event.target.closest('[data-act]')
    if (actionEl !== null) {
      event.stopPropagation()
      const action = actionEl.dataset.act
      if (action === 'toggle') {
        if (expandedFolders.has(path)) expandedFolders.delete(path)
        else expandedFolders.add(path)
        renderTree()
      } else if (action === 'add') {
        openCreateMenu(actionEl, path)
      } else if (action === 'more') {
        const doc = kind === 'doc' ? docs.find((item) => item.path === path) : undefined
        const items = []
        items.push(
          { label: '重命名', value: 'rename' },
          { label: '删除', value: 'delete' },
          { label: '复制链接', value: 'link' },
        )
        if (kind === 'doc') {
          items.push(
            { separator: true },
            { info: true, label: `创建：${formatDate(doc?.created)}` },
            { info: true, label: `更新：${formatDate(doc?.mtime)}` },
          )
        } else {
          items.push(
            { separator: true },
            { info: true, label: `创建：${formatDate(folderInfo[path]?.created)}` },
          )
        }
        showContextMenu(actionEl, items, (item) => {
          if (item.value === 'rename') beginRename(node)
          else if (item.value === 'link') {
            const url = documentLink(path)
            void copyText(url).then((ok) => toast(ok ? `链接已复制：${url}` : url))
          } else void deleteNode(node)
        })
      }
      return
    }
    if (event.target.closest('.tree-rename') !== null) return
    if (kind === 'media') {
      const item = media.find((entry) => entry.path === path)
      if (item !== undefined) void openMedia(item)
      return
    }
    if (kind === 'folder') {
      if (expandedFolders.has(path)) expandedFolders.delete(path)
      else expandedFolders.add(path)
      renderTree()
    } else {
      void openDoc(path).then(() => document.body.classList.remove('nav-open')).catch((error) => toast(error.message))
    }
  })
  $('empty-new').addEventListener('click', () => { void createNode('', 'doc') })
  if ($('save') !== null) $('save').addEventListener('click', saveDoc)
  if (imageBtn !== null) imageBtn.addEventListener('click', () => imageInput.click())
  imageInput.addEventListener('change', () => uploadMedia(imageInput.files?.[0]))
  if ($('rename') !== null) $('rename').addEventListener('click', renameDoc)
  if ($('delete') !== null) $('delete').addEventListener('click', deleteDoc)
  $('menu').addEventListener('click', () => document.body.classList.toggle('nav-open'))
  $('sidebar-mask').addEventListener('click', () => document.body.classList.remove('nav-open'))
  searchEl.addEventListener('input', renderTree)
  editorEl.addEventListener('paste', onPaste, true)

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideContextMenu()
    const mod = event.metaKey || event.ctrlKey
    if (!mod) return
    if (event.key.toLowerCase() === 's') {
      event.preventDefault()
      saveDoc()
    } else if (event.key.toLowerCase() === 'n') {
      event.preventDefault()
      void createNode('', 'doc')
    } else if (event.key.toLowerCase() === 'p') {
      event.preventDefault()
      searchEl.focus()
    }
  })

  window.addEventListener('beforeunload', (event) => {
    if (!dirty) return
    event.preventDefault()
    event.returnValue = ''
  })

  // Diagnostics hook for the preview/tests; harmless in production.
  window.botcampWorkspace = {
    loadTree,
    save: saveDoc,
    get vditor() { return vditor },
    get activePath() { return activePath },
    get activeMediaPath() { return activeMediaPath },
    get dirty() { return dirty },
  }

  // Boot.
  loadTree().then(async () => {
    const requested = new URLSearchParams(window.location.search).get('path')
    const initial = requested || (docs.length > 0 ? docs[0].path : '')
    if (initial) await openDoc(initial)
  })
})()
