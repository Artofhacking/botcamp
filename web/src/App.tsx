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
import type { TabId, WorkspaceBundle } from "./types";
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

type MainMode = "chat" | TabId;
type Anchor = { kind: string; id: string; title: string; tab?: TabId };
type ChatMsg = { role: "editor" | "you" | "system"; text: string };

function fmt(n: number | null | undefined) {
  if (n == null) return "—";
  return n.toLocaleString("zh-CN");
}

function platformLabel(p: string) {
  return p === "xiaoheihe" ? "小黑盒" : p;
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
}: {
  title: string;
  meta: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`entity${active ? " active" : ""}`}
      onClick={onClick}
    >
      <div className="entity-title">{title}</div>
      <div className="entity-meta">{meta}</div>
    </button>
  );
}

function SoTView({
  section,
  data,
  anchor,
  onAnchor,
  onOpenManuscript,
  preview,
}: {
  section: TabId;
  data: WorkspaceBundle;
  anchor: Anchor | null;
  onAnchor: (a: Anchor) => void;
  onOpenManuscript: (id: string) => void;
  preview: { id: string; title: string; body: string | null } | null;
}) {
  const { account, board } = data;

  if (section === "board") {
    return (
      <div className="sot">
        <div className="sot-meta">
          {account.display_name} · {platformLabel(account.platform)} ·{" "}
          {account.status}
        </div>
        <div className="sot-meta">
          漏斗：
          {Object.entries(board.post_funnel || {})
            .map(([k, v]) => `${k} ${v}`)
            .join(" · ") || "—"}
        </div>
        <div className="sot-meta">
          {board.positioning?.what_it_is} · 粉丝{" "}
          {fmt(board.followers_latest?.followers)} · KPI ¥{board.revenue_kpi_cny}
        </div>
        {(board.writing || []).length > 0 ? (
          <>
            <div className="sot-label">此刻焦点 · 写稿中</div>
            {board.writing.slice(0, 5).map((p) => (
              <EntityRow
                key={p.id}
                title={p.title}
                meta={`${p.status}`}
                active={anchor?.id === p.id}
                onClick={() =>
                  onAnchor({
                    kind: "帖子",
                    id: p.id,
                    title: p.title,
                    tab: "posts",
                  })
                }
              />
            ))}
          </>
        ) : null}
        {(board.pending_final_review || []).length > 0 ? (
          <>
            <div className="sot-label">待确认</div>
            {board.pending_final_review.slice(0, 5).map((p) => (
              <EntityRow
                key={p.id}
                title={p.title}
                meta="待确认"
                active={anchor?.id === p.id}
                onClick={() =>
                  onAnchor({
                    kind: "帖子",
                    id: p.id,
                    title: p.title,
                    tab: "posts",
                  })
                }
              />
            ))}
          </>
        ) : null}
      </div>
    );
  }

  if (section === "posts") {
    return (
      <div className="sot">
        <div className="sot-label">帖子 / 选题</div>
        {data.posts.map((p) => (
          <EntityRow
            key={p.id}
            title={p.title}
            meta={`${p.status} · ${p.content_type || ""} · 浏览 ${fmt(p.metrics_views)}${
              p.remark ? ` · ${p.remark.split("\n").slice(-1)[0]}` : ""
            }`}
            active={anchor?.id === p.id}
            onClick={() =>
              onAnchor({ kind: "帖子", id: p.id, title: p.title, tab: "posts" })
            }
          />
        ))}
      </div>
    );
  }

  if (section === "manuscripts") {
    return (
      <div className="sot">
        <div className="sot-label">历史稿件 · 写作稿 ≠ 发布版</div>
        {data.manuscripts.map((m) => (
          <div key={m.id}>
            <EntityRow
              title={m.title}
              meta={`${m.status} · 终审 ${m.final_review_passed ? "通过" : "未过"}`}
              active={anchor?.id === m.id}
              onClick={() =>
                onAnchor({
                  kind: "稿件",
                  id: m.id,
                  title: m.title,
                  tab: "manuscripts",
                })
              }
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
        ))}
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
        {data.published_works.map((p) => (
          <EntityRow
            key={p.id}
            title={p.title}
            meta={`浏览 ${fmt(p.metrics_views)} · 赞 ${fmt(p.metrics_likes)}`}
            active={anchor?.id === p.id}
            onClick={() =>
              onAnchor({
                kind: "帖子",
                id: p.id,
                title: p.title,
                tab: "published",
              })
            }
          />
        ))}
      </div>
    );
  }

  if (section === "engagement") {
    const rows = [...data.engagement_snapshots].sort((a, b) =>
      `${b.snapshot_date}`.localeCompare(`${a.snapshot_date}`),
    );
    return (
      <div className="sot">
        <div className="sot-label">互动快照（趋势 SoT）</div>
        {rows.map((e) => (
          <EntityRow
            key={e.id}
            title={e.title}
            meta={`${e.snapshot_date} · 浏览 ${fmt(e.views)} · 赞 ${fmt(e.likes)}`}
            active={anchor?.id === e.id}
            onClick={() =>
              onAnchor({
                kind: "快照",
                id: e.id,
                title: e.title,
                tab: "engagement",
              })
            }
          />
        ))}
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
      <div className="sot-label">平台事件</div>
      {data.platform_events.map((e) => (
        <EntityRow
          key={e.id}
          title={e.name}
          meta={`${e.event_type} · ${e.occurred_at}`}
          active={anchor?.id === e.id}
          onClick={() =>
            onAnchor({ kind: "事件", id: e.id, title: e.name, tab: "events" })
          }
        />
      ))}
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
          setMessages([
            {
              role: "editor",
              text: openerFor(ws, null),
            },
          ]);
        }
      } catch (e) {
        setAuthError((e as Error).message);
      } finally {
        setBoot(false);
      }
    })();
  }, [loadWorkspace]);

  function openerFor(ws: WorkspaceBundle | null, a: Anchor | null) {
    if (a?.id === "pst_d2r_mobile" || a?.title.includes("D2R")) {
      return "这篇《D2R Mobile》还在写稿中、终审未过。按规矩：正文不放外链、配图 16:9、晚上 20–21 点发。要先过终审清单，还是先改标题口吻？";
    }
    if (a) {
      return `已锚定「${a.title}」。改状态、补备注，还是对照互动快照复盘？`;
    }
    const writing = ws?.board.writing?.[0];
    if (writing) {
      return `看板里写稿中还有《${writing.title}》。要先推进哪一条？也可以从侧栏打开帖子·选题核对。`;
    }
    return `当前号「${ws?.account.display_name || "—"}」。从侧栏打开工作台分区，或直接告诉我下一步。`;
  }

  async function afterLogin(next: AuthUser) {
    setUser(next);
    setAuthError(null);
    setAnchor(null);
    setMode("chat");
    setDrawer(false);
    const ws = await loadWorkspace();
    setMessages([{ role: "editor", text: openerFor(ws, null) }]);
  }

  const onCycleTheme = () => {
    const next = cycleTheme(themeMode);
    setThemeMode(next);
    applyTheme(next);
  };

  const onAnchor = (a: Anchor) => {
    setAnchor(a);
    setMode("chat");
    setDrawer(false);
    setMessages((prev) => [
      ...prev,
      { role: "editor", text: openerFor(data, a) },
    ]);
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || !data || sending) return;
    setSending(true);
    setDraft("");
    setMessages((m) => [...m, { role: "you", text }]);
    try {
      await noteMediaEntity({
        accountId: data.account.id,
        kind: anchor?.kind === "帖子" ? "post" : "event",
        entityId: anchor?.kind === "帖子" ? anchor.id : undefined,
        title: anchor?.title || null,
        text,
      });
      await loadWorkspace();
      setMessages((m) => [
        ...m,
        {
          role: "system",
          text: "已写入工作台（帖备注 / 事件）并刷新 SoT。",
        },
        {
          role: "editor",
          text: "记下了。还要改这条的状态，还是切到下一题？",
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

  if (!data) return <div className="loading">加载工作台…</div>;

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
                  setMessages([
                    { role: "editor", text: openerFor(res.workspace, null) },
                  ]);
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
                  },
                ]);
              }}
            >
              起新号
            </button>
          </div>
        ) : null}

        <div className="rail-section">工作台</div>
        <button
          type="button"
          className={`rail-item${mode === "chat" ? " active" : ""}`}
          onClick={() => {
            setMode("chat");
            setDrawer(false);
          }}
        >
          对话
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
            {s.label}
          </button>
        ))}

        <div className="rail-section">会话</div>
        <button type="button" className="rail-item muted">
          主编 · 小稿本周
        </button>

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

  return (
    <div className={`shell${drawer ? " drawer-open" : ""}`}>
      <div className="mobile-top">
        <button type="button" onClick={() => setDrawer((v) => !v)}>
          工作台
        </button>
        <span style={{ color: "var(--ink-2)" }}>BotCamp</span>
        <span style={{ marginLeft: "auto", color: "var(--ink-3)" }}>
          {data.account.display_name}
        </span>
      </div>

      {rail}

      <main className="main">
        {mode === "chat" ? (
          <>
            {anchor ? (
              <div className="main-bar">
                <span>
                  锚定 · {anchor.kind} · {anchor.title}
                </span>
                <button
                  type="button"
                  className="link"
                  onClick={() => setAnchor(null)}
                >
                  取消
                </button>
              </div>
            ) : null}
            <div className="main-scroll chat">
              <div className="chat-col">
                {messages.map((m, i) => (
                  <div key={`${i}-${m.role}`}>
                    <div className="bubble-meta">
                      {m.role === "editor"
                        ? "主编"
                        : m.role === "you"
                          ? "你"
                          : "系统"}
                    </div>
                    <div
                      className={
                        m.role === "system" ? "writeback" : "bubble-text"
                      }
                    >
                      {m.text}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="composer-wrap">
              <div className="composer">
                <textarea
                  rows={1}
                  placeholder="发给主编"
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
              <strong>
                {SECTIONS.find((s) => s.id === mode)?.label || mode}
              </strong>
              <button
                type="button"
                className="link"
                onClick={() => setMode("chat")}
              >
                回对话
              </button>
            </div>
            <div className="main-scroll">
              <SoTView
                section={mode}
                data={data}
                anchor={anchor}
                onAnchor={onAnchor}
                onOpenManuscript={openManuscript}
                preview={preview}
              />
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
          className={drawer || mode !== "chat" ? "active" : undefined}
          onClick={() => setDrawer(true)}
        >
          工作台
        </button>
      </nav>
    </div>
  );
}
