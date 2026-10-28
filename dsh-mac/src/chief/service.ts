/** Main-process 主编 calls: the ledger, this app's browser, and the chosen workspace. */

import { postLedger, type LedgerResult } from './ledger.ts'
import { allowedHosts } from './policy.ts'
import { listWorkspace, readWorkspace, rememberWorkspace } from './workspace.ts'

export interface ChiefBrowser {
  open(url: string, hosts: readonly string[]): Promise<string>
  read(): Promise<string>
  close(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Desktop-owned tools used by the 主编 panel. */
export function createChiefService(options: {
  browser: ChiefBrowser
  userDataDir: string
  fetchImpl?: typeof fetch
}): {
  handle(request: unknown): Promise<LedgerResult | string>
  close(): void
} {
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    close: () => { options.browser.close() },
    async handle(request: unknown): Promise<LedgerResult | string> {
      if (!isRecord(request) || typeof request.op !== 'string') throw new Error('没有这个接口。')
      if (request.op === 'ledger') {
        const endpoint = typeof request.endpoint === 'string' ? request.endpoint : ''
        const token = typeof request.token === 'string' ? request.token : ''
        return postLedger(endpoint, request.payload, token, fetchImpl)
      }
      if (request.op === 'browser_open') {
        const url = typeof request.url === 'string' ? request.url : ''
        return options.browser.open(url, allowedHosts(request.hosts))
      }
      if (request.op === 'browser_read') return options.browser.read()
      if (request.op === 'computer_list') return listWorkspace(options.userDataDir)
      if (request.op === 'computer_read') {
        const path = typeof request.path === 'string' ? request.path : ''
        return readWorkspace(options.userDataDir, path)
      }
      if (request.op === 'computer_choose') {
        const root = typeof request.root === 'string' ? request.root : ''
        return rememberWorkspace(options.userDataDir, root)
      }
      throw new Error('没有这个接口。')
    },
  }
}
