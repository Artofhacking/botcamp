import type { BotAvatarSet } from "@botcamp/contracts";
import { newClientId, ORGANIC_AVATAR_HEART_FAMILY, organicAvatarFamily } from "@botcamp/core";
import {
  BotAvatar,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  ListSearchInput,
  ScrollArea,
} from "@botcamp/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useDeferredValue, useMemo, useRef, useState } from "react";
import { errorText } from "../../lib/user-error";
import type { RecruitPreset } from "./recruit-presets";
import { RECRUIT_PRESETS } from "./recruit-presets";

/** What adding a preset sends to bot creation, with the avatar the preview drew. */
export interface RecruitBotInput {
  name: string;
  description: string;
  instructions: string;
  color: string;
  id?: string;
  avatarFamily?: number;
}

/** Cards rendered before the window asks for the next page. */
const PAGE_SIZE = 60;

/** A preview id the created bot can keep, avoiding the family the dialog never shows. */
function reservedIdentity(): string {
  let id: string;
  do {
    id = `c${newClientId().replaceAll("-", "").slice(0, 24)}`;
  } while (organicAvatarFamily(id) === ORGANIC_AVATAR_HEART_FAMILY);
  return id;
}

/** The recruit window: a searchable catalog of ready-made bots, each added in one click. */
export function RecruitDialog({
  avatarSet,
  presets = RECRUIT_PRESETS,
  onCancel,
  onAdd,
}: {
  /** The account's set, so the previews match the bots they create. */
  avatarSet: BotAvatarSet;
  /** The catalog to offer; the app passes its built-in roles. */
  presets?: readonly RecruitPreset[];
  onCancel: () => void;
  onAdd: (input: RecruitBotInput) => Promise<void>;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // One preview identity per rendered preset, so a card and the bot it creates draw the
  // same avatar. Only rendered presets get one, not the whole catalog.
  const identities = useRef(new Map<string, string>());
  const deferredQuery = useDeferredValue(query);
  const needle = deferredQuery.trim().toLocaleLowerCase();

  const matches = useMemo(
    () =>
      presets.filter((preset) => {
        if (!needle) return true;
        return (
          t(preset.name).toLocaleLowerCase().includes(needle) ||
          t(preset.summary).toLocaleLowerCase().includes(needle)
        );
      }),
    [presets, needle, t],
  );
  const visible = matches.slice(0, visibleCount);

  function identityFor(presetId: string): string {
    const cached = identities.current.get(presetId);
    if (cached) return cached;
    const identity = reservedIdentity();
    identities.current.set(presetId, identity);
    return identity;
  }

  async function add(preset: RecruitPreset) {
    if (adding) return;
    setError(null);
    setAdding(preset.id);
    const identity = identityFor(preset.id);
    try {
      await onAdd({
        name: t(preset.name),
        description: t(preset.summary),
        instructions: t(preset.instructions),
        color: preset.color,
        ...(avatarSet === "rakazo" ? { id: identity } : {}),
        ...(avatarSet === "organic" ? { avatarFamily: organicAvatarFamily(identity) } : {}),
      });
    } catch (err) {
      setError(errorText(err, t`Could not create bot`));
      setAdding(null);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !adding) onCancel();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        initialFocus={searchRef}
        data-testid="recruit-dialog"
        className="flex h-[min(80dvh,44rem)] flex-col gap-3 overflow-hidden sm:max-w-4xl"
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Recruit</Trans>
          </DialogTitle>
        </DialogHeader>
        <ListSearchInput
          query={query}
          setQuery={(next) => {
            setQuery(next);
            setVisibleCount(PAGE_SIZE);
          }}
          label={t`Search bots`}
          placeholder={t`Search bots`}
          inputRef={searchRef}
        />
        <ScrollArea className="min-h-0 flex-1">
          {matches.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              <Trans>No bots match</Trans>
            </p>
          ) : (
            <ul
              data-testid="recruit-list"
              className="grid grid-cols-1 gap-2 pb-1 sm:grid-cols-2 lg:grid-cols-3"
            >
              {visible.map((preset) => {
                const identity = identityFor(preset.id);
                const name = t(preset.name);
                return (
                  <li
                    key={preset.id}
                    data-testid={`recruit-${preset.id}`}
                    className="flex items-start gap-3 rounded-xl border border-border p-3"
                  >
                    <BotAvatar
                      avatarSet={avatarSet}
                      color={preset.color}
                      identity={identity}
                      size={40}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{name}</p>
                      <p className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">
                        {t(preset.summary)}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      disabled={adding !== null}
                      aria-label={t`Add ${name}`}
                      data-testid={`recruit-add-${preset.id}`}
                      onClick={() => void add(preset)}
                    >
                      <Trans>Add</Trans>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {visible.length < matches.length ? (
            <Button
              variant="outline"
              size="sm"
              className="mx-auto my-3 flex"
              data-testid="recruit-show-more"
              onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
            >
              <Trans>Show more</Trans>
            </Button>
          ) : null}
        </ScrollArea>
        {error ? (
          <p role="alert" data-testid="recruit-error" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
