/** Mount 主编 inside the real DSH window. Does not replace the sidebar or the browser. */

import { contextBridge, ipcRenderer } from 'electron'
import { installChiefPanel } from '/tmp/dsh-desktop/dsh-plugin-desktop/src/client/chief-panel.ts'

const CHIEF_CHANNEL = 'dsh-desktop:chief'
const DIRECTORY_CHANNEL = 'dsh-desktop:native-directory-picker'

const bridge = {
  protocolVersion: 1 as const,
  ledger: (endpoint: string, payload: unknown, token: string) => ipcRenderer.invoke(CHIEF_CHANNEL, {
    op: 'ledger', endpoint, payload, token,
  }),
  browser: {
    open: (url: string, hosts: readonly string[]) => ipcRenderer.invoke(CHIEF_CHANNEL, {
      op: 'browser_open', url, hosts: [...hosts],
    }),
    read: () => ipcRenderer.invoke(CHIEF_CHANNEL, { op: 'browser_read' }),
  },
  computer: {
    list: () => ipcRenderer.invoke(CHIEF_CHANNEL, { op: 'computer_list' }),
    read: (path: string) => ipcRenderer.invoke(CHIEF_CHANNEL, { op: 'computer_read', path }),
    choose: (root: string) => ipcRenderer.invoke(CHIEF_CHANNEL, { op: 'computer_choose', root }),
  },
}

window.dshChief = bridge
window.__DSH_DIRECTORY_PICKER__ = {
  pick: () => ipcRenderer.invoke(DIRECTORY_CHANNEL),
}

contextBridge.exposeInMainWorld('dshChief', {
  protocolVersion: 1,
  ledger: bridge.ledger,
  browser: { open: bridge.browser.open, read: bridge.browser.read },
  computer: {
    list: bridge.computer.list,
    read: bridge.computer.read,
    choose: bridge.computer.choose,
  },
})

function mount(): void {
  installChiefPanel()
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
else mount()
