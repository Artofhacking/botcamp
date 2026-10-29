/* BotCamp Library workspace: file tree + create/edit/save on top of Vditor. */
(() => {
  'use strict'

  const PREFIX = (window.location.pathname.match(/^\/desk\/d\d+/) || [''])[0]
  const API = `${PREFIX}/md-reader`
  const CDN = `${PREFIX}/library/vditor`

  const $ = (id) => document.getElementById(id)
  const sidebar = $('sidebar')
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

  let docs = []
  let media = []
  let activePath = ''
  let activeTitle = ''
  let dirty = false
  let vditor = null
  let editorReady = null
  let loadingValue = false
  let toastTimer = null

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
    statusEl.textContent = text
    statusEl.classList.toggle('dirty', isDirty)
  }

  function setDirty(next) {
    dirty = next
    setStatus(next ? '未保存' : activePath ? '已保存' : '', next)
  }

  function setActiveButtons(enabled) {
    saveBtn.disabled = !enabled
    imageBtn.disabled = !enabled
    renameBtn.disabled = !enabled
    deleteBtn.disabled = !enabled
  }

  function renderTree() {
    const query = searchEl.value.trim().toLowerCase()
    const visible = docs.filter((doc) => {
      if (query === '') return true
      return `${doc.title} ${doc.path}`.toLowerCase().includes(query)
    })
    const groups = new Map()
    for (const doc of visible) {
      const slug = doc.path.split('/')[1] || '未分组'
      if (!groups.has(slug)) groups.set(slug, [])
      groups.get(slug).push(doc)
    }
    const parts = []
    if (groups.size === 0) {
      parts.push(`<div class="tree-empty">${query ? '没有匹配的文档' : '还没有文档，点「新建文档」开始。'}</div>`)
    } else {
      for (const [slug, items] of groups) {
        parts.push(`<div class="group-label">${escapeHtml(slug)}</div>`)
        for (const doc of items) {
          parts.push(`<button class="file-row${doc.path === activePath ? ' active' : ''}" data-path="${escapeAttr(doc.path)}" title="${escapeAttr(doc.description || doc.path)}">
            <span class="file-icon">${escapeHtml(doc.icon || '📄')}</span>
            <span class="file-title">${escapeHtml(doc.title || slug)}</span>
            <span class="file-meta">${escapeHtml(String(doc.updated || ''))}</span>
          </button>`)
        }
      }
    }
    if (media.length > 0) {
      parts.push('<div class="group-label">media</div>')
      for (const item of media) {
        parts.push(`<div class="media-row" title="${escapeAttr(item.path)}">🖼 ${escapeHtml(item.name)}</div>`)
      }
    }
    treeEl.innerHTML = parts.join('')
    for (const row of treeEl.querySelectorAll('.file-row')) {
      row.addEventListener('click', () => {
        openDoc(row.dataset.path).catch((error) => toast(error.message))
        document.body.classList.remove('nav-open')
      })
    }
  }

  async function loadTree() {
    try {
      const value = await api('/tree')
      docs = Array.isArray(value.docs) ? value.docs : []
      media = Array.isArray(value.media) ? value.media : []
      renderTree()
    } catch (error) {
      toast(`读取文档树失败：${error.message}`)
    }
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
          mode: 'sv',
          height: '100%',
          value: '',
          cache: { enable: false },
          counter: { enable: true },
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
            'undo', 'redo', '|', 'edit-mode', 'preview', 'outline', 'fullscreen',
          ],
          toolbarConfig: { pin: true },
          input: () => {
            if (!loadingValue) setDirty(true)
          },
          after: () => {
            if (window.matchMedia('(max-width: 760px)').matches) vditor.setPreviewMode('editor')
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
      // Resolve relative images/links against the document folder while the
      // source stays unchanged (raw host route, same /desk/dN prefix).
      const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
      const linkBase = `${PREFIX}/md-reader/raw?root=library&path=${encodeURIComponent(directory)}`
      vditor.vditor.options.preview.markdown.linkBase = linkBase
      vditor.vditor.lute.SetLinkBase?.(linkBase)
      loadingValue = true
      vditor.setValue(value.content || '', true)
      loadingValue = false
      activePath = path
      const doc = docs.find((item) => item.path === path)
      activeTitle = doc?.title || path
      pathEl.textContent = path
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

  async function saveDoc() {
    if (!activePath) return
    try {
      const content = vditor?.getValue() ?? ''
      await api('/write', { method: 'POST', body: JSON.stringify({ path: activePath, content }) })
      setDirty(false)
      toast('已保存')
      await loadTree()
    } catch (error) {
      toast(`保存失败：${error.message}`)
    }
  }

  async function newDoc() {
    const title = window.prompt('文档标题')
    if (title === null) return
    const clean = title.trim()
    if (clean === '') return
    try {
      const value = await api('/create', { method: 'POST', body: JSON.stringify({ title: clean }) })
      await loadTree()
      await openDoc(value.path)
      toast('已新建')
    } catch (error) {
      toast(`新建失败：${error.message}`)
    }
  }

  async function uploadImage(file) {
    if (!activePath || file === undefined) return
    if (file.size > 20 * 1024 * 1024) {
      toast('图片不能超过 20MB')
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
      vditor.insertValue(`\n![${file.name}](${value.path})\n`)
      setDirty(true)
      toast('图片已插入')
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
      pathEl.textContent = '未选择文档'
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
  $('new-doc').addEventListener('click', newDoc)
  $('empty-new').addEventListener('click', newDoc)
  $('refresh').addEventListener('click', loadTree)
  $('save').addEventListener('click', saveDoc)
  imageBtn.addEventListener('click', () => imageInput.click())
  imageInput.addEventListener('change', () => uploadImage(imageInput.files?.[0]))
  $('rename').addEventListener('click', renameDoc)
  $('delete').addEventListener('click', deleteDoc)
  $('menu').addEventListener('click', () => document.body.classList.toggle('nav-open'))
  $('sidebar-mask').addEventListener('click', () => document.body.classList.remove('nav-open'))
  searchEl.addEventListener('input', renderTree)

  document.addEventListener('keydown', (event) => {
    const mod = event.metaKey || event.ctrlKey
    if (!mod) return
    if (event.key.toLowerCase() === 's') {
      event.preventDefault()
      saveDoc()
    } else if (event.key.toLowerCase() === 'n') {
      event.preventDefault()
      newDoc()
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
    get dirty() { return dirty },
  }

  // Boot.
  loadTree().then(async () => {
    const requested = new URLSearchParams(window.location.search).get('path')
    const initial = requested || (docs.length > 0 ? docs[0].path : '')
    if (initial) await openDoc(initial)
  })
})()
