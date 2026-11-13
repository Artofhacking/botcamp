/**
 * Match a BCP-47 tag (`en-US`, `zh-Hant-HK`, `zh_Hans_CN`) to one of the `supported` UI locales,
 * else English. Any Chinese tag matches Simplified Chinese when that locale is supported.
 * Each surface ships its own catalogs, so it passes its own list.
 */
export function matchUiLocale<L extends string>(
  raw: string | null | undefined,
  supported: readonly L[],
): L | "en" {
  const candidate = uiLocaleCandidate(raw);
  return (supported as readonly string[]).includes(candidate) ? (candidate as L) : "en";
}

function uiLocaleCandidate(raw: string | null | undefined): string {
  if (!raw) return "en";
  const normalized = raw.trim().toLowerCase().replace(/_/g, "-");
  // Any Chinese tag, including Traditional, is Simplified Chinese.
  const [language] = normalized.split("-");
  if (language === "zh") return "zh-CN";
  return language ?? "";
}

/** Repair a language write overtaken by a local choice while the request was in flight. */
export async function reportUiLocale<L extends string>(
  current: () => L,
  write: (locale: L) => Promise<unknown>,
): Promise<void> {
  let locale: L;
  do {
    locale = current();
    await write(locale);
  } while (current() !== locale);
}
