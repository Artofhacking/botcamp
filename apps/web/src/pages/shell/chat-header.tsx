import type { Bot, Group, ThreadSnapshot } from "@botcamp/contracts";
import { sharedGroupFaces } from "@botcamp/core";
import { BotAvatar, Button, GroupAvatar } from "@botcamp/ui-web";
import { useLingui } from "@lingui/react/macro";
import { Gift, Menu, Phone } from "lucide-react";
import { useState } from "react";
import { IconTooltip } from "../../components/IconTooltip";
import { InviteDialog } from "../../components/InviteDialog";
import { useBilling } from "../../components/SubscriptionGate";
import { SharedMark } from "./shared-mark";

/** The floating header over the transcript: navigation, the chat's name, call and invite. */
export function ChatHeader({
  inGroup,
  active,
  activeGroup,
  activeSnapshot,
  phoneCallsEnabled,
  voiceReady,
  inCall,
  panelOpen,
  onOpenNavigation,
  onTogglePanel,
  onCall,
}: {
  inGroup: boolean;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  activeSnapshot: ThreadSnapshot | null;
  phoneCallsEnabled: boolean;
  /** False while the voice status loads or no voice is connected; the button then opens voice settings. */
  voiceReady: boolean;
  inCall: boolean;
  panelOpen: boolean;
  onOpenNavigation: () => void;
  onTogglePanel: () => void;
  onCall: (bot: Bot) => void;
}) {
  const { t } = useLingui();
  const referral = useBilling().status?.referral;
  const [inviteOpen, setInviteOpen] = useState(false);
  const headerMembers = sharedGroupFaces(
    activeGroup?.shared,
    activeGroup?.members,
    activeSnapshot?.members,
  );
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 grid grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-2 px-3 py-[13px] md:px-[22px] [&_button]:pointer-events-auto">
      <div className="flex items-center">
        <Button
          variant="floating"
          size="icon-lg"
          aria-label={t`Open navigation`}
          onClick={onOpenNavigation}
          className="app-no-drag md:hidden"
        >
          <Menu strokeWidth={1.7} className="size-[19px]" />
        </Button>
      </div>
      <Button
        variant="floating"
        data-testid="bot-settings-trigger"
        aria-expanded={panelOpen}
        onClick={onTogglePanel}
        className="app-no-drag h-auto min-w-0 gap-2 py-1 ps-1 pe-3.5"
      >
        {inGroup ? (
          <GroupAvatar members={[...headerMembers]} size={26} />
        ) : active ? (
          <BotAvatar
            avatarSet={active.avatarSet}
            color={active.color}
            identity={active.id}
            size={26}
            status={active.status}
          />
        ) : null}
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5" dir="auto">
            <span className="truncate text-[15px] font-medium text-foreground">
              {inGroup
                ? (activeGroup?.name ?? activeSnapshot?.groupName ?? t`Group`)
                : (active?.name ?? t`Select a bot`)}
            </span>
            {activeGroup?.shared ? <SharedMark /> : null}
          </span>
          {activeGroup?.shared && headerMembers.length > 0 ? (
            <span className="mt-0.5 flex max-w-72 flex-wrap items-center gap-x-2 gap-y-1">
              {headerMembers.map((member) => (
                <span key={member.botId} className="flex min-w-0 items-center gap-1">
                  <BotAvatar
                    avatarSet={member.avatarSet}
                    color={member.color}
                    identity={member.botId}
                    size={18}
                  />
                  <span className="truncate text-[12px] text-muted-foreground" dir="auto">
                    {member.name}
                  </span>
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </Button>
      <div className="flex items-center justify-self-end gap-2">
        {phoneCallsEnabled && !inGroup && active ? (
          <IconTooltip label={inCall ? t`Open call` : t`Call`}>
            <Button
              variant="floating"
              size="icon-lg"
              data-testid="call-button"
              aria-label={inCall ? t`Open call` : t`Call`}
              onClick={() => onCall(active)}
              data-active={inCall ? "" : undefined}
              data-voice-ready={voiceReady ? "" : undefined}
              className="app-no-drag"
            >
              <Phone strokeWidth={1.6} className="size-[17px]" />
            </Button>
          </IconTooltip>
        ) : null}
        {referral && !inGroup && active ? (
          <IconTooltip label={t`Invite a friend`}>
            <Button
              variant="floating"
              size="icon-lg"
              aria-label={t`Invite a friend`}
              onClick={() => setInviteOpen(true)}
              className="app-no-drag"
            >
              <Gift strokeWidth={1.6} className="size-[17px]" />
            </Button>
          </IconTooltip>
        ) : null}
      </div>
      {referral ? (
        <InviteDialog referral={referral} open={inviteOpen} onOpenChange={setInviteOpen} />
      ) : null}
    </div>
  );
}
