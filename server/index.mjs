import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureStoreDirs, kvGet, listKvKeys } from "./kv.mjs";
import {
  getFocusedAccountId,
  loadMediaAccountBundle,
  getManuscriptBody,
} from "./accountStore.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const OWNER = process.env.BOTCAMP_OWNER_ID || "usr_01JXIAOGUAO00000000000";

ensureStoreDirs();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, schema_version: "1.0.0" });
});

app.get("/api/focus", (_req, res) => {
  const focus = kvGet(`owner:${OWNER}:focus`);
  res.json({ owner_user_id: OWNER, focus });
});

app.get("/api/accounts", (_req, res) => {
  const ids = kvGet(`owner:${OWNER}:media_accounts`) || [];
  const accounts = ids
    .map((id) => kvGet(`media_account:${id}`))
    .filter((a) => a && !a.deleted_at);
  res.json({ owner_user_id: OWNER, accounts });
});

app.get("/api/accounts/:id", (req, res) => {
  const bundle = loadMediaAccountBundle(req.params.id);
  if (!bundle) return res.status(404).json({ error: "media_account_not_found" });
  if (bundle.account.owner_user_id !== OWNER) {
    return res.status(403).json({ error: "forbidden" });
  }
  res.json(bundle);
});

app.get("/api/accounts/:id/manuscripts/:mid", (req, res) => {
  const data = getManuscriptBody(req.params.id, req.params.mid);
  if (!data) return res.status(404).json({ error: "manuscript_not_found" });
  res.json(data);
});

app.get("/api/me/workspace", (_req, res) => {
  const macId = getFocusedAccountId(OWNER);
  if (!macId) return res.status(404).json({ error: "no_focus" });
  const bundle = loadMediaAccountBundle(macId);
  if (!bundle) return res.status(404).json({ error: "media_account_not_found" });
  res.json(bundle);
});

app.get("/api/debug/kv-keys", (_req, res) => {
  res.json({ keys: listKvKeys() });
});

if (process.env.NODE_ENV === "production") {
  const webDist = path.resolve(__dirname, "../web/dist");
  app.use(express.static(webDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`BotCamp API http://127.0.0.1:${PORT}`);
});
