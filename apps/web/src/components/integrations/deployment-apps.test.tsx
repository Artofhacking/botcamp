// @vitest-environment jsdom
import type { McpServer } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { DeploymentApp } from "../../lib/ui-flags";
import { DeploymentApps } from "./deployment-apps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    DropdownMenu: Container,
    DropdownMenuContent: Container,
    DropdownMenuItem: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
    DropdownMenuTrigger: Container,
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

it("lists only the apps the deployment offers", async () => {
  const container = await render(
    <DeploymentApps
      apps={[APP]}
      servers={[]}
      pending={null}
      error={null}
      onConnect={vi.fn()}
      onDisconnect={vi.fn()}
    />,
  );
  const rows = appRows(container);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.textContent).toContain("Mail");
});

it("offers each scope the deployment allows, and connects with the chosen one", async () => {
  const onConnect = vi.fn();
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
  const choices = [...container.querySelectorAll("button")].filter(
    (button) => button.textContent === "Read and send",
  );
  expect(choices).toHaveLength(1);
  await act(async () => choices[0]?.click());
  expect(onConnect).toHaveBeenCalledWith(APP, {
    label: "Read and send",
    scope: "mail.read mail.send",
  });
});

it("connects straight away when the app offers one scope", async () => {
  const onConnect = vi.fn();
  const container = await render(
    <DeploymentApps
      apps={[{ ...APP, scopes: [{ label: "Read only", scope: "mail.read" }] }]}
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
  expect(onConnect).toHaveBeenCalledWith(
    { ...APP, scopes: [{ label: "Read only", scope: "mail.read" }] },
    { label: "Read only", scope: "mail.read" },
  );
});

it("shows a connected app with its disconnect, and disconnects it", async () => {
  const onDisconnect = vi.fn();
  const container = await render(
    <DeploymentApps
      apps={[APP]}
      servers={[server()]}
      pending={null}
      error={null}
      onConnect={vi.fn()}
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

it("asks for a reconnect when the grant lapsed", async () => {
  const container = await render(
    <DeploymentApps
      apps={[APP]}
      servers={[server({ oauthStatus: "reconnect" })]}
      pending={null}
      error={null}
      onConnect={vi.fn()}
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
      onConnect={vi.fn()}
      onDisconnect={vi.fn()}
    />,
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not connect");
});
