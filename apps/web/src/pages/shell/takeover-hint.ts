const STORAGE_KEY = "botcamp.takeoverHintDismissed";

/** The person turned off the note shown before the first takeover. */
export function takeoverHintDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissTakeoverHint(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Storage can be blocked. The note shows again next time.
  }
}

/**
 * Taking control waits for a confirmation until the note is turned off.
 * A view, a computer the person already holds, or a busy bot does not ask.
 */
export function takeoverNeedsConfirm(input: {
  requested: boolean;
  holdsControl: boolean;
  blocked: boolean;
  dismissed: boolean;
}): boolean {
  return input.requested && !input.holdsControl && !input.blocked && !input.dismissed;
}
