import { Trans } from "@lingui/react/macro";
import type { McpServer } from "@rakazo/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import type { DeploymentApp, DeploymentAppScope } from "../../lib/ui-flags";

function AppIcon({ name }: { name: string }) {
  return (
    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-sm font-semibold text-foreground">
      {name[0]}
    </div>
  );
}

/**
 * The apps a deployment offers, one row each. Nothing else is listed here, so the row
 * carries its own connect and disconnect; the server row a connected app owns is the
 * one whose endpoint matches.
 */
export function DeploymentApps({
  apps,
  servers,
  pending,
  error,
  onConnect,
  onDisconnect,
}: {
  apps: readonly DeploymentApp[];
  /** The user's MCP servers, so a row knows what is already connected. */
  servers: readonly McpServer[];
  /** Endpoint of the app with a connect or disconnect in flight. */
  pending: string | null;
  error: string | null;
  onConnect: (app: DeploymentApp, scope: DeploymentAppScope | undefined) => void;
  onDisconnect: (app: DeploymentApp) => void;
}) {
  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div data-testid="deployment-apps" className="grid gap-2">
        {apps.map((app) => {
          const server = servers.find(
            (entry) => !entry.installId && entry.endpoint === app.endpoint,
          );
          const connected = server?.oauthStatus === "connected";
          const expiring = server?.oauthStatus === "reconnect";
          const busy = pending === app.endpoint;
          return (
            <div
              key={app.endpoint}
              data-testid="deployment-app"
              className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2"
            >
              <AppIcon name={app.name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium">{app.name}</span>
                {connected || expiring ? (
                  <span className="block truncate text-[13px] text-muted-foreground">
                    {connected ? <Trans>Connected</Trans> : <Trans>OAuth expired</Trans>}
                  </span>
                ) : null}
              </span>
              {connected ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => onDisconnect(app)}
                >
                  <Trans>Disconnect</Trans>
                </Button>
              ) : app.scopes.length > 1 ? (
                // The user picks what the app may do; each choice is its own grant.
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="secondary" size="sm" disabled={busy} />}
                  >
                    {expiring ? <Trans>Reconnect</Trans> : <Trans>Connect</Trans>}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {app.scopes.map((option) => (
                      <DropdownMenuItem key={option.scope} onClick={() => onConnect(app, option)}>
                        {option.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => onConnect(app, app.scopes[0])}
                >
                  {expiring ? <Trans>Reconnect</Trans> : <Trans>Connect</Trans>}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
