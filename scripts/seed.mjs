/**
 * Seed MediaAccount store: full Notion fixture for 小稿的AI日记 (phosa)
 * + isolation counterparty other_creator.
 * Never stores secrets — credential_ref is a pointer only.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureStoreDirs, kvSet, DATA_ROOT } from "../server/kv.mjs";
import { importXiaogaoFixture } from "./import-notion.mjs";
import {
  PHOSA_OWNER_ID,
  OTHER_OWNER_ID,
  PHOSA_MAC_ID,
  OTHER_MAC_ID,
} from "./seed-ids.mjs";

export {
  PHOSA_OWNER_ID,
  OTHER_OWNER_ID,
  PHOSA_MAC_ID,
  OTHER_MAC_ID,
};

const SCHEMA = "1.0.0";
const NOW = new Date().toISOString();

function seedOtherOwner() {
  const otherMac = OTHER_MAC_ID;
  const otherOwner = OTHER_OWNER_ID;

  kvSet(`owner:${otherOwner}:prefs`, {
    owner_user_id: otherOwner,
    display_name: "别家创作者",
    preferred_timezone: "Asia/Singapore",
    locale: "zh-CN",
    schema_version: SCHEMA,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
  });

  kvSet(`owner:${otherOwner}:focus`, {
    id: otherOwner,
    owner_user_id: otherOwner,
    current_media_account_id: otherMac,
    last_session_id: null,
    schema_version: SCHEMA,
    version: 1,
    updated_at: NOW,
  });

  kvSet(`owner:${otherOwner}:media_accounts`, [otherMac]);

  kvSet(`media_account:${otherMac}`, {
    id: otherMac,
    owner_user_id: otherOwner,
    platform: "douyin",
    display_name: "别家效率号",
    handle: "other_eff",
    profile_url: null,
    avatar_ref: null,
    biz_line_tag: "other",
    status: "active",
    onboarding_path: "new_account",
    stage: "operating",
    content_timezone: "Asia/Singapore",
    credential_ref: null,
    platform_fetch_template: null,
    schema_version: SCHEMA,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
  });

  kvSet(`media_account:${otherMac}:profile`, {
    id: "prf_01JOTHER000000000000001",
    owner_user_id: otherOwner,
    media_account_id: otherMac,
    what_it_is: "演示用隔离账号（不应被 phosa 看见）",
    goal: "证明跨 owner 403",
    redlines_summary: "仅 demo",
    audience: null,
    tone_notes: null,
    prefer_hands_on_tutorials: false,
    schema_version: SCHEMA,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
  });

  const secretPost = {
    id: "pst_other_secret",
    title: "【机密】别家选题：只有 other_creator 能看",
    status: "选题",
    content_type: "干货",
    form: "文章",
    planned_publish_at: null,
    published_at: null,
    url: null,
    platform_post_id: null,
    manuscript_id: null,
    metrics_views: null,
    metrics_likes: null,
    metrics_comments: null,
    metrics_favorites: null,
    metrics_shares: null,
    metrics_updated_at: null,
    remark: "isolation probe",
    source: "other",
    owner_user_id: otherOwner,
    media_account_id: otherMac,
    schema_version: SCHEMA,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
  };
  kvSet(`media_account:${otherMac}:posts`, [secretPost.id]);
  kvSet(`media_account:${otherMac}:post:${secretPost.id}`, secretPost);
  kvSet(`media_account:${otherMac}:posts_by_status:选题`, [secretPost.id]);
  kvSet(`media_account:${otherMac}:manuscripts`, []);
  kvSet(`media_account:${otherMac}:engagement_snapshots`, []);
  kvSet(`media_account:${otherMac}:follower_snapshots`, []);
  kvSet(`media_account:${otherMac}:revenue`, []);
  kvSet(`media_account:${otherMac}:platform_events`, []);
  kvSet(`media_account:${otherMac}:daily_trends`, []);
  kvSet(`media_account:${otherMac}:rules`, {
    id: "rul_01JOTHER000000000000001",
    owner_user_id: otherOwner,
    media_account_id: otherMac,
    enabled_rule_ids: ["final_review_before_publish"],
    publish_window_start: null,
    publish_window_end: null,
    notes: null,
    schema_version: SCHEMA,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
  });
}

function seed() {
  ensureStoreDirs();
  const result = importXiaogaoFixture({ quiet: false });
  seedOtherOwner();
  console.log(
    `Seeded MediaAccount ${PHOSA_MAC_ID} (owner phosa=${PHOSA_OWNER_ID}) → ${DATA_ROOT}`,
  );
  console.log(
    `Also seeded ${OTHER_MAC_ID} (owner=${OTHER_OWNER_ID}) for isolation`,
  );
  console.log(
    `Posts=${result.counts.posts} manuscripts=${result.counts.manuscripts} engagement=${result.counts.engagement_snapshots}`,
  );
  return result;
}

export { seed };

const entryUrl = typeof import.meta !== "undefined" ? import.meta.url : "";
if (
  entryUrl &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(entryUrl)
) {
  seed();
}
