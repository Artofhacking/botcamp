import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Group } from "@botcamp/contracts";
import { GROUP_MEMBER_MAX, GROUP_NAME_MAX_LENGTH } from "@botcamp/contracts";
import {
  BotAvatar,
  Button,
  Checkbox,
  Input,
  ListSearchInput,
  SectionHeading,
} from "@botcamp/ui-web";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
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
    if (pending) return false;
    setPending(key);
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(errorText(cause, t`Could not save group`));
      return false;
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
        <ul className="space-y-1">
          {group.people?.map((person) => (
            <li key={person.userId} className="flex min-h-9 items-center gap-2 rounded-xl px-1.5">
              <PersonFace name={person.name} />
              <span className="min-w-0 flex-1 truncate text-sm">{person.name}</span>
              <span className="flex shrink-0 items-center gap-1">
                {owner && person.role !== "owner" ? (
                  <PersonRoleSelect
                    name={person.name}
                    group={person.userId}
                    role={person.role}
                    disabled={pending !== null}
                    onRole={(role) =>
                      run(`role:${person.userId}`, async () => {
                        onGroup(
                          await rpc.groups.setPersonRole({
                            groupId: group.id,
                            userId: person.userId,
                            role,
                          }),
                        );
                      })
                    }
                  />
                ) : (
                  <RoleLabel role={person.role} />
                )}
                {owner && person.role !== "owner" ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t`Remove`}
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
                    <X />
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {manager ? (
          <InviteSearch
            disabled={pending !== null}
            onSearch={async (query) =>
              (await rpc.groups.searchPeople({ groupId: group.id, query })).people
            }
            onInvite={(email) =>
              run("invite", async () => {
                onGroup(await rpc.groups.invite({ groupId: group.id, email }));
              })
            }
          />
        ) : null}
      </section>
      <section className="mt-6">
        <SectionHeading variant="label" className="mb-2">
          <Trans>Your bots</Trans>
        </SectionHeading>
        <ul className="space-y-1">
          {group.members.map((member) => {
            const mine = ownBotIds.has(member.botId);
            const canRemove = owner || (manager && mine);
            return (
              <li key={member.botId} className="flex items-center gap-2 rounded-xl px-1.5 py-1">
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
                    size="icon-sm"
                    aria-label={t`Remove`}
                    disabled={pending !== null}
                    onClick={() =>
                      void run(`bot:${member.botId}`, async () => {
                        onGroup(
                          await rpc.groups.removeBot({ groupId: group.id, botId: member.botId }),
                        );
                      })
                    }
                  >
                    <X />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {manager && !full && available.length > 0 ? (
          <OwnBotSearch
            bots={available}
            disabled={pending !== null}
            onAdd={(botId) =>
              run(`add:${botId}`, async () => {
                onGroup(await rpc.groups.addBot({ groupId: group.id, botId }));
              })
            }
          />
        ) : null}
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

function personInitial(name: string) {
  return name.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "?";
}

function PersonFace({ name }: { name: string }) {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs text-foreground">
      {personInitial(name)}
    </span>
  );
}

function RoleLabel({ role }: { role: "owner" | "admin" | "member" }) {
  return (
    <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
      {role === "owner" ? (
        <Trans>Owner</Trans>
      ) : role === "admin" ? (
        <Trans>Admin</Trans>
      ) : (
        <Trans>Member</Trans>
      )}
    </span>
  );
}

function PersonRoleSelect({
  name,
  group,
  role,
  disabled,
  onRole,
}: {
  name: string;
  group: string;
  role: "admin" | "member";
  disabled: boolean;
  onRole: (role: "admin" | "member") => Promise<boolean>;
}) {
  const { t } = useLingui();
  const options = [
    { value: "member" as const, label: t`Member` },
    { value: "admin" as const, label: t`Admin` },
  ];
  return (
    <fieldset aria-label={name} className="m-0 inline-flex rounded-lg border-0 bg-muted p-0.5">
      {options.map((option) => {
        const selected = option.value === role;
        const tone = selected
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground";
        return (
          <label
            key={option.value}
            className={`rounded-md px-2 py-0.5 text-xs ${tone}${disabled ? " opacity-50" : ""}`}
          >
            <input
              type="radio"
              name={group}
              value={option.value}
              checked={selected}
              disabled={disabled}
              className="sr-only"
              onChange={() => {
                if (!selected) void onRole(option.value);
              }}
            />
            {option.label}
          </label>
        );
      })}
    </fieldset>
  );
}

function InviteSearch({
  disabled,
  onSearch,
  onInvite,
}: {
  disabled: boolean;
  onSearch: (query: string) => Promise<Array<{ userId: string; name: string; email: string }>>;
  onInvite: (email: string) => Promise<boolean>;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ userId: string; name: string; email: string }>>(
    [],
  );
  const searchRef = useRef(onSearch);
  searchRef.current = onSearch;
  const trimmed = query.trim();

  useEffect(() => {
    if (!trimmed) {
      setResults([]);
      return;
    }
    let cancel = false;
    const timer = window.setTimeout(() => {
      void searchRef
        .current(trimmed)
        .then((people) => {
          if (!cancel) setResults(people);
        })
        .catch(() => {
          if (!cancel) setResults([]);
        });
    }, 200);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
  }, [trimmed]);

  const typedEmail = looksLikeEmail(trimmed) ? trimmed.toLowerCase() : "";
  const emailListed = results.some((person) => person.email.toLowerCase() === typedEmail);

  async function choose(email: string) {
    if (await onInvite(email)) {
      setQuery("");
      setResults([]);
    }
  }

  return (
    <div className="mt-3">
      <ListSearchInput
        query={query}
        setQuery={setQuery}
        label={t`People`}
        placeholder={t`Search`}
      />
      {results.length || typedEmail ? (
        <ul className="mt-1 overflow-hidden rounded-xl border border-border">
          {results.map((person) => (
            <li key={person.userId}>
              <button
                type="button"
                disabled={disabled}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50"
                onClick={() => void choose(person.email)}
              >
                <PersonFace name={person.name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{person.name}</span>
                  {person.email.toLowerCase() === person.name.toLowerCase() ? null : (
                    <span className="block truncate text-xs text-muted-foreground">
                      {person.email}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
          {typedEmail && !emailListed ? (
            <li>
              <button
                type="button"
                disabled={disabled}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
                onClick={() => void choose(typedEmail)}
              >
                <PersonFace name={typedEmail} />
                <span className="min-w-0 flex-1 truncate">{typedEmail}</span>
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function OwnBotSearch({
  bots,
  disabled,
  onAdd,
}: {
  bots: Bot[];
  disabled: boolean;
  onAdd: (botId: string) => Promise<boolean>;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const trimmed = query.trim().toLowerCase();
  const matches = trimmed ? bots.filter((bot) => bot.name.toLowerCase().includes(trimmed)) : [];

  return (
    <div className="mt-3">
      <ListSearchInput
        query={query}
        setQuery={setQuery}
        label={t`Your bots`}
        placeholder={t`Search`}
      />
      {matches.length ? (
        <ul className="mt-1 overflow-hidden rounded-xl border border-border">
          {matches.map((bot) => (
            <li key={bot.id}>
              <button
                type="button"
                disabled={disabled}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50"
                onClick={() =>
                  void onAdd(bot.id).then((added) => {
                    if (added) setQuery("");
                  })
                }
              >
                <BotAvatar
                  avatarSet={bot.avatarSet}
                  color={bot.color}
                  identity={bot.id}
                  size={28}
                  status={bot.status}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{bot.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
