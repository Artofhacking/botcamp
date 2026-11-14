// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { requestBrowserNotificationPermission } from "./browser-notifications";
import { androidNotificationBridge, nativeNotificationPermission } from "./native-notifications";

afterEach(() => {
  delete window.botcampAndroid;
  vi.unstubAllGlobals();
});

it("reads the Android shell's permission", () => {
  window.botcampAndroid = {
    notificationPermission: () => "granted",
    showNotification: vi.fn(),
  };
  expect(androidNotificationBridge()).toBeDefined();
  expect(nativeNotificationPermission()).toBe("granted");
});

it("asks no browser Notification API when the shell answers", async () => {
  window.botcampAndroid = {
    notificationPermission: () => "denied",
    showNotification: vi.fn(),
  };
  const requestPermission = vi.fn();
  await expect(
    requestBrowserNotificationPermission({ permission: "default", requestPermission }),
  ).resolves.toBe("denied");
  expect(requestPermission).not.toHaveBeenCalled();
});
