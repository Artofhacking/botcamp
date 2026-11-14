import { randomBytes } from "node:crypto";
import { runContinueJob } from "@botcamp/adapter-kit";
import {
  archiveBot,
  checkpointAndStopComputer,
  defaultVaultItemTitle,
  forgetBotSecret,
  forgetPageShareSecrets,
  hasActiveComputerControl,
  isSecretAlreadySaved,
  listVaultItems,
  newVaultItemName,
  normalizeSecretDestination,
  pageUrlOrigin,
  relabelVaultItem,
  revealBotSecret,
  SPACE_VAULT_NOT_IN_USE,
  stopCancelledGroupRuns,
  storeBotSecret,
  toComputerRef,
  validateBotModelChange,
} from "@botcamp/adapters";
import type {
  Actor,
  Bot,
  BotSecretMetadata,
  SettingsScope,
  VaultPutInput,
} from "@botcamp/contracts";
import { BotSecretAuth, resolveBotAvatarSet } from "@botcamp/contracts";
import { ACTIVE_RUN_STATUSES, displayName } from "@botcamp/core";
import type { Prisma, PrismaClient } from "@botcamp/db";
import {
  BotSectionNameConflictError,
  botProfileLabelsChanged,
  ComputerLimitError,
  commitBotUpdate,
  createSharedGroupRepos,
  ensureComputerRecord,
  expireComputerExecutionLeases,
  InstructionConflictError,
  IsolationError,
  parseComputerMode,
  recordComputerRunEnd,
  recordSecurityEvent,
  restoreBotUnderComputerQuota,
  runAsSystem,
  SharedGroupInputError,
  SpaceDeletionInProgressError,
  settingsTarget,
} from "@botcamp/db";
import { getLogger } from "@botcamp/logging";
import { ORPCError } from "@orpc/server";
import type { AgentImportServices } from "../agent-import.js";
import { agentImportSetupState, createImportedBot, previewAgentImport } from "../agent-import.js";
import { deleteAgentSecret, listAgentSecrets, putAgentSecret } from "../agent-secrets.js";
import { requirePrimaryBot } from "../bot-primary.js";
import { changedBotSettings } from "../bot-setting-analytics.js";
import { requireIdentityConfirmation } from "../identity-confirmation.js";
import type { RouterDeps } from "../router.js";
import { loadMessagePage } from "../thread-message-pages.js";
import type { RouterContext } from "./context.js";
import {
  computerContext,
  isRecordNotFound,
  modelSetup,
  THREAD_MESSAGE_PAGE_SIZE,
} from "./shared.js";

/** Surface a Space deletion race as a retryable conflict instead of a generic failure. */
function mapSpaceLifecycleError(error: unknown): unknown {
  if (error instanceof SpaceDeletionInProgressError) {
    return new ORPCError("CONFLICT", { message: error.message });
  }
  if (error instanceof ComputerLimitError) {
    return new ORPCError("BAD_REQUEST", { message: error.message });
  }
  return error;
}

const BOT_SECRET_INPUT_ERRORS = [
  "Invalid credential destination",
  "Invalid credential length",
  "Credential cannot be used with this authentication method",
  "Remove the existing credential before changing its destination",
  "Credential limit reached",
  "Invalid card",
  "Invalid contact",
  SPACE_VAULT_NOT_IN_USE,
];

/** A credential the user typed that cannot be stored, as a bad request. Never echoes the value. */
export function mapBotSecretInputError(error: unknown): unknown {
  if (
    error instanceof Error &&
    BOT_SECRET_INPUT_ERRORS.some((prefix) => error.message.startsWith(prefix))
  ) {
    return new ORPCError("BAD_REQUEST", { message: error.message });
  }
  return error;
}

/** Map credential validation failures to a bad request without echoing the submitted value. */
function mapBotSecretStoreError(error: unknown): unknown {
  if (error instanceof ORPCError) return error;
  const mapped = mapBotSecretInputError(error);
  if (mapped !== error) return mapped;
  // Login decoding failures: a JSON parse message can quote the submitted value, so never forward it.
  if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")) {
    return new ORPCError("BAD_REQUEST", {
      message: "A website login needs a label and a value for every field",
    });
  }
  return error;
}

function vaultScope(actor: Actor, vault?: SettingsScope) {
  return { userId: actor.userId, spaceId: actor.spaceId, vault };
}

/**
 * Save a vault item. One without a name is new and gets a free name from its title. One already
 * saved under the name keeps its value when none is given, so its title or note can change alone.
 */
async function saveVaultCredential(
  deps: RouterDeps,
  scope: ReturnType<typeof vaultScope>,
  input: Pick<VaultPutInput, "destination" | "value" | "title" | "note">,
) {
  const { name } = input.destination;
  if (input.value === undefined) {
    if (!name) throw new ORPCError("BAD_REQUEST", { message: "A new item needs its value" });
    try {
      const labels = { title: input.title, note: input.note };
      if (!(await relabelVaultItem(deps.prisma, scope, name, labels))) {
        throw new ORPCError("NOT_FOUND", { message: "Credential not found" });
      }
    } catch (error) {
      throw mapBotSecretStoreError(error);
    }
    return vaultItemDto(deps, scope, name);
  }
  const { value } = input;
  // A pasted page URL is saved under its site. One with a username or password is left
  // as typed, so the origin rule turns it down and the person can fix it.
  const site = pageUrlOrigin(input.destination.origin, { allowUserinfo: false, maxLength: 2048 });
  const store = (itemName: string, createOnly: boolean) =>
    storeBotSecret({
      prisma: deps.prisma,
      secretStore: deps.secrets,
      scope,
      destination: { ...input.destination, name: itemName, ...(site ? { origin: site } : {}) },
      plaintext: value,
      title: input.title,
      note: input.note,
      createOnly,
    });
  try {
    if (name) {
      await store(name, false);
      return vaultItemDto(deps, scope, name);
    }
    // A new item is named from its title. It is only ever created, so another save that took
    // the same name a moment earlier is never replaced; this one takes the next free name.
    const base = input.title || defaultVaultItemTitle(input.destination, value);
    for (let attempt = 0; ; attempt++) {
      const fresh = await newVaultItemName(deps.prisma, scope, base, input.destination.auth.type);
      try {
        await store(fresh, true);
        return vaultItemDto(deps, scope, fresh);
      } catch (error) {
        if (attempt >= 2 || !isSecretAlreadySaved(error)) throw error;
      }
    }
  } catch (error) {
    throw mapBotSecretStoreError(error);
  }
}

async function vaultItemDto(
  deps: RouterDeps,
  scope: ReturnType<typeof vaultScope>,
  name: string,
): Promise<BotSecretMetadata> {
  const [row] = await listVaultItems(deps.prisma, deps.secrets, scope, name);
  if (!row) throw new ORPCError("CONFLICT", { message: "Credential was not saved" });
  return botSecretMetadataDto(row);
}

function botSecretMetadataDto(
  row: Awaited<ReturnType<typeof listVaultItems>>[number],
): BotSecretMetadata {
  // Unreadable or no-longer-storable destinations become auth:null so the owner UI stays remove-only.
  const parsed = BotSecretAuth.safeParse(row.auth);
  let auth: BotSecretMetadata["auth"] = null;
  if (parsed.success) {
    try {
      normalizeSecretDestination({ name: row.name, origin: row.origin, auth: parsed.data });
      auth = parsed.data;
    } catch {
      auth = null;
    }
  }
  return {
    name: row.name,
    origin: row.origin,
    auth,
    title: row.title,
    note: row.note,
    ...(row.preview ? { preview: row.preview } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The creation intro's hidden prompt. It names only the tools this bot still has. */
export function botIntroPrompt(input: {
  userName: string;
  spaceName: string | null;
  disabledBuiltinTools: readonly string[];
}): string {
  const canUpdate = !input.disabledBuiltinTools.includes("update_bot");
  const who = [
    "你刚被创建。",
    input.userName ? `${input.userName} 创建了你。` : undefined,
    input.spaceName ? `所在的团队空间叫“${input.spaceName}”。` : undefined,
  ]
    .filter(Boolean)
    .join("");
  return [
    who,
    "用一句话打招呼，格式是“你好，{用户名}。我是{你的名字}。”，紧接一句问对方想办什么事。",
    // A menu of guesses makes a first conversation feel like a form, so there is none.
    "不要弹选项卡，不要列选项，不要编号，不要提议你先帮忙做哪几类事。",
    "全文只用简体中文：不要英文单词，不要表情符号，不要感叹号，不要自称 AI 助手。",
    canUpdate
      ? "对方说完要办的事之后，再用 update_bot 补上你负责什么、怎么做，名字还是“新 Bot”这类占位名时换一个短名字。形象保持不动。"
      : "你没有修改自己资料的权限，先照着对方的要求做。",
    "然后直接开始做，只有在缺信息确实没法动手时才追问一句。",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Creating a bot asks only for a name and a look, so one hidden-prompt turn greets the user and
 * asks what the bot is for. The executor limits the "created" trigger to that question and the
 * bot's own profile, and answering resumes the run as the user's turn.
 */
export async function enqueueBotIntroRun(deps: RouterDeps, actor: Actor, bot: Bot): Promise<void> {
  const threadId = bot.threadId;
  if (!threadId) return;
  // In the scripted test/eval runtime an automatic run would compete with the harness's next
  // queued response.
  if (deps.env.agentRuntime === "scripted") return;
  if ((await modelSetup(deps, actor)).needsModel) return;
  const [user, space] = await Promise.all([
    deps.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } }),
    deps.prisma.space.findUnique({
      where: { id: actor.spaceId },
      select: { name: true, isDefault: true },
    }),
  ]);
  const prompt = botIntroPrompt({
    userName: displayName(user?.name, ""),
    spaceName: space && !space.isDefault ? space.name.trim() || null : null,
    disabledBuiltinTools: bot.disabledBuiltinTools ?? [],
  });
  const run = await deps.prisma.$transaction(async (tx) => {
    // An idempotent create (spawnKey) returns the bot it already made; it gets one intro.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
    if (await tx.run.findFirst({ where: { botId: bot.id }, select: { id: true } })) return null;
    const task = await tx.task.create({
      data: {
        spaceId: actor.spaceId,
        botId: bot.id,
        threadId,
        userId: actor.userId,
        prompt,
        status: "queued",
      },
    });
    return tx.run.create({
      data: {
        spaceId: actor.spaceId,
        botId: bot.id,
        threadId,
        taskId: task.id,
        userId: actor.userId,
        status: "queued",
        trigger: "created",
      },
      select: { id: true },
    });
  });
  if (run) await deps.jobs.enqueue(runContinueJob(run.id));
}

function mapSharedGroupError(error: unknown): unknown {
  if (error instanceof SharedGroupInputError) {
    return new ORPCError("BAD_REQUEST", { message: error.message });
  }
  return mapSpaceLifecycleError(error);
}

export function botsRoutes(ctx: RouterContext) {
  const { deps, repos, botModelValidation, removeBot, agentImportServices, groupRepos, authed } =
    ctx;
  const sharedGroupRepos = createSharedGroupRepos(deps.prisma);
  return {
    bots: {
      list: authed.bots.list.handler(async ({ context }) => repos.listBots(context.actor)),
      listArchived: authed.bots.listArchived.handler(async ({ context }) =>
        repos.listBots(context.actor, { archived: true }),
      ),
      get: authed.bots.get.handler(async ({ context, input }) => {
        const found = (await repos.listBots(context.actor)).find((bot) => bot.id === input.botId);
        if (!found) throw new IsolationError();
        return found;
      }),
      create: authed.bots.create.handler(async ({ context, input }) => {
        await requirePrimaryBot(deps.prisma, context.actor.userId, primaryActorBotId(context));
        let bot: Bot;
        try {
          // Older apps always send Original, which would pin every new bot to it.
          const { avatarSet: _ignored, ...request } = input;
          bot = await repos.createBot(context.actor, request);
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
        await enqueueBotIntroRun(deps, context.actor, bot).catch((error) => {
          getLogger().error("bot intro run enqueue", error);
        });
        return bot;
      }),
      importPreview: authed.bots.importPreview.handler(async ({ context, input }) =>
        previewAgentImport(agentImportServices as AgentImportServices, context.actor, input),
      ),
      importCreate: authed.bots.importCreate.handler(async ({ context, input }) => {
        let bot: Bot;
        try {
          bot = await createImportedBot(agentImportServices, context.actor, input, context.signal);
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
        // An imported bot starts inert: no intro run, paused routines, unapproved servers.
        return bot;
      }),
      importSetupState: authed.bots.importSetupState.handler(async ({ context, input }) =>
        agentImportSetupState(agentImportServices as AgentImportServices, context.actor, input),
      ),
      duplicate: authed.bots.duplicate.handler(async ({ context, input }) => {
        const source = await repos.getBot(context.actor, input.botId);
        const duplicate = await repos
          .createBot(context.actor, {
            name: duplicateBotName(source.name),
            description: source.description,
            instructions: source.instructions,
            notifyOnFinish: source.notifyOnFinish,
            dailyCheckIns: source.dailyCheckIns,
            color: source.color,
            avatarSet: resolveBotAvatarSet(source.avatarSet),
            avatarSetPinned: source.avatarSetPinned,
            modelProvider: source.modelProvider,
            modelId: source.modelId,
            thinkingLevel: source.thinkingLevel,
            disabledBuiltinTools: source.disabledBuiltinTools,
          })
          .catch((error: unknown) => {
            throw mapSpaceLifecycleError(error);
          });
        const assignments = await deps.prisma.botMcpServer.findMany({
          where: {
            botId: source.id,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (assignments.length) {
          await deps.prisma.botMcpServer.createMany({
            data: assignments.map((assignment) => ({
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              botId: duplicate.id,
              serverId: assignment.serverId,
              allowAllTools: assignment.allowAllTools,
              allowedTools: assignment.allowedTools as Prisma.InputJsonValue,
            })),
          });
        }
        return duplicate;
      }),
      reorder: authed.bots.reorder.handler(async ({ context, input }) => {
        await repos.reorderBots(context.actor, input.botIds);
        return { ok: true as const };
      }),
      update: authed.bots.update.handler(async ({ context, input }) => {
        const existing = await repos.getBot(context.actor, input.botId);
        if (input.sectionId) {
          const section = await deps.prisma.botSection.findFirst({
            where: {
              id: input.sectionId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            select: { id: true },
          });
          if (!section) throw new IsolationError();
        }
        const modelChange = await validateBotModelChange(botModelValidation(context.actor), {
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
          provider:
            input.modelProvider !== undefined ? input.modelProvider : existing.modelProvider,
          model: input.modelId !== undefined ? input.modelId : existing.modelId,
          thinkingLevel: input.thinkingLevel,
          current: { provider: existing.modelProvider, model: existing.modelId },
        });
        if (!modelChange.ok) throw new ORPCError("BAD_REQUEST", { message: modelChange.error });
        const thinkingLevel = input.thinkingLevel;
        if (!existing.thread) throw new IsolationError();
        // Picking a set on one bot pins it unless it is the owner's default, which unpins it.
        const avatarSetPinned =
          input.avatarSet === undefined
            ? undefined
            : await deps.prisma.user
                .findUniqueOrThrow({
                  where: { id: context.actor.userId },
                  select: { botAvatarSet: true },
                })
                .then((user) => input.avatarSet !== resolveBotAvatarSet(user.botAvatarSet));
        // 升级/降级是「同一台电脑换运行环境」：沿用同一条 computer 记录和同一份 home，
        // 只改 provider 种类并清掉旧的容器引用，下次 boot 由新 provider 接手。
        if (input.computerTier !== undefined) {
          const computerId = existing.computer?.id;
          const kind = input.computerTier === "small" ? "docker" : "kubernetes";
          if (computerId && existing.computer?.kind !== kind) {
            await runAsSystem("switch a computer's tier", () =>
              deps.prisma.computer.update({
                where: { id: computerId },
                data: { kind, providerRef: null, state: "stopped" },
              }),
            );
          }
          await deps.prisma.bot.update({
            where: { id: input.botId },
            data: { computerTier: input.computerTier },
          });
        }
        // 主 bot 只有一个：换人时先把上一个降下来，再抬起这一个。
        if (input.isPrimary === true && !existing.isPrimary) {
          await deps.prisma.$transaction(async (tx) => {
            await tx.bot.updateMany({
              where: {
                userId: context.actor.userId,
                spaceId: context.actor.spaceId,
                isPrimary: true,
                id: { not: input.botId },
              },
              data: { isPrimary: false },
            });
            await tx.bot.update({ where: { id: input.botId }, data: { isPrimary: true } });
          });
        }
        await commitBotUpdate({
          prisma: deps.prisma,
          notify: (threadId, seq) => deps.events.notify(threadId, seq),
          spaceId: context.actor.spaceId,
          threadId: existing.thread.id,
          botId: input.botId,
          emitBotUpdated:
            botProfileLabelsChanged(input) ||
            input.expectedSettings !== undefined ||
            input.dailyCheckIns !== undefined,
          expectedInstructions: input.expectedInstructions,
          expectedSettings: input.expectedSettings,
          data: {
            name: input.name,
            description: input.description,
            instructions: input.instructions,
            notifyOnFinish: input.notifyOnFinish,
            color: input.color,
            avatarSet: input.avatarSet,
            avatarSetPinned,
            pinned: input.pinned,
            memoryScope: input.memoryScope,
            sectionId: input.sectionId,
            voiceId: input.voiceId,
            autoSpeak: input.autoSpeak,
            ...(input.modelProvider !== undefined
              ? { modelProvider: input.modelProvider, modelId: input.modelId ?? null }
              : {}),
            ...(input.thinkingLevel !== undefined ? { thinkingLevel } : {}),
            ...(input.teamChatAmbientEnabled !== undefined
              ? { teamChatAmbientEnabled: input.teamChatAmbientEnabled }
              : {}),
            ...(input.teamChatRules !== undefined ? { teamChatRules: input.teamChatRules } : {}),
            ...(input.crossSpaceCommunication !== undefined
              ? { crossSpaceCommunication: input.crossSpaceCommunication }
              : {}),
            ...(input.dailyCheckIns !== undefined ? { dailyCheckIns: input.dailyCheckIns } : {}),
            ...(input.fleetManagement !== undefined
              ? { fleetManagement: input.fleetManagement }
              : {}),
            ...(input.disabledBuiltinTools !== undefined
              ? { disabledBuiltinTools: input.disabledBuiltinTools }
              : {}),
            ...(input.computerTier !== undefined ? { computerTier: input.computerTier } : {}),
          },
        }).catch((error) => {
          if (input.expectedSettings && isRecordNotFound(error))
            throw new ORPCError("CONFLICT", {
              message: "Settings changed; review the current settings first.",
            });
          if (!(error instanceof InstructionConflictError)) throw error;
          throw new ORPCError("CONFLICT", { message: error.message });
        });
        for (const setting of changedBotSettings(existing, input)) {
          deps.analytics?.capture(context.actor.userId, { name: "bot_setting_changed", setting });
        }
        const bots = await repos.listBots(context.actor);
        const bot = bots.find((b) => b.id === input.botId);
        if (!bot) throw new IsolationError();
        return bot;
      }),
      restoreInstructions: authed.bots.restoreInstructions.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.thread) throw new IsolationError();
        try {
          await commitBotUpdate({
            prisma: deps.prisma,
            notify: (threadId, seq) => deps.events.notify(threadId, seq),
            spaceId: context.actor.spaceId,
            threadId: bot.thread.id,
            botId: bot.id,
            data: {},
            emitBotUpdated: true,
            expectedInstructions: input.expectedInstructions,
            instructionRestore: { versionId: input.versionId, undo: input.undo },
          });
        } catch (error) {
          if (!(error instanceof InstructionConflictError)) throw error;
          throw new ORPCError("CONFLICT", { message: error.message });
        }
        return (await repos.listBots(context.actor)).find((bot) => bot.id === input.botId)!;
      }),
      archive: authed.bots.archive.handler(async ({ context, input }) => {
        await requirePrimaryBot(deps.prisma, context.actor.userId, primaryActorBotId(context));
        await assertNotPrimaryTarget(deps.prisma, input.botId);
        const bot = await repos.getBot(context.actor, input.botId, { includeArchived: true });
        await archiveBot(
          {
            prisma: deps.prisma,
            sandbox: deps.sandbox,
            home: deps.home,
            jobs: deps.jobs,
            artifacts: deps.artifacts,
            dataDir: deps.dataDir,
          },
          bot,
          computerContext(context.actor, bot.id, "archive"),
        );
        return { ok: true as const };
      }),
      restore: authed.bots.restore.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId, { includeArchived: true });
        if (!bot.archivedAt) return { ok: true as const };
        try {
          if (bot.computer) {
            await restoreBotUnderComputerQuota(deps.prisma, {
              userId: context.actor.userId,
              botId: bot.id,
              computerId: bot.computer.id,
            });
          } else {
            await deps.prisma.bot.update({ where: { id: bot.id }, data: { archivedAt: null } });
          }
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
        return { ok: true as const };
      }),
      remove: authed.bots.remove.handler(async ({ context, input }) => {
        await requirePrimaryBot(deps.prisma, context.actor.userId, primaryActorBotId(context));
        await assertNotPrimaryTarget(deps.prisma, input.botId);
        await removeBot(context.actor, input.botId, { deleteMemories: input.deleteMemories });
        return { ok: true as const };
      }),
      rotateWebhookSecret: authed.bots.rotateWebhookSecret.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const plaintext = randomBytes(32).toString("base64url");
        const stored = await deps.secrets.put(plaintext, {
          operationId: "bots.rotateWebhookSecret",
          traceId: "bots.rotateWebhookSecret",
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          signal: context.signal ?? new AbortController().signal,
        });
        await deps.prisma.$transaction(async (tx) => {
          const previousSecretId = bot.webhookSecretId;
          await tx.secret.create({
            data: {
              id: stored.id,
              userId: context.actor.userId,
              spaceId: context.actor.spaceId,
              kind: "webhook",
              ciphertext: stored.ciphertext,
            },
          });
          await tx.bot.update({
            where: { id: bot.id },
            data: { webhookSecretId: stored.id },
          });
          if (previousSecretId) {
            await tx.secret.deleteMany({
              where: {
                id: previousSecretId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                kind: "webhook",
              },
            });
          }
        });
        return {
          secret: plaintext,
          path: `/api/v1/bots/${bot.id}/webhook`,
          webhookConfigured: true as const,
        };
      }),
    },
    groups: {
      create: authed.groups.create.handler(async ({ context, input }) => {
        try {
          return await groupRepos.createGroup(context.actor, input);
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
      }),
      list: authed.groups.list.handler(async ({ context }) => groupRepos.listGroups(context.actor)),
      listArchived: authed.groups.listArchived.handler(async ({ context }) =>
        groupRepos.listGroups(context.actor, { archived: true }),
      ),
      get: authed.groups.get.handler(async ({ context, input }) => {
        const group = await groupRepos.getGroup(context.actor, input.groupId);
        return {
          ...groupRepos.mapGroup(group),
          messages: (
            await loadMessagePage(
              deps.prisma,
              group.thread!.id,
              undefined,
              THREAD_MESSAGE_PAGE_SIZE,
            )
          ).messages,
        };
      }),
      duplicate: authed.groups.duplicate.handler(async ({ context, input }) => {
        const source = await groupRepos.getGroup(context.actor, input.groupId);
        if (source.shared) throw new IsolationError();
        try {
          return await groupRepos.createGroup(context.actor, {
            name: duplicateBotName(source.name),
            botIds: source.members.map((member) => member.bot.id),
          });
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
      }),
      update: authed.groups.update.handler(async ({ context, input }) => {
        if (input.sectionId) {
          const section = await deps.prisma.botSection.findFirst({
            where: {
              id: input.sectionId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            select: { id: true },
          });
          if (!section) throw new IsolationError();
        }
        const updated = await groupRepos.updateGroup(context.actor, input);
        await stopCancelledGroupRuns(deps, context.actor, updated);
        return updated.group;
      }),
      archive: authed.groups.archive.handler(async ({ context, input }) => {
        const archived = await groupRepos.archiveGroup(context.actor, input.groupId);
        await stopCancelledGroupRuns(deps, context.actor, archived);
        return { ok: true as const };
      }),
      restore: authed.groups.restore.handler(async ({ context, input }) => {
        try {
          await groupRepos.restoreGroup(context.actor, input.groupId);
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
        return { ok: true as const };
      }),
      remove: authed.groups.remove.handler(async ({ context, input }) => {
        const removed = await groupRepos.removeGroup(context.actor, input.groupId);
        try {
          await stopCancelledGroupRuns(deps, context.actor, removed);
        } finally {
          // The group row is already gone, so a retry could no longer find these.
          const cleanup = await Promise.allSettled(
            removed.artifactStorageKeys.map((storageKey) =>
              deps.artifacts.remove(
                storageKey,
                computerContext(
                  context.actor,
                  removed.contextBotId,
                  `group-remove:${input.groupId}`,
                ),
              ),
            ),
          );
          for (const result of cleanup) {
            if (result.status === "rejected")
              getLogger().error("group artifact cleanup", result.reason);
          }
          await forgetPageShareSecrets(deps.secrets, removed.pageShareSecrets);
        }
        return { ok: true as const };
      }),
      createShared: authed.groups.createShared.handler(async ({ context, input }) => {
        try {
          return await sharedGroupRepos.createSharedGroup(context.actor, input);
        } catch (error) {
          throw mapSharedGroupError(error);
        }
      }),
      invite: authed.groups.invite.handler(async ({ context, input }) => {
        try {
          return await sharedGroupRepos.invitePerson(context.actor, input);
        } catch (error) {
          throw mapSharedGroupError(error);
        }
      }),
      searchPeople: authed.groups.searchPeople.handler(async ({ context, input }) => {
        try {
          return { people: await sharedGroupRepos.searchPeople(context.actor, input) };
        } catch (error) {
          throw mapSharedGroupError(error);
        }
      }),
      setPersonRole: authed.groups.setPersonRole.handler(async ({ context, input }) => {
        try {
          return await sharedGroupRepos.setPersonRole(context.actor, input);
        } catch (error) {
          throw mapSharedGroupError(error);
        }
      }),
      removePerson: authed.groups.removePerson.handler(async ({ context, input }) => {
        try {
          return await sharedGroupRepos.removePerson(context.actor, input);
        } catch (error) {
          throw mapSharedGroupError(error);
        }
      }),
      addBot: authed.groups.addBot.handler(async ({ context, input }) => {
        try {
          return await sharedGroupRepos.addBot(context.actor, input);
        } catch (error) {
          throw mapSharedGroupError(error);
        }
      }),
      removeBot: authed.groups.removeBot.handler(async ({ context, input }) => {
        try {
          return await sharedGroupRepos.removeBot(context.actor, input);
        } catch (error) {
          throw mapSharedGroupError(error);
        }
      }),
    },
    botSections: {
      list: authed.botSections.list.handler(async ({ context }) =>
        repos.listBotSections(context.actor),
      ),
      create: authed.botSections.create.handler(async ({ context, input }) =>
        repos.createBotSection(context.actor, input),
      ),
      update: authed.botSections.update.handler(async ({ context, input }) => {
        try {
          return await repos.updateBotSection(context.actor, input);
        } catch (error) {
          if (error instanceof BotSectionNameConflictError) {
            throw new ORPCError("CONFLICT", { message: error.message });
          }
          throw error;
        }
      }),
      remove: authed.botSections.remove.handler(async ({ context, input }) =>
        repos.deleteBotSection(context.actor, input),
      ),
    },
    agentSecrets: {
      list: authed.agentSecrets.list.handler(async ({ context }) =>
        listAgentSecrets({ prisma: deps.prisma, secrets: deps.secrets }, context.actor),
      ),
      put: authed.agentSecrets.put.handler(async ({ context, input }) =>
        putAgentSecret({ prisma: deps.prisma, secrets: deps.secrets }, context.actor, input),
      ),
      remove: authed.agentSecrets.remove.handler(async ({ context, input }) =>
        deleteAgentSecret({ prisma: deps.prisma, secrets: deps.secrets }, context.actor, input.id),
      ),
    },
    vault: {
      list: authed.vault.list.handler(async ({ context, input }) => {
        const rows = await listVaultItems(
          deps.prisma,
          deps.secrets,
          vaultScope(context.actor, input?.scope),
        );
        return rows.map(botSecretMetadataDto);
      }),
      put: authed.vault.put.handler(({ context, input }) =>
        saveVaultCredential(deps, vaultScope(context.actor, input.scope), input),
      ),
      reveal: authed.vault.reveal.handler(async ({ context, input }) => {
        await requireIdentityConfirmation(deps.auth, context);
        // Resolved here, so the event names the vault that was read even when scope is omitted.
        const scope = await settingsTarget(deps.prisma, context.actor, "credentials", input.scope);
        const revealed = await revealBotSecret({
          prisma: deps.prisma,
          secretStore: deps.secrets,
          scope: vaultScope(context.actor, scope),
          name: input.name,
        });
        if (!revealed) throw new ORPCError("NOT_FOUND", { message: "Credential not found" });
        await recordSecurityEvent({
          type: "credential.revealed",
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
          metadata: {
            procedure: "vault.reveal",
            kind: "vault_credential",
            scope,
            name: input.name,
          },
        });
        return revealed;
      }),
      remove: authed.vault.remove.handler(async ({ context, input }) => {
        await forgetBotSecret(deps.prisma, vaultScope(context.actor, input.scope), input.name);
        return { ok: true as const };
      }),
    },
    botSecrets: {
      list: authed.botSecrets.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const rows = await listVaultItems(deps.prisma, deps.secrets, vaultScope(context.actor));
        return rows.map(botSecretMetadataDto);
      }),
      put: authed.botSecrets.put.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return saveVaultCredential(deps, vaultScope(context.actor), input);
      }),
      remove: authed.botSecrets.remove.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        await forgetBotSecret(deps.prisma, vaultScope(context.actor), input.name);
        return { ok: true as const };
      }),
    },
  };
}

function duplicateBotName(name: string) {
  const label = displayName(name, "");
  return label ? `${label.slice(0, 75)} copy` : "";
}

/** The bot that issued this request, when the client names one. */
function primaryActorBotId(context: unknown): string | null {
  const actor = (context as { actor?: { botId?: string | null } | null } | undefined)?.actor;
  return actor?.botId ?? null;
}

/** 主 bot 不能被删除或归档，避免账号失去管理入口。 */
async function assertNotPrimaryTarget(prisma: PrismaClient, botId: string): Promise<void> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { isPrimary: true } });
  if (bot?.isPrimary) {
    throw new ORPCError("BAD_REQUEST", {
      message: "主 bot 不能删除；请先把另一个 bot 设为主 bot",
    });
  }
}
