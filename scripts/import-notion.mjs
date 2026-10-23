/**
 * Idempotent Notion → MediaAccount SoT import for 小稿的AI日记 @ 小黑盒.
 * Fixture: data/import/xiaogao/  |  Run: npm run import:notion
 * Never stores secrets.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureStoreDirs,
  kvSet,
  writeBlob,
  getDataRoot,
} from "../server/kv.mjs";
import { RULE_CATALOG } from "../server/ruleCatalog.mjs";
import {
  PHOSA_OWNER_ID,
  PHOSA_MAC_ID,
  OTHER_OWNER_ID,
} from "./seed-ids.mjs";
import packedFixture from "../fixtures/xiaogao/fixture.generated.json" with { type: "json" };

function moduleDir() {
  const url = typeof import.meta !== "undefined" ? import.meta.url : "";
  if (!url) return path.resolve(process.cwd(), "scripts");
  try {
    return path.dirname(fileURLToPath(url));
  } catch {
    return path.resolve(process.cwd(), "scripts");
  }
}
const __dirname = moduleDir();
const FIXTURE = path.resolve(__dirname, "../fixtures/xiaogao");
const SCHEMA = "1.0.0";
const OWNER = PHOSA_OWNER_ID;
const MAC = PHOSA_MAC_ID;

const POST_STATUSES = new Set([
  "选题",
  "写稿中",
  "待确认",
  "已发布",
  "被隐藏",
  "搁置",
]);

function nowIso() {
  return new Date().toISOString();
}

function meta(extra = {}) {
  const stamp = nowIso();
  return {
    owner_user_id: OWNER,
    media_account_id: MAC,
    schema_version: SCHEMA,
    version: 1,
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null,
    ...extra,
  };
}

function loadPack() {
  if (packedFixture?.posts) return packedFixture;
  const p = path.join(FIXTURE, "fixture.generated.json");
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  throw new Error("missing fixture.generated.json — run npm run pack:fixture");
}

function notionPageId(urlOrId) {
  if (!urlOrId) return null;
  const s = String(urlOrId);
  const m =
    s.match(/([0-9a-f]{32})/i) ||
    s.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    );
  if (!m) return null;
  return m[1].replace(/-/g, "").toLowerCase();
}

function stableId(prefix, urlOrId, fallback) {
  const nid = notionPageId(urlOrId);
  if (nid) return `${prefix}_${nid.slice(0, 24)}`;
  return `${prefix}_${fallback}`;
}

function platformPostIdFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/link\/(\d+)/);
  return m ? m[1] : null;
}

function mapRevenueType(notionType, recordTitle) {
  const t = String(notionType || "");
  const r = String(recordTitle || "");
  if (t === "原创奖励") return "reward";
  if (t === "创作者任务奖励") return "task";
  if (t === "截图凭证") return "screenshot_proof";
  if (/余额/.test(r) || /余额/.test(t)) return "balance";
  return "reward";
}

function mapSource(s) {
  if (!s || s === "小黑盒") return "xiaoheihe";
  return String(s);
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function postIdForRow(row, index) {
  const platformId = platformPostIdFromUrl(row["链接"]);
  if (platformId) return `pst_${platformId}`;
  return stableId("pst", row.url || row.id, index);
}

export function importXiaogaoFixture({ quiet = false } = {}) {
  ensureStoreDirs();
  const stamp = nowIso();
  const pack = loadPack();
  const fixtureMeta = pack.meta || {};
  const profileIn = pack.profile;
  const rulesIn = pack.rules_notes;
  const postsIn = pack.posts || [];
  const engIn = pack.engagement || [];
  const folIn = pack.followers || [];
  const revIn = pack.revenue || [];
  const evtIn = pack.events || [];
  const trendIn = pack.daily_trends || [];
  const msIndex = pack.manuscripts_index || { children: [] };
  const manuscriptBodies = pack.manuscripts || {};

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
    created_at: stamp,
    updated_at: stamp,
  });
  kvSet(`owner:${OWNER}:focus`, {
    id: OWNER,
    owner_user_id: OWNER,
    current_media_account_id: MAC,
    last_session_id: null,
    schema_version: SCHEMA,
    version: 1,
    updated_at: stamp,
  });
  kvSet(`owner:${OWNER}:media_accounts`, [MAC]);

  kvSet(`media_account:${MAC}`, {
    id: MAC,
    owner_user_id: OWNER,
    platform: "xiaoheihe",
    display_name: profileIn.display_name || "小稿的AI日记",
    handle: null,
    profile_url: profileIn.source_url || null,
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
    updated_at: stamp,
    deleted_at: null,
  });

  kvSet(`media_account:${MAC}:profile`, {
    id: "prf_01JXIAOGUAO00000000001",
    ...meta({ created_at: stamp, updated_at: stamp }),
    what_it_is: profileIn.what_it_is || "个人技术内容账号",
    goal: profileIn.goal || "",
    redlines_summary: profileIn.redlines_summary || "",
    audience: null,
    tone_notes: "标题口语、短、糙；偏好可动手白嫖教程",
    prefer_hands_on_tutorials: true,
  });

  kvSet(`media_account:${MAC}:rules`, {
    id: "rul_01JXIAOGUAO00000000001",
    ...meta({ created_at: stamp, updated_at: stamp }),
    enabled_rule_ids: RULE_CATALOG.map((r) => r.rule_id),
    publish_window_start: "20:00",
    publish_window_end: "21:00",
    notes: (rulesIn.bullets || []).join("\n"),
  });

  const manuscriptByNotionId = new Map();
  const manuscripts = new Map();
  const msIds = [];
  const mdEntries = Object.entries(manuscriptBodies);

  for (const [rawId, body] of mdEntries) {
    const nid = notionPageId(rawId) || rawId.replace(/-/g, "").toLowerCase();
    const id = `man_${nid.slice(0, 24)}`;
    const fromIndex = (msIndex.children || []).find(
      (c) => notionPageId(c.url) === nid,
    );
    const heading = String(body).split("\n").find((l) => l.startsWith("# "));
    const title =
      fromIndex?.title ||
      (heading ? heading.replace(/^#\s*/, "") : rawId).slice(0, 160);
    const bodyRef = writeBlob(`manuscripts/${id}/body.md`, body);
    const reviewed =
      /已审通过|已发布|终审通过/.test(title) ||
      /已审通过|终审通过/.test(body.slice(0, 500));
    const drafting = /待终审|写稿中|待截图/.test(title);
    const status = drafting ? "写稿中" : reviewed ? "已发布" : "写稿中";
    const row = {
      id,
      title,
      post_id: null,
      body_ref: bodyRef,
      published_edition_ref: null,
      notion_page_url: `https://app.notion.com/p/${nid}`,
      status,
      archive_bucket: "active",
      final_review_passed: Boolean(reviewed && !drafting),
      final_reviewed_at: reviewed && !drafting ? stamp : null,
      ...meta({ created_at: stamp, updated_at: stamp }),
    };
    manuscripts.set(id, row);
    manuscriptByNotionId.set(nid, id);
    msIds.push(id);
    kvSet(`media_account:${MAC}:manuscript:${id}`, row);
  }
  kvSet(`media_account:${MAC}:manuscripts`, msIds);

  const posts = [];
  const byStatus = {};
  postsIn.forEach((row, index) => {
    const id = postIdForRow(row, index);
    const status = POST_STATUSES.has(row["状态"]) ? row["状态"] : "选题";
    const platformId = platformPostIdFromUrl(row["链接"]);
    const bodyNid = notionPageId(row["正文页"]);
    let manuscriptId = bodyNid ? manuscriptByNotionId.get(bodyNid) || null : null;
    if (!manuscriptId) {
      const title = String(row["标题"] || "");
      for (const m of manuscripts.values()) {
        if (m.title === title || (title && m.title.includes(title.slice(0, 10)))) {
          manuscriptId = m.id;
          break;
        }
      }
    }

    const post = {
      id,
      title: String(row["标题"] || "未命名"),
      status,
      content_type: row["类型"] || null,
      form: row["形式"] || null,
      planned_publish_at: row["date:计划发布:start"] || null,
      published_at: row["date:发布时间:start"] || null,
      url: row["链接"] || null,
      platform_post_id: platformId,
      manuscript_id: manuscriptId,
      notion_page_url: row.url || null,
      metrics_views: num(row["浏览"]),
      metrics_likes: num(row["赞"]),
      metrics_comments: num(row["评论"]),
      metrics_favorites: num(row["收藏"]),
      metrics_shares: num(row["分享"]),
      metrics_updated_at: row["date:数据更新于:start"] || null,
      remark: row["备注"] || null,
      source: "xiaoheihe",
      ...meta({ created_at: stamp, updated_at: stamp, version: 2 }),
    };
    posts.push(post);
    kvSet(`media_account:${MAC}:post:${id}`, post);
    byStatus[status] = byStatus[status] || [];
    byStatus[status].push(id);

    if (manuscriptId && manuscripts.has(manuscriptId)) {
      const m = manuscripts.get(manuscriptId);
      const next = {
        ...m,
        post_id: id,
        updated_at: stamp,
      };
      if (status === "已发布" || status === "被隐藏") {
        next.status = status;
        if (status === "已发布") next.final_review_passed = true;
      } else if (status === "写稿中" || status === "待确认") {
        next.status = status;
      }
      manuscripts.set(manuscriptId, next);
      kvSet(`media_account:${MAC}:manuscript:${manuscriptId}`, next);
    }
  });

  kvSet(
    `media_account:${MAC}:posts`,
    posts.map((p) => p.id),
  );
  for (const [st, ids] of Object.entries(byStatus)) {
    kvSet(`media_account:${MAC}:posts_by_status:${st}`, ids);
  }

  const engIds = [];
  const engByDate = {};
  for (const row of engIn) {
    const id = stableId("eng", row.url || row.id, engIds.length);
    const snapshot_date = row["date:日期:start"] || "unknown";
    const postUrl = row["帖链接"] || null;
    const platformId = platformPostIdFromUrl(postUrl);
    const e = {
      id,
      snapshot_date,
      title: String(row["标题"] || ""),
      form: row["形式"] || null,
      views: num(row["浏览"]),
      likes: num(row["赞"]),
      comments: num(row["评"]),
      favorites: num(row["收藏"]),
      shares: num(row["分享"]),
      source: mapSource(row["来源"]),
      post_url: postUrl,
      post_id: platformId ? `pst_${platformId}` : null,
      notion_page_url: row.url || null,
      ...meta({ created_at: stamp, updated_at: stamp }),
    };
    engIds.push(id);
    kvSet(`media_account:${MAC}:engagement_snapshot:${id}`, e);
    engByDate[snapshot_date] = engByDate[snapshot_date] || [];
    engByDate[snapshot_date].push(id);
  }
  kvSet(`media_account:${MAC}:engagement_snapshots`, engIds);
  for (const [d, ids] of Object.entries(engByDate)) {
    kvSet(`media_account:${MAC}:engagement_snapshots:${d}`, ids);
  }

  const folIds = [];
  for (const row of folIn) {
    const id = stableId("fol", row.url || row.id, folIds.length);
    const f = {
      id,
      record_date: row["date:日期:start"] || String(row["记录"] || ""),
      followers: num(row["粉丝"]),
      post_count: num(row["帖子数"]),
      likes_and_favorites: num(row["获赞与收藏"]),
      source: row["来源"] || null,
      record_title: String(row["记录"] || row["date:日期:start"] || id),
      notion_page_url: row.url || null,
      ...meta({ created_at: stamp, updated_at: stamp }),
    };
    folIds.push(id);
    kvSet(`media_account:${MAC}:follower_snapshot:${id}`, f);
  }
  kvSet(`media_account:${MAC}:follower_snapshots`, folIds);

  const revIds = [];
  for (const row of revIn) {
    const id = stableId("rev", row.url || row.id, revIds.length);
    const r = {
      id,
      record_title: String(row["记录"] || id),
      amount: num(row["金额"]) ?? 0,
      currency: "CNY",
      occurred_at: row["date:时间:start"] || stamp,
      fetched_on: row["date:抓取日:start"] || null,
      source: mapSource(row["来源"]),
      source_title: row["来源标题"] || null,
      revenue_type: mapRevenueType(row["类型"], row["记录"]),
      notion_page_url: row.url || null,
      ...meta({ created_at: stamp, updated_at: stamp }),
    };
    revIds.push(id);
    kvSet(`media_account:${MAC}:revenue:${id}`, r);
  }
  kvSet(`media_account:${MAC}:revenue`, revIds);

  const evtIds = [];
  for (const row of evtIn) {
    const id = stableId("evt", row.url || row.id, evtIds.length);
    const e = {
      id,
      name: String(row["名称"] || "事件"),
      event_type: row["事件类型"] || "其他",
      occurred_at: row["date:时间:start"] || stamp,
      registered_on: row["date:登记日:start"] || null,
      source: mapSource(row["来源"]),
      related_title: row["关联标题"] || null,
      remark: row["备注"] || null,
      notion_page_url: row.url || null,
      ...meta({ created_at: stamp, updated_at: stamp }),
    };
    evtIds.push(id);
    kvSet(`media_account:${MAC}:platform_event:${id}`, e);
  }
  kvSet(`media_account:${MAC}:platform_events`, evtIds);

  const trendIds = [];
  const trendByDate = {};
  for (const row of trendIn) {
    const id = stableId("dtr", row.url || row.id, trendIds.length);
    const trend_date = row["date:日期:start"] || "unknown";
    const platformId =
      row["帖ID"] != null && row["帖ID"] !== ""
        ? String(Math.trunc(Number(row["帖ID"])))
        : platformPostIdFromUrl(row["帖链接"]);
    const t = {
      id,
      trend_date,
      title: row["标题"] || null,
      platform_post_id: platformId,
      post_url: row["帖链接"] || null,
      post_id: platformId ? `pst_${platformId}` : null,
      views: num(row["浏览"]),
      likes: num(row["赞"]),
      comments: num(row["评"]),
      favorites: num(row["藏"]),
      shares: num(row["分享"]),
      charges: num(row["充电"]),
      new_followers: num(row["新增粉丝"]),
      source: mapSource(row["来源"]),
      record_title: String(row["记录"] || `${trend_date} 日趋势`),
      notion_page_url: row.url || null,
      ...meta({ created_at: stamp, updated_at: stamp }),
    };
    trendIds.push(id);
    kvSet(`media_account:${MAC}:daily_trend:${id}`, t);
    trendByDate[trend_date] = trendByDate[trend_date] || [];
    trendByDate[trend_date].push(id);
  }
  kvSet(`media_account:${MAC}:daily_trends`, trendIds);
  for (const [d, ids] of Object.entries(trendByDate)) {
    kvSet(`media_account:${MAC}:daily_trends:${d}`, ids);
  }

  const counts = {
    posts: posts.length,
    manuscripts: msIds.length,
    engagement_snapshots: engIds.length,
    follower_snapshots: folIds.length,
    revenue: revIds.length,
    platform_events: evtIds.length,
    daily_trends: trendIds.length,
  };

  kvSet(`media_account:${MAC}:import_meta`, {
    id: "imp_xiaogao_notion",
    ...meta({ created_at: stamp, updated_at: stamp }),
    source: "notion_fixture",
    fixture_dir: "fixtures/xiaogao",
    import_timestamp: fixtureMeta.import_timestamp || stamp,
    applied_at: stamp,
    counts,
    expected: fixtureMeta.counts || null,
    gaps: [
      "部分已发帖正文仅在平台且需登录，未自动抓；Notion 稿页已入库。",
      "链接为空的帖子行 platform URL 待补。",
      "Notion Query SQL 配额不足时用 view dump；createdTime 可能为空。",
    ],
  });

  if (!quiet) {
    console.log(`import:notion applied → ${getDataRoot()}`);
    console.log(
      `posts=${counts.posts} manuscripts=${counts.manuscripts} engagement=${counts.engagement_snapshots} followers=${counts.follower_snapshots} revenue=${counts.revenue} events=${counts.platform_events} daily_trends=${counts.daily_trends}`,
    );
  }
  return { counts, macId: MAC, ownerId: OWNER, import_timestamp: fixtureMeta.import_timestamp };
}

export { FIXTURE };

const entryUrl = typeof import.meta !== "undefined" ? import.meta.url : "";
if (
  entryUrl &&
  process.argv[1] &&
  (() => {
    try {
      return path.resolve(process.argv[1]) === fileURLToPath(entryUrl);
    } catch {
      return false;
    }
  })()
) {
  importXiaogaoFixture();
}
