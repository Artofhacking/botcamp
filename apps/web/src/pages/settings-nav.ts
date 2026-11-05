import { useLingui } from "@lingui/react/macro";
import {
  Brain,
  Cpu,
  CreditCard,
  Gauge,
  Info,
  KeyRound,
  MessageCircle,
  Monitor,
  Settings,
  ShieldCheck,
  Volume2,
  Wallet,
} from "lucide-react";
import type { ComponentType } from "react";
import type { SettingsSection } from "./shell-overlay";
import { sectionHidden } from "../lib/ui-flags.js";

export type SettingsNavItem = {
  id: SettingsSection;
  label: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
};

/** The settings sections this deployment offers, in nav order. */
export function useSettingsNavItems(available: {
  messaging: boolean;
  wallet: boolean;
  computer: boolean;
  billing: boolean;
  updates: boolean;
}): SettingsNavItem[] {
  const { t } = useLingui();
  const hidden = (id: SettingsSection) => sectionHidden(id);
  return [
    { id: "general", label: t`General`, icon: Settings },
    ...(hidden("models") ? [] : [{ id: "models" as const, label: t`Models`, icon: Cpu }]),
    ...(hidden("voice") ? [] : [{ id: "voice" as const, label: t`Voice`, icon: Volume2 }]),
    { id: "confirmations", label: t`Approvals`, icon: ShieldCheck },
    { id: "vault", label: t`Vault`, icon: KeyRound },
    ...(available.messaging
      ? [{ id: "messaging" as const, label: t`Messaging`, icon: MessageCircle }]
      : []),
    ...(available.wallet ? [{ id: "wallet" as const, label: t`Wallet`, icon: Wallet }] : []),
    { id: "memory", label: t`Memory`, icon: Brain },
    { id: "usage", label: t`Usage`, icon: Gauge },
    ...(available.computer && !hidden("computer")
      ? [{ id: "computer" as const, label: t`Computer`, icon: Monitor }]
      : []),
    ...(available.billing && !hidden("billing")
      ? [{ id: "billing" as const, label: t`Billing`, icon: CreditCard }]
      : []),
    // 字面量：新 msgid 没进编译目录时会渲染成哈希
    { id: "updates" as const, label: "关于", icon: Info },
  ];
}
