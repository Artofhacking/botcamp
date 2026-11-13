// Runs before first paint, as a file because the app's CSP blocks inline scripts.
(() => {
  const key = "botcamp.uiAppearance";
  const previousKey = "rakazo.uiAppearance";
  let preference = "system";
  try {
    let stored = localStorage.getItem(key);
    if (stored === null) {
      stored = localStorage.getItem(previousKey);
      if (stored !== null) {
        localStorage.setItem(key, stored);
        localStorage.removeItem(previousKey);
      }
    }
    if (stored === "system" || stored === "light" || stored === "dark") preference = stored;
  } catch {}
  const systemLight =
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
  const theme = preference === "system" ? (systemLight ? "light" : "dark") : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#ffffff" : "#0a0a0a");
  // macOS draws regular text at 420 (see --font-weight-normal); iPads report a Mac platform too.
  const nav = typeof navigator === "object" ? navigator : undefined;
  if (nav && /^Mac/.test(nav.platform || "") && !(nav.maxTouchPoints > 1)) {
    document.documentElement.dataset.os = "mac";
  }
})();
