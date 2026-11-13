// @vitest-environment jsdom

import type { Bot, ComputerStatus } from "@botcamp/contracts";
import { i18n } from "@lingui/core";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@botcamp/ui-web", () => ({
  BotAvatar: () => null,
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  Checkbox: ({
    checked,
    onCheckedChange,
    id,
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    id?: string;
  }) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
    />
  ),
}));
vi.mock("../../components/ComputerMaintenanceActions", () => ({
  ComputerMaintenanceActions: () => null,
}));
vi.mock("../../components/teach/TeachCaptureOverlay", () => ({ TeachCaptureOverlay: () => null }));
vi.mock("../../components/teach/TeachComputerOverlay", () => ({
  TeachComputerOverlayControl: () => null,
}));
vi.mock("../../components/teach/TeachRecordingChrome", () => ({
  TeachRecordingChrome: () => null,
  TeachStopButton: () => null,
}));

import { ComputerOverlay } from "./computer-overlay";

let container: HTMLDivElement;
let root: Root;

const bot = { id: "bot-1", name: "Ada", color: "ink", status: "idle" } as Bot;

function computer(state: ComputerStatus["state"]): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "team",
    kind: "boat",
    state,
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: false,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    canUpdate: false,
    terminalAvailable: false,
  };
}

async function render(state: ComputerStatus["state"], onStart = vi.fn()) {
  await act(async () => {
    root.render(
      <ComputerOverlay
        bot={bot}
        computer={computer(state)}
        computerViewport={null}
        recordingSkill={null}
        teachBusy={false}
        hasControl={false}
        composerRunning={false}
        sending={false}
        booting={false}
        sendError={null}
        embeddedScreenUrl={null}
        screenFrameRef={() => undefined}
        computerScreenError={null}
        computerBooting={null}
        onStopTeaching={() => undefined}
        onStopRun={() => undefined}
        onRelease={async () => undefined}
        onTakeControl={() => undefined}
        onStart={onStart}
        onRefreshTeaching={async () => undefined}
        onRefreshComputer={async () => undefined}
        onClose={() => undefined}
      />,
    );
  });
  return onStart;
}

function startButton() {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === "Start");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("asks for confirmation before granting control, and can turn the note off", async () => {
  const onConfirmTakeover = vi.fn();
  await act(async () => {
    root.render(
      <ComputerOverlay
        bot={bot}
        computer={{ ...computer("running"), takeoverRequested: true }}
        computerViewport={null}
        recordingSkill={null}
        teachBusy={false}
        hasControl={false}
        composerRunning={false}
        sending={false}
        booting={false}
        sendError={null}
        embeddedScreenUrl="https://screen.test/view"
        screenFrameRef={() => undefined}
        computerScreenError={null}
        computerBooting={null}
        onStopTeaching={() => undefined}
        onStopRun={() => undefined}
        onRelease={async () => undefined}
        onTakeControl={() => undefined}
        takeoverPrompt
        onConfirmTakeover={onConfirmTakeover}
        onStart={() => undefined}
        onRefreshTeaching={async () => undefined}
        onRefreshComputer={async () => undefined}
        onClose={() => undefined}
      />,
    );
  });
  const prompt = container.querySelector('[data-testid="takeover-prompt"]')!;
  expect(prompt.getAttribute("role")).toBe("alertdialog");
  expect(prompt.textContent).toContain("When you are finished, choose I’m done.");
  expect(container.querySelector('[data-testid="computer-chrome"]')?.textContent).not.toContain(
    "Take control",
  );
  const box = prompt.querySelector("input")!;
  await act(async () => box.click());
  const confirm = [...prompt.querySelectorAll("button")].find(
    (button) => button.textContent === "OK",
  )!;
  await act(async () => confirm.click());
  expect(onConfirmTakeover).toHaveBeenCalledWith(true);
});

it("offers Start for a stopped computer instead of a bare label", async () => {
  const onStart = await render("stopped");
  expect(container.textContent).toContain("Computer is stopped");
  await act(async () => startButton()?.click());
  expect(onStart).toHaveBeenCalledOnce();
});

it("offers Start for an asleep computer", async () => {
  await render("suspended");
  expect(container.textContent).toContain("Computer is asleep");
  expect(startButton()).toBeDefined();
});
