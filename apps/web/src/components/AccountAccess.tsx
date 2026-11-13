import type { AccountSecurity } from "@botcamp/contracts";
import { Button, Input, Label } from "@botcamp/ui-web";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import {
  configuredSignInProvider,
  fetchAccountSecurity,
  requestAccountDeletionCode,
} from "../lib/account-security";
import { authClient } from "../lib/auth";
import { clearComposerDrafts } from "../lib/composer-draft";
import { forgetSignedIn } from "../lib/returning-user";
import { runSsoFlow } from "../lib/sso-flow";
import {
  assignAppLocation,
  hashRoutesEnabled,
  routeSearch,
  withRouteSearch,
} from "../lib/static-host-route";
import { authErrorText } from "../lib/user-error";
import { SettingsRow } from "./SettingsRows";

export function AccountAccess({
  onSecurity,
}: {
  onSecurity?: (security: AccountSecurity) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <SettingsRow
      label={<Trans>Delete account</Trans>}
      control={
        <Button
          variant="secondary"
          size="sm"
          data-testid="delete-account"
          className="text-destructive hover:text-destructive"
          onClick={() => setOpen((value) => !value)}
        >
          <Trans>Delete</Trans>
        </Button>
      }
    >
      <DeleteAccountForm open={open} onSecurity={onSecurity} />
    </SettingsRow>
  );
}

/** True when an SSO sign-in started to delete the account came back with an error. */
export function hasDeleteRedirectError(): boolean {
  return redirectError("delete") !== null;
}

/**
 * Confirms it's the account owner, then deletes the account. Security is looked up while closed
 * too, so settings can report it, and a redirect's error shows either way.
 */
export function DeleteAccountForm({
  open,
  onSecurity,
}: {
  open: boolean;
  onSecurity?: (security: AccountSecurity) => void;
}) {
  const { t } = useLingui();
  const [security, setSecurity] = useState<AccountSecurity | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const code = redirectError("delete");
    return code ? authErrorText({ code }, t`Could not continue`) : null;
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void fetchAccountSecurity()
      .then((value) => {
        if (active) {
          setSecurity(value);
          onSecurity?.(value);
        }
      })
      .catch(() => {
        if (active) setError(t`Could not continue`);
      });
    return () => {
      active = false;
    };
  }, [attempt, onSecurity]);
  async function action(run: () => Promise<unknown>, sso = false) {
    if (!sso) setPending(true);
    setError(null);
    try {
      await run();
    } catch (error) {
      setError(error instanceof Error ? error.message : t`Could not continue`);
    } finally {
      if (!sso) setPending(false);
    }
  }
  return (
    <>
      {open ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm">
            <Trans>This permanently deletes your account and data.</Trans>
          </p>
          {!security ? (
            <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              <Trans>Retry</Trans>
            </Button>
          ) : security.hasPassword ? (
            <div className="space-y-2">
              <Label htmlFor="delete-password">
                <Trans>Current password</Trans>
              </Label>
              <Input
                id="delete-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          ) : (
            <>
              {configuredSignInProvider(security) ? (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void action(async () => {
                      const provider = configuredSignInProvider(security);
                      if (!provider) return;
                      const returnTo = ssoReturnURL(false);
                      const result = await runSsoFlow(
                        (disableRedirect, callbackURL) =>
                          authClient.signIn.social({
                            disableRedirect,
                            provider,
                            additionalData: { reauthenticate: true },
                            callbackURL: callbackURL(returnTo),
                            errorCallbackURL: callbackURL(returnTo),
                          }),
                        [returnTo],
                      );
                      if (result.error)
                        throw new Error(authErrorText(result.error, t`Could not continue`));
                    }, true)
                  }
                >
                  <Trans>Sign in again</Trans>
                </Button>
              ) : null}
              {security.emailDeletion ? (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void action(async () => {
                      await requestAccountDeletionCode();
                      setSent(true);
                    })
                  }
                >
                  <Trans>Send deletion code</Trans>
                </Button>
              ) : null}
              {sent ? (
                <div className="space-y-2">
                  <Label htmlFor="deletion-code">
                    <Trans>Deletion code</Trans>
                  </Label>
                  <Input
                    id="deletion-code"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </div>
              ) : null}
            </>
          )}
          <Button
            variant="destructive"
            disabled={
              pending ||
              !security ||
              (security.hasPassword && !password) ||
              (!security.hasPassword && !security.freshOidcAuth && !code.trim())
            }
            onClick={() =>
              void action(async () => {
                const current = await fetchAccountSecurity();
                setSecurity(current);
                onSecurity?.(current);
                if (!current.hasPassword && !current.freshOidcAuth && !code.trim()) return;
                if (current.hasPassword && !password) return;
                const result = await authClient.deleteUser(
                  current.hasPassword ? { password } : code.trim() ? { token: code.trim() } : {},
                );
                if (result.error)
                  throw new Error(authErrorText(result.error, t`Could not continue`));
                clearComposerDrafts();
                forgetSignedIn();
                assignAppLocation("/sign-in");
              })
            }
          >
            <Trans>Delete account</Trans>
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** Links the organization's SSO or directory identity to an account that signed up another way. */
export function LinkSsoRow({
  provider = "oidc",
  label,
  linked = null,
  attached = false,
}: {
  provider?: "oidc" | "directory";
  label?: string;
  /** The linked person's name and picture. Hides the link button. */
  linked?: { name: string; image?: string } | null;
  /** Already attached even when no name was stored. Hides the link button. */
  attached?: boolean;
} = {}) {
  const { t } = useLingui();
  const [error, setError] = useState<string | null>(() => {
    const code = redirectError("link");
    return code ? authErrorText({ code }, t`Could not continue`) : null;
  });
  async function link() {
    setError(null);
    const returnTo = ssoReturnURL(false);
    const failed = ssoReturnURL(true);
    try {
      const result = await runSsoFlow(
        (disableRedirect, callbackURL) =>
          authClient.linkSocial({
            disableRedirect,
            provider,
            callbackURL: callbackURL(returnTo),
            errorCallbackURL: callbackURL(failed),
          }),
        [returnTo, failed],
      );
      if (result.error) setError(authErrorText(result.error, t`Could not continue`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not continue`);
    }
  }
  return (
    <SettingsRow
      label={label ?? <Trans>SSO</Trans>}
      control={
        linked ? (
          <span className="flex min-w-0 items-center gap-2">
            {linked.image ? (
              <img
                alt=""
                src={linked.image}
                referrerPolicy="no-referrer"
                className="size-6 shrink-0 rounded-full object-cover"
              />
            ) : null}
            <span className="truncate text-[13px]">{linked.name}</span>
          </span>
        ) : attached ? null : (
          <Button variant="secondary" size="sm" onClick={() => void link()}>
            <Trans>Link SSO</Trans>
          </Button>
        )
      }
    >
      {error ? (
        <p role="alert" className="mt-2 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsRow>
  );
}

/** Starts the directory link for the signed-in account. Returns an error message, or null. */
export async function beginDirectoryLink(): Promise<string | null> {
  const returnTo = ssoReturnURL(false);
  const failed = ssoReturnURL(true);
  try {
    const result = await runSsoFlow(
      (disableRedirect, callbackURL) =>
        authClient.linkSocial({
          disableRedirect,
          provider: "directory",
          callbackURL: callbackURL(returnTo),
          errorCallbackURL: callbackURL(failed),
        }),
      [returnTo, failed],
    );
    if (result.error) return authErrorText(result.error, t`Could not continue`);
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : t`Could not continue`;
  }
}

const LINK_RETURN = "sso-link";

/** This page without an earlier redirect's result; a failed link's return is marked as one. */
function ssoReturnURL(failedLink: boolean): string {
  const update = (params: URLSearchParams) => {
    params.delete("error");
    params.delete(LINK_RETURN);
    if (failedLink) params.set(LINK_RETURN, "1");
  };
  if (hashRoutesEnabled()) return withRouteSearch(update);
  const url = new URL(window.location.href);
  update(url.searchParams);
  return url.href;
}

/** The error an SSO redirect came back with, for the flow that started it. */
function redirectError(flow: "link" | "delete"): string | null {
  const params = new URLSearchParams(routeSearch());
  return params.has(LINK_RETURN) === (flow === "link") ? params.get("error") : null;
}
