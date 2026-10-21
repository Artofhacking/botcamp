// 由 scripts/build-function.mjs 从 functions/bot/entry.mjs 打包。改入口，不要手改这个文件。
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// functions/bot/entry.mjs
var entry_exports = {};
__export(entry_exports, {
  handleDemoxRequest: () => handleDemoxRequest,
  handler: () => handler,
  resetDemoxCamp: () => resetDemoxCamp
});
module.exports = __toCommonJS(entry_exports);

// app/botcamp/isolate.mjs
var CROSS_MESSAGE = "\u65E0\u6743\u67E5\u770B\u6216\u64CD\u4F5C\u5176\u4ED6\u7528\u6237\u7684\u673A\u5668\u4EBA\u3001\u4F1A\u8BDD\u6216\u8BBE\u7F6E\u3002";
var QUOTA_MESSAGE = "\u914D\u989D\u5DF2\u7528\u5B8C\uFF0C\u65E0\u6CD5\u53D1\u9001\u3002\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u63D0\u9AD8\u53EF\u53D1\u9001\u7684\u6D88\u606F\u6570\u3002";
var SHARED_MESSAGE = "\u8FD9\u9879\u8BBE\u7F6E\u5728\u5171\u4EAB\u5185\u6838\u4E0A\u662F\u5168\u5C40\u7684\uFF0C\u4E0D\u80FD\u6309\u8D26\u53F7\u4FEE\u6539\uFF0C\u4EE5\u514D\u5F71\u54CD\u5176\u4ED6\u7528\u6237\u3002";
var FILE_MESSAGE = "\u5171\u4EAB\u5185\u6838\u7684\u6587\u4EF6\u548C\u8BCA\u65AD\u65E5\u5FD7\u4E0D\u5411\u5355\u4E2A\u8D26\u53F7\u5F00\u653E\u3002";
var METERED = /* @__PURE__ */ new Set(["send", "memory-ask"]);
var LOCAL = /* @__PURE__ */ new Set(["set-prefs", "set-main", "diagnostics-log", "diagnostics-clear"]);
var BLOCKED = /* @__PURE__ */ new Set([
  "provider-key",
  "provider-add",
  "provider-remove",
  "team-workspace",
  "folder-pick",
  "folder-list",
  "folders",
  "file-text",
  "connector-connect",
  "connector-disconnect",
  "connector-retry",
  "update-install",
  "dsh-update-install"
]);
var FILE_BLOCKED = /* @__PURE__ */ new Set(["team-workspace", "folder-pick", "folder-list", "folders", "file-text"]);
var ID_KEYS = ["id", "botId", "sessionId", "roomId", "agentId"];
var MARK = "~botcamp~";
var PREF_KEYS = /* @__PURE__ */ new Set(["theme", "accent", "motion"]);
function createAccess(userId, resources) {
  const owners = /* @__PURE__ */ new Map();
  for (const resource of resources) {
    if (!owners.has(resource.id)) owners.set(resource.id, resource.userId);
  }
  const owned = new Set(resources.filter((resource) => resource.userId === userId).map((resource) => resource.id));
  const pending = [];
  const released = [];
  return {
    userId,
    owns: (id) => typeof id === "string" && owned.has(id),
    ownerOf: (id) => typeof id === "string" ? owners.get(id) ?? null : null,
    claim(id, kind, parentId = null) {
      if (typeof id !== "string" || id.length === 0 || id.length > 200) return false;
      const owner = owners.get(id);
      if (owner && owner !== userId) return false;
      if (owner === userId) return true;
      owners.set(id, userId);
      owned.add(id);
      pending.push({ id, kind, parentId });
      return true;
    },
    release(id) {
      if (typeof id !== "string" || !owned.has(id)) return;
      released.push(id);
      owned.delete(id);
      owners.delete(id);
    },
    pending: () => pending,
    released: () => released
  };
}
function accessPlan(endpoint, payload) {
  const mustOwn = [];
  const claimIfFree = [];
  let claimKind = "secret";
  if (payload && typeof payload === "object") {
    for (const key of ID_KEYS) {
      if (typeof payload[key] === "string" && payload[key]) mustOwn.push(payload[key]);
    }
    if (endpoint === "exchange") {
      if (typeof payload.a === "string") mustOwn.push(payload.a);
      if (typeof payload.b === "string") mustOwn.push(payload.b);
    }
    if (Array.isArray(payload.members)) {
      for (const member of payload.members) {
        if (typeof member === "string" && member) mustOwn.push(member);
        else if (member && typeof member.id === "string") mustOwn.push(member.id);
      }
    }
    if (endpoint === "secret-delete" || endpoint === "secret-update") {
      if (typeof payload.name === "string") mustOwn.push(payload.name);
    }
    if (endpoint === "capability-delete" || endpoint === "capability-approve" || endpoint === "bot-capability") {
      if (typeof payload.name === "string") mustOwn.push(payload.name);
    }
    if (endpoint === "secret-set" && typeof payload.name === "string") claimIfFree.push(payload.name);
    if (endpoint === "capability-save") {
      claimKind = "capability";
      const name = payload.name ?? payload.capability?.name;
      if (typeof name === "string") claimIfFree.push(name);
    }
  }
  return { mustOwn, claimIfFree, claimKind };
}
function decide(endpoint, payload, access) {
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > 80) {
    return { action: "refuse", message: "\u65E0\u6548\u7684\u8BF7\u6C42\u3002" };
  }
  if (BLOCKED.has(endpoint)) {
    return { action: "refuse", message: FILE_BLOCKED.has(endpoint) ? FILE_MESSAGE : SHARED_MESSAGE };
  }
  if (endpoint === "provider-models" && typeof payload?.key === "string" && payload.key !== "") {
    return { action: "refuse", message: "\u6A21\u578B\u4F9B\u5E94\u5546\u5BC6\u94A5\u4E0D\u80FD\u63D0\u4EA4\u5230\u5171\u4EAB\u5185\u6838\uFF0C\u4EE5\u514D\u88AB\u5176\u4ED6\u8D26\u53F7\u5171\u7528\u3002" };
  }
  const plan = accessPlan(endpoint, payload);
  for (const id of plan.mustOwn) {
    if (!access.owns(id)) return { action: "refuse", message: CROSS_MESSAGE };
  }
  for (const id of plan.claimIfFree) {
    const owner = access.ownerOf(id);
    if (owner && owner !== access.userId) return { action: "refuse", message: CROSS_MESSAGE };
    if (!owner) access.claim(id, plan.claimKind);
  }
  if (LOCAL.has(endpoint)) return { action: "local", endpoint };
  if (METERED.has(endpoint)) return { action: "metered" };
  return { action: "forward" };
}
function mergePrefs(current, patch) {
  const prefs = { ...current ?? {} };
  if (!patch || typeof patch !== "object") return prefs;
  for (const key of PREF_KEYS) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    if (value == null || value === "") {
      delete prefs[key];
      continue;
    }
    if (typeof value !== "string" || value.length > 40) continue;
    if (key === "accent" && !/^#[0-9a-fA-F]{6}$/.test(value)) continue;
    prefs[key] = value;
  }
  return prefs;
}
function prefsVersionFromModelsKey(modelsKey) {
  if (typeof modelsKey !== "string") return null;
  const at = modelsKey.lastIndexOf(MARK);
  if (at < 0) return null;
  const version = Number(modelsKey.slice(at + MARK.length));
  return Number.isInteger(version) ? version : null;
}
function unstampModelsKey(modelsKey) {
  if (typeof modelsKey !== "string") return modelsKey ?? "";
  const at = modelsKey.indexOf(MARK);
  return at >= 0 ? modelsKey.slice(0, at) : modelsKey;
}
function stampModelsKey(modelsKey, prefsVersion) {
  const base = unstampModelsKey(modelsKey == null ? "" : String(modelsKey));
  return `${base}${MARK}${prefsVersion ?? 0}`;
}
function stateRequestPayload(payload, user) {
  const next = payload && typeof payload === "object" ? { ...payload } : {};
  const clientVersion = prefsVersionFromModelsKey(next.models);
  if (clientVersion !== (user.prefsVersion ?? 0)) delete next.since;
  if (typeof next.models === "string") next.models = unstampModelsKey(next.models);
  return next;
}
function keepMap(map, owns) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return {};
  return Object.fromEntries(Object.entries(map).filter(([key]) => owns(key)));
}
function filterWork(work, access) {
  if (!work || typeof work !== "object") return work ?? { bots: {}, approvals: [] };
  const owns = access.owns;
  const approvals = Array.isArray(work.approvals) ? work.approvals.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const mine = owns(entry.botId) || owns(entry.sessionId) || owns(entry.roomId);
    if (!mine) return false;
    if (typeof entry.id === "string") access.claim(entry.id, "approval", entry.botId ?? entry.sessionId ?? null);
    return true;
  }) : [];
  return {
    ...work,
    bots: keepMap(work.bots, owns),
    rooms: keepMap(work.rooms, owns),
    waiting: keepMap(work.waiting, owns),
    approvals
  };
}
function claimBot(access, bot) {
  if (!bot || typeof bot.id !== "string") return false;
  if (!access.owns(bot.id)) return false;
  if (typeof bot.sessionId === "string") access.claim(bot.sessionId, "session", bot.id);
  if (Array.isArray(bot.parts)) {
    for (const part of bot.parts) {
      if (typeof part === "string") access.claim(part, "session", bot.id);
    }
  }
  return true;
}
function filterState(value, user, access) {
  if (!value || typeof value !== "object") return value;
  if (value.unchanged) return value;
  const bots = [];
  for (const bot of value.bots ?? []) {
    if (claimBot(access, bot)) bots.push(bot);
  }
  const rooms = [];
  for (const room of value.rooms ?? []) {
    if (room && access.owns(room.id)) rooms.push(room);
  }
  const agents = [];
  for (const agent of value.agents ?? []) {
    if (!agent || !access.owns(agent.id)) continue;
    agents.push(agent);
    for (const sessionId of agent.sessions ?? []) {
      if (typeof sessionId === "string") access.claim(sessionId, "session", agent.id);
    }
  }
  const mainBotIds = (user.mainBotIds ?? []).filter((id) => access.owns(id));
  const secrets = (value.secrets ?? []).filter((secret) => secret && access.owns(secret.name ?? secret.id));
  const capabilities = (value.capabilities ?? []).filter((item) => item && access.owns(item.name ?? item.id));
  return {
    ...value,
    bots,
    rooms,
    agents,
    mainBotId: mainBotIds[0] ?? null,
    mainBotIds,
    prefs: { ...user.prefs ?? {} },
    questions: keepMap(value.questions, access.owns),
    exchangeTurns: keepMap(value.exchangeTurns, access.owns),
    secrets,
    capabilities,
    capabilityStatuses: keepMap(value.capabilityStatuses, access.owns),
    secretRequests: keepMap(value.secretRequests, access.owns),
    activity: keepMap(value.activity, access.owns),
    memoryNews: keepMap(value.memoryNews, access.owns),
    work: filterWork(value.work, access),
    connectors: [],
    modelsKey: stampModelsKey(value.modelsKey, user.prefsVersion ?? 0)
  };
}
function filterUsage(value, access) {
  if (!value || typeof value !== "object" || !Array.isArray(value.rows)) return value;
  return { ...value, rows: value.rows.filter((row) => Array.isArray(row) && access.owns(row[1])) };
}
function filterSchedules(value, access) {
  const list = Array.isArray(value) ? value : value?.schedules;
  if (!Array.isArray(list)) return value;
  const kept = list.filter((item) => item && (access.owns(item.id) || access.owns(item.sessionId) || access.owns(item.botId)));
  return Array.isArray(value) ? kept : { ...value, schedules: kept };
}
function claimCreated(endpoint, value, access) {
  if (!value || typeof value !== "object") return;
  const body = value.bot ?? value.room ?? value.agent ?? value;
  if (endpoint === "create-bot" || endpoint === "duplicate-bot") {
    if (typeof body.id === "string") access.claim(body.id, "bot");
    if (typeof body.sessionId === "string") access.claim(body.sessionId, "session", body.id ?? null);
    if (Array.isArray(body.parts)) {
      for (const part of body.parts) if (typeof part === "string") access.claim(part, "session", body.id ?? null);
    }
  } else if (endpoint === "create-room") {
    if (typeof body.id === "string") access.claim(body.id, "room");
  } else if (endpoint === "add-agent") {
    if (typeof body.id === "string") access.claim(body.id, "agent");
    for (const sessionId of body.sessions ?? []) {
      if (typeof sessionId === "string") access.claim(sessionId, "session", body.id ?? null);
    }
  } else if (endpoint === "agent-session") {
    const sessionId = value.sessionId ?? body.sessionId ?? (typeof body.id === "string" && body.id !== value.agentId ? body.id : null);
    if (typeof sessionId === "string") access.claim(sessionId, "session", value.agentId ?? null);
  } else if (endpoint === "schedule-create") {
    const id = value.id ?? value.schedule?.id;
    if (typeof id === "string") access.claim(id, "schedule", value.sessionId ?? null);
  }
}
var RELEASE_ENDPOINTS = /* @__PURE__ */ new Set(["delete-bot", "delete-room", "remove-agent", "schedule-delete", "secret-delete", "capability-delete"]);
function releaseDeleted(endpoint, payload, access) {
  if (!RELEASE_ENDPOINTS.has(endpoint) || !payload || typeof payload !== "object") return;
  if (typeof payload.id === "string") access.release(payload.id);
  if (typeof payload.name === "string") access.release(payload.name);
}
function rewriteValue(endpoint, value, user, access) {
  if (endpoint === "state") return filterState(value, user, access);
  if (endpoint === "usage") return filterUsage(value, access);
  if (endpoint === "schedules") return filterSchedules(value, access);
  if (endpoint === "providers") return stripSecrets(value);
  return value;
}
function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && /apiKey|token|password|secret|authorization/i.test(key)) continue;
    next[key] = stripSecrets(child);
  }
  return next;
}
function localValue(endpoint, user) {
  if (endpoint === "diagnostics-log") return "";
  if (endpoint === "diagnostics-clear") return true;
  if (endpoint === "set-prefs") return { ...user.prefs ?? {} };
  if (endpoint === "set-main") return { mainBotIds: [...user.mainBotIds ?? []] };
  return null;
}
function feedBlockAllowed(block, access) {
  const lines = block.split("\n");
  if (lines.every((line) => line === "" || line.startsWith(":"))) return true;
  let event = "message";
  const data = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (event === "hello" || event === "revision") return true;
  if (data.length === 0) return false;
  let payload;
  try {
    payload = JSON.parse(data.join("\n"));
  } catch {
    return false;
  }
  const ids = [];
  for (const key of ID_KEYS) {
    if (typeof payload?.[key] === "string" && payload[key]) ids.push(payload[key]);
  }
  if (ids.length === 0) return false;
  let mine = false;
  for (const id of ids) {
    const owner = access.ownerOf(id);
    if (owner && owner !== access.userId) return false;
    if (owner === access.userId) mine = true;
  }
  if (!mine) return false;
  for (const id of ids) if (!access.ownerOf(id)) access.claim(id, "session");
  return true;
}
function feedMessageItem(block) {
  const data = [];
  let event = "message";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (event !== "message" || data.length === 0) return null;
  try {
    const payload = JSON.parse(data.join("\n"));
    if (!payload || typeof payload.sessionId !== "string" || !payload.item) return null;
    return payload;
  } catch {
    return null;
  }
}

// app/botcamp/store.mjs
var import_node_crypto2 = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"), 1);
var import_node_url = require("node:url");

// app/botcamp/passwords.mjs
var import_node_crypto = require("node:crypto");
var import_node_util = require("node:util");
var scryptAsync = (0, import_node_util.promisify)(import_node_crypto.scrypt);
var KEY_LEN = 32;
async function hashPassword(password) {
  const salt = (0, import_node_crypto.randomBytes)(16).toString("base64url");
  const key = await scryptAsync(password, salt, KEY_LEN);
  return `scrypt$${salt}$${key.toString("base64url")}`;
}
async function verifyPassword(password, stored) {
  const parts = typeof stored === "string" ? stored.split("$") : [];
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, encoded] = parts;
  let expected;
  try {
    expected = Buffer.from(encoded, "base64url");
  } catch {
    return false;
  }
  if (expected.length !== KEY_LEN) return false;
  const actual = await scryptAsync(String(password), salt, KEY_LEN);
  return (0, import_node_crypto.timingSafeEqual)(actual, expected);
}
function normalizeEmail(email) {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
}
function validEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function validPassword(password) {
  return typeof password === "string" && password.length >= 8 && password.length <= 200;
}

// app/botcamp/store.mjs
var import_meta = {};
var SESSION_MS = 14 * 24 * 60 * 60 * 1e3;
function defaultDataDir() {
  if (!import_meta.url) return import_node_path.default.join(process.cwd(), "data");
  return (0, import_node_url.fileURLToPath)(new URL("../../data", import_meta.url));
}
function emptyData() {
  return { users: [], sessions: [], resources: [] };
}
function publicUser(user) {
  const quota = user.quota ?? 0;
  const used = user.used ?? 0;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    quota,
    used,
    remaining: Math.max(0, quota - used),
    createdAt: user.createdAt
  };
}
function principal(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    quota: user.quota ?? 0,
    used: user.used ?? 0,
    kernelKey: user.kernelKey,
    prefs: { ...user.prefs ?? {} },
    prefsVersion: user.prefsVersion ?? 0,
    mainBotIds: [...user.mainBotIds ?? []]
  };
}
function defaultQuota(env) {
  const parsed = Number(env.BOTCAMP_DEFAULT_QUOTA ?? 200);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 1e9 ? parsed : 200;
}
function bootstrapCredentials(env) {
  const email = typeof env.BOTCAMP_ADMIN_EMAIL === "string" ? env.BOTCAMP_ADMIN_EMAIL.trim() : "";
  const password = typeof env.BOTCAMP_ADMIN_PASSWORD === "string" ? env.BOTCAMP_ADMIN_PASSWORD : "";
  if (email && password) return { email, password };
  if (env.NODE_ENV === "production" || env.BOTCAMP_PRODUCTION === "1") return null;
  return { email: "admin@localhost", password: "botcamp-dev" };
}
function newUser({ email, passwordHash, role, quota }) {
  return {
    id: (0, import_node_crypto2.randomBytes)(16).toString("base64url"),
    email,
    passwordHash,
    role,
    quota,
    used: 0,
    kernelKey: `u_${(0, import_node_crypto2.randomBytes)(12).toString("base64url")}`,
    prefs: {},
    prefsVersion: 0,
    mainBotIds: [],
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function openStore(dataDir) {
  const dir = dataDir;
  const file = import_node_path.default.join(dir, "accounts.json");
  const namespaceDir = import_node_path.default.join(dir, "namespaces");
  await (0, import_promises.mkdir)(namespaceDir, { recursive: true });
  let data = emptyData();
  try {
    data = JSON.parse(await (0, import_promises.readFile)(file, "utf8"));
    if (!Array.isArray(data.users) || !Array.isArray(data.sessions) || !Array.isArray(data.resources)) data = emptyData();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let dummyHash = null;
  const ensureDummy = async () => {
    if (!dummyHash) dummyHash = await hashPassword("botcamp-dummy-check");
    return dummyHash;
  };
  let chain = Promise.resolve();
  const exclusive = (fn) => {
    const run = chain.then(fn);
    chain = run.then(() => {
    }, () => {
    });
    return run;
  };
  const saveAccounts = () => writeAtomic(file, data);
  const api = {
    idle: () => chain,
    publicUser,
    exclusive,
    async bootstrap(env) {
      return exclusive(async () => {
        if (data.users.length > 0) return { created: false };
        const creds = bootstrapCredentials(env);
        if (!creds || !validEmail(normalizeEmail(creds.email)) || typeof creds.password !== "string" || creds.password.length < 8) {
          return { created: false };
        }
        const email = normalizeEmail(creds.email);
        data.users.push(newUser({
          email,
          passwordHash: await hashPassword(creds.password),
          role: "admin",
          quota: defaultQuota(env)
        }));
        await saveAccounts();
        return { created: true };
      });
    },
    getUser(id) {
      return exclusive(async () => principal(data.users.find((user) => user.id === id)));
    },
    async authenticate(email, password) {
      const normalized = normalizeEmail(typeof email === "string" ? email : "");
      const candidate = typeof password === "string" && password.length <= 200 ? password : "";
      const dummy = await ensureDummy();
      const hash = await exclusive(async () => data.users.find((user) => user.email === normalized)?.passwordHash ?? null);
      const ok = await verifyPassword(candidate, hash ?? dummy);
      if (!ok || !hash || candidate === "") return null;
      return exclusive(async () => principal(data.users.find((user) => user.email === normalized)));
    },
    listUsers() {
      return exclusive(async () => data.users.map(publicUser));
    },
    resources() {
      return exclusive(async () => data.resources.map((resource) => ({ ...resource })));
    },
    async createUser({ email, password, role, quota }) {
      const normalized = normalizeEmail(email);
      if (!validEmail(normalized)) return { error: "\u8BF7\u586B\u5199\u6709\u6548\u7684\u90AE\u7BB1\u3002" };
      if (!validPassword(password)) return { error: "\u5BC6\u7801\u81F3\u5C11 8 \u4F4D\u3002" };
      if (role !== "admin" && role !== "user") return { error: "\u89D2\u8272\u65E0\u6548\u3002" };
      if (!Number.isInteger(quota) || quota < 0) return { error: "\u914D\u989D\u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570\u3002" };
      return exclusive(async () => {
        if (data.users.some((user2) => user2.email === normalized)) return { error: "\u8FD9\u4E2A\u90AE\u7BB1\u5DF2\u7ECF\u6709\u8D26\u53F7\u3002" };
        const user = newUser({ email: normalized, passwordHash: await hashPassword(password), role, quota });
        data.users.push(user);
        await saveAccounts();
        return { user: publicUser(user) };
      });
    },
    async updateUser(id, patch) {
      if (patch.role !== void 0 && patch.role !== "admin" && patch.role !== "user") return { error: "\u89D2\u8272\u65E0\u6548\u3002" };
      if (patch.quota !== void 0 && (!Number.isInteger(patch.quota) || patch.quota < 0)) return { error: "\u914D\u989D\u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570\u3002" };
      if (patch.used !== void 0 && (!Number.isInteger(patch.used) || patch.used < 0)) return { error: "\u5DF2\u7528\u6761\u6570\u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570\u3002" };
      if (patch.password !== void 0 && !validPassword(patch.password)) return { error: "\u5BC6\u7801\u81F3\u5C11 8 \u4F4D\u3002" };
      const passwordHash = patch.password !== void 0 ? await hashPassword(patch.password) : null;
      return exclusive(async () => {
        const user = data.users.find((entry) => entry.id === id);
        if (!user) return { error: "\u6CA1\u6709\u8FD9\u4E2A\u7528\u6237\u3002", status: 404 };
        if (patch.role !== void 0) {
          if (user.role === "admin" && patch.role !== "admin" && data.users.filter((entry) => entry.role === "admin").length <= 1) {
            return { error: "\u81F3\u5C11\u8981\u7559\u4E0B\u4E00\u540D\u7BA1\u7406\u5458\u3002" };
          }
          user.role = patch.role;
        }
        if (patch.quota !== void 0) user.quota = patch.quota;
        if (patch.used !== void 0) user.used = patch.used;
        if (passwordHash) user.passwordHash = passwordHash;
        await saveAccounts();
        return { user: publicUser(user) };
      });
    },
    async deleteUser(id, actorId) {
      return exclusive(async () => {
        const user = data.users.find((entry) => entry.id === id);
        if (!user) return { error: "\u6CA1\u6709\u8FD9\u4E2A\u7528\u6237\u3002", status: 404 };
        if (user.id === actorId) return { error: "\u4E0D\u80FD\u5220\u9664\u5F53\u524D\u767B\u5F55\u7684\u8D26\u53F7\u3002" };
        if (user.role === "admin" && data.users.filter((entry) => entry.role === "admin").length <= 1) {
          return { error: "\u81F3\u5C11\u8981\u7559\u4E0B\u4E00\u540D\u7BA1\u7406\u5458\u3002" };
        }
        data.users = data.users.filter((entry) => entry.id !== id);
        data.sessions = data.sessions.filter((session) => session.userId !== id);
        data.resources = data.resources.filter((resource) => resource.userId !== id);
        await saveAccounts();
        return { ok: true };
      });
    },
    async createSession(userId) {
      const token = (0, import_node_crypto2.randomBytes)(32).toString("base64url");
      const tokenHash = hashToken(token);
      const expiresAt = Date.now() + SESSION_MS;
      await exclusive(async () => {
        data.sessions.push({ id: (0, import_node_crypto2.randomBytes)(12).toString("base64url"), userId, tokenHash, expiresAt });
        await saveAccounts();
      });
      return { token, expiresAt };
    },
    async userForToken(token) {
      if (typeof token !== "string" || token.length < 20) return null;
      const tokenHash = hashToken(token);
      return exclusive(async () => {
        const now = Date.now();
        const session = data.sessions.find((entry) => entry.tokenHash === tokenHash);
        if (!session) return null;
        if (session.expiresAt <= now) {
          data.sessions = data.sessions.filter((entry) => entry !== session);
          await saveAccounts();
          return null;
        }
        return principal(data.users.find((user) => user.id === session.userId));
      });
    },
    async deleteSession(token) {
      if (typeof token !== "string") return;
      const tokenHash = hashToken(token);
      await exclusive(async () => {
        const next = data.sessions.filter((entry) => entry.tokenHash !== tokenHash);
        if (next.length === data.sessions.length) return;
        data.sessions = next;
        await saveAccounts();
      });
    },
    async tryConsume(userId) {
      return exclusive(async () => {
        const user = data.users.find((entry) => entry.id === userId);
        if (!user) return { ok: false };
        if (user.used >= user.quota) return { ok: false };
        user.used += 1;
        await saveAccounts();
        return { ok: true, user: publicUser(user) };
      });
    },
    async refund(userId) {
      await exclusive(async () => {
        const user = data.users.find((entry) => entry.id === userId);
        if (!user || user.used <= 0) return;
        user.used -= 1;
        await saveAccounts();
      });
    },
    async setPrefs(userId, prefs) {
      return exclusive(async () => {
        const user = data.users.find((entry) => entry.id === userId);
        if (!user) return null;
        user.prefs = prefs;
        user.prefsVersion = (user.prefsVersion ?? 0) + 1;
        await saveAccounts();
        return principal(user);
      });
    },
    async setMain(userId, mainBotIds) {
      return exclusive(async () => {
        const user = data.users.find((entry) => entry.id === userId);
        if (!user) return null;
        user.mainBotIds = mainBotIds;
        user.prefsVersion = (user.prefsVersion ?? 0) + 1;
        await saveAccounts();
        return principal(user);
      });
    },
    async commitAccess(userId, access) {
      await exclusive(async () => {
        let changed = false;
        for (const id of access.released()) {
          const next = data.resources.filter((resource) => !(resource.userId === userId && (resource.id === id || resource.parentId === id)));
          if (next.length !== data.resources.length) changed = true;
          data.resources = next;
        }
        for (const claim of access.pending()) {
          const existing = data.resources.find((resource) => resource.id === claim.id);
          if (existing && existing.userId !== userId) continue;
          if (existing) continue;
          data.resources.push({ id: claim.id, userId, kind: claim.kind, parentId: claim.parentId ?? null });
          changed = true;
        }
        if (changed) await saveAccounts();
      });
    },
    async rememberPage(userId, sessionId, items) {
      if (typeof sessionId !== "string" || !Array.isArray(items)) return;
      await exclusive(async () => {
        const user = data.users.find((entry) => entry.id === userId);
        if (!user || !safeKernelKey(user.kernelKey)) return;
        const transcriptFile = import_node_path.default.join(namespaceDir, `${user.kernelKey}.json`);
        const saved = await readNamespace(transcriptFile);
        saved.transcripts[sessionId] = { items: items.slice(-200) };
        await writeAtomic(transcriptFile, saved);
      });
    },
    async appendItem(userId, sessionId, item) {
      if (typeof sessionId !== "string" || !item || typeof item !== "object") return;
      await exclusive(async () => {
        const user = data.users.find((entry) => entry.id === userId);
        if (!user || !safeKernelKey(user.kernelKey)) return;
        const transcriptFile = import_node_path.default.join(namespaceDir, `${user.kernelKey}.json`);
        const saved = await readNamespace(transcriptFile);
        const page = saved.transcripts[sessionId] ?? { items: [] };
        const items = Array.isArray(page.items) ? page.items : [];
        const same = items.some((entry) => entry.kind === item.kind && entry.time === item.time && entry.text === item.text);
        if (!same) items.push(item);
        saved.transcripts[sessionId] = { items: items.slice(-200) };
        await writeAtomic(transcriptFile, saved);
      });
    },
    kernelKey(userId) {
      return exclusive(async () => data.users.find((user) => user.id === userId)?.kernelKey ?? "");
    }
  };
  return api;
}
function hashToken(token) {
  return (0, import_node_crypto2.createHash)("sha256").update(token).digest("hex");
}
function safeKernelKey(kernelKey) {
  return typeof kernelKey === "string" && /^u_[A-Za-z0-9_-]{8,}$/.test(kernelKey);
}
async function readNamespace(file) {
  try {
    const saved = JSON.parse(await (0, import_promises.readFile)(file, "utf8"));
    if (!saved.transcripts || typeof saved.transcripts !== "object") saved.transcripts = {};
    return saved;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { transcripts: {} };
  }
}
async function writeAtomic(file, value) {
  await (0, import_promises.mkdir)(import_node_path.default.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${(0, import_node_crypto2.randomBytes)(4).toString("hex")}.tmp`;
  await (0, import_promises.writeFile)(tmp, JSON.stringify(value), { mode: 384 });
  await (0, import_promises.rename)(tmp, file);
}

// app/botcamp/http.mjs
var COOKIE = "botcamp_session";
var SESSION_MAX_AGE = 14 * 24 * 60 * 60;
var JSON_LIMIT = 1024 * 1024;
var BOT_LIMIT = 20 * 1024 * 1024;
function routePath(url) {
  const path2 = (url ?? "").split("?")[0];
  return path2.length > 1 && path2.endsWith("/") ? path2.slice(0, -1) : path2;
}
function sendJson(res, status, body, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(body));
}
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== "string") return "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) === name) {
      try {
        return decodeURIComponent(trimmed.slice(eq + 1));
      } catch {
        return "";
      }
    }
  }
  return "";
}
function secureRequest(req) {
  if (req.socket?.encrypted) return true;
  const proto = req.headers["x-forwarded-proto"];
  return typeof proto === "string" && proto.split(",")[0].trim() === "https";
}
function sessionCookie(token, req, maxAge) {
  const parts = [`${COOKIE}=${encodeURIComponent(token)}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAge}`];
  if (secureRequest(req)) parts.push("Secure");
  return parts.join("; ");
}
async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      const error = new Error("body too large");
      error.code = "LIMIT";
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString("utf8"));
}
function refused(message) {
  return { ok: false, error: { code: "bot/refused", message } };
}
function logFailure(error, fallback) {
  const message = error instanceof Error ? error.message : fallback;
  console.error("[botcamp]", String(message).replace(/([?&#])token=[^&#\s]*/gi, "$1token=").replace(/dsh-auth-[^\s;,]*/gi, "dsh-auth"));
}
async function createBotcamp(options = {}) {
  const env = options.env ?? process.env;
  const kernelOrigin = (options.kernelOrigin ?? env.DSH_KERNEL_ORIGIN ?? "https://camp.aigc.sx.cn").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const store = await openStore(options.dataDir ?? defaultDataDir());
  const boot = await store.bootstrap(env);
  if (boot.created) console.info("[botcamp] \u5DF2\u521B\u5EFA\u5F15\u5BFC\u7BA1\u7406\u5458\u3002");
  else if ((await store.listUsers()).length === 0) console.warn("[botcamp] \u7528\u6237\u5E93\u4E3A\u7A7A\u3002\u8BBE\u7F6E BOTCAMP_ADMIN_EMAIL \u548C BOTCAMP_ADMIN_PASSWORD \u540E\u91CD\u542F\uFF0C\u624D\u4F1A\u521B\u5EFA\u7BA1\u7406\u5458\u3002");
  const jar = /* @__PURE__ */ new Map();
  function cookieHeader() {
    return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  function storeCookies(response) {
    const headers = response.headers;
    const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : headers.get("set-cookie") ? [headers.get("set-cookie")] : [];
    for (const cookie of list) {
      const pair = cookie.split(";", 1)[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  async function refreshCookie() {
    jar.clear();
    let url = `${kernelOrigin}/`;
    for (let hop = 0; hop < 6; hop += 1) {
      const response = await fetchImpl(url, {
        redirect: "manual",
        headers: cookieHeader() ? { cookie: cookieHeader() } : {}
      });
      storeCookies(response);
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {
      });
      if (!location || response.status < 300 || response.status >= 400) break;
      url = new URL(location, url).toString();
    }
  }
  async function callKernel(pathname, { method, body, signal, namespace }) {
    if (jar.size === 0) await refreshCookie();
    const headers = { origin: kernelOrigin, "content-type": "application/json" };
    if (cookieHeader()) headers.cookie = cookieHeader();
    if (typeof namespace === "string" && /^u_[A-Za-z0-9_-]{8,}$/.test(namespace)) headers["x-botcamp-namespace"] = namespace;
    const send = () => fetchImpl(new URL(pathname, `${kernelOrigin}/`), {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? void 0 : body,
      redirect: "manual",
      signal
    });
    let upstream = await send();
    if (upstream.status === 401 && !signal?.aborted) {
      await upstream.body?.cancel().catch(() => {
      });
      await refreshCookie();
      if (cookieHeader()) headers.cookie = cookieHeader();
      else delete headers.cookie;
      upstream = await send();
    }
    storeCookies(upstream);
    return upstream;
  }
  async function accessFor(userId) {
    return createAccess(userId, await store.resources());
  }
  async function currentUser(req) {
    return store.userForToken(readCookie(req, COOKIE));
  }
  async function applyLocal(user, endpoint, payload) {
    if (endpoint === "set-prefs") return store.setPrefs(user.id, mergePrefs(user.prefs, payload));
    if (endpoint === "set-main") {
      const id = payload?.id;
      let ids = [...user.mainBotIds ?? []];
      if (payload?.main === false) ids = ids.filter((item) => item !== id);
      else ids = [id, ...ids.filter((item) => item !== id)];
      return store.setMain(user.id, ids);
    }
    return user;
  }
  async function handleAuth(req, res, path2) {
    try {
      if (req.method === "POST" && path2 === "/api/auth/signup") {
        sendJson(res, 403, { ok: false, error: { code: "auth/closed", message: "\u4E0D\u80FD\u81EA\u884C\u6CE8\u518C\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u5F00\u901A\u8D26\u53F7\u3002" } });
        return;
      }
      if (req.method === "GET" && path2 === "/api/auth/me") {
        const user = await currentUser(req);
        if (!user) {
          sendJson(res, 401, { ok: false, error: { code: "auth/required", message: "\u8BF7\u5148\u767B\u5F55" } });
          return;
        }
        sendJson(res, 200, { ok: true, user: store.publicUser(user) });
        return;
      }
      if (req.method === "POST" && path2 === "/api/auth/login") {
        const body = await readJson(req, JSON_LIMIT);
        const user = await store.authenticate(body?.email, body?.password);
        if (!user) {
          sendJson(res, 401, { ok: false, error: { code: "auth/invalid", message: "\u90AE\u7BB1\u6216\u5BC6\u7801\u4E0D\u6B63\u786E" } });
          return;
        }
        const session = await store.createSession(user.id);
        sendJson(res, 200, { ok: true, user: store.publicUser(user) }, {
          "set-cookie": sessionCookie(session.token, req, SESSION_MAX_AGE)
        });
        return;
      }
      if (req.method === "POST" && path2 === "/api/auth/logout") {
        await store.deleteSession(readCookie(req, COOKIE));
        sendJson(res, 200, { ok: true }, { "set-cookie": sessionCookie("", req, 0) });
        return;
      }
      sendJson(res, 404, { ok: false, error: { code: "auth/unknown", message: "\u672A\u77E5\u7684\u767B\u5F55\u63A5\u53E3\u3002" } });
    } catch (error) {
      if (error?.code === "LIMIT") {
        sendJson(res, 413, { ok: false, error: { message: "\u8BF7\u6C42\u592A\u5927\u3002" } });
        return;
      }
      if (error instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: { message: "\u8BF7\u6C42\u683C\u5F0F\u4E0D\u6B63\u786E\u3002" } });
        return;
      }
      logFailure(error, "auth failed");
      sendJson(res, 500, { ok: false, error: { message: "\u767B\u5F55\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528\u3002" } });
    }
  }
  async function handleAdmin(req, res, path2, user) {
    if (!user) {
      sendJson(res, 401, { ok: false, error: { code: "auth/required", message: "\u8BF7\u5148\u767B\u5F55" } });
      return;
    }
    if (user.role !== "admin") {
      sendJson(res, 403, { ok: false, error: { code: "auth/forbidden", message: "\u53EA\u6709\u7BA1\u7406\u5458\u53EF\u4EE5\u7BA1\u7406\u7528\u6237\u548C\u914D\u989D\u3002" } });
      return;
    }
    try {
      if (req.method === "GET" && path2 === "/api/admin/users") {
        sendJson(res, 200, { ok: true, users: await store.listUsers() });
        return;
      }
      if (req.method === "POST" && path2 === "/api/admin/users") {
        const body = await readJson(req, JSON_LIMIT);
        const created = await store.createUser({
          email: body?.email,
          password: body?.password,
          role: body?.role === void 0 ? "user" : body.role,
          quota: body?.quota === void 0 ? defaultQuota(env) : body.quota
        });
        if (created.error) {
          sendJson(res, 400, { ok: false, error: { message: created.error } });
          return;
        }
        sendJson(res, 201, { ok: true, user: created.user });
        return;
      }
      const match = path2.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (match && (req.method === "PATCH" || req.method === "DELETE")) {
        const id = decodeURIComponent(match[1]);
        if (req.method === "DELETE") {
          const result2 = await store.deleteUser(id, user.id);
          if (result2.error) {
            sendJson(res, result2.status ?? 400, { ok: false, error: { message: result2.error } });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        const body = await readJson(req, JSON_LIMIT);
        const patch = {};
        if (Object.hasOwn(body ?? {}, "quota")) patch.quota = body.quota;
        if (Object.hasOwn(body ?? {}, "used")) patch.used = body.used;
        if (Object.hasOwn(body ?? {}, "role")) patch.role = body.role;
        if (Object.hasOwn(body ?? {}, "password")) patch.password = body.password;
        const result = await store.updateUser(id, patch);
        if (result.error) {
          sendJson(res, result.status ?? 400, { ok: false, error: { message: result.error } });
          return;
        }
        sendJson(res, 200, { ok: true, user: result.user });
        return;
      }
      sendJson(res, 404, { ok: false, error: { message: "\u672A\u77E5\u7684\u7BA1\u7406\u63A5\u53E3\u3002" } });
    } catch (error) {
      if (error?.code === "LIMIT") {
        sendJson(res, 413, { ok: false, error: { message: "\u8BF7\u6C42\u592A\u5927\u3002" } });
        return;
      }
      if (error instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: { message: "\u8BF7\u6C42\u683C\u5F0F\u4E0D\u6B63\u786E\u3002" } });
        return;
      }
      logFailure(error, "admin failed");
      sendJson(res, 500, { ok: false, error: { message: "\u7BA1\u7406\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528\u3002" } });
    }
  }
  async function handleBot(req, res, user, given) {
    const client = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) client.abort();
    };
    res.on("close", onClose);
    let charged = false;
    try {
      let body = given;
      if (body === void 0) {
        const raw = await readBody(req, BOT_LIMIT);
        try {
          body = JSON.parse(raw.length ? raw.toString("utf8") : "{}");
        } catch {
          sendJson(res, 400, { ok: false, error: { code: "bot/invalid", message: "\u8BF7\u6C42\u683C\u5F0F\u4E0D\u6B63\u786E\u3002" } });
          return;
        }
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        sendJson(res, 400, { ok: false, error: { code: "bot/invalid", message: "\u8BF7\u6C42\u683C\u5F0F\u4E0D\u6B63\u786E\u3002" } });
        return;
      }
      const endpoint = body.endpoint;
      const payload = body.payload ?? null;
      const access = await accessFor(user.id);
      const decision = decide(endpoint, payload, access);
      if (decision.action === "refuse") {
        sendJson(res, 200, refused(decision.message ?? CROSS_MESSAGE));
        return;
      }
      if (access.pending().length > 0) await store.commitAccess(user.id, access);
      const reserved = access.pending().map((claim) => claim.id);
      if (decision.action === "local") {
        const updated = await applyLocal(user, endpoint, payload);
        sendJson(res, 200, { ok: true, value: localValue(endpoint, updated ?? user) });
        return;
      }
      if (decision.action === "metered") {
        const charge = await store.tryConsume(user.id);
        if (!charge.ok) {
          sendJson(res, 200, refused(QUOTA_MESSAGE));
          return;
        }
        charged = true;
      }
      const outboundPayload = endpoint === "state" ? stateRequestPayload(payload, await store.getUser(user.id) ?? user) : payload;
      const upstream = await callKernel("/api/bot", {
        method: "POST",
        body: JSON.stringify({ endpoint, payload: outboundPayload }),
        signal: client.signal,
        namespace: user.kernelKey
      });
      const text = await upstream.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (charged && (!upstream.ok || parsed?.ok === false)) {
        await store.refund(user.id);
        charged = false;
      }
      if (parsed?.ok === false && reserved.length > 0) {
        const rollback = await accessFor(user.id);
        for (const id of reserved) rollback.release(id);
        await store.commitAccess(user.id, rollback);
      }
      if (parsed && typeof parsed === "object" && Object.hasOwn(parsed, "value")) {
        const after = await accessFor(user.id);
        const fresh = await store.getUser(user.id) ?? user;
        if (parsed.ok !== false) {
          claimCreated(endpoint, parsed.value, after);
          releaseDeleted(endpoint, payload, after);
          if ((endpoint === "chat" || endpoint === "earlier") && Array.isArray(parsed.value?.items)) {
            const sessionId = parsed.value.sessionId ?? payload?.sessionId ?? payload?.botId;
            await store.rememberPage(user.id, sessionId, parsed.value.items);
          }
        }
        parsed.value = rewriteValue(endpoint, parsed.value, fresh, after);
        await store.commitAccess(user.id, after);
        sendJson(res, upstream.status, parsed);
        return;
      }
      if (res.writableEnded || res.destroyed) return;
      res.statusCode = upstream.status;
      const contentType = upstream.headers.get("content-type");
      if (contentType) res.setHeader("content-type", contentType);
      res.setHeader("cache-control", "no-store");
      res.end(text);
    } catch (error) {
      if (charged) await store.refund(user.id).catch(() => {
      });
      if (client.signal.aborted || error?.name === "AbortError") {
        if (!res.writableEnded) res.end();
        return;
      }
      if (error?.code === "LIMIT") {
        sendJson(res, 413, { ok: false, error: { message: "\u8BF7\u6C42\u592A\u5927\u3002" } });
        return;
      }
      logFailure(error, "bot proxy failed");
      sendJson(res, 502, { ok: false, error: { code: "bot/error", message: "\u6682\u65F6\u8FDE\u4E0D\u4E0A\u5185\u6838\u3002" } });
    } finally {
      res.off("close", onClose);
    }
  }
  async function handleFeed(req, res, user) {
    const client = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) client.abort();
    };
    res.on("close", onClose);
    try {
      const upstream = await callKernel("/api/bot/feed", {
        method: "GET",
        signal: client.signal,
        namespace: user.kernelKey
      });
      if (!upstream.ok || upstream.body == null) {
        await upstream.body?.cancel().catch(() => {
        });
        sendJson(res, upstream.ok ? 502 : upstream.status, { ok: false, error: { message: "\u6682\u65F6\u8FDE\u4E0D\u4E0A\u5185\u6838\u3002" } });
        return;
      }
      if (client.signal.aborted || res.writableEnded) {
        await upstream.body.cancel().catch(() => {
        });
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-accel-buffering", "no");
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const writeBlock = async (block) => {
        const access = await accessFor(user.id);
        if (!feedBlockAllowed(block, access)) return;
        await store.commitAccess(user.id, access);
        const message = feedMessageItem(block);
        if (message) await store.appendItem(user.id, message.sessionId, message.item);
        if (!res.writableEnded) res.write(`${block}

`);
      };
      try {
        for (; ; ) {
          if (client.signal.aborted || res.writableEnded) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split = buffer.indexOf("\n\n");
          while (split >= 0) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            if (block.trim() !== "") await writeBlock(block);
            split = buffer.indexOf("\n\n");
          }
        }
      } finally {
        reader.releaseLock();
        await upstream.body.cancel().catch(() => {
        });
      }
      if (!res.writableEnded) res.end();
    } catch (error) {
      if (client.signal.aborted || error?.name === "AbortError") {
        if (!res.writableEnded) res.end();
        return;
      }
      logFailure(error, "feed failed");
      sendJson(res, 502, { ok: false, error: { message: "\u6682\u65F6\u8FDE\u4E0D\u4E0A\u5185\u6838\u3002" } });
    } finally {
      res.off("close", onClose);
    }
  }
  function replay(req, method, payload) {
    const raw = Buffer.from(JSON.stringify(payload ?? {}));
    let sent = false;
    return {
      method,
      url: req.url,
      headers: req.headers,
      socket: req.socket,
      async *[Symbol.asyncIterator]() {
        if (sent) return;
        sent = true;
        if (raw.length > 0) yield raw;
      }
    };
  }
  async function handleLocalEndpoint(req, res, endpoint, payload) {
    const user = await currentUser(req);
    if (endpoint === "botcamp/login") {
      await handleAuth(replay(req, "POST", payload), res, "/api/auth/login");
      return;
    }
    if (endpoint === "botcamp/logout") {
      await handleAuth(replay(req, "POST", {}), res, "/api/auth/logout");
      return;
    }
    if (endpoint === "botcamp/me") {
      await handleAuth(replay(req, "GET", {}), res, "/api/auth/me");
      return;
    }
    if (endpoint === "botcamp/signup") {
      await handleAuth(replay(req, "POST", payload), res, "/api/auth/signup");
      return;
    }
    if (endpoint === "botcamp/admin-list") {
      await handleAdmin(replay(req, "GET", {}), res, "/api/admin/users", user);
      return;
    }
    if (endpoint === "botcamp/admin-create") {
      await handleAdmin(replay(req, "POST", payload), res, "/api/admin/users", user);
      return;
    }
    if (endpoint === "botcamp/admin-update") {
      const id = typeof payload?.id === "string" ? payload.id : "";
      const patch = { ...payload ?? {} };
      delete patch.id;
      await handleAdmin(replay(req, "PATCH", patch), res, `/api/admin/users/${encodeURIComponent(id)}`, user);
      return;
    }
    if (endpoint === "botcamp/admin-delete") {
      const id = typeof payload?.id === "string" ? payload.id : "";
      await handleAdmin(replay(req, "DELETE", {}), res, `/api/admin/users/${encodeURIComponent(id)}`, user);
      return;
    }
    sendJson(res, 404, { ok: false, error: { message: "\u672A\u77E5\u63A5\u53E3\u3002" } });
  }
  async function handle(req, res, next) {
    const path2 = routePath(req.url);
    if (!path2.startsWith("/api/")) {
      next();
      return;
    }
    if (path2.startsWith("/api/auth")) {
      await handleAuth(req, res, path2);
      return;
    }
    if (path2 === "/api/bot" && req.method === "POST") {
      let body;
      try {
        const raw = await readBody(req, BOT_LIMIT);
        body = JSON.parse(raw.length ? raw.toString("utf8") : "{}");
      } catch (error) {
        if (error?.code === "LIMIT") {
          sendJson(res, 413, { ok: false, error: { message: "\u8BF7\u6C42\u592A\u5927\u3002" } });
          return;
        }
        sendJson(res, 400, { ok: false, error: { code: "bot/invalid", message: "\u8BF7\u6C42\u683C\u5F0F\u4E0D\u6B63\u786E\u3002" } });
        return;
      }
      if (body && typeof body === "object" && !Array.isArray(body) && typeof body.endpoint === "string" && body.endpoint.startsWith("botcamp/")) {
        await handleLocalEndpoint(req, res, body.endpoint, body.payload ?? null);
        return;
      }
      const user2 = await currentUser(req);
      if (!user2) {
        sendJson(res, 401, { ok: false, error: { code: "auth/required", message: "\u8BF7\u5148\u767B\u5F55" } });
        return;
      }
      await handleBot(req, res, user2, body);
      return;
    }
    const user = await currentUser(req);
    if (path2.startsWith("/api/admin")) {
      await handleAdmin(req, res, path2, user);
      return;
    }
    if (!user) {
      sendJson(res, 401, { ok: false, error: { code: "auth/required", message: "\u8BF7\u5148\u767B\u5F55" } });
      return;
    }
    if (path2 === "/api/bot/feed" && (req.method === "GET" || req.method === "HEAD")) {
      await handleFeed(req, res, user);
      return;
    }
    sendJson(res, 404, { ok: false, error: { message: "\u672A\u77E5\u63A5\u53E3\u3002" } });
  }
  return { store, handle, idle: () => store.idle() };
}

// functions/bot/entry.mjs
var DATA_DIR = "/tmp/botcamp-data";
var campPromise = null;
function runtimeEnv(extra) {
  const merged = { ...process.env };
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value === "string") merged[key] = value;
    }
  }
  merged.NODE_ENV = "production";
  merged.BOTCAMP_PRODUCTION = "1";
  if (!merged.BOTCAMP_DATA_DIR) merged.BOTCAMP_DATA_DIR = DATA_DIR;
  return merged;
}
async function sharedCamp(extra) {
  if (!campPromise) {
    const env = runtimeEnv(extra);
    campPromise = createBotcamp({ env, dataDir: env.BOTCAMP_DATA_DIR });
  }
  return campPromise;
}
function resetDemoxCamp() {
  campPromise = null;
}
function methodOf(request) {
  return String(request?.method || request?.httpMethod || "GET").toUpperCase();
}
function pathOf(request) {
  const raw = request?.path || request?.rawPath || request?.route || request?.url || "/api/bot";
  let path2 = String(raw);
  try {
    if (path2.includes("://")) path2 = new URL(path2).pathname || "/";
  } catch {
  }
  path2 = path2.split("?")[0] || "/";
  if (path2.length > 1 && path2.endsWith("/")) path2 = path2.slice(0, -1);
  return path2;
}
function headerMap(request) {
  const source = request?.headers || request?.multiValueHeaders || {};
  const headers = {};
  if (source && typeof source === "object") {
    for (const [key, value] of Object.entries(source)) {
      const name = String(key).toLowerCase();
      if (Array.isArray(value)) headers[name] = value.map((item) => String(item)).join(name === "cookie" ? "; " : ", ");
      else if (typeof value === "string") headers[name] = value;
    }
  }
  if (!headers.cookie && request?.cookies && typeof request.cookies === "object") {
    headers.cookie = Object.entries(request.cookies).filter(([, value]) => typeof value === "string").map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("; ");
  }
  if (!headers["x-forwarded-proto"]) headers["x-forwarded-proto"] = "https";
  return headers;
}
async function bodyText(request, method) {
  if (method === "GET" || method === "HEAD") return "";
  const body = request?.body;
  if (typeof body === "string") {
    if (request?.isBase64Encoded) return Buffer.from(body, "base64").toString("utf8");
    return body;
  }
  if (body == null || body === "") {
    if (typeof request?.text === "function") {
      const text = await request.text();
      return typeof text === "string" ? text : "";
    }
    return "";
  }
  if (typeof body === "object") return JSON.stringify(body);
  return String(body);
}
function createReq(method, url, headers, text) {
  const raw = Buffer.from(text);
  let sent = false;
  return {
    method,
    url,
    headers,
    socket: { encrypted: true },
    async *[Symbol.asyncIterator]() {
      if (sent) return;
      sent = true;
      if (raw.length > 0) yield raw;
    }
  };
}
function createRes(feed) {
  const headers = /* @__PURE__ */ new Map();
  let statusCode = 200;
  const chunks = [];
  let writableEnded = false;
  let destroyed = false;
  const listeners = /* @__PURE__ */ new Set();
  const emitClose = () => {
    for (const fn of [...listeners]) fn();
  };
  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value) {
      statusCode = value;
    },
    get writableEnded() {
      return writableEnded;
    },
    get destroyed() {
      return destroyed;
    },
    get headersSent() {
      return writableEnded;
    },
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    },
    write(chunk) {
      if (writableEnded) return false;
      chunks.push(Buffer.from(chunk));
      if (feed && Buffer.concat(chunks).includes("\n\n")) {
        emitClose();
        writableEnded = true;
        return false;
      }
      return true;
    },
    end(chunk) {
      if (writableEnded) return;
      if (chunk) chunks.push(Buffer.from(chunk));
      writableEnded = true;
      emitClose();
    },
    on(event, fn) {
      if (event === "close") listeners.add(fn);
    },
    off(event, fn) {
      listeners.delete(fn);
    },
    destroy() {
      destroyed = true;
      writableEnded = true;
    }
  };
  return {
    res,
    snapshot() {
      return { statusCode, headers, body: Buffer.concat(chunks).toString("utf8") };
    }
  };
}
function scrub(text) {
  return String(text).replace(/([?&#])token=[^&#\s"'<>]*/gi, "$1token=").replace(/dsh-auth-[^=;\s"']*=[^;\s"']*/gi, "dsh-auth=");
}
function toResult(snapshot) {
  const headers = { "cache-control": snapshot.headers.get("cache-control") || "no-store" };
  const contentType = snapshot.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;
  const cookie = snapshot.headers.get("set-cookie") || "";
  if (cookie.startsWith("botcamp_session=")) headers["set-cookie"] = cookie;
  return { statusCode: snapshot.statusCode, headers, body: scrub(snapshot.body) };
}
function failed(statusCode, message) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify({ ok: false, error: { message } })
  };
}
async function handleDemoxRequest(request, env, options = {}) {
  const gate = options.camp ?? await sharedCamp(env);
  const method = methodOf(request);
  const path2 = pathOf(request);
  const feed = path2 === "/api/bot/feed";
  const captured = createRes(feed);
  const req = createReq(method, path2, headerMap(request), await bodyText(request, method));
  await gate.handle(req, captured.res, () => {
    captured.res.statusCode = 404;
    captured.res.setHeader("content-type", "text/plain; charset=utf-8");
    captured.res.end("not found");
  });
  return toResult(captured.snapshot());
}
async function handler(request, env) {
  try {
    return await handleDemoxRequest(request || {}, env);
  } catch {
    return failed(502, "\u6682\u65F6\u8FDE\u4E0D\u4E0A\u5185\u6838\u3002");
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handleDemoxRequest,
  handler,
  resetDemoxCamp
});
