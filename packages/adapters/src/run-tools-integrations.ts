import { normalizedHttpUrl } from "@botcamp/core/egress";
import { executeCloudAgentTool } from "./cloud-agent-service.js";
import { collectLogIds } from "./composio-connector.js";
import { connectApp } from "./connect-app.js";
import { isMailboxAppName } from "./mailbox-app.js";
import { loadSavedMailbox } from "./mailbox-connection.js";
import { qqMailGrantConnected } from "./mcp-oauth.js";
import { addMcpServerFromTool } from "./mcp-server-tool.js";
import { isNotionAppName, NOTION_APP_NAME, NOTION_MCP_ENDPOINT } from "./notion-app.js";
import type { RunContext } from "./run-context.js";
import { runScopedToolExecutionId } from "./run-effects.js";
import { flushProgress, publishMidTurnNarration, showNarrationStatus } from "./run-progress.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { webFetchFromTool, webSearchFromTool } from "./web-tools.js";

export async function cloudAgentTool(ctx: RunContext, call: ToolCall) {
  const { deps, run, bot, context } = ctx;
  const { name, args, effectKey } = call;
  return call.finish(
    await executeCloudAgentTool(
      { ...deps, cloudAgent: ctx.providers.cloudAgent },
      { ...context, operationId: effectKey, botId: bot.id },
      run,
      name,
      args,
    ),
  );
}

export async function connectorTool(ctx: RunContext, call: ToolCall) {
  const { deps, run, bot, thread, context } = ctx;
  const { name, args, effectKey, connectorCall } = call;
  if (deps.connector) {
    let result: unknown = { error: `unknown tool ${name}` };
    for await (const event of deps.connector.execute(
      { ...connectorCall, tool: name, args, executionId: effectKey },
      context,
    )) {
      if (event.type === "result") {
        result = event.data;
        const logIds = collectLogIds(event.data);
        for (const logId of logIds) {
          await deps.events.append({
            spaceId: run.spaceId,
            threadId: thread.id,
            botId: bot.id,
            runId: run.id,
            type: "effect.recorded",
            payload: { tool: name, logId },
          });
        }
      }
      if (event.type === "error") {
        result = { error: event.message };
        for (const logId of event.logIds ?? []) {
          await deps.events.append({
            spaceId: run.spaceId,
            threadId: thread.id,
            botId: bot.id,
            runId: run.id,
            type: "effect.recorded",
            payload: { tool: name, logId },
          });
        }
      }
    }
    return call.finish(result);
  }
  return call.finish({ error: `unknown tool ${name}` });
}

/** Web, cloud agents, MCP servers, app connections and connector tools. */
export const integrationTools: ToolHandlers = {
  async web_search(ctx, call) {
    const { context } = ctx;
    const { args } = call;
    const found = await webSearchFromTool(ctx.providers.web, context, args);
    // A result's exact URL was chosen by the search index, not by text in this run.
    for (const hit of ("results" in found && found.results) || []) {
      const url = normalizedHttpUrl(hit.url);
      if (url) ctx.trust.searchResultUrls.add(url);
    }
    return call.finish(found);
  },
  async web_fetch(ctx, call) {
    const { context } = ctx;
    const { args } = call;
    return call.finish(await webFetchFromTool(ctx.providers.web, context, args));
  },
  async add_mcp_server(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args, executionId } = call;
    return call.finish(await addMcpServerFromTool(deps, run, bot.id, args, executionId));
  },
  async connect_app(ctx, call) {
    const { deps, run, runId, context, bot } = ctx;
    const { args, executionId, applied } = call;
    await flushProgress(ctx);
    await showNarrationStatus(ctx, await publishMidTurnNarration(ctx, true));
    if (typeof args.app === "string" && isNotionAppName(args.app)) {
      const existing = await deps.prisma.mcpServer.findFirst({
        where: { userId: run.userId, spaceId: run.spaceId, endpoint: NOTION_MCP_ENDPOINT },
        select: { id: true },
      });
      if (existing) {
        return call.finish({
          status: "pending",
          message:
            "Notion is already added. Ask the user to choose Connect on Notion in Integrations, or to authorize the card already in the chat.",
        });
      }
      return call.finish(
        await addMcpServerFromTool(
          deps,
          run,
          bot.id,
          {
            name: NOTION_APP_NAME,
            transport: "streamable_http",
            endpoint: NOTION_MCP_ENDPOINT,
            description: "Search and edit pages and databases.",
          },
          executionId,
        ),
      );
    }
    const mailboxConnected =
      typeof args.app === "string" && isMailboxAppName(args.app)
        ? Boolean(
            await loadSavedMailbox(deps.prisma, deps.secretStore, {
              userId: run.userId,
              spaceId: run.spaceId,
            }).catch(() => null),
          ) ||
          (await qqMailGrantConnected(deps.prisma, deps.secretStore, {
            userId: run.userId,
            spaceId: run.spaceId,
          }).catch(() => false))
        : false;
    return call.finish(
      await connectApp(
        deps,
        deps.connectors?.managedProviders?.() ?? [],
        context,
        run,
        args.app,
        applied?.effect.id ?? runScopedToolExecutionId(runId, executionId),
        mailboxConnected,
      ),
    );
  },
};
