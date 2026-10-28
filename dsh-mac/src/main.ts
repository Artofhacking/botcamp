import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { CHIEF_CHANNEL } from './chief/contract.ts'
import { createElectronChiefBrowser } from './chief/electron-browser.ts'
import { createChiefService } from './chief/service.ts'

declare const __DSH_VERSION__: string

const DIRECTORY_CHANNEL = 'dsh-desktop:chief-directory'

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 440,
    height: 760,
    minWidth: 360,
    minHeight: 520,
    title: `DSH Desktop ${__DSH_VERSION__}`,
    backgroundColor: '#1c1e22',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.once('ready-to-show', () => {
    window.setTitle(`DSH Desktop ${__DSH_VERSION__}`)
    window.show()
  })
  void window.loadFile(join(__dirname, 'index.html'))
  return window
}

app.setName('DSH Desktop')
app.on('window-all-closed', () => { app.quit() })

void app.whenReady().then(() => {
  const chief = createChiefService({
    browser: createElectronChiefBrowser({ BrowserWindow }),
    userDataDir: app.getPath('userData'),
  })
  const trusted = (sender: Electron.WebContents): boolean => {
    const owner = BrowserWindow.fromWebContents(sender)
    return owner !== undefined && !owner.isDestroyed() && sender === owner.webContents
  }
  ipcMain.handle(CHIEF_CHANNEL, (event, request: unknown) => {
    if (!trusted(event.sender)) throw new Error('untrusted')
    return chief.handle(request)
  })
  ipcMain.handle(DIRECTORY_CHANNEL, async event => {
    if (!trusted(event.sender)) return null
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(owner!, {
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  app.on('before-quit', () => { chief.close() })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
