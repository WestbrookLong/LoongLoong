import { CheckCircle2, FileSearch, FolderOpen, Globe2, LoaderCircle, Search, XCircle } from "lucide-react";
import type { AgentActivityEvent } from "../types";

interface Props { activities: AgentActivityEvent[]; }

const labels: Record<string, string> = {
  web_search: "搜索网页",
  web_read: "读取网页",
  filesystem_list: "查看文件",
  filesystem_read: "读取文件",
  filesystem_search: "搜索文件",
};

function ToolIcon({ tool }: { tool: string }) {
  if (tool === "web_search") return <Search size={14} />;
  if (tool === "web_read") return <Globe2 size={14} />;
  if (tool === "filesystem_list") return <FolderOpen size={14} />;
  return <FileSearch size={14} />;
}

function detail(activity: AgentActivityEvent) {
  const args = activity.arguments || {};
  return String(args.query || args.url || args.path || activity.result?.summary || "只读操作");
}

export function AgentActivityList({ activities }: Props) {
  if (!activities.length) return null;
  return (
    <div className="agent-activities" aria-label="Agent 工具活动">
      {activities.map((activity) => {
        const complete = activity.type === "tool_completed";
        const ok = activity.result?.ok !== false;
        return (
          <div className={`agent-activity ${complete ? (ok ? "complete" : "failed") : "running"}`} key={activity.tool_call_id}>
            <ToolIcon tool={activity.tool} />
            <div>
              <strong>{labels[activity.tool] || activity.tool}</strong>
              <span title={detail(activity)}>{detail(activity)}</span>
            </div>
            {!complete ? <LoaderCircle className="spin" size={14} /> : ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          </div>
        );
      })}
    </div>
  );
}
