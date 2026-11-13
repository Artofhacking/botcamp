import { Trans } from "@lingui/react/macro";

/** Marks a group other accounts can join. Private groups do not use it. */
export function SharedMark() {
  return (
    <span
      data-shared-mark
      className="shrink-0 rounded bg-muted px-1 py-px text-[10px] font-medium leading-4 text-muted-foreground"
    >
      <Trans>Shared</Trans>
    </span>
  );
}
