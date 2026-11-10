import { Trans, useLingui } from "@lingui/react/macro";
import type { McpServer } from "@botcamp/contracts";
import { MAILBOX_AUTH_REJECTED, MAILBOX_UNREACHABLE, mailboxAuthCode } from "@botcamp/contracts";
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
import type { FormEvent } from "react";
import { useId, useState } from "react";
import type { DeploymentApp, DeploymentAppScope } from "../../lib/ui-flags";
import { errorText } from "../../lib/user-error";

function AppIcon({ name }: { name: string }) {
  return (
    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-sm font-semibold text-foreground">
      {name[0]}
    </div>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type MailboxConnectInput = {
  address: string;
  authCode: string;
  scope: string;
};

/** A scope list is the mailbox authorization-code form. Other apps use their own sign-in. */
function signsInWithMailbox(app: DeploymentApp): boolean {
  return app.scopes.length > 0;
}

/**
 * The apps a deployment offers, one row each. A mailbox asks for the authorization
 * code and the permission, then tests that sign-in before saving it. Any other app
 * starts its own sign-in.
 */
export function DeploymentApps({
  apps,
  servers,
  pending,
  error,
  linked = false,
  onSave,
  onConnect,
  onDisconnect,
}: {
  apps: readonly DeploymentApp[];
  /** The user's MCP servers, so a row knows what is already connected. */
  servers: readonly McpServer[];
  /** Endpoint of the app with a connect or disconnect in flight. */
  pending: string | null;
  error: string | null;
  /** The saved mailbox sign-in. It connects only an app that asks for that code. */
  linked?: boolean;
  onSave: (app: DeploymentApp, input: MailboxConnectInput) => Promise<void>;
  onConnect?: (app: DeploymentApp) => void;
  onDisconnect: (app: DeploymentApp) => void;
}) {
  const { t } = useLingui();
  const emailId = useId();
  const codeId = useId();
  const permissionId = useId();
  const [draft, setDraft] = useState<DeploymentApp | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [scope, setScope] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function open(app: DeploymentApp) {
    setDraft(app);
    setEmail("");
    setCode("");
    setScope(app.scopes[0]?.scope ?? "");
    setFormError(null);
  }

  function signInError(err: unknown): string {
    const message = errorText(err, t`Could not sign in`);
    if (message === MAILBOX_AUTH_REJECTED) return t`Authorization code was rejected`;
    if (message === MAILBOX_UNREACHABLE) return t`Could not reach the mailbox`;
    return message;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || saving) return;
    const address = email.trim().toLowerCase();
    const authCode = mailboxAuthCode(code);
    if (!EMAIL.test(address) || address.length > 254) {
      setFormError(t`Enter a valid email`);
      return;
    }
    if (!authCode) {
      setFormError(t`Enter the 16-character authorization code`);
      return;
    }
    if (!scope) return;
    setSaving(true);
    setFormError(null);
    try {
      await onSave(draft, { address, authCode, scope });
      setDraft(null);
    } catch (err) {
      setFormError(signInError(err));
    } finally {
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
                  onClick={() => (mailbox ? open(app) : onConnect?.(app))}
                >
                  {expiring ? <Trans>Reconnect</Trans> : <Trans>Connect</Trans>}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setDraft(null);
        }}
      >
        <DialogContent>
          <form onSubmit={(event) => void submit(event)} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{draft?.name}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor={emailId}>
                <Trans>Mailbox</Trans>
              </Label>
              <Input
                id={emailId}
                type="email"
                autoComplete="email"
                autoFocus
                required
                disabled={saving}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={codeId}>
                <Trans>Authorization code</Trans>
              </Label>
              <Input
                id={codeId}
                type="password"
                autoComplete="off"
                required
                disabled={saving}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
            {draft && draft.scopes.length > 0 ? (
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
              <Button type="submit" disabled={saving || !email.trim() || !code.trim() || !scope}>
                {saving ? <Trans>Testing…</Trans> : <Trans>Test and save</Trans>}
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
