import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureStoreDirs, kvGet } from "./kv.mjs";
import {
  getFocusedAccountId,
  loadMediaAccountBundle,
  getManuscriptBody,
} from "./accountStore.mjs";
import {
  requireAuth,
  createSession,
  destroySession,
  findDemoUser,
  listDemoUsers,
  setSessionCookie,
  clearSessionCookie,
  extractToken,
  resolveSession,
} from "./auth.mjs";
import { handleMediaControl } from "../app/botcamp/mediaControl.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);

ensureStoreDirs();

const MEDIA_CONTROL = new Set([
  "media/demo-users",
  "media/login",
  "media/logout",
  "media/me",
  "media/workspace",
  "media/manuscript",
]);

export function createApp() {
  const app = express();
  app.use(
    cors({
      origin: true,
      credentials: true,
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, schema_version: "1.0.0", auth: true });
  });

  // Demox-shaped CONTROL surface so web/ can use the same api/bot client locally.
  app.post("/api/bot", (req, res) => {
    const endpoint = req.body?.endpoint;
    const payload =
      req.body?.payload &&
      typeof req.body.payload === "object" &&
      !Array.isArray(req.body.payload)
        ? req.body.payload
        : {};
    if (!MEDIA_CONTROL.has(endpoint)) {
      return res.status(404).json({
        ok: false,
        error: { message: "本地 Express 只处理 media/* 控制面。" },
      });
    }
    const result = handleMediaControl(req, endpoint, payload, null);
    if (result.setCookie) res.setHeader("set-cookie", result.setCookie);
    return res.status(result.status).json(result.body);
  });

  /** Dev/demo login directory — usernames only, no secrets. */
  app.get("/api/auth/demo-users", (_req, res) => {
    res.json({
      users: listDemoUsers().map((u) => ({
        username: u.username,
        display_name: u.display_name,
      })),
    });
  });

  app.post("/api/auth/login", (req, res) => {
    const user = findDemoUser(req.body?.username);
    if (!user) {
      return res.status(401).json({ error: "invalid_credentials" });
    }
    const session = createSession(user.owner_user_id);
    setSessionCookie(res, session.token);
    res.json({
      owner_user_id: user.owner_user_id,
      username: user.username,
      display_name: user.display_name,
      token: session.token,
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = extractToken(req);
    destroySession(token);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get("/api/auth/me", (req, res) => {
    const token = extractToken(req);
    const session = resolveSession(token);
    if (!session) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const prefs = kvGet(`owner:${session.owner_user_id}:prefs`);
    const demo = listDemoUsers().find(
      (u) => u.owner_user_id === session.owner_user_id,
    );
    res.json({
      owner_user_id: session.owner_user_id,
      display_name: prefs?.display_name || demo?.display_name || null,
      username: demo?.username || null,
    });
  });

  app.get("/api/focus", requireAuth, (req, res) => {
    const focus = kvGet(`owner:${req.ownerUserId}:focus`);
    res.json({ owner_user_id: req.ownerUserId, focus });
  });

  app.get("/api/accounts", requireAuth, (req, res) => {
    const ids = kvGet(`owner:${req.ownerUserId}:media_accounts`) || [];
    const accounts = ids
      .map((id) => kvGet(`media_account:${id}`))
      .filter(
        (a) =>
          a &&
          !a.deleted_at &&
          a.owner_user_id === req.ownerUserId,
      );
    res.json({ owner_user_id: req.ownerUserId, accounts });
  });

  app.get("/api/accounts/:id", requireAuth, (req, res) => {
    const bundle = loadMediaAccountBundle(req.params.id);
    if (!bundle) {
      return res.status(404).json({ error: "media_account_not_found" });
    }
    if (bundle.account.owner_user_id !== req.ownerUserId) {
      return res.status(403).json({ error: "forbidden" });
    }
    res.json(bundle);
  });

  app.get("/api/accounts/:id/manuscripts/:mid", requireAuth, (req, res) => {
    const account = kvGet(`media_account:${req.params.id}`);
    if (!account || account.deleted_at) {
      return res.status(404).json({ error: "media_account_not_found" });
    }
    if (account.owner_user_id !== req.ownerUserId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const data = getManuscriptBody(req.params.id, req.params.mid);
    if (!data) return res.status(404).json({ error: "manuscript_not_found" });
    if (
      data.manuscript.owner_user_id &&
      data.manuscript.owner_user_id !== req.ownerUserId
    ) {
      return res.status(403).json({ error: "forbidden" });
    }
    res.json(data);
  });

  app.get("/api/me/workspace", requireAuth, (req, res) => {
    const macId = getFocusedAccountId(req.ownerUserId);
    if (!macId) return res.status(404).json({ error: "no_focus" });
    const bundle = loadMediaAccountBundle(macId);
    if (!bundle) {
      return res.status(404).json({ error: "media_account_not_found" });
    }
    if (bundle.account.owner_user_id !== req.ownerUserId) {
      return res.status(403).json({ error: "forbidden" });
    }
    res.json(bundle);
  });

  // /api/debug/kv-keys removed — never expose global KV keys to clients.

  if (process.env.NODE_ENV === "production") {
    const webDist = path.resolve(__dirname, "../web/dist");
    app.use(express.static(webDist));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  return app;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  createApp().listen(PORT, () => {
    console.log(`BotCamp API http://127.0.0.1:${PORT}`);
  });
}
