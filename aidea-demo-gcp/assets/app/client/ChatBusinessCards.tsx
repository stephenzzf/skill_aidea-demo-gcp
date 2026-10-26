import { formatMetricValue } from "../shared/metric-format.ts";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { PropsWithChildren, ReactNode } from "react";
import { useAuiState, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { IconArrowUpRight, IconCheck, IconCircleCheck, IconExternalLink, IconLoader2, IconX } from "@tabler/icons-react";
import type { PublicConfig } from "../shared/contracts.ts";
import { isPlannedDomain, type DomainPage } from "../shared/solution.ts";
import type { ActionResult, ActionTransition, DataRow, WorkspaceDefinition, WorkspaceState } from "../shared/workspace.ts";
import { chatActionUnknownKey, allowedRecordActions, findActionReceipt, isAnalysisToolResult, parseToolResult, parseWorkspaceRecordResult } from "./ChatBusinessModel.ts";
import "./chat-business-cards.css";

export interface ChatBusinessContextValue {
  config: PublicConfig;
  definition: WorkspaceDefinition;
  state: WorkspaceState;
  navigate: (pageId: string, dataset?: string, recordId?: string) => void;
  executeAction: (input: {
    pageId: string;
    datasetId: string;
    record: DataRow;
    transition: ActionTransition;
    snapshotRevision: number;
    fields: Record<string, string | number | boolean>;
  }) => Promise<ActionResult["receipt"]>;
}

export class ChatActionError extends Error {
  readonly outcome: "rejected" | "unknown";
  constructor(message: string, outcome: "rejected" | "unknown") {
    super(message);
    this.outcome = outcome;
    this.name = "ChatActionError";
  }
}

export const ChatBusinessContext = createContext<ChatBusinessContextValue | null>(null);

export function ChatBusinessContextProvider({ value, children }: PropsWithChildren<{ value: ChatBusinessContextValue }>) {
  return <ChatBusinessContext.Provider value={value}>{children}</ChatBusinessContext.Provider>;
}

type ToolPart = ToolCallMessagePartProps;

function isSuccessful(part: ToolPart) {
  return part.status.type === "complete" && !part.isError && !part.isPreliminary;
}

export function canRenderChatBusinessTool(part: ToolPart, definition?: WorkspaceDefinition): boolean {
  if (!isSuccessful(part) || part.result === undefined) return false;
  if (part.toolName === "analyze_workspace") return isAnalysisToolResult(part.result);
  if (part.toolName === "get_workspace_record") return Boolean(definition && parseWorkspaceRecordResult(part.result, part.args, definition));
  return false;
}

function readable(value: unknown): string {
  if (value === undefined || value === null || value === "") return "暂无";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
  return String(value);
}

function sourceKind(config: PublicConfig, datasetId: string) {
  const source = config.workspace?.datasets.find(dataset => dataset.id === datasetId);
  return source ? `${source.origin === "synthetic" ? "合成演示" : "客户授权数据"} · ${source.source}` : "演示数据来源";
}

function pageForDataset(pages: readonly DomainPage[], datasetId: string, metricId?: string) {
  return pages.find(page => page.datasets.includes(datasetId) && (metricId === undefined || page.metrics.includes(metricId)));
}

function AnalysisBusinessCard({ part, context }: { part: ToolPart; context: ChatBusinessContextValue | null }) {
  const result = parseToolResult(part.result);
  if (!result || !Array.isArray(result.metrics) || !Array.isArray(result.sources)) return null;
  const pages = (context?.config.solution?.pages ?? []).filter(page => !isPlannedDomain(page, context?.config.solution?.design?.coverage ?? []));
  const metrics = result.metrics.flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    const metric = raw as Record<string, unknown>;
    if (typeof metric.id !== "string" || typeof metric.label !== "string" || typeof metric.dataset !== "string" ||
      !(metric.value === null || typeof metric.value === "number")) return [];
    if (Array.isArray(metric.partitions) && metric.partitions.length) {
      return metric.partitions.flatMap(rawPart => {
        if (!rawPart || typeof rawPart !== "object") return [];
        const part = rawPart as Record<string, unknown>;
        if (!(part.value === null || typeof part.value === "number")) return [];
        const currency = typeof part.currency === "string" ? part.currency : "";
        return [{ id: metric.id as string, label: `${metric.label}${currency ? ` · ${currency}` : ""}`, dataset: metric.dataset as string, value: part.value,
          unit: typeof part.unit === "string" ? part.unit : currency }];
      });
    }
    return [{ id: metric.id, label: metric.label, dataset: metric.dataset, value: metric.value,
      unit: typeof metric.unit === "string" ? metric.unit : "" }];
  }).slice(0, 4);
  const sources = result.sources.flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    const source = raw as Record<string, unknown>;
    return typeof source.id === "string" && typeof source.source === "string"
      ? [{ id: source.id, source: source.source, total: typeof source.total === "number" ? source.total : undefined }]
      : [];
  }).slice(0, 3);
  const revision = typeof result.revision === "number" ? result.revision : undefined;
  const filters = objectFilters(result.filters);
  return <article className="chat-business-card" aria-label="分析结果">
    <div className="chat-business-card-heading"><span className="chat-business-mark"><IconCheck size={15} /></span><div><strong>分析结果</strong><small>{revision === undefined ? "查询时快照 · 不随操作自动更新" : `查询快照 · 数据版本 ${revision}`}</small></div></div>
    {metrics.length > 0 && <dl className="chat-business-metrics">{metrics.map(metric => {
      const page = pageForDataset(pages, metric.dataset, metric.id);
      return <div key={`${metric.dataset}:${metric.id}:${metric.label}`}>
        <dt>{metric.label}</dt><dd>{formatMetricValue(metric.value, metric.unit)}</dd>
        {page && context && <button type="button" className="chat-business-link" onClick={() => context.navigate(page.id, metric.dataset)}>{page.title}<IconArrowUpRight size={13} /></button>}
      </div>;
    })}</dl>}
    {filters.length > 0 && <div className="chat-business-sources"><span>本次筛选</span>{filters.map((filter, index) => <small key={`${filter}:${index}`}>{filter}</small>)}</div>}
    {sources.length > 0 && <div className="chat-business-sources"><span>数据来源</span>{sources.map(source => {
      const page = pageForDataset(pages, source.id);
      return page && context
        ? <button key={source.id} type="button" onClick={() => context.navigate(page.id, source.id)}>{page.title}：{source.source}{source.total !== undefined ? ` · ${source.total} 条` : ""}<IconExternalLink size={13} /></button>
        : <small key={source.id}>{source.source}{source.total !== undefined ? ` · ${source.total} 条` : ""}</small>;
    })}</div>}
    {sources.some(source => pageForDataset(pages, source.id)) && <small className="chat-business-disclaimer">跳转到领域数据视图；本次聊天筛选条件不会传递。</small>}
    {context?.config.synthetic && <small className="chat-business-disclaimer">合成演示数据，不代表线上经营结果。</small>}
  </article>;
}

function RecordBusinessCard({ part, context }: { part: ToolPart; context: ChatBusinessContextValue | null }) {
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const parsed = context ? parseWorkspaceRecordResult(part.result, part.args, context.definition) : null;
  const definition = context?.definition.datasets.find(item => item.id === parsed?.dataset);
  const unknownKey = context && parsed && definition ? chatActionUnknownKey(context.config, parsed.dataset, String(parsed.record[definition.key])) : "";
  useEffect(() => {
    if (!unknownKey) { setOutcomeUnknown(false); return; }
    try { setOutcomeUnknown(sessionStorage.getItem(unknownKey) === "1"); } catch { setOutcomeUnknown(false); }
  }, [unknownKey]);
  if (!context) return <article className="chat-business-card"><strong>业务记录</strong><p>当前无法加载演示工作区，请返回方案页面查看。</p></article>;
  const result = parseWorkspaceRecordResult(part.result, part.args, context.definition);
  if (!result) return null;
  const dataset = context.definition.datasets.find(item => item.id === result.dataset)!;
  const pages = (context.config.solution?.pages ?? []).filter(page => !isPlannedDomain(page, context.config.solution?.design?.coverage ?? []));
  const actionOptions = allowedRecordActions(result.dataset, result.record, context.definition, pages);
  const actionReceipt = findActionReceipt(context.state, result.dataset, result.record, context.definition, result.revision);
  const page = pageForDataset(pages, result.dataset);
  return <article className="chat-business-card" aria-label={`${dataset.label}记录 ${String(result.record[dataset.key])}`}>
    <div className="chat-business-card-heading"><span className="chat-business-mark"><IconCheck size={15} /></span><div><strong>{dataset.label} · {String(result.record[dataset.key])}</strong><small>{sourceKind(context.config, result.dataset)} · 查询时记录快照</small></div></div>
    <dl className="chat-business-record-fields">{dataset.fields.filter(field => field.id !== dataset.key && result.record[field.id] !== undefined).slice(0, 6).map(field => <div key={field.id}><dt>{field.label}</dt><dd>{field.id === context.definition.workflow?.statusField ? (context.definition.stages.find(stage => stage.id === result.record[field.id])?.label ?? readable(result.record[field.id])) : readable(result.record[field.id])}{field.unit && typeof result.record[field.id] === "number" ? field.unit : ""}</dd></div>)}</dl>
    {page && <div className="chat-business-card-links"><button type="button" className="chat-business-link" onClick={() => context.navigate(page.id, result.dataset, String(result.record[dataset.key]))}>查看来源记录<IconArrowUpRight size={13} /></button></div>}
    {actionReceipt && <div className="chat-business-receipt" role="status"><IconCircleCheck size={16} /><span><strong>操作回执 · {actionReceipt.transition.label}</strong><small>操作目标状态：{context.definition.stages.find(stage => stage.id === actionReceipt.transition.to)?.label ?? actionReceipt.transition.to} · 修订 {actionReceipt.revision}</small><small>请求 {actionReceipt.event.requestId} · {new Date(actionReceipt.event.at).toLocaleString("zh-CN")} · 本次演示模拟</small></span></div>}
    {outcomeUnknown && <div className="chat-business-outcome-unknown"><p className="chat-business-stale">服务端不保留模拟回执；本次结果无法确认，领域页只显示当前浏览器已知状态。请勿重复提交。按“重新体验”清空后可重新演示。</p>{page && <button type="button" className="chat-business-link" onClick={() => context.navigate(page.id, result.dataset, String(result.record[dataset.key]))}>查看当前浏览器记录<IconArrowUpRight size={13} /></button>}</div>}
    {!actionReceipt && actionOptions.map(({ page: actionPage, transition }) => <RecordActionCard key={`${actionPage.id}:${transition.id}`} outcomeUnknown={outcomeUnknown} onOutcomeUnknown={() => { setOutcomeUnknown(true); try { sessionStorage.setItem(unknownKey, "1"); } catch { /* Keep the lock for this mounted card. */ } }} page={actionPage} transition={transition} record={result.record} datasetId={result.dataset} snapshotRevision={result.revision} context={context} />)}
    {result.revision !== context.state.revision && <p className="chat-business-stale" role="status">记录基于版本 {result.revision}，当前为 {context.state.revision}。请重新查询后再操作。</p>}
    {!actionOptions.length && !actionReceipt && page && <p className="chat-business-card-footnote">可在“{page.title}”中查看记录和已配置的操作。</p>}
  </article>;
}

function objectFilters(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const query = value as Record<string, unknown>;
  const items: string[] = [];
  if (typeof query.dataset === "string") items.push(`数据集：${query.dataset}`);
  if (typeof query.from === "string" || typeof query.to === "string") items.push(`日期：${typeof query.from === "string" ? query.from : "起始未限定"} 至 ${typeof query.to === "string" ? query.to : "结束未限定"}`);
  if (typeof query.origin === "string") items.push(`来源：${query.origin === "synthetic" ? "合成演示" : query.origin === "customer" ? "客户数据" : query.origin}`);
  if (Array.isArray(query.filters)) for (const raw of query.filters.slice(0, 3)) {
    if (!raw || typeof raw !== "object") continue;
    const filter = raw as Record<string, unknown>;
    if (typeof filter.field === "string" && typeof filter.op === "string" && ["string", "number", "boolean"].includes(typeof filter.value)) {
      items.push(`${filter.field} ${filter.op} ${String(filter.value)}`);
    }
  }
  return items;
}

function RecordActionCard({ page, transition, record, datasetId, snapshotRevision, context, outcomeUnknown, onOutcomeUnknown }: {
  page: DomainPage; transition: ActionTransition; record: DataRow; datasetId: string; snapshotRevision: number; context: ChatBusinessContextValue;
  outcomeUnknown: boolean; onOutcomeUnknown: () => void;
}) {
  const busy = useAuiState(state => state.thread.isRunning);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string | number | boolean>>(() => Object.fromEntries((transition.inputFields ?? []).flatMap(field => {
    const value = record[field.id];
    return value === undefined || value === null ? [] : [[field.id, value]];
  })));
  const pending = useRef(false);
  const workflow = context.definition.workflow!;
  const recordId = String(record[context.definition.datasets.find(item => item.id === datasetId)!.key]);
  const missing = (transition.requiredFields ?? []).filter(field => {
    const value = fields[field] ?? record[field];
    return value === undefined || value === null || value === "";
  });
  const missingInputs = (transition.inputFields ?? []).filter(field => field.required && (fields[field.id] === undefined || fields[field.id] === ""));
  const stale = snapshotRevision !== context.state.revision || Boolean(transition.requireFresh && record[workflow.staleField ?? "__stale"] === true);
  const confirm = async () => {
    if (pending.current || outcomeUnknown || busy || stale || missing.length || missingInputs.length) return;
    pending.current = true;
    setSubmitting(true);
    setError("");
    try {
      await context.executeAction({ pageId: page.id, datasetId, record, transition, snapshotRevision, fields });
      setConfirming(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未能确认；请重新查询后核对状态。未自动重试。");
      if (cause instanceof ChatActionError && cause.outcome === "unknown") onOutcomeUnknown();
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  };
  return <section className="chat-business-action" aria-label={`${transition.label}模拟操作`}>
    {!confirming ? <button type="button" className="chat-business-action-preview" disabled={busy || stale || outcomeUnknown} onClick={() => setConfirming(true)}>
      {outcomeUnknown ? "结果待核对" : `预览并确认：${transition.label}`}<IconArrowUpRight size={14} />
    </button> : <div className="chat-business-action-confirm">
      <div><strong>确认模拟操作</strong><button type="button" aria-label="取消操作" disabled={submitting} onClick={() => { setConfirming(false); setError(""); }}><IconX size={15} /></button></div>
      <p>{context.definition.stages.find(stage => stage.id === record[workflow.statusField])?.label ?? readable(record[workflow.statusField])} → {context.definition.stages.find(stage => stage.id === transition.to)?.label ?? transition.to}。模拟执行角色：{context.definition.roles.find(role => role.id === transition.role)?.label ?? transition.role}。仅更新本次演示状态。</p>
      {(transition.inputFields ?? []).map(field => <label key={field.id}>{field.label}
        {field.type === "boolean" ? <select aria-label={field.label} value={String(fields[field.id] ?? "")} disabled={submitting} onChange={event => setFields(current => ({ ...current, [field.id]: event.target.value === "true" }))}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>
          : <input aria-label={field.label} type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"} value={String(fields[field.id] ?? "")} required={field.required} disabled={submitting} onChange={event => setFields(current => ({ ...current, [field.id]: field.type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value }))} />}
      </label>)}
      {missing.length > 0 && <small>需先在领域页面补齐：{missing.join("、")}</small>}
      {missingInputs.length > 0 && <small>请填写：{missingInputs.map(field => field.label).join("、")}</small>}
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" disabled={submitting} onClick={() => { setConfirming(false); setError(""); }}>取消</button><button type="button" disabled={submitting || outcomeUnknown || busy || stale || missing.length > 0 || missingInputs.length > 0} onClick={() => void confirm()}>{submitting ? <><IconLoader2 className="chat-business-spin" size={14} />正在处理…</> : outcomeUnknown ? "结果待核对" : "确认模拟操作"}</button></footer>
    </div>}
    {stale && <small className="chat-business-stale">记录已过期，请重新查询。</small>}
  </section>;
}

export function ChatBusinessTool({ part }: { part: ToolPart }): ReactNode {
  const context = useContext(ChatBusinessContext);
  if (part.toolName === "analyze_workspace") return <AnalysisBusinessCard part={part} context={context} />;
  if (part.toolName === "get_workspace_record") return <RecordBusinessCard part={part} context={context} />;
  return null;
}


/** Suggestions are configuration/state-derived and never start a background model call. */
export function ChatBusinessFollowups({ config, busy, onSend }: {
  config: PublicConfig; busy: boolean; onSend: (text: string) => Promise<void>;
}) {
  const context = useContext(ChatBusinessContext);
  const event = context?.state.events.at(-1);
  const workflow = context?.definition.workflow;
  const dataset = context?.definition.datasets.find(item => item.id === workflow?.dataset);
  const transition = workflow?.transitions.find(item => item.id === event?.actionId);
  const prompts = event && dataset && transition
    ? [`请查询${dataset.label}中记录 ${event.recordId} 的最新状态与后续步骤`, `完成“${transition.label}”后，哪些当前指标变化了？请区分历史快照。`]
    : config.prompts.slice(0, 3);
  return <div className="followups" aria-label="建议追问">{prompts.map(prompt =>
    <button key={prompt} type="button" disabled={busy} onClick={() => void onSend(prompt)}>{prompt}<IconArrowUpRight size={14} /></button>
  )}</div>;
}
