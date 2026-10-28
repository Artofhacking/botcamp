import { contextBridge, ipcRenderer } from 'electron'
import { CHIEF_CHANNEL } from './chief/contract.ts'

const DIRECTORY_CHANNEL = 'dsh-desktop:chief-directory'

contextBridge.exposeInMainWorld('dshChief', Object.freeze({
  protocolVersion: 1,
  ledger: (endpoint: string, payload: unknown, token: string) => ipcRenderer.invoke(CHIEF_CHANNEL, {
    op: 'ledger', endpoint, payload, token,
  }),
  browser: Object.freeze({
    open: (url: string, hosts: readonly string[]) => ipcRenderer.invoke(CHIEF_CHANNEL, {
      op: 'browser_open', url, hosts: [...hosts],
    }),
    read: () => ipcRenderer.invoke(CHIEF_CHANNEL, { op: 'browser_read' }),
  }),
  computer: Object.freeze({
    list: () => ipcRenderer.invoke(CHIEF_CHANNEL, { op: 'computer_list' }),
    read: (path: string) => ipcRenderer.invoke(CHIEF_CHANNEL, { op: 'computer_read', path }),
    choose: (root: string) => ipcRenderer.invoke(CHIEF_CHANNEL, { op: 'computer_choose', root }),
  }),
}))

contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', Object.freeze({
  pick: (): Promise<string | null> => ipcRenderer.invoke(DIRECTORY_CHANNEL),
}))
