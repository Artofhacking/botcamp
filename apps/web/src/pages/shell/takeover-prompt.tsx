import { Trans } from "@lingui/react/macro";
import { Button, Checkbox } from "@botcamp/ui-web";
import { useId, useState } from "react";

/**
 * Covers the computer page until the person presses OK.
 * The scrim does not dismiss it. The computer's own close control stays outside this layer.
 */
export function TakeoverPrompt({
  disabled,
  onConfirm,
}: {
  disabled: boolean;
  onConfirm: (remember: boolean) => void;
}) {
  const [remember, setRemember] = useState(false);
  const titleId = useId();
  const rememberId = useId();
  return (
    <div
      data-testid="takeover-prompt"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="absolute inset-0 z-20 flex items-center justify-center bg-overlay p-6"
    >
      <div className="grid w-full max-w-sm gap-4 rounded-xl bg-dialog p-4 text-foreground ring-1 ring-foreground/10">
        <h2 id={titleId} className="text-heading3 font-medium">
          <Trans>When you are finished, choose I’m done.</Trans>
        </h2>
        <label
          htmlFor={rememberId}
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Checkbox
            id={rememberId}
            checked={remember}
            onCheckedChange={(checked) => setRemember(checked === true)}
          />
          <Trans>Don't show this again</Trans>
        </label>
        <div className="flex justify-end">
          <Button type="button" autoFocus disabled={disabled} onClick={() => onConfirm(remember)}>
            <Trans>OK</Trans>
          </Button>
        </div>
      </div>
    </div>
  );
}
