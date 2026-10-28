/**
 * The window DSH Desktop injects. Protocol 1 is the browser this app already owns.
 * The Tauri shell is not a way in.
 */
export function dshBrowser() {
  const desktop = globalThis.dshDesktop
  if (desktop?.protocolVersion !== 1 || !desktop.browser || typeof desktop.browser !== 'object') return null
  return desktop.browser
}

export function dshComputer() {
  const computer = globalThis.dshDesktop?.computer
  if (!computer || typeof computer !== 'object') return null
  return computer
}
