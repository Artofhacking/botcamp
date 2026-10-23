import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createMediaAccount,
  fetchDemoUsers,
  fetchManuscript,
  fetchMediaAccounts,
  fetchWorkspace,
  focusMediaAccount,
  loginEmail,
  loginMedia,
  logout,
  noteMediaEntity,
  updateMediaEntity,
  restoreSession,
  type AuthUser,
  type DemoUser,
  type MediaAccountRow,
} from "./api";
import {
  applyTheme,
  cycleTheme,
  getStoredTheme,
  themeLabel,
  type ThemeMode,
} from "./theme";
import type {
  Manuscript,
  PlatformEvent,
  Post,
  PostStatus,
  TabId,
  WorkspaceBundle,
} from "./types";
import "./index.css";

const SECTIONS: { id: TabId; label: string }[] = [
  { id: "board", label: "看板" },
  { id: "posts", label: "帖子·选题" },
  { id: "manuscripts", label: "历史稿件" },
  { id: "published", label: "已发作品" },
  { id: "engagement", label: "互动快照" },
  { id: "followers", label: "粉丝" },
  { id: "revenue", label: "收益" },
  { id: "events", label: "事件" },
];

const FUNNEL_ORDER: PostStatus[] = [
  "选题",
  "写稿中",
  "待确认",
  "已发布",
  "被隐藏",
  "搁置",
];

type MainMode = "chat" | "needs" | TabId;
type Anchor = { kind: string; id: string; title: string; tab?: TabId };

type QuestionCard = {
  id: string;
  title: string;
  options: string[];
  answered?: string;
};

type GateCard = {
  id: string;
  kind: "confirm" | "review";
  title: string;
  summary: string;
  checklist?: string[];
  resolved?: boolean;
};

type ChatMsg = {
  role: "editor" | "you" | "system";
  text: string;
  question?: QuestionCard;
  gate?: GateCard;
  milestones?: string[];
};

type NeedsItem = {
  id: string;
  kind: "pending" | "review" | "event";
  title: string;
  meta: string;
  anchor: Anchor;
};

function fmt(n: number | null | undefined) {
  if (n == null) return "—";
  return n.toLocaleString("zh-CN");
}

function platformLabel(p: string) {
  return p === "xiaoheihe" ? "小黑盒" : p;
}

function buildNeeds(data: WorkspaceBundle): NeedsItem[] {
  const items: NeedsItem[] = [];
  const pendingIds = new Set(
    (data.board.pending_final_review || []).map((p) => p.id),
  );

  for (const p of data.posts) {
    if (p.status === "待确认" || pendingIds.has(p.id)) {
      items.push({
        id: `need-post-${p.id}`,
        kind: "pending",
        title: p.title,
        meta: "待确认 · 选题/发布闸门",
        anchor: { kind: "帖子", id: p.id, title: p.title, tab: "posts" },
      });
    }
  }

  for (const m of data.manuscripts) {
    if (!m.final_review_passed && m.status !== "归档废弃") {
      items.push({
        id: `need-ms-${m.id}`,
        kind: "review",
        title: m.title,
        meta: "终审未过 · Review 闸门",
        anchor: {
          kind: "稿件",
          id: m.id,
          title: m.title,
          tab: "manuscripts",
        },
      });
    }
  }

  for (const e of data.platform_events) {
    const t = `${e.event_type} ${e.name} ${e.remark || ""}`;
    const failed =
      /未通过|拒绝|隐藏|下架|违规|失败/.test(t) ||
      (/审核/.test(t) && !/通过|成功/.test(t));
    if (failed) {
      items.push({
        id: `need-ev-${e.id}`,
        kind: "event",
        title: e.name,
        meta: `${e.event_type} · ${e.occurred_at}`,
        anchor: { kind: "事件", id: e.id, title: e.name, tab: "events" },
      });
    }
  }

  const seen = new Set<string>();
  return items.filter((it) => {
    const key = `${it.kind}:${it.anchor.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildBrief(data: WorkspaceBundle, needsCount: number) {
  const goal =
    data.profile?.goal ||
    data.board.positioning?.goal ||
    "本周把写稿中的帖推进到可发";
  const writing = data.board.writing?.[0];
  const pending = data.board.pending_final_review?.[0];
  const now = writing
    ? `写稿中 · 《${writing.title}》`
    : pending
      ? `待确认 · 《${pending.title}》`
      : data.board.recent_published_mirror?.[0]
        ? `最近已发 · 《${data.board.recent_published_mirror[0].title}》`
        : "暂无进行中帖";
  const waiting =
    needsCount > 0
      ? `${needsCount} 项等你（待确认 / 终审 / 审核事件）`
      : "暂无卡点";
  return { goal, now, waiting };
}

function defaultQuestionFor(a: Anchor | null, data: WorkspaceBundle | null): QuestionCard | null {
  if (a?.kind === "帖子" || a?.title.includes("D2R")) {
    return {
      id: `q-${a.id}`,
      title: "下一步怎么走？",
      options: ["先过终审清单", "先改标题口吻", "先对互动快照"],
    };
  }
  if (a?.kind === "稿件") {
    return {
      id: `q-${a.id}`,
      title: "终审闸门",
      options: ["对照红线过审", "先改正文", "搁置这篇"],
    };
  }
  const writing = data?.board.writing?.[0];
  if (writing) {
    return {
      id: `q-open-${writing.id}`,
      title: "看板焦点",
      options: [`推进《${writing.title}》`, "打开 Needs you", "说本周目标"],
    };
  }
  return {
    id: "q-open",
    title: "从哪开始？",
    options: ["看 Needs you", "打开看板漏斗", "起新选题"],
  };
}

function gateForAnchor(
  a: Anchor | null,
  data: WorkspaceBundle | null,
): GateCard | null {
  if (!a || !data) return null;
  if (a.kind === "稿件") {
    const m = data.manuscripts.find((x) => x.id === a.id);
    if (m && !m.final_review_passed) {
      return {
        id: `gate-review-${m.id}`,
        kind: "review",
        title: "发布前终审 · Review",
        summary: `《${m.title}》终审未过。勾选规矩后再放行。`,
        checklist: (data.board.rules_enabled || [])
          .slice(0, 4)
          .map((r) => r.label)
          .concat(
            data.board.publish_window
              ? [`发布窗 ${data.board.publish_window}`]
              : ["发布窗 20–21 点"],
          ),
      };
    }
  }
  if (a.kind === "帖子") {
    const p = data.posts.find((x) => x.id === a.id);
    if (p?.status === "待确认" || p?.status === "选题") {
      return {
        id: `gate-confirm-${p.id}`,
        kind: "confirm",
        title: "选题确认 · Confirm",
        summary: `确认《${p.title}》立项规格：类型 ${p.content_type || "—"} · 形态 ${p.form || "—"}。`,
        checklist: ["标题口吻符合人设", "无外链/红线风险", "时段可排进发布窗"],
      };
    }
    if (p?.status === "写稿中") {
      const linked = data.manuscripts.find(
        (m) => m.post_id === p.id || m.id === p.manuscript_id,
      );
      if (linked && !linked.final_review_passed) {
        return {
          id: `gate-review-post-${p.id}`,
          kind: "review",
          title: "发布前终审 · Review",
          summary: `《${p.title}》写稿中，关联稿终审未过。`,
          checklist: (data.board.rules_enabled || [])
            .slice(0, 4)
            .map((r) => r.label),
        };
      }
    }
  }
  return null;
}

function milestonesForGoal(text: string): string[] | null {
  if (!/本周|这周|发出|目标|搞定|推进/.test(text)) return null;
  return [
    "补齐选题 Spec（Confirm）",
    "过红线终审清单（Review）",
    "排进 20–21 点发布窗",
    "发布后建互动快照提醒",
  ];
}

function LoginScreen({
  demos,
  onEmail,
  onDemo,
  error,
  themeMode,
  onCycleTheme,
}: {
  demos: DemoUser[];
  onEmail: (email: string, password: string) => Promise<void>;
  onDemo: (username: string) => Promise<void>;
  error: string | null;
  themeMode: ThemeMode;
  onCycleTheme: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">BotCamp</div>
        <h1>登录</h1>
        <p>邮箱密码进入工作台。主编对话读写当前自媒体账号。</p>
        {error ? <p className="auth-error">{error}</p> : null}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await onEmail(email.trim(), password);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            邮箱
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label>
            密码
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "登录中…" : "登录"}
          </button>
        </form>
        <div className="auth-demos">
          <div className="hint">演示账号（隔离验证）</div>
          {demos.map((u) => (
            <button
              key={u.username}
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onDemo(u.username);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {u.display_name} · @{u.username}
            </button>
          ))}
        </div>
        <p style={{ marginTop: 16 }}>
          <button type="button" className="rail-quiet" onClick={onCycleTheme}>
            主题 · {themeLabel(themeMode)}
          </button>
        </p>
      </div>
    </div>
  );
}

function EntityRow({
  title,
  meta,
  active,
  onClick,
  onCite,
}: {
  title: string;
  meta: string;
  active?: boolean;
  onClick: () => void;
  onCite?: () => void;
}) {
  return (
    <div className={`entity-row${active ? " active" : ""}`}>
      <button type="button" className="entity" onClick={onClick}>
        <div className="entity-title">{title}</div>
        <div className="entity-meta">{meta}</div>
      </button>
      {onCite ? (
        <button type="button" className="link" onClick={onCite}>
          引用
        </button>
      ) : null}
    </div>
  );
}

function BriefBar({
  goal,
  now,
  waiting,
}: {
  goal: string;
  now: string;
  waiting: string;
}) {
  return (
    <div className="brief-bar" aria-label="账号简报">
      <div className="brief-row">
        <span className="brief-k">Goal</span>
        <span className="brief-v">{goal}</span>
      </div>
      <div className="brief-row">
        <span className="brief-k">Now</span>
        <span className="brief-v">{now}</span>
      </div>
      <div className="brief-row">
        <span className="brief-k">等你</span>
        <span className="brief-v">{waiting}</span>
      </div>
    </div>
  );
}

function FunnelBoard({
  data,
  anchor,
  onAnchor,
  onCite,
}: {
  data: WorkspaceBundle;
  anchor: Anchor | null;
  onAnchor: (a: Anchor) => void;
  onCite: (a: Anchor) => void;
}) {
  const byStatus = useMemo(() => {
    const map = new Map<PostStatus, Post[]>();
    for (const s of FUNNEL_ORDER) map.set(s, []);
    for (const p of data.posts) {
      const list = map.get(p.status) || [];
      list.push(p);
      map.set(p.status, list);
    }
    return map;
  }, [data.posts]);

  return (
    <div className="sot">
      <div className="sot-meta">
        {data.account.display_name} · {platformLabel(data.account.platform)} ·{" "}
        {data.account.status}
      </div>
      <div className="sot-meta">
        {data.board.positioning?.what_it_is || data.profile?.what_it_is || "—"} ·
        粉丝 {fmt(data.board.followers_latest?.followers)} · KPI ¥
        {data.board.revenue_kpi_cny}
      </div>
      <div className="sot-label">帖状态漏斗（派生自 SoT，非第二套列）</div>
      <div className="funnel">
        {FUNNEL_ORDER.map((status) => {
          const rows = byStatus.get(status) || [];
          const count = data.board.post_funnel?.[status] ?? rows.length;
          return (
            <div key={status} className="funnel-col">
              <div className="funnel-head">
                <span>{status}</span>
                <span>{count}</span>
              </div>
              {rows.length === 0 ? (
                <div className="funnel-empty">空</div>
              ) : (
                rows.slice(0, 6).map((p) => (
                  <EntityRow
                    key={p.id}
                    title={p.title}
                    meta={p.content_type || ""}
                    active={anchor?.id === p.id}
                    onClick={() =>
                      onAnchor({
                        kind: "帖子",
                        id: p.id,
                        title: p.title,
                        tab: "posts",
                      })
                    }
                    onCite={() =>
                      onCite({
                        kind: "帖子",
                        id: p.id,
                        title: p.title,
                        tab: "posts",
                      })
                    }
                  />
                ))
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NeedsInbox({
  items,
  onOpen,
  onAct,
  busy,
}: {
  items: NeedsItem[];
  onOpen: (item: NeedsItem) => void;
  onAct: (item: NeedsItem, action: "pass_review" | "confirm_topic" | "hold") => void;
  busy: boolean;
}) {
  if (items.length === 0) {
    return (
      <div className="sot">
        <div className="sot-label">Needs you</div>
        <div className="empty-state">此刻没有等你拍板的项。</div>
      </div>
    );
  }
  return (
    <div className="sot">
      <div className="sot-label">Needs you · {items.length}</div>
      <div className="sot-meta">聚合：待确认帖 · 终审未过 · 失败审核事件</div>
      {items.map((it) => (
        <div key={it.id} className="needs-row">
          <EntityRow
            title={it.title}
            meta={it.meta}
            onClick={() => onOpen(it)}
          />
          <div className="gate">
            {it.kind === "pending" ? (
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => onAct(it, "confirm_topic")}
              >
                确认选题
              </button>
            ) : null}
            {it.kind === "review" ? (
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => onAct(it, "pass_review")}
              >
                终审通过
              </button>
            ) : null}
            {it.kind !== "event" ? (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => onAct(it, "hold")}
              >
                搁置
              </button>
            ) : null}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => onOpen(it)}
            >
              打开对话
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function SoTView({
  section,
  data,
  anchor,
  onAnchor,
  onCite,
  onOpenManuscript,
  preview,
}: {
  section: TabId;
  data: WorkspaceBundle;
  anchor: Anchor | null;
  onAnchor: (a: Anchor) => void;
  onCite: (a: Anchor) => void;
  onOpenManuscript: (id: string) => void;
  preview: { id: string; title: string; body: string | null } | null;
}) {
  if (section === "board") {
    return (
      <FunnelBoard
        data={data}
        anchor={anchor}
        onAnchor={onAnchor}
        onCite={onCite}
      />
    );
  }

  if (section === "posts") {
    if (data.posts.length === 0) {
      return (
        <div className="sot">
          <div className="sot-label">帖子 / 选题</div>
          <div className="empty-state">还没有帖子行。在对话里让主编起选题。</div>
        </div>
      );
    }
    return (
      <div className="sot">
        <div className="sot-label">帖子 / 选题 · {data.posts.length}</div>
        {data.posts.map((p) => {
          const a: Anchor = {
            kind: "帖子",
            id: p.id,
            title: p.title,
            tab: "posts",
          };
          return (
            <EntityRow
              key={p.id}
              title={p.title}
              meta={`${p.status} · ${p.content_type || ""} · 浏览 ${fmt(p.metrics_views)}${
                p.remark ? ` · ${p.remark.split("\n").slice(-1)[0]}` : ""
              }`}
              active={anchor?.id === p.id}
              onClick={() => onAnchor(a)}
              onCite={() => onCite(a)}
            />
          );
        })}
      </div>
    );
  }

  if (section === "manuscripts") {
    return (
      <div className="sot">
        <div className="sot-label">
          历史稿件 · {data.manuscripts.length} · 写作稿 ≠ 发布版
        </div>
        {data.manuscripts.length === 0 ? (
          <div className="empty-state">尚无稿页。</div>
        ) : null}
        {data.manuscripts.map((m: Manuscript) => {
          const a: Anchor = {
            kind: "稿件",
            id: m.id,
            title: m.title,
            tab: "manuscripts",
          };
          return (
            <div key={m.id}>
              <EntityRow
                title={m.title}
                meta={`${m.status} · 终审 ${m.final_review_passed ? "通过" : "未过"}`}
                active={anchor?.id === m.id}
                onClick={() => onAnchor(a)}
                onCite={() => onCite(a)}
              />
              <button
                type="button"
                className="rail-quiet"
                style={{ margin: "0 0 8px 4px" }}
                onClick={() => onOpenManuscript(m.id)}
              >
                看正文
              </button>
            </div>
          );
        })}
        {preview ? (
          <pre className="preview">{preview.body || "（无写作稿）"}</pre>
        ) : null}
      </div>
    );
  }

  if (section === "published") {
    return (
      <div className="sot">
        <div className="sot-label">已发作品 · 当前镜像</div>
        {data.published_works.map((p) => {
          const a: Anchor = {
            kind: "帖子",
            id: p.id,
            title: p.title,
            tab: "published",
          };
          return (
            <EntityRow
              key={p.id}
              title={p.title}
              meta={`浏览 ${fmt(p.metrics_views)} · 赞 ${fmt(p.metrics_likes)}`}
              active={anchor?.id === p.id}
              onClick={() => onAnchor(a)}
              onCite={() => onCite(a)}
            />
          );
        })}
      </div>
    );
  }

  if (section === "engagement") {
    const rows = [...data.engagement_snapshots].sort((a, b) =>
      `${b.snapshot_date}`.localeCompare(`${a.snapshot_date}`),
    );
    return (
      <div className="sot">
        <div className="sot-label">
          互动快照（趋势 SoT）· {rows.length}
        </div>
        {rows.length === 0 ? (
          <div className="empty-state">尚无快照行。</div>
        ) : null}
        {rows.map((e) => {
          const a: Anchor = {
            kind: "快照",
            id: e.id,
            title: e.title,
            tab: "engagement",
          };
          return (
            <EntityRow
              key={e.id}
              title={e.title}
              meta={`${e.snapshot_date} · 浏览 ${fmt(e.views)} · 赞 ${fmt(e.likes)}`}
              active={anchor?.id === e.id}
              onClick={() => onAnchor(a)}
              onCite={() => onCite(a)}
            />
          );
        })}
      </div>
    );
  }

  if (section === "followers") {
    const rows = [...data.follower_snapshots].sort((a, b) =>
      b.record_date.localeCompare(a.record_date),
    );
    return (
      <div className="sot">
        <div className="sot-label">粉丝</div>
        {rows.map((f) => (
          <div key={f.id} className="entity" style={{ cursor: "default" }}>
            <div className="entity-title">{f.record_date}</div>
            <div className="entity-meta">
              粉丝 {fmt(f.followers)}
              {f.post_count != null ? ` · 帖 ${fmt(f.post_count)}` : ""}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (section === "revenue") {
    return (
      <div className="sot">
        <div className="sot-label">收益 · KPI ¥{data.board.revenue_kpi_cny}</div>
        {data.revenue.map((r) => (
          <div key={r.id} className="entity" style={{ cursor: "default" }}>
            <div className="entity-title">{r.record_title}</div>
            <div className="entity-meta">
              {r.amount} {r.currency} · {r.revenue_type}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="sot">
      <div className="sot-label">平台事件 · {data.platform_events.length}</div>
      {data.platform_events.length === 0 ? (
        <div className="empty-state">尚无平台事件。</div>
      ) : null}
      {data.platform_events.map((e: PlatformEvent) => {
        const a: Anchor = {
          kind: "事件",
          id: e.id,
          title: e.name,
          tab: "events",
        };
        return (
          <EntityRow
            key={e.id}
            title={e.name}
            meta={`${e.event_type} · ${e.occurred_at}`}
            active={anchor?.id === e.id}
            onClick={() => onAnchor(a)}
            onCite={() => onCite(a)}
          />
        );
      })}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [demos, setDemos] = useState<DemoUser[]>([]);
  const [data, setData] = useState<WorkspaceBundle | null>(null);
  const [accounts, setAccounts] = useState<MediaAccountRow[]>([]);
  const [authError, setAuthError] = useState<string | null>(null);
  const [boot, setBoot] = useState(true);
  const [mode, setMode] = useState<MainMode>("chat");
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredTheme());
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState<{
    id: string;
    title: string;
    body: string | null;
  } | null>(null);

  const needs = useMemo(() => (data ? buildNeeds(data) : []), [data]);
  const brief = useMemo(
    () => (data ? buildBrief(data, needs.length) : null),
    [data, needs.length],
  );

  const loadWorkspace = useCallback(async () => {
    const ws = await fetchWorkspace();
    setData(ws);
    try {
      const acc = await fetchMediaAccounts();
      setAccounts(acc.accounts || []);
    } catch {
      setAccounts([]);
    }
    return ws;
  }, []);

  useEffect(() => {
    applyTheme(themeMode);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (getStoredTheme() === "system") applyTheme("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [themeMode]);

  function openerMessage(ws: WorkspaceBundle | null, a: Anchor | null): ChatMsg {
    const q = defaultQuestionFor(a, ws);
    const gate = gateForAnchor(a, ws);
    let text: string;
    if (a?.id === "pst_d2r_mobile" || a?.title.includes("D2R")) {
      text =
        "这篇《D2R Mobile》还在写稿中、终审未过。按规矩：正文不放外链、配图 16:9、晚上 20–21 点发。";
    } else if (a) {
      text = `已锚定「${a.title}」。改状态、补备注，还是走闸门？`;
    } else {
      const writing = ws?.board.writing?.[0];
      text = writing
        ? `看板里写稿中还有《${writing.title}》。可以说本周目标，我会拆成里程碑；或先处理 Needs you。`
        : `当前号「${ws?.account.display_name || "—"}」。从侧栏打开看板漏斗，或直接告诉我下一步。`;
    }
    return { role: "editor", text, question: q || undefined, gate: gate || undefined };
  }

  useEffect(() => {
    (async () => {
      try {
        setDemos(await fetchDemoUsers());
      } catch {
        setDemos([]);
      }
      try {
        const me = await restoreSession();
        if (me) {
          setUser(me);
          const ws = await loadWorkspace();
          setMessages([openerMessage(ws, null)]);
        }
      } catch (e) {
        setAuthError((e as Error).message);
      } finally {
        setBoot(false);
      }
    })();
  }, [loadWorkspace]);

  async function afterLogin(next: AuthUser) {
    setUser(next);
    setAuthError(null);
    setAnchor(null);
    setMode("chat");
    setDrawer(false);
    const ws = await loadWorkspace();
    setMessages([openerMessage(ws, null)]);
  }

  const onCycleTheme = () => {
    const next = cycleTheme(themeMode);
    setThemeMode(next);
    applyTheme(next);
  };

  const citeEntity = (a: Anchor, openChat = true) => {
    setAnchor(a);
    if (openChat) {
      setMode("chat");
      setDrawer(false);
    }
  };

  const onAnchor = (a: Anchor) => {
    setAnchor(a);
    setMode("chat");
    setDrawer(false);
    setMessages((prev) => [...prev, openerMessage(data, a)]);
  };

  const answerQuestion = async (msgIndex: number, option: string) => {
    if (!data || sending) return;
    setSending(true);
    setMessages((prev) => {
      const next = [...prev];
      const m = next[msgIndex];
      if (m?.question) {
        next[msgIndex] = {
          ...m,
          question: { ...m.question, answered: option },
        };
      }
      return [
        ...next,
        { role: "you", text: option },
      ];
    });

    if (option.includes("Needs you") || option === "打开 Needs you") {
      setMode("needs");
      setMessages((m) => [
        ...m,
        {
          role: "editor",
          text: `Needs you 里有 ${needs.length} 项。点开一条即可锚定并走闸门。`,
        },
      ]);
      setSending(false);
      return;
    }
    if (option.includes("看板")) {
      setMode("board");
      setSending(false);
      return;
    }

    try {
      // Meaningful options → real status mutations when anchored
      if (anchor && /终审|过审|过红线/.test(option)) {
        const kind = anchor.kind === "稿件" ? "manuscript" : "post";
        const res = await updateMediaEntity({
          accountId: data.account.id,
          kind,
          entityId: anchor.id,
          action: "pass_review",
          note: option,
        });
        setData(res.workspace);
      } else if (anchor?.kind === "帖子" && /确认选题|立项/.test(option)) {
        const res = await updateMediaEntity({
          accountId: data.account.id,
          kind: "post",
          entityId: anchor.id,
          action: "confirm_topic",
          note: option,
        });
        setData(res.workspace);
      } else if (anchor && /搁置/.test(option)) {
        const kind = anchor.kind === "稿件" ? "manuscript" : "post";
        const res = await updateMediaEntity({
          accountId: data.account.id,
          kind,
          entityId: anchor.id,
          action: "hold",
          note: option,
        });
        setData(res.workspace);
      } else {
        const res = await noteMediaEntity({
          accountId: data.account.id,
          kind: anchor?.kind === "帖子" ? "post" : "event",
          entityId: anchor?.kind === "帖子" ? anchor.id : undefined,
          title: anchor?.title || null,
          text: `[选项] ${option}`,
        });
        if (res.workspace) setData(res.workspace);
        else await loadWorkspace();
      }
      const milestones = milestonesForGoal(option);
      const ws = data;
      setMessages((m) => [
        ...m,
        { role: "system", text: "已写入 SoT 并刷新工作台。" },
        {
          role: "editor",
          text: milestones
            ? "收到目标。先按这四步拆开推进："
            : "已落库。还要改状态，还是继续下一问？",
          milestones: milestones || undefined,
          question: milestones
            ? {
                id: `q-ms-${Date.now()}`,
                title: "先做哪一步？",
                options: milestones.slice(0, 3),
              }
            : defaultQuestionFor(anchor, ws) || undefined,
          gate: gateForAnchor(anchor, ws) || undefined,
        },
      ]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: "system", text: `写回失败：${(e as Error).message}` },
      ]);
    } finally {
      setSending(false);
    }
  };

  const resolveGate = async (msgIndex: number, action: "pass" | "hold") => {
    if (!data || sending) return;
    const gate = messages[msgIndex]?.gate;
    setSending(true);
    const label =
      action === "hold"
        ? "先搁置闸门"
        : gate?.kind === "review"
          ? "终审通过"
          : "确认选题";
    setMessages((prev) => {
      const next = [...prev];
      const m = next[msgIndex];
      if (m?.gate) {
        next[msgIndex] = { ...m, gate: { ...m.gate, resolved: true } };
      }
      return [...next, { role: "you", text: label }];
    });
    try {
      const kind =
        anchor?.kind === "稿件" ? "manuscript" : ("post" as const);
      const entityId = anchor?.id;
      if (!entityId) throw new Error("没有锚定实体，无法改状态。");
      let apiAction: "confirm_topic" | "pass_review" | "hold" = "hold";
      if (action === "hold") apiAction = "hold";
      else if (gate?.kind === "review") apiAction = "pass_review";
      else apiAction = "confirm_topic";
      const res = await updateMediaEntity({
        accountId: data.account.id,
        kind,
        entityId,
        action: apiAction,
        note: label,
      });
      setData(res.workspace);
      try {
        const acc = await fetchMediaAccounts();
        setAccounts(acc.accounts || []);
      } catch {
        /* ignore */
      }
      const post = res.workspace.posts.find((p) => p.id === entityId);
      const statusLine = post
        ? `帖状态现为「${post.status}」。`
        : "SoT 已刷新。";
      setMessages((m) => [
        ...m,
        { role: "system", text: `闸门已写入状态机。${statusLine}` },
        {
          role: "editor",
          text:
            action === "pass"
              ? "闸门已落地。下一步排发布窗，还是对照互动快照？"
              : "已搁置。需要时从 Needs you 再打开。",
          question: {
            id: `q-after-gate-${Date.now()}`,
            title: "接着？",
            options: ["打开 Needs you", "打开看板漏斗", "继续聊"],
          },
        },
      ]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: "system", text: `闸门失败：${(e as Error).message}` },
      ]);
    } finally {
      setSending(false);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || !data || sending) return;
    setSending(true);
    setDraft("");
    setMessages((m) => [...m, { role: "you", text }]);
    try {
      const res = await noteMediaEntity({
        accountId: data.account.id,
        kind: anchor?.kind === "帖子" ? "post" : "event",
        entityId: anchor?.kind === "帖子" ? anchor.id : undefined,
        title: anchor?.title || null,
        text,
      });
      if (res.workspace) setData(res.workspace);
      else await loadWorkspace();
      const milestones = milestonesForGoal(text);
      const ws = res.workspace || data;
      setMessages((m) => [
        ...m,
        {
          role: "system",
          text: "已写入工作台（帖备注 / 事件）并刷新 SoT。",
        },
        {
          role: "editor",
          text: milestones
            ? "本周目标收到。按里程碑拆开："
            : "记下了。还要改这条的状态，还是切到下一题？",
          milestones: milestones || undefined,
          question: milestones
            ? {
                id: `q-goal-${Date.now()}`,
                title: "先推进哪一步？",
                options: milestones.slice(0, 3),
              }
            : defaultQuestionFor(anchor, ws) || undefined,
          gate: gateForAnchor(anchor, ws) || undefined,
        },
      ]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: "system", text: `写回失败：${(e as Error).message}` },
      ]);
    } finally {
      setSending(false);
    }
  };

  const openManuscript = async (id: string) => {
    if (!data) return;
    const res = await fetchManuscript(data.account.id, id);
    setPreview({ id, title: res.manuscript.title, body: res.body });
    setMode("manuscripts");
  };

  const accountLabel = useMemo(() => {
    if (!data) return "加载账号…";
    return `${data.account.display_name} · ${platformLabel(data.account.platform)}`;
  }, [data]);

  if (boot) return <div className="boot">启动中…</div>;

  if (!user) {
    return (
      <LoginScreen
        demos={demos}
        error={authError}
        themeMode={themeMode}
        onCycleTheme={onCycleTheme}
        onEmail={async (email, password) => {
          setAuthError(null);
          try {
            await afterLogin(await loginEmail(email, password));
          } catch (e) {
            setAuthError((e as Error).message);
          }
        }}
        onDemo={async (username) => {
          setAuthError(null);
          try {
            await afterLogin(await loginMedia(username));
          } catch (e) {
            setAuthError((e as Error).message);
          }
        }}
      />
    );
  }

  if (!data || !brief) return <div className="loading">加载工作台…</div>;

  const rail = (
    <div className="rail-wrap">
      <aside className="rail">
        <div className="rail-brand">BotCamp</div>
        <button
          type="button"
          className="rail-account"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span className="rail-account-label">{accountLabel}</span>
          <span className="rail-account-chevron">▾</span>
        </button>
        {menuOpen ? (
          <div className="rail-menu" role="menu">
            {accounts.map((a) => (
              <button
                key={a.id}
                type="button"
                role="menuitem"
                className={a.id === data.account.id ? "active" : undefined}
                onClick={async () => {
                  setMenuOpen(false);
                  const res = await focusMediaAccount(a.id);
                  setData(res.workspace);
                  setAnchor(null);
                  setMode("chat");
                  setMessages([openerMessage(res.workspace, null)]);
                }}
              >
                {a.display_name} · {platformLabel(a.platform)}
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              onClick={async () => {
                setMenuOpen(false);
                const res = await createMediaAccount();
                setData(res.workspace);
                setAnchor(null);
                setMode("chat");
                await loadWorkspace();
                setMessages([
                  {
                    role: "editor",
                    text: "新号已创建。我们一次一问完成起号：这个号主要发什么？",
                    question: {
                      id: "q-new-account",
                      title: "号定位",
                      options: ["游戏测评", "硬件改造", "生活随笔", "其他"],
                    },
                  },
                ]);
              }}
            >
              起新号
            </button>
          </div>
        ) : null}

        <div className="rail-scroll">
          <div className="rail-section">工作台</div>
          <button
            type="button"
            className={`rail-item${mode === "chat" ? " active" : ""}`}
            onClick={() => {
              setMode("chat");
              setDrawer(false);
            }}
          >
            <span className="rail-item-label">对话</span>
          </button>
          <button
            type="button"
            className={`rail-item${mode === "needs" ? " active" : ""}`}
            onClick={() => {
              setMode("needs");
              setDrawer(false);
            }}
          >
            <span className="rail-item-label">Needs you</span>
            {needs.length > 0 ? (
              <span className="badge">{needs.length}</span>
            ) : null}
          </button>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`rail-item${mode === s.id ? " active" : ""}`}
              onClick={() => {
                setMode(s.id);
                setDrawer(false);
              }}
            >
              <span className="rail-item-label">{s.label}</span>
            </button>
          ))}

          <div className="rail-section">会话</div>
          <button type="button" className="rail-item muted">
            <span className="rail-item-label">主编 · 小稿本周</span>
          </button>
        </div>

        <div className="rail-foot">
          <button type="button" className="rail-quiet" onClick={onCycleTheme}>
            主题 · {themeLabel(themeMode)}
          </button>
          <button
            type="button"
            className="rail-quiet"
            onClick={async () => {
              await logout();
              setUser(null);
              setData(null);
              setMessages([]);
            }}
          >
            {user.display_name || user.email || "退出"}
          </button>
        </div>
      </aside>
    </div>
  );

  const sectionLabel =
    mode === "needs"
      ? "Needs you"
      : SECTIONS.find((s) => s.id === mode)?.label || mode;

  return (
    <div className={`shell${drawer ? " drawer-open" : ""}`}>
      <div className="mobile-top">
        <button type="button" onClick={() => setDrawer((v) => !v)}>
          菜单
        </button>
        <span>BotCamp</span>
        <span className="grow">{data.account.display_name}</span>
      </div>

      {rail}

      <main className="main">
        <BriefBar goal={brief.goal} now={brief.now} waiting={brief.waiting} />

        {mode === "chat" ? (
          <>
            {anchor ? (
              <div className="main-bar">
                <button
                  type="button"
                  className="chip"
                  onClick={() => {
                    if (anchor.tab) setMode(anchor.tab);
                  }}
                  title="打开实体"
                >
                  {anchor.kind} · {anchor.title}
                </button>
                <span className="grow" />
                <button
                  type="button"
                  className="link"
                  onClick={() => setAnchor(null)}
                >
                  取消锚定
                </button>
              </div>
            ) : null}
            <div className="main-scroll chat">
              <div className="chat-col">
                {messages.map((m, i) => (
                  <div key={`${i}-${m.role}`} className={`msg ${m.role}`}>
                    <div className="msg-meta">
                      {m.role === "editor"
                        ? "主编"
                        : m.role === "you"
                          ? "你"
                          : "系统"}
                    </div>
                    <div className="msg-text">{m.text}</div>
                    {m.milestones && m.milestones.length > 0 ? (
                      <ol className="msg-text" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                        {m.milestones.map((step) => (
                          <li key={step}>{step}</li>
                        ))}
                      </ol>
                    ) : null}
                    {m.gate && !m.gate.resolved ? (
                      <div className="qcard">
                        <div className="qcard-title">{m.gate.title}</div>
                        <div className="msg-text" style={{ fontSize: 13 }}>
                          {m.gate.summary}
                        </div>
                        {m.gate.checklist && m.gate.checklist.length > 0 ? (
                          <ul
                            className="msg-text"
                            style={{
                              margin: 0,
                              paddingLeft: 18,
                              fontSize: 12,
                              color: "var(--ink-2)",
                            }}
                          >
                            {m.gate.checklist.map((c) => (
                              <li key={c}>{c}</li>
                            ))}
                          </ul>
                        ) : null}
                        <div className="gate">
                          <button
                            type="button"
                            className="primary"
                            disabled={sending}
                            onClick={() => void resolveGate(i, "pass")}
                          >
                            {m.gate.kind === "review" ? "终审通过" : "确认选题"}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            disabled={sending}
                            onClick={() => void resolveGate(i, "hold")}
                          >
                            先搁置
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {m.question && !m.question.answered ? (
                      <div className="qcard">
                        <div className="qcard-title">{m.question.title}</div>
                        <div className="qcard-opts">
                          {m.question.options.map((opt) => (
                            <button
                              key={opt}
                              type="button"
                              disabled={sending}
                              onClick={() => void answerQuestion(i, opt)}
                            >
                              {opt}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
            <div className="composer-wrap">
              <div className="composer">
                {anchor ? (
                  <span className="chip soft" title="当前引用">
                    {anchor.kind} · {anchor.title}
                  </span>
                ) : null}
                <textarea
                  rows={1}
                  placeholder={anchor ? "带着引用发给主编" : "发给主编"}
                  value={draft}
                  disabled={sending}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <button
                  type="button"
                  disabled={sending || draft.trim() === ""}
                  onClick={() => void send()}
                >
                  发送
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="main-bar">
              <strong>{sectionLabel}</strong>
              <span className="grow" />
              <button
                type="button"
                className="link"
                onClick={() => setMode("chat")}
              >
                回对话
              </button>
            </div>
            <div className="main-scroll">
              {mode === "needs" ? (
                <NeedsInbox
                  items={needs}
                  busy={sending}
                  onOpen={(item) => onAnchor(item.anchor)}
                  onAct={async (item, action) => {
                    if (!data || sending) return;
                    setSending(true);
                    try {
                      const kind =
                        item.anchor.kind === "稿件" ? "manuscript" : "post";
                      const res = await updateMediaEntity({
                        accountId: data.account.id,
                        kind,
                        entityId: item.anchor.id,
                        action,
                      });
                      setData(res.workspace);
                      setMode("chat");
                      setAnchor(item.anchor);
                      setMessages((prev) => [
                        ...prev,
                        {
                          role: "system",
                          text: `Needs you 已处理：${action} · ${item.title}`,
                        },
                        openerMessage(res.workspace, item.anchor),
                      ]);
                    } catch (e) {
                      setMessages((prev) => [
                        ...prev,
                        {
                          role: "system",
                          text: `操作失败：${(e as Error).message}`,
                        },
                      ]);
                      setMode("chat");
                    } finally {
                      setSending(false);
                    }
                  }}
                />
              ) : (
                <SoTView
                  section={mode}
                  data={data}
                  anchor={anchor}
                  onAnchor={onAnchor}
                  onCite={(a) => {
                    citeEntity(a);
                    setMessages((prev) => [
                      ...prev,
                      {
                        role: "system",
                        text: `已引用 ${a.kind}「${a.title}」到对话。`,
                      },
                      openerMessage(data, a),
                    ]);
                  }}
                  onOpenManuscript={openManuscript}
                  preview={preview}
                />
              )}
            </div>
          </>
        )}
      </main>

      <nav className="mobile-bar" aria-label="主区">
        <button
          type="button"
          className={mode === "chat" && !drawer ? "active" : undefined}
          onClick={() => {
            setMode("chat");
            setDrawer(false);
          }}
        >
          对话
        </button>
        <button
          type="button"
          className={mode === "needs" && !drawer ? "active" : undefined}
          onClick={() => {
            setMode("needs");
            setDrawer(false);
          }}
        >
          Needs{needs.length > 0 ? ` · ${needs.length}` : ""}
        </button>
        <button
          type="button"
          className={drawer || (mode !== "chat" && mode !== "needs") ? "active" : undefined}
          onClick={() => setDrawer(true)}
        >
          工作台
        </button>
      </nav>
    </div>
  );
}
