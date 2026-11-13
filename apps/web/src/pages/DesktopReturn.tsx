import { desktopAppReturnUrl } from "@botcamp/contracts";
import { Button } from "@botcamp/ui-web";
import { Trans } from "@lingui/react/macro";
import { useEffect } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

/** A system-browser OAuth callback with no app session hands the result to the desktop app. */
export function DesktopReturnPage({ kind }: { kind: "mcp-oauth" | "slack-install" }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const handoff = desktopAppReturnUrl(kind, params);
  const signIn = `/sign-in?next=${encodeURIComponent(pathname + search)}`;
  useEffect(() => {
    if (!handoff) {
      navigate(signIn, { replace: true });
      return;
    }
    window.location.replace(handoff);
  }, [handoff, navigate, signIn]);
  if (!handoff) return null;
  return (
    <div className="grid min-h-screen place-items-center bg-background p-6 text-center">
      <div>
        <p className="text-sm text-muted-foreground">
          <Trans>You can close this window.</Trans>
        </p>
        <Button type="button" className="mt-5" onClick={() => navigate(signIn)}>
          <Trans>Return to BotCamp</Trans>
        </Button>
      </div>
    </div>
  );
}
