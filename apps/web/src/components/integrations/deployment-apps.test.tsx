// @vitest-environment jsdom
import type { McpServer } from "@botcamp/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { McpOauthPaste } from "../../lib/mcp-connect";
import type { DeploymentApp } from "../../lib/ui-flags";
import { DeploymentApps } from "./deployment-apps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { translate } = vi.hoisted(() => ({
  translate: (value: { message?: string } | string | TemplateStringsArray, ...parts: unknown[]) => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return String.raw({ raw: value }, ...(parts as string[]));
    return (value as { message?: string }).message ?? "";
  },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children, message }: { children?: ReactNode; message?: string }) =>
    children ?? message ?? null,
  useLingui: () => ({ t: translate, _: translate }),
}));
vi.mock("@lingui/react", () => ({
  useLingui: () => ({ t: translate, _: translate }),
  Trans: ({ children, message }: { children?: ReactNode; message?: string }) =>
    children ?? message ?? null,
}));
vi.mock("@botcamp/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? <div data-testid="mailbox-dialog">{children}</div> : null,
    DialogContent: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Label: ({ children, ...props }: ComponentProps<"label">) => (
      // The input this names is rendered beside the label.
      // biome-ignore lint/a11y/noLabelWithoutControl: test double
      <label {...props}>{children}</label>
    ),
    RadioGroup: ({
      children,
      onValueChange,
    }: {
      children?: ReactNode;
      value?: string;
      onValueChange?: (value: string) => void;
    }) => (
      // biome-ignore lint/a11y/noStaticElementInteractions: test double selects the clicked radio
      // biome-ignore lint/a11y/useKeyWithClickEvents: test double
      <div
        onClick={(event) => {
          const value = (event.target as HTMLElement)
            .closest("[data-value]")
            ?.getAttribute("data-value");
          if (value) onValueChange?.(value);
        }}
      >
        {children}
      </div>
    ),
    RadioGroupItem: ({ value }: { value: string }) => <button type="button" data-value={value} />,
  };
});

const APP: DeploymentApp = {
  name: "Mail",
  endpoint: "https://mail.example.test/mcp",
  scopes: [
    { label: "Read only", scope: "mail.read" },
    { label: "Read and send", scope: "mail.read mail.send" },
  ],
};

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: "server-1",
    spaceId: "space-1",
    installId: null,
    slug: "mail",
    name: "Mail",
    description: "",
    transport: "streamable_http",
    endpoint: APP.endpoint,
    command: null,
    hasArgs: false,
    envKeys: [],
    fileKeys: [],
    headerKeys: [],
    hasSecret: false,
    oauthStatus: "connected",
    oauthClientId: null,
    enabled: true,
    verbatimResults: false,
    revision: 1,
    health: { status: "unknown", message: null, toolCount: null, checkedAt: null },
    availability: { allSpaces: true, spaceIds: ["space-1"] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

async function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => root.render(element));
  return container;
}

function appRows(container: HTMLElement) {
  return [...container.querySelectorAll('[data-testid="deployment-app"]')];
}

function typeInto(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("shows a linked directory account as connected without a second disconnect", async () => {
  const onConnect = vi.fn();
  const container = await render(
    <DeploymentApps
      apps={[]}
      servers={[]}
      pending={null}
      error={null}
      onDisconnect={vi.fn()}
      directory={{ name: "飞书", linked: true, onConnect }}
    />,
  );
  const row = container.querySelector('[data-testid="directory-app"]');
  expect(row?.textContent).toContain("飞书");
  expect(row?.textContent).toContain("Connected");
  expect(row?.querySelector("button")).toBeNull();
});

it("links a directory account from the connect button", async () => {
  const onConnect = vi.fn();
  const container = await render(
    <DeploymentApps
      apps={[]}
      servers={[]}
      pending={null}
      error={null}
      onDisconnect={vi.fn()}
      directory={{ name: "飞书", linked: false, onConnect }}
    />,
  );
  const connect = container.querySelector('[data-testid="directory-app"] button');
  await act(async () => (connect as HTMLButtonElement).click());
  expect(onConnect).toHaveBeenCalledOnce();
});

it("lists only the apps the deployment offers", async () => {
  const container = await render(
    <DeploymentApps apps={[APP]} servers={[]} pending={null} error={null} onDisconnect={vi.fn()} />,
  );
  const rows = appRows(container);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.textContent).toContain("Mail");
  expect(container.querySelector('[data-testid="deployment-apps"]')?.className).toBe(
    "grid grid-cols-1 gap-2 sm:grid-cols-2",
  );
  expect(container.querySelector('[data-testid="mailbox-dialog"]')).toBeNull();
});

it("starts sign-in with the chosen permission and accepts the callback address", async () => {
  let pasted = "";
  const onConnect = vi.fn(async (_app: DeploymentApp, scope?: string, paste?: McpOauthPaste) => {
    expect(scope).toBe("mail.read mail.send");
    pasted =
      (await paste?.({
        sessionId: "session-1",
        authorizationUrl: "https://wx.mail.qq.com/oauth/authorize?state=session-1",
      })) ?? "";
  });
  const container = await render(
    <DeploymentApps
      apps={[APP]}
      servers={[]}
      pending={null}
      error={null}
      onConnect={onConnect}
      onDisconnect={vi.fn()}
    />,
  );
  const connect = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Connect",
  );
  await act(async () => connect?.click());
  expect(container.querySelector('input[type="email"]')).toBeNull();
  expect(container.querySelector('[data-testid="mailbox-dialog"]')?.textContent).toContain(
    "Read and send",
  );
  const send = container.querySelector('[data-value="mail.read mail.send"]');
  await act(async () => (send as HTMLButtonElement).click());
  await act(async () => {
    container.querySelector("form")?.requestSubmit();
    await Promise.resolve();
  });
  const pending = onConnect.mock.results[0]?.value as Promise<void> | undefined;
  expect(container.textContent).toContain("Callback address");
  const input = container.querySelector("input") as HTMLInputElement;
  await act(async () => typeInto(input, "not-a-callback"));
  await act(async () => container.querySelector("form")?.requestSubmit());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "That address has no authorization code",
  );
  await act(async () =>
    typeInto(input, "http://127.0.0.1:47631/callback?code=auth-code&state=session-1"),
  );
  await act(async () => {
    container.querySelector("form")?.requestSubmit();
    await pending;
  });
  expect(pasted).toContain("auth-code");
  expect(container.querySelector('[data-testid="mailbox-dialog"]')).toBeNull();
});

it("shows a connected app with its disconnect, and disconnects it", async () => {
  const onDisconnect = vi.fn();
  const container = await render(
    <DeploymentApps
      apps={[APP]}
      servers={[server()]}
      pending={null}
      error={null}
      onDisconnect={onDisconnect}
    />,
  );
  expect(container.textContent).toContain("Connected");
  const disconnect = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Disconnect",
  );
  await act(async () => disconnect?.click());
  expect(onDisconnect).toHaveBeenCalledWith(APP);
});

it("starts Notion sign-in without the mailbox form, and a saved mailbox does not connect it", async () => {
  const notion: DeploymentApp = {
    name: "Notion",
    endpoint: "https://mcp.notion.com/mcp",
    scopes: [],
  };
  const onConnect = vi.fn();
  const container = await render(
    <DeploymentApps
      apps={[APP, notion]}
      servers={[]}
      pending={null}
      error={null}
      linked
      onConnect={onConnect}
      onDisconnect={vi.fn()}
    />,
  );
  const rows = appRows(container);
  expect(rows[0]?.textContent).toContain("Connected");
  expect(rows[1]?.textContent).not.toContain("Connected");
  const connect = [...rows[1]!.querySelectorAll("button")].find(
    (button) => button.textContent === "Connect",
  );
  await act(async () => connect?.click());
  expect(onConnect).toHaveBeenCalledWith(notion);
  expect(container.querySelector('[data-testid="mailbox-dialog"]')).toBeNull();
});

it("shows a saved mailbox as connected", async () => {
  const container = await render(
    <DeploymentApps
      apps={[APP]}
      servers={[]}
      pending={null}
      error={null}
      linked
      onDisconnect={vi.fn()}
    />,
  );
  expect(container.textContent).toContain("Connected");
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === "Connect"),
  ).toBe(false);
});

it("asks for a reconnect when the grant lapsed", async () => {
  const container = await render(
    <DeploymentApps
      apps={[APP]}
      servers={[server({ oauthStatus: "reconnect" })]}
      pending={null}
      error={null}
      onDisconnect={vi.fn()}
    />,
  );
  expect(container.textContent).toContain("OAuth expired");
  expect(container.textContent).toContain("Reconnect");
});

it("says why connecting failed", async () => {
  const container = await render(
    <DeploymentApps
      apps={[APP]}
      servers={[]}
      pending={null}
      error="Could not connect"
      onDisconnect={vi.fn()}
    />,
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not connect");
});
