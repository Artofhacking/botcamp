import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { Bell, PanelLeftClose, PanelLeftOpen, Plus, Search } from "lucide-react";
import { IconTooltip } from "../../components/IconTooltip";
import { desktopBridge, windowChromeKind } from "../../lib/desktop";
import type { Panel } from "../../lib/right-panel-state";
import { brandIconSrc, siteHomeHref } from "../../lib/static-host-route";
import { WindowChrome } from "../WindowChrome";
import { BotCreatePicker } from "./bot-picker";

const BRAND = "BotCamp";

/** The mark alone: the window and the page title already say what this is. */
function BrandHome({ mini }: { mini: boolean }) {
  return (
    <a
      href={siteHomeHref(window.location.origin)}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="brand-home"
      aria-label={BRAND}
      className={`app-no-drag flex min-w-0 items-center rounded-md text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring ${mini ? "justify-center" : "gap-2"}`}
    >
      <img
        src={brandIconSrc(import.meta.env.BASE_URL)}
        alt=""
        width={22}
        height={22}
        className="size-[22px] shrink-0 rounded-md"
      />
    </a>
  );
}

export function SidebarHeader({
  mini = false,
  createMenuOpen,
  setCreateMenuOpen,
  activityMode,
  toggleActivityMode,
  searchOpen = false,
  onSearch,
  setBotsSidebarCollapsedPref,
  bots,
  setMobileSidebarOpen,
  setPanel,
  navigate,
  setCreateBotOpen,
}: {
  mini?: boolean;
  createMenuOpen: boolean;
  setCreateMenuOpen: (open: boolean) => void;
  activityMode: boolean;
  toggleActivityMode: () => void;
  searchOpen?: boolean;
  onSearch?: () => void;
  setBotsSidebarCollapsedPref: (collapsed: boolean) => void;
  bots: Bot[];
  setMobileSidebarOpen: (open: boolean) => void;
  setPanel: (panel: Panel) => void;
  navigate: (path: string) => void;
  setCreateBotOpen: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const desktop = desktopBridge();
  const hasWindowChrome = Boolean(desktop);
  // The shared spacer is 72px. Traffic lights end sooner, and that extra gap
  // pushes the name into the buttons at the sidebar's normal width.
  const compactLights = !mini && windowChromeKind(desktop) === "darwin";
  const toggleLabel = mini ? t`Show bots` : t`Minimize bots`;
  return (
    <div
      className={`app-drag flex items-center ${mini ? `flex-col gap-2 px-0 pb-2 ${hasWindowChrome ? "pt-4" : "pt-2"}` : "w-full gap-1 px-[18px] pb-3 pt-4"}`}
    >
      {hasWindowChrome ? (
        <div className={compactLights ? "w-14 shrink-0 overflow-hidden" : "shrink-0"}>
          <WindowChrome />
        </div>
      ) : null}
      <BrandHome mini={mini} />
      <div
        className={`relative flex shrink-0 items-center ${mini ? "flex-col gap-0.5" : "ms-auto gap-1"}`}
      >
        {onSearch ? (
          <IconTooltip label={t`Search`}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Search`}
              aria-pressed={searchOpen}
              data-testid="sidebar-search-trigger"
              onClick={onSearch}
              className="app-no-drag text-muted-foreground"
            >
              <Search size={15} strokeWidth={1.8} aria-hidden="true" />
            </Button>
          </IconTooltip>
        ) : null}
        <IconTooltip label={t`Activity`}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Activity`}
            aria-pressed={activityMode}
            data-activity-mode={activityMode ? "on" : "off"}
            onClick={toggleActivityMode}
            className={`app-no-drag ${activityMode ? "bg-accent text-foreground" : "text-muted-foreground"}`}
          >
            {/* A filled bell marks Activity on, so on and hovered never look alike. */}
            <Bell
              size={15}
              strokeWidth={1.8}
              fill={activityMode ? "currentColor" : "none"}
              aria-hidden="true"
            />
          </Button>
        </IconTooltip>
        <IconTooltip label={toggleLabel}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="app-no-drag hidden text-muted-foreground md:inline-flex"
            aria-label={toggleLabel}
            data-testid={mini ? "restore-bots-sidebar" : "minimize-bots-sidebar"}
            onClick={() => setBotsSidebarCollapsedPref(!mini)}
          >
            {mini ? (
              <PanelLeftOpen size={15} strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={15} strokeWidth={1.8} aria-hidden="true" />
            )}
          </Button>
        </IconTooltip>
        <Popover open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
          <IconTooltip label={t`Create`}>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="app-no-drag text-muted-foreground"
                />
              }
              aria-label={t`Create`}
              data-testid="create-menu-trigger"
            >
              <Plus size={15} strokeWidth={1.8} aria-hidden="true" />
            </PopoverTrigger>
          </IconTooltip>
          {/* Unmount with the state change so the panel it opens never coexists with the menu. */}
          {createMenuOpen ? (
            <PopoverContent
              align="end"
              className="app-no-drag w-auto gap-0 overflow-hidden p-0 data-closed:animate-none"
            >
              <BotCreatePicker
                bots={bots}
                onCreateBot={() => {
                  setCreateMenuOpen(false);
                  setMobileSidebarOpen(false);
                  setCreateBotOpen(true);
                }}
                onOpenBot={(id) => {
                  setCreateMenuOpen(false);
                  setMobileSidebarOpen(false);
                  navigate(`/app/${id}`);
                }}
                onCreateGroup={() => {
                  setCreateMenuOpen(false);
                  setMobileSidebarOpen(false);
                  setPanel("create-group");
                }}
              />
            </PopoverContent>
          ) : null}
        </Popover>
      </div>
    </div>
  );
}
