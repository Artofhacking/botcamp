import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@botcamp/contracts";
import {
  BotAvatar,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@botcamp/ui-web";
import { Plus, Users } from "lucide-react";
import { useMemo, useState } from "react";

export function BotCreatePicker({
  bots,
  onCreateBot,
  onOpenBot,
  onCreateGroup,
}: {
  bots: Bot[];
  onCreateBot: () => void;
  onOpenBot: (botId: string) => void;
  onCreateGroup: () => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matched = useMemo(() => {
    if (!needle) return bots;
    return bots.filter((bot) => bot.name.toLowerCase().includes(needle));
  }, [bots, needle]);
  const showCreate =
    !needle ||
    "new bot".includes(needle) ||
    needle.split(/\s+/).every((part) => "new bot".includes(part));

  return (
    <div data-testid="bot-create-picker" className="w-[min(320px,calc(100vw-2rem))]">
      <Command
        shouldFilter={false}
        className="h-auto max-h-(--available-height) rounded-none border-0 bg-transparent p-0"
      >
        <label className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <span className="shrink-0 text-[13px] text-muted-foreground">
            <Trans>To:</Trans>
          </span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t`Search`}
            aria-label={t`Search`}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <CommandList className="flex min-h-0 max-h-none flex-col overflow-hidden p-1 [&>[cmdk-list-sizer]]:flex [&>[cmdk-list-sizer]]:min-h-0 [&>[cmdk-list-sizer]]:flex-col">
          <CommandEmpty>
            <Trans>No bots match</Trans>
          </CommandEmpty>
          <CommandGroup className="shrink-0">
            {showCreate ? (
              <CommandItem
                value="create-new-bot"
                data-testid="create-new-bot"
                onSelect={() => onCreateBot()}
                className="gap-2"
              >
                <span className="flex size-[22px] shrink-0 items-center justify-center">
                  <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
                </span>
                <Trans>New bot</Trans>
              </CommandItem>
            ) : null}
            <CommandItem
              value="create-group"
              data-testid="create-new-group"
              onSelect={() => onCreateGroup()}
              className="gap-2"
            >
              <span className="flex size-[22px] shrink-0 items-center justify-center">
                <Users size={16} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <Trans>New group chat</Trans>
            </CommandItem>
          </CommandGroup>
          <CommandSeparator className="shrink-0" />
          <CommandGroup className="min-h-0 max-h-60 overflow-y-auto">
            {matched.map((bot) => (
              <CommandItem
                key={bot.id}
                value={bot.id}
                data-testid={`picker-bot-${bot.id}`}
                onSelect={() => onOpenBot(bot.id)}
                className="gap-2"
              >
                <BotAvatar
                  avatarSet={bot.avatarSet}
                  color={bot.color}
                  identity={bot.id}
                  size={22}
                  status={bot.status}
                />
                <span className="min-w-0 flex-1 truncate">{bot.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}
