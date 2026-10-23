import { useEffect, useMemo, useState } from "react";
import { fetchManuscript, fetchWorkspace } from "./api";
import type { TabId, WorkspaceBundle } from "./types";
import "./index.css";

const TABS: { id: TabId; label: string }[] = [
  { id: "board", label: "运营看板" },
  { id: "posts", label: "帖子 / 选题发布" },
  { id: "manuscripts", label: "历史稿件" },
  { id: "published", label: "已发作品" },
  { id: "engagement", label: "互动快照（趋势）" },
  { id: "followers", label: "粉丝" },
  { id: "revenue", label: "收益" },
  { id: "events", label: "平台事件" },
];

function fmt(n: number | null | undefined) {
  if (n == null) return "—";
  return n.toLocaleString("zh-CN");
}

function statusClass(status: string) {
  if (status === "已发布") return "badge pub";
  if (status === "写稿中" || status === "待确认") return "badge draft";
  return "badge";
}

export default function App() {
  const [data, setData] = useState<WorkspaceBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("board");
  const [msPreview, setMsPreview] = useState<{
    id: string;
    title: string;
    body: string | null;
    published_edition: string | null;
  } | null>(null);

  useEffect(() => {
    fetchWorkspace()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  const sortedEngagement = useMemo(() => {
    if (!data) return [];
    return [...data.engagement_snapshots].sort((a, b) =>
      `${b.snapshot_date}${b.title}`.localeCompare(`${a.snapshot_date}${a.title}`),
    );
  }, [data]);

  async function openManuscript(id: string) {
    if (!data) return;
    const res = await fetchManuscript(data.account.id, id);
    setMsPreview({
      id,
      title: res.manuscript.title,
      body: res.body,
      published_edition: res.published_edition,
    });
  }

  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="loading">加载自媒体账号工作台…</div>;

  const { account, board } = data;

  return (
    <div className="app">
      <header className="hero">
        <div className="brand">BotCamp · 自媒体账号</div>
        <h1>{account.display_name}</h1>
        <div className="meta">
          <span className="pill ok">小黑盒 · {account.platform}</span>
          <span className="pill">{account.status}</span>
          <span className="pill">业务线 {account.biz_line_tag}</span>
          <span className="pill">{account.content_timezone}</span>
        </div>
        <p className="note">
          趋势权威：互动快照 append-only。帖子行指标仅为当前镜像。稿页 ≠ 发布版。
        </p>
      </header>

      <nav className="tabs" aria-label="工作台分区">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab${tab === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="panel">
        {tab === "board" && (
          <div>
            <div className="grid stats">
              <div className="stat">
                <div className="label">收益 KPI（¥）</div>
                <div className="value">{board.revenue_kpi_cny}</div>
              </div>
              <div className="stat">
                <div className="label">粉丝（最新）</div>
                <div className="value">
                  {fmt(board.followers_latest?.followers)}
                </div>
              </div>
              <div className="stat">
                <div className="label">互动快照条数</div>
                <div className="value">{board.trend_hint.snapshot_count}</div>
              </div>
              <div className="stat">
                <div className="label">帖子总数</div>
                <div className="value">{data.posts.length}</div>
              </div>
            </div>

            <h2 className="section-title">定位</h2>
            {board.positioning && (
              <div className="list">
                <div className="list-item">
                  <h3>{board.positioning.what_it_is}</h3>
                  <p className="note">{board.positioning.goal}</p>
                  <p className="note">红线：{board.positioning.redlines_summary}</p>
                </div>
              </div>
            )}

            <h2 className="section-title">
              规矩启用
              {board.publish_window ? ` · 发帖窗口 ${board.publish_window}` : ""}
            </h2>
            <div className="rules">
              {board.rules_enabled.map((r) => (
                <span key={r.rule_id} className="pill">
                  {r.label}
                </span>
              ))}
            </div>

            <h2 className="section-title">帖子漏斗</h2>
            <div className="grid stats">
              {Object.entries(board.post_funnel).map(([k, v]) => (
                <div className="stat" key={k}>
                  <div className="label">{k}</div>
                  <div className="value">{v}</div>
                </div>
              ))}
            </div>

            <h2 className="section-title">近作当前镜像（非趋势）</h2>
            <div className="list">
              {board.recent_published_mirror.map((p) => (
                <div className="list-item" key={p.id}>
                  <h3>
                    {p.url ? (
                      <a href={p.url} target="_blank" rel="noreferrer">
                        {p.title}
                      </a>
                    ) : (
                      p.title
                    )}
                  </h3>
                  <p className="note">
                    浏览 {fmt(p.metrics_views)} · 赞 {fmt(p.metrics_likes)} ·{" "}
                    {p.note}
                  </p>
                </div>
              ))}
            </div>

            <h2 className="section-title">最近平台事件</h2>
            <div className="list">
              {board.recent_events.map((e) => (
                <div className="list-item" key={e.id}>
                  <h3>
                    <span className="badge">{e.event_type}</span> {e.name}
                  </h3>
                  <p className="note">
                    {e.occurred_at}
                    {e.related_title ? ` · ${e.related_title}` : ""}
                  </p>
                </div>
              ))}
            </div>
            <p className="note" style={{ marginTop: "1rem" }}>
              {board.revenue_kpi_note}
            </p>
          </div>
        )}

        {tab === "posts" && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>标题</th>
                  <th>状态</th>
                  <th>类型</th>
                  <th>形式</th>
                  <th>浏览</th>
                  <th>赞</th>
                  <th>更新于</th>
                </tr>
              </thead>
              <tbody>
                {data.posts.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div>{p.title}</div>
                      {p.url && (
                        <a href={p.url} target="_blank" rel="noreferrer">
                          链接
                        </a>
                      )}
                      {p.remark && <div className="note">{p.remark}</div>}
                    </td>
                    <td>
                      <span className={statusClass(p.status)}>{p.status}</span>
                    </td>
                    <td>{p.content_type}</td>
                    <td>{p.form}</td>
                    <td>{fmt(p.metrics_views)}</td>
                    <td>{fmt(p.metrics_likes)}</td>
                    <td>{p.metrics_updated_at || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "manuscripts" && (
          <div>
            <p className="note">写作稿 ≠ 发布版。空正文页合法（非正式帖 / 未留稿）。</p>
            <div className="list" style={{ marginTop: "0.75rem" }}>
              {data.manuscripts.map((m) => (
                <div className="list-item" key={m.id}>
                  <h3>{m.title}</h3>
                  <p className="note">
                    <span className={statusClass(m.status)}>{m.status}</span> ·{" "}
                    {m.archive_bucket} · 终审{" "}
                    {m.final_review_passed ? "通过" : "未过"}
                  </p>
                  <button type="button" className="pill" onClick={() => openManuscript(m.id)}>
                    查看稿正文
                  </button>
                </div>
              ))}
            </div>
            {msPreview && (
              <div>
                <h2 className="section-title">预览：{msPreview.title}</h2>
                <div className="ms-preview">{msPreview.body || "（无写作稿）"}</div>
                {msPreview.published_edition && (
                  <>
                    <h2 className="section-title">发布版节</h2>
                    <div className="ms-preview">{msPreview.published_edition}</div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {tab === "published" && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>标题</th>
                  <th>发布时间</th>
                  <th>浏览</th>
                  <th>赞</th>
                  <th>评</th>
                  <th>藏</th>
                  <th>分享</th>
                  <th>稿</th>
                </tr>
              </thead>
              <tbody>
                {data.published_works.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.url ? (
                        <a href={p.url} target="_blank" rel="noreferrer">
                          {p.title}
                        </a>
                      ) : (
                        p.title
                      )}
                    </td>
                    <td>{p.published_at || "—"}</td>
                    <td>{fmt(p.metrics_views)}</td>
                    <td>{fmt(p.metrics_likes)}</td>
                    <td>{fmt(p.metrics_comments)}</td>
                    <td>{fmt(p.metrics_favorites)}</td>
                    <td>{fmt(p.metrics_shares)}</td>
                    <td>{p.manuscript_id ? "有" : "空（合法）"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "engagement" && (
          <div>
            <p className="note">
              趋势 SoT：每日追加、不覆盖。日期 {board.trend_hint.latest_dates.join("、") || "—"}
            </p>
            <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
              <table>
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>标题</th>
                    <th>形式</th>
                    <th>浏览</th>
                    <th>赞</th>
                    <th>评</th>
                    <th>藏</th>
                    <th>分享</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedEngagement.map((e) => (
                    <tr key={e.id}>
                      <td>{e.snapshot_date}</td>
                      <td>
                        {e.post_url ? (
                          <a href={e.post_url} target="_blank" rel="noreferrer">
                            {e.title}
                          </a>
                        ) : (
                          e.title
                        )}
                      </td>
                      <td>{e.form}</td>
                      <td>{fmt(e.views)}</td>
                      <td>{fmt(e.likes)}</td>
                      <td>{fmt(e.comments)}</td>
                      <td>{fmt(e.favorites)}</td>
                      <td>{fmt(e.shares)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "followers" && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>日期</th>
                  <th>粉丝</th>
                  <th>帖子数</th>
                  <th>获赞与收藏</th>
                  <th>来源</th>
                </tr>
              </thead>
              <tbody>
                {[...data.follower_snapshots]
                  .sort((a, b) => b.record_date.localeCompare(a.record_date))
                  .map((f) => (
                    <tr key={f.id}>
                      <td>{f.record_date}</td>
                      <td>{fmt(f.followers)}</td>
                      <td>{fmt(f.post_count)}</td>
                      <td>{fmt(f.likes_and_favorites)}</td>
                      <td>{f.source || "—"}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "revenue" && (
          <div>
            <p className="note">
              KPI ≈ ¥{board.revenue_kpi_cny}（{board.revenue_kpi_note}）
            </p>
            <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
              <table>
                <thead>
                  <tr>
                    <th>记录</th>
                    <th>金额</th>
                    <th>类型</th>
                    <th>时间</th>
                    <th>来源标题</th>
                  </tr>
                </thead>
                <tbody>
                  {data.revenue.map((r) => (
                    <tr key={r.id}>
                      <td>{r.record_title}</td>
                      <td>
                        {r.amount} {r.currency}
                      </td>
                      <td>
                        <span className="badge">{r.revenue_type}</span>
                      </td>
                      <td>{r.occurred_at}</td>
                      <td>{r.source_title || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "events" && (
          <div className="list">
            {data.platform_events.map((e) => (
              <div className="list-item" key={e.id}>
                <h3>
                  <span className="badge">{e.event_type}</span> {e.name}
                </h3>
                <p className="note">
                  {e.occurred_at}
                  {e.related_title ? ` · ${e.related_title}` : ""}
                </p>
                {e.remark && <p className="note">{e.remark}</p>}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
