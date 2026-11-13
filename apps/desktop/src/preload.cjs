const { contextBridge, ipcRenderer } = require("electron");

/** Listen for a main-process signal without handing the IPC event to the renderer. */
function subscribe(channel) {
  return (listener) => {
    const handler = () => listener();
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.off(channel, handler);
  };
}

const pendingLinks = [];
const linkListeners = new Set();
ipcRenderer.on("desktop.links.url", (_event, link) => {
  if (linkListeners.size === 0) {
    pendingLinks.push(link);
    if (pendingLinks.length > 8) pendingLinks.shift();
    return;
  }
  for (const listener of linkListeners) listener(link);
});

contextBridge.exposeInMainWorld("botcampDesktop", {
  platform: process.platform,
  nativeWindowFrame: process.platform === "win32",
  badge: {
    set: (count) => ipcRenderer.invoke("desktop.badge.set", count),
  },
  computer: {
    managesHostChoice: true,
    requestAccess: () => ipcRenderer.invoke("desktop.computer.requestAccess"),
    revokeAccess: () => ipcRenderer.invoke("desktop.computer.revokeAccess"),
    onConfigure: subscribe("desktop.computer.configure"),
  },
  settings: {
    onOpen: subscribe("desktop.settings.open"),
  },
  device: {
    state: () => ipcRenderer.invoke("desktop.device.state"),
    setAllowed: (allowed) => ipcRenderer.invoke("desktop.device.setAllowed", allowed),
  },
  locale: {
    set: (locale) => ipcRenderer.invoke("desktop.locale.set", locale),
  },
  menu: {
    onCommand: (listener) => {
      // The IpcRendererEvent stays in the preload: the renderer only sees the command.
      const handler = (_event, command) => listener(command);
      ipcRenderer.on("desktop.menu.command", handler);
      return () => ipcRenderer.off("desktop.menu.command", handler);
    },
  },
  monitoring: {
    enabled: () => ipcRenderer.invoke("desktop.monitoring.enabled"),
  },
  passkeys: {
    rpIds: () => ipcRenderer.invoke("desktop.passkeys.rpIds"),
  },
  // Only macOS ships a system recognizer helper; elsewhere dictation keeps its provider path.
  ...(process.platform === "darwin"
    ? {
        speech: {
          start: (language, session) =>
            ipcRenderer.invoke("desktop.speech.start", language, session),
          stop: (session) => ipcRenderer.invoke("desktop.speech.stop", session),
          abort: (session) => ipcRenderer.invoke("desktop.speech.abort", session),
          onEvent: (listener) => {
            // The IpcRendererEvent stays in the preload: the renderer only sees the payload.
            const handler = (_event, payload) => listener(payload);
            ipcRenderer.on("desktop.speech.event", handler);
            return () => ipcRenderer.off("desktop.speech.event", handler);
          },
        },
      }
    : {}),
  window: {
    close: () => ipcRenderer.invoke("desktop.window.close"),
    minimize: () => ipcRenderer.invoke("desktop.window.minimize"),
    toggleMaximize: () => ipcRenderer.invoke("desktop.window.toggleMaximize"),
    state: () => ipcRenderer.invoke("desktop.window.state"),
  },
  update: {
    state: () => ipcRenderer.invoke("desktop.update.state"),
    check: () => ipcRenderer.invoke("desktop.update.check"),
    download: () => ipcRenderer.invoke("desktop.update.download"),
    install: () => ipcRenderer.invoke("desktop.update.install"),
  },
  links: {
    open: (url) => ipcRenderer.invoke("desktop.links.open", url),
    onUrl: (listener) => {
      linkListeners.add(listener);
      const queued = pendingLinks.splice(0);
      for (const link of queued) listener(link);
      return () => linkListeners.delete(listener);
    },
  },
  oauth: {
    open: (url) => ipcRenderer.invoke("desktop.oauth.open", url),
    cancel: (url) => ipcRenderer.invoke("desktop.oauth.cancel", url),
    onCallback: (listener) => {
      // The IpcRendererEvent stays in the preload: the renderer only sees the code.
      const handler = (_event, callback) => listener(callback);
      ipcRenderer.on("desktop.oauth.callback", handler);
      return () => ipcRenderer.off("desktop.oauth.callback", handler);
    },
  },
});
