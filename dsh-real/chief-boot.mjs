/** Start 主编 inside the real DSH Desktop process, then launch the upstream shell. */

import { app, BrowserWindow, ipcMain } from 'electron'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createPackagedChief } = require('./chief-service.cjs')

const CHIEF_CHANNEL = 'dsh-desktop:chief'
let chief

function service() {
  if (!chief) {
    chief = createPackagedChief({
      BrowserWindow,
      userDataDir: app.getPath('userData'),
    })
  }
  return chief
}

ipcMain.handle(CHIEF_CHANNEL, async (event, request) => {
  const contents = event.sender
  const owner = BrowserWindow.fromWebContents(contents)
  if (!owner || contents.isDestroyed() || event.senderFrame !== contents.mainFrame) {
    throw new Error('dsh-plugin-desktop: untrusted 主编 sender')
  }
  return service().handle(request)
})

app.on('will-quit', () => {
  chief?.close()
})

await import('./main.js')
