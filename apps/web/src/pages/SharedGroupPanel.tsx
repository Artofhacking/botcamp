import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Group } from "@botcamp/contracts";
import { GROUP_MEMBER_MAX, GROUP_NAME_MAX_LENGTH } from "@botcamp/contracts";
import { BotAvatar, Button, Checkbox, Input, SectionHeading } from "@botcamp/ui-web";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { errorText } from "../lib/user-error";
import type { createSpaceRpc } from "../lib/rpc";
import { DeleteItemDialog } from "./shell/dialogs";

const EMAIL_LIMIT = 20;

function looksLikeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function manageable(role: Group["myRole"]) {
  return role === "owner" || role === "admin";
}

export function CreateSharedGroupForm({
  bots,
  onCancel,
  onCreate,
}: {
  bots: Bot[];
  onCancel: () => void;
  onCreate: (input: { name: string; emails?: string[]; botIds?: string[] }) => Promise<void>;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const [name, setName] = useState("");
  const [draft, setDraft] = useState("");
  const [emails, setEmails] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = bots.filter((bot) => !bot.archivedAt);

  function addEmail() {
    const email = draft.trim().toLowerCase();
    if (!email) return;
    if (!looksLikeEmail(email)) {
      setError(t`Invite with an email`);
      return;
    }
    setError(null);
    setDraft("");
    setEmails((current) =>
      current.includes(email) || current.length >= EMAIL_LIMIT ? current : [...current, email],
    );
  }

  function toggle(botId: string) {
    setSelected((current) => {
      if (current.includes(botId)) return current.filter((id) => id !== botId);
      if (current.length >= GROUP_MEMBER_MAX) return current;
      return [...current, botId];
    });
  }

  async function create() {
    const trimmed = name.trim();
    if (submitting || !trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        name: trimmed,
        ...(emails.length ? { emails } : {}),
        ...(selected.length ? { botIds: selected } : {}),
      });
    } catch (cause) {
      setError(errorText(cause, t`Could not create group`));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="create-shared-group">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          <Trans>New shared group</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Cancel new group`}
          onClick={onCancel}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <label htmlFor={nameId} className="block text-sm text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={nameId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t`Name this group`}
          maxLength={GROUP_NAME_MAX_LENGTH}
          className="mt-2"
        />
      </label>
      <div className="mt-5">
        <span className="text-sm text-muted-foreground">
          <Trans>People</Trans>
        </span>
        <div className="mt-2 flex gap-2">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addEmail();
              }
            }}
            placeholder={t`Invite with an email`}
            aria-label={t`Invite with an email`}
          />
          <Button type="button" variant="outline" onClick={addEmail} disabled={!draft.trim()}>
            <Trans>Add</Trans>
          </Button>
        </div>
        {emails.length ? (
          <ul className="mt-2 space-y-1">
            {emails.map((email) => (
              <li key={email} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">{email}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEmails((current) => current.filter((item) => item !== email))}
                >
                  <Trans>Remove</Trans>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="mt-5 min-h-0 flex-1">
        <span className="text-sm text-muted-foreground">
          <Trans>Your bots</Trans>
        </span>
        <div className="mt-2 space-y-1 overflow-y-auto">
          {choices.map((bot) => {
            const checked = selected.includes(bot.id);
            return (
              <label key={bot.id} className="flex items-center gap-3 rounded-xl px-2.5 py-2">
                <BotAvatar
                  avatarSet={bot.avatarSet}
                  color={bot.color}
                  identity={bot.id}
                  size={28}
                  status={bot.status}
                />
                <span className="min-w-0 flex-1 truncate text-[15px]">{bot.name}</span>
                <Checkbox
                  checked={checked}
                  aria-label={bot.name}
                  onCheckedChange={() => toggle(bot.id)}
                />
              </label>
            );
          })}
        </div>
      </div>
      <Button className="mt-5 w-full" disabled={submitting || !name.trim()} onClick={() => void create()}>
        {submitting ? <Trans>Creating…</Trans> : <Trans>Create shared group</Trans>}
      </Button>
    </div>
  );
}

export function SharedGroupSettings({
  rpc,
  group,
  bots,
  userId,
  pages,
  onGroup,
  onLeft,
  onRemove,
  onClose,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  group: Group;
  bots: Bot[];
  userId: string | undefined;
  pages?: ReactNode;
  onGroup: (group: Group) => void;
  onLeft: () => void;
  onRemove: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const [name, setName] = useState(group.name);
  const [shown, setShown] = useState(group);
  if (group !== shown) {
    setShown(group);
    if (name === shown.name) setName(group.name);
  }
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const manager = manageable(group.myRole);
  const owner = group.myRole === "owner";
  const ownBotIds = new Set(bots.filter((bot) => !bot.archivedAt).map((bot) => bot.id));
  const memberBotIds = new Set(group.members.map((member) => member.botId));
  const available = bots.filter((bot) => !bot.archivedAt && !memberBotIds.has(bot.id));
  const full = group.members.length >= GROUP_MEMBER_MAX;

  async function run(key: string, action: () => Promise<void>) {
    if (pending) return;
    setPending(key);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause, t`Could not save group`));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="shared-group-settings">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          <Trans>Group settings</Trans>
        </span>
        <Button variant="ghost" size="icon-sm" aria-label={t`Close panel`} onClick={onClose}>
          <X size={16} strokeWidth={1.8} />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {manager ? (
        <label htmlFor={nameId} className="block text-sm text-muted-foreground">
          <Trans>Name</Trans>
          <Input
            id={nameId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={GROUP_NAME_MAX_LENGTH}
            className="mt-2"
          />
        </label>
      ) : (
        <p className="text-[15px]">{group.name}</p>
      )}
      {manager && name.trim() && name.trim() !== group.name ? (
        <Button
          className="mt-3 w-full"
          disabled={pending !== null}
          onClick={() =>
            void run("name", async () => {
              onGroup(await rpc.groups.update({ groupId: group.id, name: name.trim() }));
            })
          }
        >
          <Trans>Save</Trans>
        </Button>
      ) : null}
      <section className="mt-6">
        <SectionHeading variant="label" className="mb-2">
          <Trans>People</Trans>
        </SectionHeading>
        <ul className="space-y-2">
          {group.people?.map((person) => (
            <li key={person.userId} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{person.name}</span>
              <span className="text-muted-foreground">
                {person.role === "owner" ? (
                  <Trans>Owner</Trans>
                ) : person.role === "admin" ? (
                  <Trans>Admin</Trans>
                ) : (
                  <Trans>Member</Trans>
                )}
              </span>
              {owner && person.role !== "owner" ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending !== null}
                    onClick={() =>
                      void run(`role:${person.userId}`, async () => {
                        onGroup(
                          await rpc.groups.setPersonRole({
                            groupId: group.id,
                            userId: person.userId,
                            role: person.role === "admin" ? "member" : "admin",
                          }),
                        );
                      })
                    }
                  >
                    {person.role === "admin" ? <Trans>Member</Trans> : <Trans>Admin</Trans>}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending !== null}
                    onClick={() =>
                      void run(`person:${person.userId}`, async () => {
                        onGroup(
                          await rpc.groups.removePerson({
                            groupId: group.id,
                            userId: person.userId,
                          }),
                        );
                      })
                    }
                  >
                    <Trans>Remove</Trans>
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
        {manager ? (
          <div className="mt-3 flex gap-2">
            <Input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t`Invite with an email`}
              aria-label={t`Invite with an email`}
            />
            <Button
              variant="outline"
              disabled={pending !== null || !email.trim()}
              onClick={() =>
                void run("invite", async () => {
                  onGroup(await rpc.groups.invite({ groupId: group.id, email: email.trim() }));
                  setEmail("");
                })
              }
            >
              <Trans>Add</Trans>
            </Button>
          </div>
        ) : null}
      </section>
      <section className="mt-6">
        <SectionHeading variant="label" className="mb-2">
          <Trans>Your bots</Trans>
        </SectionHeading>
        <ul className="space-y-2">
          {group.members.map((member) => {
            const mine = ownBotIds.has(member.botId);
            const canRemove = owner || (manager && mine);
            return (
              <li key={member.botId} className="flex items-center gap-2">
                <BotAvatar
                  avatarSet={member.avatarSet}
                  color={member.color}
                  identity={member.botId}
                  size={28}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{member.name}</span>
                {canRemove ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending !== null}
                    onClick={() =>
                      void run(`bot:${member.botId}`, async () => {
                        onGroup(
                          await rpc.groups.removeBot({ groupId: group.id, botId: member.botId }),
                        );
                      })
                    }
                  >
                    <Trans>Remove</Trans>
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {manager && !full
          ? available.map((bot) => (
              <div key={bot.id} className="mt-2 flex items-center gap-2">
                <BotAvatar
                  avatarSet={bot.avatarSet}
                  color={bot.color}
                  identity={bot.id}
                  size={28}
                  status={bot.status}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{bot.name}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending !== null}
                  onClick={() =>
                    void run(`add:${bot.id}`, async () => {
                      onGroup(await rpc.groups.addBot({ groupId: group.id, botId: bot.id }));
                    })
                  }
                >
                  <Trans>Add</Trans>
                </Button>
              </div>
            ))
          : null}
      </section>
      {pages ? <section className="mt-6">{pages}</section> : null}
      {owner ? (
        <Button
          variant="destructive"
          className="mt-6 w-full"
          disabled={pending !== null}
          onClick={() => setConfirmingDelete(true)}
        >
          <Trans>Delete group</Trans>
        </Button>
      ) : userId ? (
        <Button
          variant="outline"
          className="mt-6 w-full"
          disabled={pending !== null}
          onClick={() =>
            void run("leave", async () => {
              await rpc.groups.removePerson({ groupId: group.id, userId });
              onLeft();
            })
          }
        >
          <Trans>Leave</Trans>
        </Button>
      ) : null}
      {confirmingDelete ? (
        <DeleteItemDialog
          item={group}
          noun="group"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={onRemove}
        />
      ) : null}
    </div>
  );
}
