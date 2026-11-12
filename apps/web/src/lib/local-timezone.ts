/**
 * The browser's IANA timezone (e.g. "Australia/Sydney"), for timestamp inputs
 * that would otherwise default to UTC. Falls back to UTC when unavailable.
 */
export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

let knownTimezones: readonly string[] | null = null;

/** The runtime's IANA zones plus UTC, sorted once per page. */
function ianaTimezones(): readonly string[] {
  if (knownTimezones) return knownTimezones;
  const zones = new Set<string>(
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [],
  );
  zones.add("UTC");
  knownTimezones = [...zones].sort((a, b) => a.localeCompare(b));
  return knownTimezones;
}

/** Timezones to offer in pickers: the runtime's IANA list, always including `current`. */
export function timezoneOptions(current?: string | null): string[] {
  const zones = ianaTimezones();
  if (!current || zones.includes(current)) return [...zones];
  return [...zones, current].sort((a, b) => a.localeCompare(b));
}

/** The runtime's own spelling of a zone, so aliases such as Asia/Kolkata and Asia/Calcutta match. */
function canonicalTimeZone(zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return zone;
  }
}

export function sameTimeZone(a: string, b: string): boolean {
  return a === b || canonicalTimeZone(a) === canonicalTimeZone(b);
}
