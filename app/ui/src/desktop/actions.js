/** Panel actions for the local browser. They never call the server to open a page. */
export function browserActions({ browsers, bridge, ui }) {
  if (!browsers || !bridge) return {}
  return {
    browserNewTab: (id) => {
      browsers.ensureTabs(id)
      const tabId = browsers.openTab(id)
      ui.set((state) => ({ ...state, details: id, view: 'browser', renaming: false, tab: null }))
      return tabId
    },
    browserPick: (id, tabId) => {
      browsers.activate(id, tabId)
      ui.set((state) => ({ ...state, details: id, view: 'browser' }))
    },
    browserEnsure: (botId) => browsers.ensureTabs(botId),
    browserCloseTab: (botId, tabId) => browsers.closeTab(botId, tabId),
    browserActivate: (botId, tabId) => browsers.activate(botId, tabId),
    browserShow: (tabId, box) => browsers.show(tabId, box),
    browserNavigate: (tabId, input) => browsers.navigate(tabId, input),
    browserCommand: (tabId, name) => browsers.command(tabId, name),
    browserFocus: (tabId) => browsers.focus(tabId),
    browserImport: {
      sources: () => bridge.importSources(),
      pick: () => bridge.importPick(),
      live: (source, close) => bridge.importLive(source, close),
      apply: (botId, id) => bridge.importApply(`bot:${botId}`, id),
      cancel: (id) => bridge.importCancel(id),
    },
  }
}
