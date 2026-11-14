import { Button } from "@botcamp/ui-web";
import { Trans } from "@lingui/react/macro";
import { Plus, Users } from "lucide-react";

/** What the sidebar's plus starts. It only creates; switching to a bot stays in the roster. */
export function CreateMenu({
  onCreateBot,
  onCreateGroup,
  onCreateSharedGroup,
}: {
  onCreateBot: () => void;
  onCreateGroup: () => void;
  onCreateSharedGroup?: () => void;
}) {
  return (
    <div
      data-testid="create-menu"
      className="flex w-[min(240px,calc(100vw-2rem))] flex-col gap-0.5"
    >
      <Button
        variant="ghost"
        className="h-9 w-full justify-start gap-2.5 font-normal"
        data-testid="create-new-bot"
        onClick={() => onCreateBot()}
      >
        <Plus className="text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
        <Trans>New bot</Trans>
      </Button>
      <Button
        variant="ghost"
        className="h-9 w-full justify-start gap-2.5 font-normal"
        data-testid="create-new-group"
        onClick={() => onCreateGroup()}
      >
        <Users className="text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
        <Trans>New group chat</Trans>
      </Button>
      {onCreateSharedGroup ? (
        <Button
          variant="ghost"
          className="h-9 w-full justify-start gap-2.5 font-normal"
          data-testid="create-shared-group"
          onClick={() => onCreateSharedGroup()}
        >
          <Users className="text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
          <Trans>New shared group</Trans>
        </Button>
      ) : null}
    </div>
  );
}
