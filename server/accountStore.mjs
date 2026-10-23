import { kvGet, readBlob } from "./kv.mjs";
import { RULE_CATALOG } from "./ruleCatalog.mjs";

function loadList(ids, keyFn) {
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => kvGet(keyFn(id))).filter(Boolean);
}

export function getFocusedAccountId(ownerUserId) {
  const focus = kvGet(`owner:${ownerUserId}:focus`);
  return focus?.current_media_account_id ?? null;
}

export function loadMediaAccountBundle(mediaAccountId) {
  const account = kvGet(`media_account:${mediaAccountId}`);
  if (!account || account.deleted_at) return null;

  const profile = kvGet(`media_account:${mediaAccountId}:profile`);
  const rules = kvGet(`media_account:${mediaAccountId}:rules`);
  const postIds = kvGet(`media_account:${mediaAccountId}:posts`) || [];
  const posts = loadList(postIds, (id) => `media_account:${mediaAccountId}:post:${id}`);
  const msIds = kvGet(`media_account:${mediaAccountId}:manuscripts`) || [];
  const manuscripts = loadList(
    msIds,
    (id) => `media_account:${mediaAccountId}:manuscript:${id}`,
  );
  const engIds = kvGet(`media_account:${mediaAccountId}:engagement_snapshots`) || [];
  const engagement_snapshots = loadList(
    engIds,
    (id) => `media_account:${mediaAccountId}:engagement_snapshot:${id}`,
  );
  const folIds = kvGet(`media_account:${mediaAccountId}:follower_snapshots`) || [];
  const follower_snapshots = loadList(
    folIds,
    (id) => `media_account:${mediaAccountId}:follower_snapshot:${id}`,
  );
  const revIds = kvGet(`media_account:${mediaAccountId}:revenue`) || [];
  const revenue = loadList(
    revIds,
    (id) => `media_account:${mediaAccountId}:revenue:${id}`,
  );
  const evtIds = kvGet(`media_account:${mediaAccountId}:platform_events`) || [];
  const platform_events = loadList(
    evtIds,
    (id) => `media_account:${mediaAccountId}:platform_event:${id}`,
  );
  const trendIds = kvGet(`media_account:${mediaAccountId}:daily_trends`) || [];
  const daily_trends = loadList(
    trendIds,
    (id) => `media_account:${mediaAccountId}:daily_trend:${id}`,
  );

  const published = posts.filter((p) => p.status === "已发布" || p.status === "被隐藏");
  const board = deriveBoard({
    account,
    profile,
    rules,
    posts,
    manuscripts,
    engagement_snapshots,
    follower_snapshots,
    revenue,
    platform_events,
  });

  return {
    account,
    profile,
    rules,
    rule_catalog: RULE_CATALOG,
    posts,
    manuscripts,
    published_works: published,
    engagement_snapshots,
    daily_trends,
    follower_snapshots,
    revenue,
    platform_events,
    board,
    authority: {
      trend_source: "engagement_snapshots (append-only)",
      post_metrics: "current mirror only — not trend SoT",
      manuscript: "writing draft ≠ published edition; use post.url / published_edition_ref / platform SSR",
      empty_manuscript_ok: true,
    },
  };
}

export function deriveBoard(ctx) {
  const {
    account,
    profile,
    rules,
    posts,
    manuscripts,
    engagement_snapshots,
    follower_snapshots,
    revenue,
    platform_events,
  } = ctx;

  const funnel = {};
  for (const p of posts) {
    funnel[p.status] = (funnel[p.status] || 0) + 1;
  }

  const kpiRevenue = revenue
    .filter((r) => r.revenue_type === "reward" || r.revenue_type === "task")
    .reduce((s, r) => s + (Number(r.amount) || 0), 0);

  const pendingReview = posts.filter((p) => p.status === "待确认");
  const latestFollowers = [...follower_snapshots].sort((a, b) =>
    String(b.record_date).localeCompare(String(a.record_date)),
  )[0];

  const recentPublished = posts
    .filter((p) => p.status === "已发布")
    .sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")))
    .slice(0, 5)
    .map((p) => ({
      id: p.id,
      title: p.title,
      url: p.url,
      metrics_views: p.metrics_views,
      metrics_likes: p.metrics_likes,
      metrics_favorites: p.metrics_favorites,
      metrics_updated_at: p.metrics_updated_at,
      note: "镜像指标，非趋势源",
    }));

  const enabledRules = (rules?.enabled_rule_ids || []).map((id) => {
    const cat = RULE_CATALOG.find((r) => r.rule_id === id);
    return { rule_id: id, label: cat?.label || id };
  });

  return {
    header: {
      display_name: account.display_name,
      platform: account.platform,
      status: account.status,
      stage: account.stage,
      biz_line_tag: account.biz_line_tag,
    },
    positioning: profile
      ? {
          what_it_is: profile.what_it_is,
          goal: profile.goal,
          redlines_summary: profile.redlines_summary,
        }
      : null,
    rules_enabled: enabledRules,
    publish_window:
      rules?.publish_window_start && rules?.publish_window_end
        ? `${rules.publish_window_start}–${rules.publish_window_end}`
        : null,
    post_funnel: funnel,
    pending_final_review: pendingReview.map((p) => ({
      id: p.id,
      title: p.title,
      manuscript_id: p.manuscript_id,
    })),
    writing: posts
      .filter((p) => p.status === "写稿中" || p.status === "待确认")
      .map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        manuscript_id: p.manuscript_id,
        note: "帖状态机派生",
      })),
    recent_published_mirror: recentPublished,
    trend_hint: {
      snapshot_count: engagement_snapshots.length,
      latest_dates: [
        ...new Set(engagement_snapshots.map((e) => e.snapshot_date)),
      ]
        .sort()
        .slice(-5),
      authority: "互动快照 append-only",
    },
    followers_latest: latestFollowers
      ? {
          record_date: latestFollowers.record_date,
          followers: latestFollowers.followers,
          post_count: latestFollowers.post_count,
          likes_and_favorites: latestFollowers.likes_and_favorites,
        }
      : null,
    revenue_kpi_cny: Math.round(kpiRevenue * 100) / 100,
    revenue_kpi_note: "仅计 reward + task；不含 balance / screenshot_proof",
    recent_events: platform_events.slice(0, 5).map((e) => ({
      id: e.id,
      name: e.name,
      event_type: e.event_type,
      occurred_at: e.occurred_at,
      related_title: e.related_title,
    })),
  };
}

export function getManuscriptBody(mediaAccountId, manuscriptId) {
  const ms = kvGet(`media_account:${mediaAccountId}:manuscript:${manuscriptId}`);
  if (!ms) return null;
  return {
    manuscript: ms,
    body: ms.body_ref ? readBlob(ms.body_ref) : null,
    published_edition: ms.published_edition_ref
      ? readBlob(ms.published_edition_ref)
      : null,
  };
}
