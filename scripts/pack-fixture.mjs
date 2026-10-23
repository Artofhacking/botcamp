/**
 * Pack fixtures/xiaogao → fixture.generated.json + gzip base64 module for Demox size limits.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const dir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/xiaogao",
);
const outJson = path.join(dir, "fixture.generated.json");
const outMod = path.join(dir, "fixture.generated.mjs");

const pack = {
  meta: JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")),
  profile: JSON.parse(fs.readFileSync(path.join(dir, "profile.json"), "utf8")),
  rules_notes: JSON.parse(
    fs.readFileSync(path.join(dir, "rules_notes.json"), "utf8"),
  ),
  posts: JSON.parse(fs.readFileSync(path.join(dir, "posts.json"), "utf8")),
  engagement: JSON.parse(
    fs.readFileSync(path.join(dir, "engagement.json"), "utf8"),
  ),
  followers: JSON.parse(
    fs.readFileSync(path.join(dir, "followers.json"), "utf8"),
  ),
  revenue: JSON.parse(fs.readFileSync(path.join(dir, "revenue.json"), "utf8")),
  events: JSON.parse(fs.readFileSync(path.join(dir, "events.json"), "utf8")),
  daily_trends: JSON.parse(
    fs.readFileSync(path.join(dir, "daily_trends.json"), "utf8"),
  ),
  manuscripts_index: JSON.parse(
    fs.readFileSync(path.join(dir, "manuscripts_index.json"), "utf8"),
  ),
  manuscripts: {},
};
const msDir = path.join(dir, "manuscripts");
const MAX_MS = 8000;
for (const f of fs.readdirSync(msDir).filter((x) => x.endsWith(".md"))) {
  let body = fs.readFileSync(path.join(msDir, f), "utf8");
  if (body.length > MAX_MS) {
    body = `${body.slice(0, MAX_MS)}\n\n…(稿页截断入库；完整版在 Notion)`;
  }
  pack.manuscripts[f.replace(/\.md$/, "")] = body;
}

const json = JSON.stringify(pack);
fs.writeFileSync(outJson, json);
const gz = zlib.gzipSync(Buffer.from(json, "utf8"), { level: 9 });
const b64 = gz.toString("base64");
const mod = `import { gunzipSync } from "node:zlib";
const GZ_B64 = ${JSON.stringify(b64)};
const packedFixture = JSON.parse(gunzipSync(Buffer.from(GZ_B64, "base64")).toString("utf8"));
export default packedFixture;
`;
fs.writeFileSync(outMod, mod);
console.log(
  `packed json=${fs.statSync(outJson).size}B gz-module=${fs.statSync(outMod).size}B posts=${pack.posts.length} trends=${pack.daily_trends.length} manuscripts=${Object.keys(pack.manuscripts).length}`,
);
