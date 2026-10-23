/**
 * Seed MediaAccount「小稿的AI日记 @ 小黑盒」from design + Notion evidence/examples.
 * Never stores secrets — credential_ref is a pointer only.
 * 小稿归 phosa；另种 other_creator 账号用于隔离验证。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureStoreDirs,
  kvSet,
  writeBlob,
  DATA_ROOT,
} from "../server/kv.mjs";
import { RULE_CATALOG } from "../server/ruleCatalog.mjs";

/** phosa owns 小稿的AI日记; other_creator is isolation counterparty. */
export const PHOSA_OWNER_ID = "usr_01JPHOSA000000000000000";
export const OTHER_OWNER_ID = "usr_01JOTHERDEMO0000000001";
export const PHOSA_MAC_ID = "mac_01JHEYBOXXIAOGUAO0001";
export const OTHER_MAC_ID = "mac_01JOTHERDOUYIN000000001";

const OWNER = PHOSA_OWNER_ID;
const MAC = PHOSA_MAC_ID;
const NOW = "2026-10-23T03:00:00.000Z";
const SCHEMA = "1.0.0";

function meta(extra = {}) {
  return {
    owner_user_id: OWNER,
    media_account_id: MAC,
    schema_version: SCHEMA,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...extra,
  };
}

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

  kvSet("system:rule_catalog", RULE_CATALOG);

  kvSet("system:demo_users", [
    {
      username: "phosa",
      owner_user_id: PHOSA_OWNER_ID,
      display_name: "phosa",
    },
    {
      username: "other_creator",
      owner_user_id: OTHER_OWNER_ID,
      display_name: "别家创作者",
    },
  ]);

  kvSet(`owner:${OWNER}:prefs`, {
    owner_user_id: OWNER,
    display_name: "phosa",
    preferred_timezone: "Asia/Singapore",
    locale: "zh-CN",
    schema_version: SCHEMA,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
  });

  kvSet(`owner:${OWNER}:focus`, {
    id: OWNER,
    owner_user_id: OWNER,
    current_media_account_id: MAC,
    last_session_id: null,
    schema_version: SCHEMA,
    version: 1,
    updated_at: NOW,
  });

  kvSet(`owner:${OWNER}:media_accounts`, [MAC]);

  kvSet(`media_account:${MAC}`, {
    id: MAC,
    owner_user_id: OWNER,
    platform: "xiaoheihe",
    display_name: "小稿的AI日记",
    handle: null,
    profile_url: "https://app.notion.com/p/3f888c11a232806e82a9c327c371d577",
    avatar_ref: null,
    biz_line_tag: "xiaogao",
    status: "active",
    onboarding_path: "existing_account",
    stage: "operating",
    content_timezone: "Asia/Singapore",
    credential_ref: "bitwarden://item/heybox-xiaogao",
    platform_fetch_template:
      "https://api.xiaoheihe.cn/bbs/app/link/web/view?link_id={platform_post_id}&os_type=web",
    schema_version: SCHEMA,
    version: 1,
    created_at: "2026-01-15T08:00:00.000Z",
    updated_at: NOW,
    deleted_at: null,
  });

  kvSet(`media_account:${MAC}:profile`, {
    id: "prf_01JXIAOGUAO00000000001",
    ...meta(),
    what_it_is: "个人技术内容账号",
    goal: "可发技术内容持续产出；选题在库、稿件可复刻、发布必过终审；粉丝与阅读稳定增长",
    redlines_summary:
      "不提封锁/污染/翻墙，不比国内外；正文不放外链；第一人称只写真做过的；发布前须终审通过",
    audience: null,
    tone_notes: "标题口语、短、糙；偏好可动手白嫖教程",
    prefer_hands_on_tutorials: true,
  });

  kvSet(`media_account:${MAC}:rules`, {
    id: "rul_01JXIAOGUAO00000000001",
    ...meta(),
    enabled_rule_ids: RULE_CATALOG.map((r) => r.rule_id),
    publish_window_start: "20:00",
    publish_window_end: "21:00",
    notes: null,
  });

  const posts = [
    {
      id: "pst_188594751",
      title: "【个人开发日记】本机能跑，不等于别人能打开",
      status: "已发布",
      content_type: "干货",
      form: "图文",
      planned_publish_at: "2026-08-20",
      published_at: "2026-08-20",
      url: "https://www.xiaoheihe.cn/app/bbs/link/188594751",
      platform_post_id: "188594751",
      manuscript_id: "man_benji_nengpao",
      metrics_views: 4070,
      metrics_likes: 45,
      metrics_comments: 38,
      metrics_favorites: 64,
      metrics_shares: 6,
      metrics_updated_at: "2026-10-22",
      remark:
        "2026-10-17 修链：正文页前缀已改正。稿页比平台版多出若干节，平台只发了前 4 节。",
      source: "xiaoheihe",
    },
    {
      id: "pst_190700154",
      title: "自己的网站第一次盈利是什么感觉！！",
      status: "已发布",
      content_type: "经历",
      form: "文章",
      planned_publish_at: "2026-09-15",
      published_at: "2026-09-15",
      url: "https://www.xiaoheihe.cn/app/bbs/link/190700154",
      platform_post_id: "190700154",
      manuscript_id: "man_first_profit",
      metrics_views: 44007,
      metrics_likes: 1158,
      metrics_comments: 316,
      metrics_favorites: 1089,
      metrics_shares: 95,
      metrics_updated_at: "2026-10-22",
      remark: "2026-10-17 grokbot 从平台回抓原文并建稿页。",
      source: "xiaoheihe",
    },
    {
      id: "pst_193497836",
      title: "旧手机四步爆改服务器！门槛低到没手也行！",
      status: "已发布",
      content_type: "干货",
      form: "文章",
      planned_publish_at: "2026-10-12",
      published_at: "2026-10-12",
      url: "https://www.xiaoheihe.cn/app/bbs/link/193497836",
      platform_post_id: "193497836",
      manuscript_id: "man_old_phone_server",
      metrics_views: 21342,
      metrics_likes: 389,
      metrics_comments: 135,
      metrics_favorites: 1001,
      metrics_shares: 0,
      metrics_updated_at: "2026-10-22",
      remark: null,
      source: "xiaoheihe",
    },
    {
      id: "pst_189157727",
      title: "【个人开发日记4】0成本运营一个完整的线上服务",
      status: "已发布",
      content_type: "干货",
      form: "文章",
      planned_publish_at: null,
      published_at: "2026-09-01",
      url: "https://www.xiaoheihe.cn/app/bbs/link/189157727",
      platform_post_id: "189157727",
      manuscript_id: "man_diary4",
      metrics_views: 787,
      metrics_likes: 43,
      metrics_comments: 14,
      metrics_favorites: 136,
      metrics_shares: 0,
      metrics_updated_at: "2026-10-22",
      remark: "补建帖子行；平台链接已填。",
      source: "xiaoheihe",
    },
    {
      id: "pst_d2r_mobile",
      title: "开源项目 D2R Mobile：把自己的 Switch 版暗黑2重制版装到 iPhone/iPad 上",
      status: "写稿中",
      content_type: "项目展示",
      form: "文章",
      planned_publish_at: null,
      published_at: null,
      url: null,
      platform_post_id: null,
      manuscript_id: "man_d2r_mobile",
      metrics_views: null,
      metrics_likes: null,
      metrics_comments: null,
      metrics_favorites: null,
      metrics_shares: null,
      metrics_updated_at: null,
      remark: null,
      source: "xiaoheihe",
    },
    {
      id: "pst_topic_cdn",
      title: "选题：CDN 是什么（给玩家讲清楚）",
      status: "选题",
      content_type: "科普",
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
      remark: null,
      source: "xiaoheihe",
    },
    {
      id: "pst_informal_card",
      title: "这牌怎么防",
      status: "已发布",
      content_type: "游戏",
      form: "图文",
      planned_publish_at: null,
      published_at: "2026-08-01",
      url: "https://www.xiaoheihe.cn/app/bbs/link/example_informal",
      platform_post_id: null,
      manuscript_id: null,
      metrics_views: 1200,
      metrics_likes: 20,
      metrics_comments: 5,
      metrics_favorites: 8,
      metrics_shares: 1,
      metrics_updated_at: "2026-10-17",
      remark: "随手发帖、永久留空、不是缺口；正文页故意为空。",
      source: "xiaoheihe",
    },
  ];

  const postIds = posts.map((p) => p.id);
  kvSet(`media_account:${MAC}:posts`, postIds);
  const byStatus = {};
  for (const p of posts) {
    kvSet(`media_account:${MAC}:post:${p.id}`, { ...p, ...meta({ version: 2 }) });
    byStatus[p.status] = byStatus[p.status] || [];
    byStatus[p.status].push(p.id);
  }
  for (const [st, ids] of Object.entries(byStatus)) {
    kvSet(`media_account:${MAC}:posts_by_status:${st}`, ids);
  }

  const manuscripts = [
    {
      id: "man_benji_nengpao",
      title: "【个人开发日记】本机能跑，不等于别人能打开",
      post_id: "pst_188594751",
      status: "已发布",
      archive_bucket: "active",
      final_review_passed: true,
      final_reviewed_at: "2026-08-20T11:00:00.000Z",
      body: `# 本机能跑，不等于别人能打开

写作稿（≠ 发布版）。平台只发了前 4 节；完整骨架含接口/登录/对象存储等节。

## 观点

本机能跑通 ≠ 别人环境能打开。要讲清部署边界与依赖。
`,
      published_edition: `# 发布版节（摘要）

以帖子链接 / 平台 SSR 为准：https://www.xiaoheihe.cn/app/bbs/link/188594751
`,
    },
    {
      id: "man_first_profit",
      title: "自己的网站第一次盈利是什么感觉！！",
      post_id: "pst_190700154",
      status: "已发布",
      archive_bucket: "active",
      final_review_passed: true,
      final_reviewed_at: "2026-09-15T11:00:00.000Z",
      body: `# 第一次盈利

经历向写作稿。事实与观点看本稿；引用原文走帖链接。
`,
      published_edition: null,
    },
    {
      id: "man_old_phone_server",
      title: "旧手机四步爆改服务器！门槛低到没手也行！",
      post_id: "pst_193497836",
      status: "已发布",
      archive_bucket: "active",
      final_review_passed: true,
      final_reviewed_at: "2026-10-12T11:50:00.000Z",
      body: `# 旧手机四步爆改服务器

干货教程骨架。配图横图 16:9；正文不放外链。
`,
      published_edition: null,
    },
    {
      id: "man_diary4",
      title: "【个人开发日记4】0成本运营一个完整的线上服务",
      post_id: "pst_189157727",
      status: "已发布",
      archive_bucket: "historical",
      final_review_passed: true,
      final_reviewed_at: "2026-09-01T10:00:00.000Z",
      body: `# 0成本运营

历史稿子桶示例。
`,
      published_edition: null,
    },
    {
      id: "man_d2r_mobile",
      title: "开源项目 D2R Mobile…",
      post_id: "pst_d2r_mobile",
      status: "写稿中",
      archive_bucket: "active",
      final_review_passed: false,
      final_reviewed_at: null,
      body: `# D2R Mobile

写稿中。尚未终审。
`,
      published_edition: null,
    },
  ];

  const msIds = [];
  for (const m of manuscripts) {
    msIds.push(m.id);
    const bodyRef = writeBlob(`manuscripts/${m.id}/body.md`, m.body);
    const pubRef = m.published_edition
      ? writeBlob(`manuscripts/${m.id}/published.md`, m.published_edition)
      : null;
    kvSet(`media_account:${MAC}:manuscript:${m.id}`, {
      id: m.id,
      title: m.title,
      post_id: m.post_id,
      body_ref: bodyRef,
      published_edition_ref: pubRef,
      status: m.status,
      archive_bucket: m.archive_bucket,
      final_review_passed: m.final_review_passed,
      final_reviewed_at: m.final_reviewed_at,
      ...meta(),
    });
  }
  kvSet(`media_account:${MAC}:manuscripts`, msIds);

  const engagement = [
    {
      id: "eng_20261010_190700154",
      snapshot_date: "2026-10-10",
      title: "自己的网站第一次盈利是什么感觉！！",
      form: "文章",
      views: 40630,
      likes: 1075,
      comments: 307,
      favorites: 1009,
      shares: 0,
      source: "xiaoheihe",
      post_url: "https://www.xiaoheihe.cn/app/bbs/link/190700154",
      post_id: "pst_190700154",
    },
    {
      id: "eng_20261012_193497836",
      snapshot_date: "2026-10-12",
      title: "旧手机四步爆改服务器！门槛低到没手也行！",
      form: "文章",
      views: 21342,
      likes: 389,
      comments: 135,
      favorites: 1001,
      shares: 0,
      source: "xiaoheihe",
      post_url: "https://www.xiaoheihe.cn/app/bbs/link/193497836",
      post_id: "pst_193497836",
    },
    {
      id: "eng_20261013_189157727",
      snapshot_date: "2026-10-13",
      title: "【个人开发日记4】0成本运营一个完整的线上服务",
      form: "文章",
      views: 787,
      likes: 43,
      comments: 14,
      favorites: 136,
      shares: 0,
      source: "xiaoheihe",
      post_url: "https://www.xiaoheihe.cn/app/bbs/link/189157727",
      post_id: "pst_189157727",
    },
    {
      id: "eng_20261022_188594751",
      snapshot_date: "2026-10-22",
      title: "【个人开发日记】本机能跑，不等于别人能打开",
      form: "图文",
      views: 4070,
      likes: 45,
      comments: 38,
      favorites: 64,
      shares: 6,
      source: "xiaoheihe",
      post_url: "https://www.xiaoheihe.cn/app/bbs/link/188594751",
      post_id: "pst_188594751",
    },
    {
      id: "eng_20261022_190700154",
      snapshot_date: "2026-10-22",
      title: "自己的网站第一次盈利是什么感觉！！",
      form: "文章",
      views: 44007,
      likes: 1158,
      comments: 316,
      favorites: 1089,
      shares: 95,
      source: "xiaoheihe",
      post_url: "https://www.xiaoheihe.cn/app/bbs/link/190700154",
      post_id: "pst_190700154",
    },
  ];

  const engIds = [];
  const engByDate = {};
  for (const e of engagement) {
    engIds.push(e.id);
    kvSet(`media_account:${MAC}:engagement_snapshot:${e.id}`, { ...e, ...meta() });
    engByDate[e.snapshot_date] = engByDate[e.snapshot_date] || [];
    engByDate[e.snapshot_date].push(e.id);
  }
  kvSet(`media_account:${MAC}:engagement_snapshots`, engIds);
  for (const [d, ids] of Object.entries(engByDate)) {
    kvSet(`media_account:${MAC}:engagement_snapshots:${d}`, ids);
  }

  const dailyTrends = [
    {
      id: "dtr_20261022_190700154",
      trend_date: "2026-10-22",
      title: "自己的网站第一次盈利是什么感觉！！",
      platform_post_id: "190700154",
      post_url: "https://www.xiaoheihe.cn/app/bbs/link/190700154",
      post_id: "pst_190700154",
      views: 3377,
      likes: 83,
      comments: 9,
      favorites: 80,
      shares: 95,
      charges: 0,
      new_followers: 2,
      source: "xiaoheihe",
      record_title: "2026-10-22 日趋势",
    },
  ];
  kvSet(
    `media_account:${MAC}:daily_trends`,
    dailyTrends.map((t) => t.id),
  );
  kvSet(`media_account:${MAC}:daily_trends:2026-10-22`, ["dtr_20261022_190700154"]);
  for (const t of dailyTrends) {
    kvSet(`media_account:${MAC}:daily_trend:${t.id}`, { ...t, ...meta() });
  }

  const followers = [
    {
      id: "fol_20260916",
      record_date: "2026-09-16",
      followers: 60,
      post_count: null,
      likes_and_favorites: null,
      source: "profile_history.csv",
      record_title: "2026-09-16",
    },
    {
      id: "fol_20261008",
      record_date: "2026-10-08",
      followers: 117,
      post_count: null,
      likes_and_favorites: null,
      source: "profile_history.csv",
      record_title: "2026-10-08",
    },
    {
      id: "fol_20261013",
      record_date: "2026-10-13",
      followers: 201,
      post_count: 15,
      likes_and_favorites: 11052,
      source: "grokbot 回填：日终 snapshot likes+favs",
      record_title: "2026-10-13",
    },
  ];
  kvSet(
    `media_account:${MAC}:follower_snapshots`,
    followers.map((f) => f.id),
  );
  for (const f of followers) {
    kvSet(`media_account:${MAC}:follower_snapshot:${f.id}`, { ...f, ...meta() });
  }

  const revenue = [
    {
      id: "rev_20261017_18",
      record_title: "2026-10-17 14:01 原创奖励 +18.0",
      amount: 18,
      currency: "CNY",
      occurred_at: "2026-10-17T06:01:00.000Z",
      fetched_on: "2026-10-18",
      source: "xiaoheihe",
      source_title: "旧手机四步爆改服务...",
      revenue_type: "reward",
    },
    {
      id: "rev_20261018_27",
      record_title: "2026-10-18 原创奖励 +27.0",
      amount: 27,
      currency: "CNY",
      occurred_at: "2026-10-18T08:00:00.000Z",
      fetched_on: "2026-10-18",
      source: "xiaoheihe",
      source_title: "自己的网站第一次盈利是什么感觉！！",
      revenue_type: "reward",
    },
    {
      id: "rev_20261015_1",
      record_title: "2026-10-15 21:56 原创奖励 +1.0",
      amount: 1,
      currency: "CNY",
      occurred_at: "2026-10-15T13:56:00.000Z",
      fetched_on: "2026-10-18",
      source: "xiaoheihe",
      source_title: "10GB免费云存储...",
      revenue_type: "reward",
    },
    {
      id: "rev_20261013_1",
      record_title: "2026-10-13 15:16 原创奖励 +1.0",
      amount: 1,
      currency: "CNY",
      occurred_at: "2026-10-13T07:16:00.000Z",
      fetched_on: "2026-10-18",
      source: "xiaoheihe",
      source_title: "如何获得一个免费的...",
      revenue_type: "reward",
    },
    {
      id: "rev_balance_18",
      record_title: "余额入账 +18",
      amount: 18,
      currency: "CNY",
      occurred_at: "2026-10-17T00:00:00.000Z",
      fetched_on: "2026-10-18",
      source: "xiaoheihe",
      source_title: null,
      revenue_type: "balance",
    },
    {
      id: "rev_screenshot",
      record_title: "截图凭证累计约46",
      amount: 46,
      currency: "CNY",
      occurred_at: "2026-10-18T00:00:00.000Z",
      fetched_on: "2026-10-18",
      source: "xiaoheihe",
      source_title: null,
      revenue_type: "screenshot_proof",
    },
  ];
  kvSet(
    `media_account:${MAC}:revenue`,
    revenue.map((r) => r.id),
  );
  for (const r of revenue) {
    kvSet(`media_account:${MAC}:revenue:${r.id}`, { ...r, ...meta() });
  }

  const events = [
    {
      id: "evt_gaorenqi_profit",
      name: "恭喜！你发布的内容在社区内获得了超高人气！",
      event_type: "超高人气",
      occurred_at: "2026-09-17",
      registered_on: "2026-10-17",
      source: "xiaoheihe",
      related_title: "自己的网站第一次盈利是什么感觉！！",
      post_id: "pst_190700154",
      remark: "您的内容已经获得了552点赞！",
    },
    {
      id: "evt_gaorenqi_server",
      name: "恭喜！你发布的内容在社区内获得了超高人气！",
      event_type: "超高人气",
      occurred_at: "2026-10-16T16:41:00.000Z",
      registered_on: "2026-10-17",
      source: "xiaoheihe",
      related_title: "当你拥有了一台个人服务器，可以干些什么！",
      post_id: null,
      remark: "已经获得了507点赞！",
    },
    {
      id: "evt_audit_oldphone",
      name: "内容成功参与创作计划",
      event_type: "审核通过",
      occurred_at: "2026-10-12",
      registered_on: "2026-10-17",
      source: "xiaoheihe",
      related_title: "旧手机四步爆改服务器！门槛低到没手也行！",
      post_id: "pst_193497836",
      remark: "符合「文章计划」要求，将获得额外曝光和收益奖励！",
    },
  ];
  kvSet(
    `media_account:${MAC}:platform_events`,
    events.map((e) => e.id),
  );
  for (const e of events) {
    kvSet(`media_account:${MAC}:platform_event:${e.id}`, { ...e, ...meta() });
  }

  kvSet(`media_account:${MAC}:import_stub`, {
    id: "imp_01JXIAOGUAO00000000001",
    ...meta(),
    source: "manual_url",
    status: "done",
    seed_urls: ["https://www.xiaoheihe.cn/app/bbs/link/188594751"],
    seed_notes: "Notion 自媒体分区导入；凭证不入库",
    imported_published_ids: postIds.filter((id) =>
      posts.find((p) => p.id === id && p.status === "已发布"),
    ),
    error_message: null,
  });

  seedOtherOwner();

  console.log(`Seeded MediaAccount ${MAC} (owner phosa=${OWNER}) → ${DATA_ROOT}`);
  console.log(`Also seeded ${OTHER_MAC_ID} (owner=${OTHER_OWNER_ID}) for isolation`);
  console.log(`Posts=${posts.length} manuscripts=${manuscripts.length} engagement=${engagement.length}`);
}

export { seed };

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  seed();
}
