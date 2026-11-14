import type { BotAvatarSet } from "@botcamp/contracts";
import { newClientId, ORGANIC_AVATAR_HEART_FAMILY, organicAvatarFamily } from "@botcamp/core";
import {
  BotAvatar,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@botcamp/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import { errorText } from "../../lib/user-error";
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

/** A preview id the created bot can keep, avoiding the family the dialog never shows. */
function reservedIdentity(): string {
  let id: string;
  do {
    id = `c${newClientId().replaceAll("-", "").slice(0, 24)}`;
  } while (organicAvatarFamily(id) === ORGANIC_AVATAR_HEART_FAMILY);
  return id;
}

/** The recruit window: ready-made bots, each added with one click. */
export function RecruitDialog({
  avatarSet,
  onCancel,
  onAdd,
}: {
  /** The account's set, so the previews match the bots they create. */
  avatarSet: BotAvatarSet;
  onCancel: () => void;
  onAdd: (input: RecruitBotInput) => Promise<void>;
}) {
  const { t } = useLingui();
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previews = useMemo(
    () => RECRUIT_PRESETS.map((preset) => ({ preset, identity: reservedIdentity() })),
    [],
  );

  async function add(presetId: string, identity: string) {
    const entry = previews.find((candidate) => candidate.preset.id === presetId);
    if (!entry || adding) return;
    setError(null);
    setAdding(presetId);
    try {
      await onAdd({
        name: t(entry.preset.name),
        description: t(entry.preset.summary),
        instructions: t(entry.preset.instructions),
        color: entry.preset.color,
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
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        data-testid="recruit-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Recruit</Trans>
          </DialogTitle>
        </DialogHeader>
        <ul className="flex flex-col gap-2">
          {previews.map(({ preset, identity }) => {
            const name = t(preset.name);
            return (
              <li
                key={preset.id}
                data-testid={`recruit-${preset.id}`}
                className="flex items-center gap-3 rounded-xl border border-border p-3"
              >
                <BotAvatar
                  avatarSet={avatarSet}
                  color={preset.color}
                  identity={identity}
                  size={40}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{name}</p>
                  <p className="text-[13px] text-muted-foreground">{t(preset.summary)}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={adding !== null}
                  aria-label={t`Add ${name}`}
                  data-testid={`recruit-add-${preset.id}`}
                  onClick={() => void add(preset.id, identity)}
                >
                  <Trans>Add</Trans>
                </Button>
              </li>
            );
          })}
        </ul>
        {error ? (
          <p role="alert" data-testid="recruit-error" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
