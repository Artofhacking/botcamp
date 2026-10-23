/** Pack data/import/xiaogao/*.json + manuscripts → fixture.generated.json for Demox bundle. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/xiaogao");
const out = path.join(dir, "fixture.generated.json");

const pack = {
  meta: JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")),
  profile: JSON.parse(fs.readFileSync(path.join(dir, "profile.json"), "utf8")),
  rules_notes: JSON.parse(fs.readFileSync(path.join(dir, "rules_notes.json"), "utf8")),
  posts: JSON.parse(fs.readFileSync(path.join(dir, "posts.json"), "utf8")),
  engagement: JSON.parse(fs.readFileSync(path.join(dir, "engagement.json"), "utf8")),
  followers: JSON.parse(fs.readFileSync(path.join(dir, "followers.json"), "utf8")),
  revenue: JSON.parse(fs.readFileSync(path.join(dir, "revenue.json"), "utf8")),
  events: JSON.parse(fs.readFileSync(path.join(dir, "events.json"), "utf8")),
  daily_trends: JSON.parse(fs.readFileSync(path.join(dir, "daily_trends.json"), "utf8")),
  manuscripts_index: JSON.parse(
    fs.readFileSync(path.join(dir, "manuscripts_index.json"), "utf8"),
  ),
  manuscripts: {},
};
const msDir = path.join(dir, "manuscripts");
for (const f of fs.readdirSync(msDir).filter((x) => x.endsWith(".md"))) {
  pack.manuscripts[f.replace(/\.md$/, "")] = fs.readFileSync(
    path.join(msDir, f),
    "utf8",
  );
}
fs.writeFileSync(out, JSON.stringify(pack));
console.log(
  `packed ${out} (${fs.statSync(out).size} bytes) posts=${pack.posts.length} trends=${pack.daily_trends.length} manuscripts=${Object.keys(pack.manuscripts).length}`,
);
