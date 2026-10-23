export type PostStatus =
  | "选题"
  | "写稿中"
  | "待确认"
  | "已发布"
  | "被隐藏"
  | "搁置";

export interface MediaAccount {
  id: string;
  display_name: string;
  platform: string;
  status: string;
  stage: string;
  biz_line_tag: string;
  profile_url?: string | null;
  content_timezone: string;
  credential_ref?: string | null;
  platform_fetch_template?: string | null;
}

export interface AccountProfile {
  what_it_is: string;
  goal: string;
  redlines_summary: string;
  tone_notes?: string | null;
}

export interface Post {
  id: string;
  title: string;
  status: PostStatus;
  content_type: string;
  form: string;
  planned_publish_at?: string | null;
  published_at?: string | null;
  url?: string | null;
  platform_post_id?: string | null;
  manuscript_id?: string | null;
  metrics_views?: number | null;
  metrics_likes?: number | null;
  metrics_comments?: number | null;
  metrics_favorites?: number | null;
  metrics_shares?: number | null;
  metrics_updated_at?: string | null;
  remark?: string | null;
}

export interface Manuscript {
  id: string;
  title: string;
  post_id?: string | null;
  status: string;
  archive_bucket: string;
  final_review_passed: boolean;
  body_ref?: string | null;
  published_edition_ref?: string | null;
}

export interface EngagementSnapshot {
  id: string;
  snapshot_date: string;
  title: string;
  form: string;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  favorites?: number | null;
  shares?: number | null;
  post_url?: string | null;
  post_id?: string | null;
}

export interface FollowerSnapshot {
  id: string;
  record_date: string;
  followers?: number | null;
  post_count?: number | null;
  likes_and_favorites?: number | null;
  source?: string | null;
  record_title?: string | null;
}

export interface RevenueRow {
  id: string;
  record_title: string;
  amount: number;
  currency: string;
  occurred_at: string;
  fetched_on?: string | null;
  source_title?: string | null;
  revenue_type: string;
}

export interface PlatformEvent {
  id: string;
  name: string;
  event_type: string;
  occurred_at: string;
  registered_on?: string | null;
  related_title?: string | null;
  remark?: string | null;
}

export interface WorkspaceBundle {
  account: MediaAccount;
  profile: AccountProfile | null;
  rules: {
    enabled_rule_ids: string[];
    publish_window_start?: string | null;
    publish_window_end?: string | null;
  } | null;
  rule_catalog: { rule_id: string; label: string }[];
  posts: Post[];
  manuscripts: Manuscript[];
  published_works: Post[];
  engagement_snapshots: EngagementSnapshot[];
  daily_trends: unknown[];
  follower_snapshots: FollowerSnapshot[];
  revenue: RevenueRow[];
  platform_events: PlatformEvent[];
  board: {
    header: Record<string, string>;
    positioning: AccountProfile | null;
    rules_enabled: { rule_id: string; label: string }[];
    publish_window: string | null;
    post_funnel: Record<string, number>;
    pending_final_review: { id: string; title: string }[];
    writing: { id: string; title: string; status: string }[];
    recent_published_mirror: {
      id: string;
      title: string;
      url?: string | null;
      metrics_views?: number | null;
      metrics_likes?: number | null;
      note: string;
    }[];
    trend_hint: {
      snapshot_count: number;
      latest_dates: string[];
      authority: string;
    };
    followers_latest: {
      record_date: string;
      followers?: number | null;
      post_count?: number | null;
      likes_and_favorites?: number | null;
    } | null;
    revenue_kpi_cny: number;
    revenue_kpi_note: string;
    recent_events: {
      id: string;
      name: string;
      event_type: string;
      occurred_at: string;
      related_title?: string | null;
    }[];
  };
  authority: Record<string, string | boolean>;
}

export type TabId =
  | "board"
  | "posts"
  | "manuscripts"
  | "published"
  | "engagement"
  | "followers"
  | "revenue"
  | "events";
