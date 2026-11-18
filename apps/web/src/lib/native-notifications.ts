import type { BrowserNotificationPermission } from "./browser-notifications";

/**
 * The Android shell's notification shade, injected before the console loads.
 * A WebView has no `Notification` constructor, so the page asks the shell.
 */
export type AndroidNotificationBridge = {
  /** "granted", "denied", or "default" while the system prompt is unanswered. */
  notificationPermission(): string;
  /** Posts a system notification; a tap opens `groupId`, else `botId`, else the console. */
  showNotification(title: string, body: string, tag: string, groupId: string, botId: string): void;
};

declare global {
  interface Window {
    botcampAndroid?: AndroidNotificationBridge;
  }
}

export function androidNotificationBridge(): AndroidNotificationBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = window.botcampAndroid;
  return bridge && typeof bridge.showNotification === "function" ? bridge : undefined;
}

/** What this device allows now, from the shell when it has one. */
export function nativeNotificationPermission(
  bridge = androidNotificationBridge(),
): BrowserNotificationPermission {
  if (bridge) {
    try {
      const permission = bridge.notificationPermission();
      return permission === "granted" || permission === "denied" ? permission : "default";
    } catch {
      return "denied";
    }
  }
  if (typeof Notification === "undefined") return "denied";
  return Notification.permission;
}
