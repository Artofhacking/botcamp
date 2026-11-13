import type { IpcMainInvokeEvent } from "electron";
import type { AppTarget } from "./app-frame.js";
import { fromAppFrame } from "./app-frame.js";

/**
 * Reload the app page on request, ignoring the HTTP cache, so a newer web build reaches a window
 * that is already open instead of only one that was just started. Only the main frame of the page
 * the window shows may ask; anything else gets false.
 */
export function createPageReloadHandler(target: () => AppTarget | null) {
  return (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): boolean => {
    const page = target();
    if (!page || !fromAppFrame(page, event)) return false;
    page.webContents.reloadIgnoringCache();
    return true;
  };
}
