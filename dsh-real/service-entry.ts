import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import { createElectronChiefBrowser } from '/tmp/dsh-desktop/dsh-plugin-desktop/src/chief/electron-browser.ts'
import { createChiefService } from '/tmp/dsh-desktop/dsh-plugin-desktop/src/chief/service.ts'

export function createPackagedChief(options: {
  BrowserWindow: new (options: BrowserWindowConstructorOptions) => BrowserWindow
  userDataDir: string
}) {
  return createChiefService({
    browser: createElectronChiefBrowser({ BrowserWindow: options.BrowserWindow }),
    userDataDir: options.userDataDir,
  })
}
