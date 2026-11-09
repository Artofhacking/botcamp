import { useLingui } from "@lingui/react/macro";
import type { Bot, Group, Routine } from "@rakazo/contracts";
import {
  buildComposerMentionOptions,
  createRoutineMentionBatcher,
  mentionConnectorsFrom,
} from "@rakazo/core";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { cronLabels } from "../../lib/cron";
import type { SpaceQueries } from "../../lib/query";
import type { createSpaceRpc } from "../../lib/rpc";

function routineListData(results: Array<{ data?: Routine[] }>) {
  return results.map((result) => result.data);
}

/** What the composer can @mention. */
export function useComposerMentions({
  rpc,
  queries,
  bots,
  groups,
  inGroup,
  groupId,
  initialBotsLoaded,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  queries: SpaceQueries;
  bots: Bot[];
  groups: Group[];
  inGroup: boolean;
  groupId: string | undefined;
  initialBotsLoaded: boolean;
}) {
  const { i18n } = useLingui();
  const loadRoutineMentions = useMemo(
    () =>
      createRoutineMentionBatcher(
        (botIds, signal) => rpc.routines.listForMentions({ botIds }, { signal }),
        (botId, signal) => rpc.routines.list({ botId }, { signal }),
      ),
    [rpc],
  );
  const routineLists = useQueries({
    queries: bots.map((bot) => ({
      ...queries.routines.list.queryOptions({ input: { botId: bot.id } }),
      queryFn: ({ signal }: { signal: AbortSignal }) => loadRoutineMentions(bot.id, signal),
    })),
    combine: routineListData,
  });
  const mentionRoutines = useMemo(
    () =>
      bots.flatMap((bot, index) =>
        (routineLists[index] ?? []).map((routine) => ({ ...routine, botName: bot.name })),
      ),
    [bots, routineLists],
  );
  const composerConnections = useQuery({
    queryKey: [...queries.connections.catalog.queryKey({ input: {} }), "with-connections"],
    // The catalog call reconciles connection rows, so list them after it.
    queryFn: async () => {
      const catalog = await rpc.connections.catalog({}).catch(() => null);
      const connections = await rpc.connections.list().catch(() => null);
      return { catalog, connections };
    },
    enabled: initialBotsLoaded,
  });
  // A changed roster refreshes connection data too.
  const mentionBotsKey = useMemo(
    () => bots.map((bot) => `${bot.id}:${bot.name}`).join(","),
    [bots],
  );
  const connectionsRoster = useRef<string | null>(null);
  useEffect(() => {
    if (!initialBotsLoaded) return;
    const previous = connectionsRoster.current;
    connectionsRoster.current = mentionBotsKey;
    if (previous !== null && previous !== mentionBotsKey) void composerConnections.refetch();
  }, [initialBotsLoaded, mentionBotsKey]);
  const mentionConnectors = useMemo(() => {
    const { catalog, connections } = composerConnections.data ?? {};
    return bots.length === 0 ? [] : mentionConnectorsFrom(connections ?? [], catalog ?? []);
  }, [bots.length, composerConnections.data]);
  const composerMentionTargets = useMemo(
    () =>
      buildComposerMentionOptions({
        query: "",
        includeEveryone: inGroup,
        currentGroupId: groupId,
        bots: bots.map((bot) => ({
          id: bot.id,
          name: bot.name,
          color: bot.color,
          avatarSet: bot.avatarSet,
        })),
        groups: groups.map((group) => ({ id: group.id, name: group.name })),
        routines: mentionRoutines.map((routine) => ({
          id: routine.id,
          name: routine.name,
          crons: routine.crons,
          botId: routine.botId,
          botName: routine.botName,
        })),
        connectors: mentionConnectors,
        cronLabels: cronLabels(i18n.locale),
      }),
    [bots, groupId, groups, i18n.locale, inGroup, mentionConnectors, mentionRoutines],
  );
  return { composerMentionTargets };
}
