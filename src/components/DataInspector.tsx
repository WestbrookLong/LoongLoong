import { CheckCircle2, Database, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dashboard } from "../types";

type InspectorKind = "history" | "memory" | "logs";

interface Props {
  kind: InspectorKind;
  dashboard: Dashboard;
  onDashboard: (dashboard: Dashboard) => void;
  notify: (message: string) => void;
}

const tabs: Record<InspectorKind, Array<{ id: string; label: string }>> = {
  history: [
    { id: "messages", label: "消息" },
    { id: "sessions", label: "会话" },
    { id: "retrievals", label: "检索" },
    { id: "snapshots", label: "上下文快照" },
  ],
  memory: [
    { id: "memories", label: "记忆" },
    { id: "events", label: "事件" },
    { id: "days", label: "每日摘要" },
    { id: "extractions", label: "智能提取" },
    { id: "claim_relations", label: "记忆关系" },
  ],
  logs: [
    { id: "logs", label: "运行日志" },
    { id: "compactions", label: "压缩运行" },
  ],
};

const columns: Record<string, Array<{ key: string; label: string; width?: string }>> = {
  messages: [
    { key: "role", label: "角色", width: "70px" },
    { key: "content", label: "内容" },
    { key: "modality", label: "来源", width: "80px" },
    { key: "created_at", label: "时间", width: "150px" },
  ],
  sessions: [
    { key: "title", label: "会话" },
    { key: "message_count", label: "消息", width: "70px" },
    { key: "started_at", label: "开始时间", width: "170px" },
  ],
  retrievals: [
    { key: "query", label: "查询" },
    { key: "mode", label: "模式", width: "80px" },
    { key: "candidate_count", label: "候选", width: "70px" },
    { key: "token_estimate", label: "Tokens", width: "80px" },
    { key: "created_at", label: "时间", width: "150px" },
  ],
  snapshots: [
    { key: "summary_text", label: "会话摘要" },
    { key: "source_token_count", label: "原 Tokens", width: "90px" },
    { key: "summary_token_count", label: "摘要 Tokens", width: "100px" },
    { key: "created_at", label: "时间", width: "150px" },
  ],
  memories: [
    { key: "status", label: "状态", width: "90px" },
    { key: "canonical_text", label: "记忆" },
    { key: "scope_id", label: "作用域", width: "90px" },
    { key: "confidence", label: "置信度", width: "80px" },
    { key: "evidence_count", label: "证据", width: "70px" },
  ],
  events: [
    { key: "event_type", label: "类型", width: "130px" },
    { key: "content", label: "事件" },
    { key: "activity_id", label: "活动", width: "80px" },
    { key: "local_date", label: "日期", width: "110px" },
  ],
  days: [
    { key: "local_date", label: "日期", width: "120px" },
    { key: "state", label: "状态", width: "90px" },
    { key: "summary", label: "摘要" },
    { key: "version", label: "版本", width: "70px" },
  ],
  extractions: [
    { key: "trigger_type", label: "触发", width: "100px" },
    { key: "status", label: "状态", width: "90px" },
    { key: "event_count", label: "事件", width: "70px" },
    { key: "claim_count", label: "Claims", width: "70px" },
    { key: "started_at", label: "时间", width: "150px" },
  ],
  claim_relations: [
    { key: "relation", label: "关系", width: "110px" },
    { key: "source_claim_id", label: "新 Claim" },
    { key: "target_claim_id", label: "关联 Claim" },
    { key: "confidence", label: "置信度", width: "80px" },
  ],
  logs: [
    { key: "level", label: "级别", width: "80px" },
    { key: "category", label: "模块", width: "100px" },
    { key: "message", label: "消息" },
    { key: "created_at", label: "时间", width: "150px" },
  ],
  compactions: [
    { key: "trigger_type", label: "触发", width: "110px" },
    { key: "status", label: "状态", width: "90px" },
    { key: "input_tokens", label: "输入 Tokens", width: "100px" },
    { key: "output_tokens", label: "输出 Tokens", width: "100px" },
    { key: "started_at", label: "时间", width: "150px" },
  ],
};

function displayValue(key: string, value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (key.endsWith("_at")) return new Date(String(value)).toLocaleString("zh-CN");
  if (["confidence", "importance", "stability"].includes(key)) return Number(value).toFixed(2);
  return String(value);
}

export function DataInspector({ kind, dashboard, onDashboard, notify }: Props) {
  const availableTabs = tabs[kind];
  const [active, setActive] = useState(availableTabs[0].id);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setActive(availableTabs[0].id);
  }, [kind]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await window.pet.getRecords({ type: active, search, limit: 250 });
      setRows(data);
      setSelected((current) => current && data.find((row) => row.id === current.id) || data[0] || null);
    } finally {
      setLoading(false);
    }
  }, [active, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 120);
    return () => window.clearTimeout(timer);
  }, [load]);

  const title = kind === "history" ? "数据记录" : kind === "memory" ? "记忆系统" : "运行日志";
  const activeColumns = useMemo(() => columns[active] || [], [active]);

  const consolidate = async () => {
    setLoading(true);
    try {
      const result = await window.pet.consolidate();
      const skipped = Boolean(result.skipped);
      notify(skipped ? "今天的记忆已经是最新状态。" : "今天的记忆整理完成。");
      onDashboard(await window.pet.getDashboard());
      await load();
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="inspector-page">
      <header className="inspector-header">
        <div>
          <h1>{title}</h1>
          <span className="database-path"><Database size={13} /> {dashboard.databasePath}</span>
        </div>
        {kind === "memory" && (
          <button className="command-button" onClick={consolidate} disabled={loading}>
            <RefreshCw size={17} className={loading ? "spin" : ""} />
            立即整理
          </button>
        )}
      </header>

      <div className="inspector-toolbar">
        <div className="tabs" role="tablist">
          {availableTabs.map((tab) => (
            <button key={tab.id} className={active === tab.id ? "active" : ""} onClick={() => setActive(tab.id)}>
              {tab.label}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={16} />
          <input value={search} placeholder="搜索" onChange={(event) => setSearch(event.target.value)} />
        </label>
      </div>

      <div className="inspector-content">
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {activeColumns.map((column) => <th key={column.key} style={{ width: column.width }}>{column.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr
                  key={String(row.id || index)}
                  className={selected?.id === row.id ? "selected" : ""}
                  onClick={() => setSelected(row)}
                >
                  {activeColumns.map((column) => (
                    <td key={column.key} title={displayValue(column.key, row[column.key])}>
                      {column.key === "status" && <span className={`status-mark status-${row[column.key]}`} />}
                      {displayValue(column.key, row[column.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && !rows.length && <div className="empty-state"><CheckCircle2 size={22} />暂无记录</div>}
        </div>

        <aside className="record-detail">
          <div className="detail-title">记录详情</div>
          {selected ? (
            <dl>
              {Object.entries(selected).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{typeof value === "string" && (value.startsWith("{") || value.startsWith("["))
                    ? <pre>{JSON.stringify(JSON.parse(value), null, 2)}</pre>
                    : displayValue(key, value)}</dd>
                </div>
              ))}
            </dl>
          ) : <span className="muted">选择一条记录</span>}
        </aside>
      </div>
    </main>
  );
}
