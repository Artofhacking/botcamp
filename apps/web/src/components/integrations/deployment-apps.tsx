import type { McpServer } from "@botcamp/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
} from "@botcamp/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import type { FormEvent } from "react";
import { useId, useRef, useState } from "react";
import type { McpOauthPaste } from "../../lib/mcp-connect";
import { mcpOAuthRedirectUri, mcpOauthCodeFromPaste } from "../../lib/mcp-connect";
import type { DeploymentApp, DeploymentAppScope } from "../../lib/ui-flags";

/** A client the user registered with the provider. GitHub cannot register one for us. */
export type DeploymentOAuthClient = { clientId: string; clientSecret?: string };

import { errorText } from "../../lib/user-error";

function AppIcon({ name }: { name: string }) {
  return (
    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-sm font-semibold text-foreground">
      {name[0]}
    </div>
  );
}

/** A scope list is the mailbox permission choice. Other apps use their own sign-in. */
function signsInWithMailbox(app: DeploymentApp): boolean {
  return app.scopes.length > 0;
}

/**
 * The apps a deployment offers, one row each. A mailbox asks which permission to
 * grant, then signs in through that app's own page. Any other app starts its own sign-in.
 */
export function DeploymentApps({
  apps,
  servers,
  pending,
  error,
  linked = false,
  onConnect,
  onDisconnect,
  directory = null,
}: {
  apps: readonly DeploymentApp[];
  /** The user's MCP servers, so a row knows what is already connected. */
  servers: readonly McpServer[];
  /** Endpoint of the app with a connect or disconnect in flight. */
  pending: string | null;
  error: string | null;
  /** An older mailbox sign-in. It still shows that app as connected. */
  linked?: boolean;
  onConnect?: (
    app: DeploymentApp,
    scope?: string,
    paste?: McpOauthPaste,
    signal?: AbortSignal,
    client?: DeploymentOAuthClient,
  ) => void | Promise<void>;
  onDisconnect: (app: DeploymentApp) => void;
  /**
   * Directory sign-in, when this deployment offers it. A linked account is
   * already connected. Unlinking stays on the sign-in settings row.
   */
  directory?: {
    name: string;
    linked: boolean;
    pending?: boolean;
    onConnect: () => void;
  } | null;
}) {
  const { t } = useLingui();
  const callbackId = useId();
  const permissionId = useId();
  const [draft, setDraft] = useState<DeploymentApp | null>(null);
  const [clientDraft, setClientDraft] = useState<DeploymentApp | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const clientIdField = useId();
  const clientSecretField = useId();
  const redirectField = useId();
  const [scope, setScope] = useState("");
  const [callback, setCallback] = useState("");
  const [pasteSession, setPasteSession] = useState<{
    sessionId: string;
    authorizationUrl: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const pasteDone = useRef<((value: string | undefined) => void) | null>(null);
  const attempt = useRef<AbortController | null>(null);

  function close() {
    attempt.current?.abort();
    attempt.current = null;
    pasteDone.current?.(undefined);
    pasteDone.current = null;
    setDraft(null);
    setClientDraft(null);
    setClientId("");
    setClientSecret("");
    setPasteSession(null);
    setCallback("");
    setFormError(null);
  }

  function open(app: DeploymentApp) {
    attempt.current?.abort();
    attempt.current = null;
    pasteDone.current?.(undefined);
    pasteDone.current = null;
    setClientDraft(null);
    setDraft(app);
    setScope(app.scopes[0]?.scope ?? "");
    setCallback("");
    setPasteSession(null);
    setFormError(null);
  }

  function openClient(app: DeploymentApp) {
    attempt.current?.abort();
    attempt.current = null;
    pasteDone.current?.(undefined);
    pasteDone.current = null;
    setDraft(null);
    setPasteSession(null);
    setClientDraft(app);
    setClientId("");
    setClientSecret("");
    setFormError(null);
  }

  async function submitClient(event: FormEvent) {
    event.preventDefault();
    if (!clientDraft || saving) return;
    const id = clientId.trim();
    if (!id) return;
    setSaving(true);
    setFormError(null);
    try {
      await onConnect?.(clientDraft, undefined, undefined, undefined, {
        clientId: id,
        clientSecret: clientSecret.trim() || undefined,
      });
      setClientDraft(null);
      setClientId("");
      setClientSecret("");
    } catch (err) {
      setFormError(errorText(err, t`Could not sign in`));
    } finally {
      setSaving(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (clientDraft) {
      await submitClient(event);
      return;
    }
    if (!draft || saving) return;
    if (pasteSession) {
      if (!mcpOauthCodeFromPaste(callback, pasteSession.sessionId)) {
        setFormError(t`That address has no authorization code`);
        return;
      }
      pasteDone.current?.(callback.trim());
      pasteDone.current = null;
      setSaving(true);
      return;
    }
    if (!scope) return;
    const controller = new AbortController();
    attempt.current = controller;
    setSaving(true);
    setFormError(null);
    try {
      await onConnect?.(
        draft,
        scope,
        async (session) => {
          if (controller.signal.aborted) return undefined;
          setPasteSession(session);
          setCallback("");
          setSaving(false);
          return await new Promise((resolve) => {
            pasteDone.current = resolve;
          });
        },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setDraft(null);
        setPasteSession(null);
      }
    } catch (err) {
      if (!controller.signal.aborted) setFormError(errorText(err, t`Could not sign in`));
    } finally {
      if (attempt.current === controller) attempt.current = null;
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div data-testid="deployment-apps" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {apps.map((app) => {
          const server = servers.find(
            (entry) => !entry.installId && entry.endpoint === app.endpoint,
          );
          const mailbox = signsInWithMailbox(app);
          const connected = (mailbox && linked) || server?.oauthStatus === "connected";
          const expiring = !connected && server?.oauthStatus === "reconnect";
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
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    mailbox
                      ? open(app)
                      : app.oauthClientRequired && !server?.oauthClientId
                        ? openClient(app)
                        : onConnect?.(app)
                  }
                >
                  {expiring ? <Trans>Reconnect</Trans> : <Trans>Connect</Trans>}
                </Button>
              )}
            </div>
          );
        })}
        {directory ? (
          <div
            data-testid="directory-app"
            className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2"
          >
            <AppIcon name={directory.name} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium">{directory.name}</span>
              {directory.linked ? (
                <span className="block truncate text-[13px] text-muted-foreground">
                  <Trans>Connected</Trans>
                </span>
              ) : null}
            </span>
            {directory.linked ? null : (
              <Button
                variant="secondary"
                size="sm"
                disabled={directory.pending}
                onClick={directory.onConnect}
              >
                <Trans>Connect</Trans>
              </Button>
            )}
          </div>
        ) : null}
      </div>
      <Dialog
        open={draft !== null || clientDraft !== null}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogContent>
          <form onSubmit={(event) => void submit(event)} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{(clientDraft ?? draft)?.name}</DialogTitle>
            </DialogHeader>
            {clientDraft ? (
              <div className="grid gap-3">
                <div className="grid gap-2">
                  <Label htmlFor={clientIdField}>
                    <Trans>OAuth client ID</Trans>
                  </Label>
                  <Input
                    id={clientIdField}
                    autoComplete="off"
                    autoFocus
                    disabled={saving}
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={clientSecretField}>
                    <Trans>OAuth client secret</Trans>
                  </Label>
                  <Input
                    id={clientSecretField}
                    type="password"
                    autoComplete="new-password"
                    disabled={saving}
                    value={clientSecret}
                    placeholder={t`Stored encrypted`}
                    onChange={(event) => setClientSecret(event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={redirectField}>
                    <Trans>Redirect URI</Trans>
                  </Label>
                  <Input
                    id={redirectField}
                    readOnly
                    value={mcpOAuthRedirectUri()}
                    onFocus={(event) => event.target.select()}
                  />
                </div>
              </div>
            ) : null}
            {pasteSession ? (
              <div className="grid gap-2">
                <p className="text-sm text-muted-foreground">
                  <Trans>
                    Sign in at{" "}
                    <a
                      href={pasteSession.authorizationUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-foreground underline"
                    >
                      {new URL(pasteSession.authorizationUrl).hostname}
                    </a>
                    , then paste the callback address.
                  </Trans>
                </p>
                <Label htmlFor={callbackId}>
                  <Trans>Callback address</Trans>
                </Label>
                <Input
                  id={callbackId}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  disabled={saving}
                  value={callback}
                  onChange={(event) => setCallback(event.target.value)}
                />
              </div>
            ) : draft && draft.scopes.length > 0 ? (
              <div className="grid gap-2">
                <p id={permissionId} className="text-sm font-medium text-muted-foreground">
                  <Trans>Permission</Trans>
                </p>
                <RadioGroup
                  aria-labelledby={permissionId}
                  value={scope}
                  disabled={saving}
                  onValueChange={(value) => setScope(value)}
                >
                  {draft.scopes.map((option) => (
                    <ScopeChoice key={option.scope} option={option} />
                  ))}
                </RadioGroup>
              </div>
            ) : null}
            {formError ? (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="submit"
                disabled={
                  saving ||
                  (clientDraft ? !clientId.trim() : pasteSession ? !callback.trim() : !scope)
                }
              >
                {saving ? (
                  <Trans>Waiting…</Trans>
                ) : pasteSession ? (
                  <Trans>Submit</Trans>
                ) : (
                  <Trans>Connect</Trans>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ScopeChoice({ option }: { option: DeploymentAppScope }) {
  return (
    // The radio is the control inside the label.
    // biome-ignore lint/a11y/noLabelWithoutControl: the wrapped RadioGroupItem is the control.
    <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2.5">
      <RadioGroupItem value={option.scope} />
      <span className="text-sm text-foreground">{option.label}</span>
    </label>
  );
}
