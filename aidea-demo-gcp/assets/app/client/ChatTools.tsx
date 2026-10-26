import { formatMetricValue } from "../shared/metric-format.ts";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { IconAlertCircle, IconCheck, IconLoader2, IconLock, IconX } from "@tabler/icons-react";

type ToolPart = ToolCallMessagePartProps;

const friendlyName: Record<string, string> = {
  analyze_workspace: "只读业务分析",
  get_workspace_record: "来源记录查询",
};

function displayValue(value: unknown): string {
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} 项记录`;
  if (value && typeof value === "object") return `${Object.keys(value).length} 个字段`;
  return "未提供";
}

function resultValue(value: unknown): unknown {
  if (typeof value !== "string" || !/^[\s]*[\[{]/.test(value)) return value;
  try { return JSON.parse(value); } catch { return value; }
}

function summaryRows(value: unknown): Array<[string, string]> {
  value = resultValue(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const metrics = (value as { metrics?: unknown }).metrics;
    if (Array.isArray(metrics)) {
      return metrics.slice(0, 6).flatMap(metric => metric && typeof metric === "object" && typeof metric.label === "string"
        ? [[metric.label, metric.value === null || typeof metric.value === "number" ? formatMetricValue(metric.value, typeof metric.unit === "string" ? metric.unit : "") : displayValue(metric.value)] as [string, string]] : []);
    }
  }
  const rows: Array<[string, string]> = [];
  const visit = (item: unknown, path: string, depth: number) => {
    if (item === null || ["string", "number", "boolean"].includes(typeof item) || Array.isArray(item)) {
      rows.push([path || "结果", displayValue(item)]);
      return;
    }
    if (depth >= 2 || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (rows.length >= 6) break;
      visit(child, path ? `${path} · ${key}` : key, depth + 1);
    }
  };
  visit(value, "", 0);
  return rows.length ? rows : [["结果", displayValue(value)]];
}

export function ChatToolState({ part }: { part: ToolPart }) {
  if (part.status.type === "incomplete" && part.status.reason === "cancelled") return <IconX size={15} aria-label="已取消" />;
  if (part.isError || part.status.type === "incomplete") return <IconX size={15} aria-label="未完成" />;
  if (part.status.type === "requires-action") return <IconAlertCircle size={15} aria-label="等待处理" />;
  if (part.status.type === "running" || part.isPreliminary) return <IconLoader2 className="chat-tool-spin" size={15} aria-label="查询中" />;
  return <IconCheck size={15} aria-label="已完成" />;
}

function ToolCallResult({ part }: { part: ToolPart }) {
  const name = friendlyName[part.toolName] ?? "业务查询";
  const rows = summaryRows(part.result);
  const hasTechnicalDetails = part.result !== undefined || part.args !== undefined;
  const status = part.status.type === "incomplete" && part.status.reason === "cancelled" ? "已取消"
    : part.isError || part.status.type === "incomplete" ? "未完成"
      : part.status.type === "requires-action" ? "等待处理"
        : part.status.type === "running" || part.isPreliminary ? "执行中" : part.result === undefined ? "已完成（无返回内容）" : "已完成";
  return (
    <div className="chat-tool-call">
      <div className="chat-tool-title"><ChatToolState part={part} /><span>{name}</span><small>{status}</small></div>
      {part.args && Object.keys(part.args).length > 0 && <div className="chat-tool-scope">{summaryRows(part.args).map(([key, value]) => <span key={key}>{key}：{value}</span>)}</div>}
      {part.result !== undefined && (
        <dl className="chat-tool-result">{rows.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
      )}
      {hasTechnicalDetails && (
        <details className="chat-tool-details">
          <summary><IconLock size={13} />技术详情</summary>
          {part.args !== undefined && <pre>{JSON.stringify(part.args, null, 2)}</pre>}
          {part.result !== undefined && <pre>{JSON.stringify(part.result, null, 2)}</pre>}
        </details>
      )}
    </div>
  );
}

export function ChatToolProcessStep({ part }: { part: ToolPart }) {
  const name = friendlyName[part.toolName] ?? "业务查询";
  const status = part.status.type === "incomplete" && part.status.reason === "cancelled" ? "已取消"
    : part.isError || part.status.type === "incomplete" ? "查询未完成"
      : part.status.type === "requires-action" ? "等待处理"
        : part.status.type === "running" || part.isPreliminary ? "正在查询" : "查询已完成";
  return <div className="chat-process-step"><ChatToolState part={part} /><span>{name}</span><small>{status}</small></div>;
}

export { ToolCallResult };
