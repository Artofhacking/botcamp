import { Trans } from "@lingui/react/macro";
import { Button, Checkbox } from "@rakazo/ui-web";
import { useId, useState } from "react";

/** Shown once at the top of the screen before control is granted. */
export function TakeoverPrompt({
  disabled,
  onConfirm,
}: {
  disabled: boolean;
  onConfirm: (remember: boolean) => void;
}) {
  const [remember, setRemember] = useState(false);
  const rememberId = useId();
  return (
    <div
      data-testid="takeover-prompt"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-warning/40 bg-warning/10 px-[18px] py-2.5"
    >
      <p className="min-w-0 flex-1 text-sm text-foreground">
        <Trans>When you are finished, choose I’m done.</Trans>
      </p>
      <label htmlFor={rememberId} className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox
          id={rememberId}
          checked={remember}
          onCheckedChange={(checked) => setRemember(checked === true)}
        />
        <Trans>Don't show this again</Trans>
      </label>
      <Button type="button" size="sm" disabled={disabled} onClick={() => onConfirm(remember)}>
        <Trans>Take control</Trans>
      </Button>
    </div>
  );
}
