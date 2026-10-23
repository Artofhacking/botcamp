/** Compare applied SoT counts vs Notion fixture expectations. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seed, PHOSA_MAC_ID } from "./seed.mjs";
import { kvGet, configureDataRoot, ensureStoreDirs } from "../server/kv.mjs";
import packed from "../fixtures/xiaogao/fixture.generated.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "botcamp-prove-"));
configureDataRoot(path.join(tmp, "media-store"));
ensureStoreDirs();
const result = seed();
const meta = kvGet(`media_account:${PHOSA_MAC_ID}:import_meta`);
const expected = {
  posts: packed.posts.length,
  engagement: packed.engagement.length,
  followers: packed.followers.length,
  revenue: packed.revenue.length,
  events: packed.events.length,
  daily_trends: packed.daily_trends.length,
  manuscripts: Object.keys(packed.manuscripts || {}).length,
};
const actual = meta?.counts || result.counts;
const rows = [
  ["posts", expected.posts, actual.posts],
  ["manuscripts", expected.manuscripts, actual.manuscripts],
  ["engagement_snapshots", expected.engagement, actual.engagement_snapshots],
  ["follower_snapshots", expected.followers, actual.follower_snapshots],
  ["revenue", expected.revenue, actual.revenue],
  ["platform_events", expected.events, actual.platform_events],
  ["daily_trends", expected.daily_trends, actual.daily_trends],
];
let ok = true;
console.log("prove:import fixture vs SoT");
for (const [name, exp, act] of rows) {
  const pass = exp === act;
  if (!pass) ok = false;
  console.log(`${pass ? "OK" : "FAIL"} ${name}: expected=${exp} actual=${act}`);
}
if (!ok) process.exit(1);
console.log("prove:import OK");
console.log("gaps:", (meta?.gaps || []).join(" | "));
