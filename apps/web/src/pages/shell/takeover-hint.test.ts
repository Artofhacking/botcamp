// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { dismissTakeoverHint, takeoverHintDismissed, takeoverNeedsConfirm } from "./takeover-hint";

afterEach(() => localStorage.clear());

describe("takeoverNeedsConfirm", () => {
  const ask = {
    requested: true,
    holdsControl: false,
    blocked: false,
    dismissed: false,
  };

  it("asks before granting control", () => {
    expect(takeoverNeedsConfirm(ask)).toBe(true);
  });

  it("skips the note when it was turned off, control is held, or the bot is busy", () => {
    expect(takeoverNeedsConfirm({ ...ask, dismissed: true })).toBe(false);
    expect(takeoverNeedsConfirm({ ...ask, holdsControl: true })).toBe(false);
    expect(takeoverNeedsConfirm({ ...ask, blocked: true })).toBe(false);
    expect(takeoverNeedsConfirm({ ...ask, requested: false })).toBe(false);
  });
});

it("remembers that the takeover note was turned off", () => {
  expect(takeoverHintDismissed()).toBe(false);
  dismissTakeoverHint();
  expect(takeoverHintDismissed()).toBe(true);
});
