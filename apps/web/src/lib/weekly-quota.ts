import { apiUrl } from "./api-origin.js";
import { authHeaders } from "./auth-token.js";

export interface WeeklyQuota {
  plan: string;
  /** Share of the weekly allowance spent, 0–100. */
  percent: number;
  /** Share of the weekly burst-container allowance spent, 0–100. */
  coreHoursPercent: number;
  /** When both allowances refill. */
  resetsAt: string;
}

export async function fetchWeeklyQuota(): Promise<WeeklyQuota | null> {
  try {
    const response = await fetch(apiUrl("/api/usage/weekly"), { headers: authHeaders() });
    if (!response.ok) return null;
    return (await response.json()) as WeeklyQuota;
  } catch {
    return null;
  }
}

/** The concrete moment the allowance comes back, e.g. "2026年11月11日 21:27". */
export function resetLabel(resetsAt: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(resetsAt));
}
