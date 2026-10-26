import { formatMetricValue } from "../shared/metric-format.ts";
import { CapabilityPanel } from "./CapabilityPanel.tsx";
import type { AnalysisMetric } from "../shared/workspace.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { IconChartBar, IconChevronRight, IconCircleCheck, IconTable } from "@tabler/icons-react";
import type {
  ActionRequest,
  ActionResult,
  ActionTransition,
  AnalysisQuery,
  AnalysisResult,
  DataFilter,
  DataRow,
  DatasetDefinition,
  FieldDefinition,
  WorkspaceDefinition,
  WorkspaceState,
} from "../shared/workspace.ts";
import type { PublicConfig, WorkspaceChatContext } from "../shared/contracts.ts";
import type { DomainPage } from "../shared/solution.ts";
import "./workspace.css";
import type { SplitLayoutController } from "./SplitWorkspace.tsx";

const STORAGE_PREFIX = "me-demo-workspace:v2:";
export const V3_UI_PREFIX = "me-demo-domain-ui:v3:";
export const INITIAL_STATE: WorkspaceState = { revision: 0, events: [] };

export interface WorkspaceProps {
  config: PublicConfig;
  overviewChat?: ReactNode;
  splitLayout?: SplitLayoutController;
  chatScopeLabel?: string;
  chatScopeSummary?: string;
  onDomainChange?: (domainId: string) => void;
  resetKey: number;
  onContext: (context: WorkspaceChatContext | undefined) => void;
}

export interface WorkspacePayload { definition: WorkspaceDefinition; state: WorkspaceState }
type ViewId = "overview" | "records" | "workflow";

export interface DomainRoute { pageId: string; dataset?: string; recordId?: string }
interface DomainUiState {
  view: ViewId;
  query: AnalysisQuery;
  datasetId: string;
  metricDetailId: string | null;
  selection?: { dataset: string; id: string; scope?: "snapshot" | "current" };
  role: string;
}

export interface WorkspaceContentProps extends WorkspaceProps {
  domainPage?: DomainPage;
  definitionOverride?: WorkspaceDefinition;
  initialStateOverride?: WorkspaceState;
  sharedState?: WorkspaceState;
  onSharedStateChange?: (state: WorkspaceState) => void;
  onNavigate?: (pageId: string, dataset?: string, recordId?: string) => void;
  route?: DomainRoute;
  onRouteChange?: (route: DomainRoute) => void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isState(value: unknown): value is WorkspaceState {
  if (!record(value) || !Number.isSafeInteger(value.revision) || !Array.isArray(value.events)) return false;
  return value.revision === value.events.length && value.events.every((event) =>
    record(event) && typeof event.requestId === "string" && typeof event.recordId === "string" &&
    typeof event.actionId === "string" && typeof event.role === "string" && record(event.input) &&
    typeof event.at === "string",
  );
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    let message = response.status === 401 ? "访问码已失效，请重新验证后再继续。" : `请求未能完成（${response.status}）。`;
    try {
      const body: unknown = await response.json();
      if (record(body) && typeof body.error === "string") message = body.error;
    } catch { /* Keep the bounded fallback message. */ }
    throw new Error(message);
  }
  return await response.json() as T;
}

function formatValue(value: unknown, unit?: string) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") {
    const formatted = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
    return unit === "%" ? `${formatted}%` : `${formatted}${unit ? ` ${unit}` : ""}`;
  }
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

function labelFor(field: FieldDefinition | undefined, id: string) { return field?.label ?? id; }

function sourceLabel(origin: string, source: string) {
  return `${origin === "customer" ? "客户资料" : origin === "combined" ? "合并来源" : "合成示例"} · ${source}`;
}

function actionFields(transition: ActionTransition, row: DataRow | undefined, fields: FieldDefinition[]) {
  const result = new Map((transition.inputFields ?? []).map((field) => [field.id, field]));
  for (const id of transition.requiredFields ?? []) {
    const value = row?.[id];
    if (value !== undefined && value !== null && value !== "") continue;
    const field = fields.find((candidate) => candidate.id === id);
    if (field && !result.has(id)) result.set(id, field);
  }
  return [...result.values()];
}

export function safeSavedState(key: string): { state: WorkspaceState | null; available: boolean } {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return { state: null, available: true };
    const parsed: unknown = JSON.parse(raw);
    return { state: isState(parsed) && parsed.events.length <= 500 ? parsed : null, available: true };
  } catch { return { state: null, available: false }; }
}

export function storeState(key: string, value: WorkspaceState) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

function routeIdentity(route: DomainRoute) {
  return JSON.stringify([route.pageId, route.dataset ?? "", route.recordId ?? ""]);
}

export function domainStorageKey(config: PublicConfig, pageId: string) {
  return `${V3_UI_PREFIX}${config.id}:${config.mode}:${pageId}`;
}

function defaultDomainView(page: DomainPage): ViewId {
  if (page.components.includes("metrics")) return "overview";
  if (page.components.includes("records")) return "records";
  return "workflow";
}

export function readDomainUiState(key: string, page: DomainPage, definition: WorkspaceDefinition): DomainUiState | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!record(value)) return null;
    const allowedDatasets = new Set(page.datasets);
    const knownFields = new Map(definition.datasets
      .filter((dataset) => allowedDatasets.has(dataset.id))
      .flatMap((dataset) => dataset.fields.map((field) => [`${dataset.id}:${field.id}`, field] as const)));
    const rawQuery = record(value.query) ? value.query : {};
    const filters = Array.isArray(rawQuery.filters) ? rawQuery.filters.flatMap((filter) => {
      if (!record(filter) || typeof filter.field !== "string" || !["eq", "contains", "gte", "lte"].includes(String(filter.op))) return [];
      const datasetId = typeof filter.dataset === "string" ? filter.dataset : page.datasets.find((id) => knownFields.has(`${id}:${filter.field}`));
      if (!datasetId || !allowedDatasets.has(datasetId) || !knownFields.has(`${datasetId}:${filter.field}`)) return [];
      if (!["string", "number", "boolean"].includes(typeof filter.value)) return [];
      return [{ dataset: datasetId, field: filter.field, op: filter.op, value: filter.value } as DataFilter];
    }) : [];
    const query: AnalysisQuery = {
      ...(typeof rawQuery.dataset === "string" && allowedDatasets.has(rawQuery.dataset) ? { dataset: rawQuery.dataset } : {}),
      ...(typeof rawQuery.origin === "string" && ["synthetic", "customer", "combined"].includes(rawQuery.origin) ? { origin: rawQuery.origin as AnalysisQuery["origin"] } : {}),
      ...(filters.length ? { filters } : {}),
    };
    const allowedViews: ViewId[] = [];
    if (page.components.includes("metrics")) allowedViews.push("overview");
    if (page.components.includes("records")) allowedViews.push("records");
    if (page.components.includes("workflow")) allowedViews.push("workflow");
    const view = allowedViews.includes(value.view as ViewId) ? value.view as ViewId : defaultDomainView(page);
    let datasetId = typeof value.datasetId === "string" && allowedDatasets.has(value.datasetId)
      ? value.datasetId
      : page.datasets[0] ?? "";
    if (view === "workflow" && definition.workflow && allowedDatasets.has(definition.workflow.dataset)) datasetId = definition.workflow.dataset;
    const selection = record(value.selection) && typeof value.selection.dataset === "string" &&
      allowedDatasets.has(value.selection.dataset) && typeof value.selection.id === "string"
      ? { dataset: value.selection.dataset, id: value.selection.id,
        ...(value.selection.scope === "snapshot" || value.selection.scope === "current" ? { scope: value.selection.scope as "snapshot" | "current" } : {}) }
      : undefined;
    const metricDetailId = typeof value.metricDetailId === "string" && page.metrics.includes(value.metricDetailId)
      ? value.metricDetailId : null;
    const role = typeof value.role === "string" && definition.roles.some((item) => item.id === value.role)
      ? value.role : definition.roles[0]?.id ?? "";
    return { view, query, datasetId, metricDetailId, ...(selection ? { selection } : {}), role };
  } catch { return null; }
}

export function WorkspaceContent({ config, resetKey, onContext, domainPage, definitionOverride, initialStateOverride, sharedState, onSharedStateChange, onNavigate, route, onRouteChange }: WorkspaceContentProps) {
  const storageKey = `${STORAGE_PREFIX}${config.id}:${config.mode}`;
  const uiStorageKey = domainPage ? domainStorageKey(config, domainPage.id) : "";
  const restoredUi = useMemo(() => domainPage && definitionOverride ? readDomainUiState(uiStorageKey, domainPage, definitionOverride) : null,
    [uiStorageKey, domainPage, definitionOverride]);
  const routeDataset = domainPage && route?.pageId === domainPage.id && route.dataset && domainPage.datasets.includes(route.dataset) ? route.dataset : undefined;
  const [definition, setDefinition] = useState<WorkspaceDefinition | null>(definitionOverride ?? null);
  const [initialState, setInitialState] = useState<WorkspaceState>(initialStateOverride ?? INITIAL_STATE);
  const [localState, setLocalState] = useState<WorkspaceState>(initialStateOverride ?? INITIAL_STATE);
  const state = sharedState ?? localState;
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [view, setView] = useState<ViewId>(restoredUi?.view ?? (domainPage ? defaultDomainView(domainPage) : "overview"));
  const [query, setQuery] = useState<AnalysisQuery>(() => ({ ...(restoredUi?.query ?? {}), ...(routeDataset ? { dataset: routeDataset } : {}) }));
  const [datasetId, setDatasetId] = useState(routeDataset ?? restoredUi?.datasetId ?? domainPage?.datasets[0] ?? "");
  const [metricDetailId, setMetricDetailId] = useState<string | null>(restoredUi?.metricDetailId ?? null);
  const [filterField, setFilterField] = useState("");
  const [filterValue, setFilterValue] = useState("");
  const [selection, setSelection] = useState<{ dataset: string; id: string; scope?: "snapshot" | "current" } | undefined>(restoredUi?.selection);
  const [role, setRole] = useState(restoredUi?.role ?? "");
  const [transition, setTransition] = useState<ActionTransition | null>(null);
  const [draft, setDraft] = useState<Record<string, string | number | boolean>>({});
  const [receipt, setReceipt] = useState<ActionResult["receipt"] | null>(null);
  const [error, setError] = useState("");
  const [storageWarning, setStorageWarning] = useState(false);
  const [loading, setLoading] = useState(!definitionOverride);
  const [submitting, setSubmitting] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  const actionGeneration = useRef(0);
  const sequence = useRef(0);
  const lastResetKey = useRef<number | null>(null);
  const internalRouteKey = useRef<string | null>(null);
  const isDocumentReload = useRef(typeof performance !== "undefined" &&
    performance.getEntriesByType("navigation").some((entry) => (entry as PerformanceNavigationTiming).type === "reload")).current;
  const workspaceRequest = useRef<AbortController | null>(null);
  const analysisRequest = useRef<AbortController | null>(null);
  const onContextRef = useRef(onContext);
  onContextRef.current = onContext;

  const updateState = useCallback((next: WorkspaceState) => {
    if (onSharedStateChange) onSharedStateChange(next);
    else setLocalState(next);
  }, [onSharedStateChange]);

  function navigateWithinDomain(next: DomainRoute) {
    internalRouteKey.current = routeIdentity(next);
    onRouteChange?.(next);
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; actionGeneration.current++; workspaceRequest.current?.abort(); analysisRequest.current?.abort(); };
  }, []);

  useEffect(() => {
    const isReset = lastResetKey.current !== null && lastResetKey.current !== resetKey;
    lastResetKey.current = resetKey;
    if (isReset && definition) {
      actionGeneration.current++;
      pending.current = false;
      setSubmitting(false);
      setTransition(null);
      setDraft({});
      try { sessionStorage.removeItem(domainPage ? uiStorageKey : storageKey); } catch { setStorageWarning(true); }
      const fresh = { ...initialState, events: [...initialState.events] };
      updateState(fresh);
      setQuery({});
      setView(domainPage ? defaultDomainView(domainPage) : definition.views.find((item) => item !== "assistant") as ViewId ?? "overview");
      setDatasetId(domainPage?.datasets[0] ?? definition.datasets[0]?.id ?? "");
      setSelection(undefined);
      setMetricDetailId(null);
      setReceipt(null);
      setError("");
      return;
    }
    if (definitionOverride && initialStateOverride) {
      setDefinition(definitionOverride);
      setInitialState(initialStateOverride);
      setRole(restoredUi?.role ?? definitionOverride.roles[0]?.id ?? "");
      const restoreWorkflow = isDocumentReload && restoredUi?.view === "workflow" && routeDataset === definitionOverride.workflow?.dataset;
      setView(route?.recordId && domainPage?.components.includes("records")
        ? restoreWorkflow ? "workflow" : "records"
        : restoredUi?.view ?? (domainPage ? defaultDomainView(domainPage) : "overview"));
      setQuery({ ...(restoredUi?.query ?? {}), ...(routeDataset ? { dataset: routeDataset } : {}) });
      setDatasetId(routeDataset ?? restoredUi?.datasetId ?? domainPage?.datasets[0] ?? "");
      setSelection(routeDataset && route?.recordId ? { dataset: routeDataset, id: route.recordId, scope: "current" } : restoredUi?.selection);
      setMetricDetailId(restoredUi?.metricDetailId ?? null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    workspaceRequest.current?.abort();
    workspaceRequest.current = controller;
    setLoading(true);
    api<WorkspacePayload>("/api/workspace", { signal: controller.signal }).then((payload) => {
      if (!mounted.current || controller.signal.aborted) return;
      setDefinition(payload.definition);
      setInitialState(payload.state);
      setRole(payload.definition.roles[0]?.id ?? "");
      const saved = safeSavedState(storageKey);
      const next = saved.state ?? payload.state;
      setLocalState(next);
      setStorageWarning(!saved.available);
      setView(payload.definition.views.find((item) => item !== "assistant") as ViewId ?? "overview");
      setDatasetId(payload.definition.datasets[0]?.id ?? "");
      setLoading(false);
      if (saved.state && saved.state.revision !== payload.state.revision) setError("已从此标签页恢复本地模拟进度。");
    }).catch((cause: unknown) => {
      if (controller.signal.aborted || !mounted.current) return;
      setError(cause instanceof Error ? cause.message : "业务工作区暂时无法加载。");
      setLoading(false);
    });
    return () => controller.abort();
  }, [config.id, storageKey, uiStorageKey, resetKey, definitionOverride, initialStateOverride, domainPage, restoredUi, updateState]);

  useEffect(() => {
    if (!definition) return;
    if (domainPage) {
      const saved: DomainUiState = { view, query, datasetId, metricDetailId, ...(selection ? { selection } : {}), role };
      try {
        sessionStorage.setItem(uiStorageKey, JSON.stringify(saved));
        setStorageWarning(false);
      } catch { setStorageWarning(true); }
      return;
    }
    if (!isState(state)) return;
    setStorageWarning(!storeState(storageKey, state));
  }, [definition, state, storageKey, uiStorageKey, domainPage, view, query, datasetId, metricDetailId, selection, role]);

  useEffect(() => {
    if (!domainPage || !route || route.pageId !== domainPage.id || !definition) return;
    if (route.dataset && domainPage.datasets.includes(route.dataset)) {
      const targetDataset = route.dataset;
      const targetRecord = route.recordId;
      setDatasetId(targetDataset);
      setQuery((current) => current.dataset === targetDataset ? current : { ...current, dataset: targetDataset });
      if (targetRecord) {
        const identity = routeIdentity(route);
        const isInternalRoute = internalRouteKey.current === identity;
        if (isInternalRoute) internalRouteKey.current = null;
        const sameWorkflowDataset = domainPage.components.includes("workflow") && definition.workflow?.dataset === targetDataset;
        const preserveSavedWorkflow = isDocumentReload && restoredUi?.view === "workflow" &&
          restoredUi.datasetId === targetDataset && sameWorkflowDataset;
        const preserveWorkflow = view === "workflow" && datasetId === targetDataset && sameWorkflowDataset &&
          (isInternalRoute || preserveSavedWorkflow);
        setSelection((current) => current?.dataset === targetDataset && current.id === targetRecord
          ? current
          : { dataset: targetDataset, id: targetRecord, scope: "current" });
        if (!preserveWorkflow && domainPage.components.includes("records")) setView("records");
      } else {
        if (internalRouteKey.current === routeIdentity(route)) internalRouteKey.current = null;
        setSelection(undefined);
      }
    }
  // React to navigation, not local panel changes; otherwise a record URL overrides
  // the user's overview/workflow selection after every click or action response.
  }, [domainPage, route, definition, restoredUi, isDocumentReload]);

  const analysisQuery = useMemo<AnalysisQuery>(() => domainPage && datasetId
    ? { ...query, dataset: datasetId }
    : query, [domainPage, query, datasetId]);

  useEffect(() => {
    if (!definition) return;
    const hasDataView = !domainPage || domainPage.components.some((component) => component !== "assistant");
    if (!hasDataView) {
      setResult({ filters: analysisQuery, metrics: [], datasets: [], revision: state.revision });
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    analysisRequest.current?.abort();
    analysisRequest.current = controller;
    const requestNumber = ++sequence.current;
    setLoading(true);
    api<AnalysisResult>("/api/analysis", {
      method: "POST", signal: controller.signal,
      body: JSON.stringify({ query: analysisQuery, state, ...(domainPage ? { domainId: domainPage.id } : {}) }),
    }).then((value) => {
      if (mounted.current && !controller.signal.aborted && requestNumber === sequence.current) {
        setResult(value);
        setError("");
        setLoading(false);
      }
    }).catch((cause: unknown) => {
      if (controller.signal.aborted || !mounted.current) return;
      setError(cause instanceof Error ? cause.message : "数据分析暂时无法加载。");
      setLoading(false);
    });
    return () => controller.abort();
  }, [definition, analysisQuery, state, domainPage]);

  const filters = query.filters ?? [];
  const scopedDatasets = definition?.datasets.filter((dataset) => !domainPage || domainPage.datasets.includes(dataset.id)) ?? [];
  const scopedResult = useMemo<AnalysisResult | null>(() => {
    if (!result) return null;
    if (!domainPage) return result;
    return {
      ...result,
      metrics: result.metrics.filter((metric) => domainPage.metrics.includes(metric.id)),
      datasets: result.datasets.filter((dataset) => domainPage.datasets.includes(dataset.id)),
    };
  }, [result, domainPage]);
  const selectedDataset = scopedDatasets.find((dataset) => dataset.id === datasetId);
  const filteredDataset = scopedResult?.datasets.find((dataset) => dataset.id === datasetId);
  const selectedMetric = scopedResult?.metrics.find((metric) => metric.id === metricDetailId);
  const metricDataset = selectedMetric && scopedResult?.datasets.find((dataset) => dataset.id === selectedMetric.dataset);
  const workflow = definition?.workflow && (!domainPage || domainPage.components.includes("workflow")) ? definition.workflow : undefined;
  const workflowDataset = workflow && scopedResult?.datasets.find((dataset) => dataset.id === workflow.dataset);
  const selectableDatasets = view === "workflow" && workflow
    ? scopedDatasets.filter((dataset) => dataset.id === workflow.dataset)
    : scopedDatasets;
  const metricRecord = selection?.scope && selectedMetric && metricDataset && selection.dataset === metricDataset.id && selection.scope === selectedMetric.scope
    ? selectedMetric.rows.find((row) => String(row[metricDataset.key]) === selection.id)
    : undefined;
  const workflowRecord = selection?.dataset === workflowDataset?.id && workflowDataset
    ? workflowDataset.rows.find((row) => String(row[workflowDataset.key]) === selection?.id)
    : undefined;
  const selectedDataRow = selection?.dataset === filteredDataset?.id && filteredDataset
    ? filteredDataset.rows.find((row) => String(row[filteredDataset.key]) === selection?.id)
    : undefined;
  const activeRecord = metricRecord ?? workflowRecord ?? selectedDataRow;
  const activeDataset = metricRecord ? metricDataset : workflowRecord ? workflowDataset : selectedDataRow ? filteredDataset : undefined;
  const activeStage = workflow && activeRecord ? String(activeRecord[workflow.statusField] ?? "") : "";
  const allowedTransitions = workflow && activeRecord ? workflow.transitions.filter((item) =>
    (!domainPage || domainPage.actions.includes(item.id)) && item.role === role && item.from.includes(activeStage) && (!item.requireFresh || activeRecord[workflow.staleField ?? "__stale"] !== true),
  ) : [];

  const currentContext = useMemo<WorkspaceChatContext | undefined>(() => definition ? {
    query: analysisQuery, state,
    ...(domainPage ? { domainId: domainPage.id } : {}),
    ...(activeRecord && activeDataset ? { selectedRecord: { dataset: activeDataset.id, id: String(activeRecord[activeDataset.key]), scope: selection?.scope ?? "current" } } : {}),
  } : undefined, [definition, analysisQuery, state, domainPage, activeRecord, activeDataset, selection]);

  useEffect(() => { onContextRef.current(currentContext); }, [currentContext]);

  const addFilter = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!filterField || !filterValue.trim() || !selectedDataset) return;
    const field = selectedDataset.fields.find((item) => item.id === filterField);
    if (!field) return;
    let value: string | number | boolean = filterValue.trim();
    if (field.type === "number") {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) { setError(`${field.label}需要有效的数字。`); return; }
      value = numeric;
    } else if (field.type === "boolean") value = value === "true";
    const nextFilter: DataFilter = { dataset: selectedDataset.id, field: filterField, op: field.type === "string" ? "contains" : "eq", value };
    setQuery((current) => ({ ...current, filters: [...(current.filters ?? []).filter((item) => item.field !== filterField || item.dataset !== selectedDataset.id), nextFilter] }));
    setError("");
  }, [filterField, filterValue, selectedDataset]);

  const removeFilter = (index: number) => setQuery((current) => ({ ...current, filters: (current.filters ?? []).filter((_, item) => item !== index) }));

  function updateDateBound(bound: "from" | "to", value: string) {
    const dataset = selectedDataset;
    const dateField = dataset?.fields.find((field) => field.type === "date");
    if (!dataset || !dateField) return;
    setQuery((current) => {
      const rest = (current.filters ?? []).filter((filter) => !(filter.dataset === dataset.id && filter.field === dateField.id && filter.op === (bound === "from" ? "gte" : "lte")));
      return { ...current, filters: value ? [...rest, { dataset: dataset.id, field: dateField.id, op: bound === "from" ? "gte" : "lte", value }] : rest };
    });
  }

  function requestAction(item: ActionTransition) {
    if (!activeRecord || pending.current) return;
    const fields = actionFields(item, activeRecord, workflowDataset?.fields ?? []);
    const existing = Object.fromEntries(fields.flatMap((field) => {
      const value = activeRecord[field.id];
      return value === undefined || value === null ? [] : [[field.id, value]];
    }));
    setDraft(existing);
    setError("");
    setTransition(item);
  }

  async function confirmAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!transition || !activeRecord || !workflow || !workflowDataset || pending.current) return;
    const effectiveRecord = { ...activeRecord, ...draft };
    const missingRequirement = (transition.requiredFields ?? []).find((field) => effectiveRecord[field] === undefined || effectiveRecord[field] === null || effectiveRecord[field] === "");
    if (missingRequirement) { setError(`请补充必需信息：${workflowDataset.fields.find((field) => field.id === missingRequirement)?.label ?? missingRequirement}`); return; }
    const missingInput = (transition.inputFields ?? []).find((field) => field.required && (draft[field.id] === undefined || draft[field.id] === null || draft[field.id] === ""));
    if (missingInput) { setError(`请填写：${missingInput.label}`); return; }
    pending.current = true;
    const generation = actionGeneration.current;
    setSubmitting(true);
    setError("");
    const input: ActionRequest = {
      requestId: crypto.randomUUID(),
      recordId: String(activeRecord[workflowDataset.key]),
      actionId: transition.id,
      role,
      ...(domainPage ? { domainId: domainPage.id } : {}),
      expectedRevision: state.revision,
      state,
      ...(Object.keys(draft).length ? { input: draft } : {}),
    };
    try {
      const response = await api<ActionResult>("/api/actions", { method: "POST", body: JSON.stringify(input) });
      if (!mounted.current || generation !== actionGeneration.current) return;
      if (!isState(response.state) || !response.receipt?.simulated) throw new Error("服务端没有返回有效的模拟处理回执。");
      updateState(response.state);
      setReceipt(response.receipt);
      setTransition(null);
      setSelection({ dataset: workflowDataset.id, id: String(activeRecord[workflowDataset.key]) });
      navigateWithinDomain({ pageId: domainPage?.id ?? "solution", dataset: workflowDataset.id, recordId: String(activeRecord[workflowDataset.key]) });
    } catch (cause) {
      if (!mounted.current || generation !== actionGeneration.current) return;
      setError(cause instanceof Error ? cause.message : "操作失败；输入已保留，请检查后再试。");
    } finally {
      if (mounted.current && generation === actionGeneration.current) {
        pending.current = false;
        setSubmitting(false);
      }
    }
  }

  const views: ViewId[] = domainPage
    ? [
      ...(domainPage.components.includes("metrics") ? ["overview" as const] : []),
      ...(domainPage.components.includes("records") ? ["records" as const] : []),
      ...(domainPage.components.includes("workflow") ? ["workflow" as const] : []),
    ]
    : (definition?.views ?? []).filter((item): item is ViewId => item !== "assistant");
  const setOrigin = (origin: "separate" | "combined" | "synthetic" | "customer") => setQuery((current) => ({ ...current, origin: origin === "separate" ? undefined : origin }));

  if (loading && !definition) return <div className="me-workspace mw-frame"><div className="mw-empty">正在载入业务工作区…</div></div>;
  if (!definition) return <div className="me-workspace mw-frame"><div className="mw-empty">{error || "此 Demo 尚未配置业务工作区。"}</div></div>;

  const viewTitle: Record<ViewId, string> = { overview: "经营概览", records: "业务记录", workflow: "处理流程" };
  const title = view === "records" && selectedMetric?.dataset === datasetId ? "指标明细" : viewTitle[view];
  const dialogFields = transition ? actionFields(transition, activeRecord, workflowDataset?.fields ?? []) : [];

  function selectRecord(dataset: AnalysisResult["datasets"][number], row: DataRow, scope: "snapshot" | "current" = "current") {
    if (domainPage && !domainPage.components.includes("records")) return;
    setMetricDetailId(null);
    setDatasetId(dataset.id);
    const recordId = String(row[dataset.key]);
    setSelection({ dataset: dataset.id, id: recordId, scope });
    setView("records");
    navigateWithinDomain({ pageId: domainPage?.id ?? "solution", dataset: dataset.id, recordId });
  }

  function changeView(next: ViewId) {
    if (next === "workflow" && workflow && (!domainPage || domainPage.datasets.includes(workflow.dataset))) {
      setDatasetId(workflow.dataset);
      setSelection((current) => current?.dataset === workflow.dataset ? current : undefined);
      navigateWithinDomain({ pageId: domainPage?.id ?? "solution", dataset: workflow.dataset });
    }
    setView(next);
  }

  function navigateRelation(datasetId: string, recordId: string) {
    if (domainPage && !domainPage.datasets.includes(datasetId)) {
      const link = domainPage.links.find((item) => item.dataset === datasetId && (item.recordId === undefined || item.recordId === recordId));
      if (!link || !onNavigate) {
        setError("此关联目标未在当前方案中配置跨领域跳转。");
        return;
      }
      onNavigate(link.pageId, link.dataset, link.recordId ?? recordId);
      return;
    }
    setMetricDetailId(null);
    setDatasetId(datasetId);
    setSelection({ dataset: datasetId, id: recordId, scope: "current" });
    setQuery((current) => ({ ...current, filters: (current.filters ?? []).filter((filter) => !filter.dataset || filter.dataset === datasetId) }));
    if (!domainPage || domainPage.components.includes("records")) setView("records");
    navigateWithinDomain({ pageId: domainPage?.id ?? "solution", dataset: datasetId, recordId });
  }

  const content = (
    <>
      {domainPage && <header className="v3-domain-heading"><span>业务领域</span><h2>{domainPage.title}</h2><p>{domainPage.goal}</p></header>}
      {views.length > 1 && <div className="mw-tabs mw-domain-view-tabs" role="tablist" aria-label={`${domainPage?.title ?? "业务工作区"}内容`}>
        {views.map((item) => <button key={item} type="button" role="tab" aria-selected={view === item} onClick={() => changeView(item)}>{viewTitle[item]}</button>)}
      </div>}
      <div className={domainPage ? "mw-content v3-domain-content" : "mw-content"}>
        {error && <div className="mw-access-hint" role="status">{error}</div>}
        {storageWarning && <div className="mw-access-hint" role="status">{domainPage ? `此浏览器暂时无法保存「${domainPage.title}」的筛选与选择状态。` : "此浏览器暂时无法保存模拟进度；刷新页面后进度可能丢失。"}</div>}
        {domainPage && domainPage.links.length > 0 && <nav className="v3-related-links" aria-label="关联业务领域">
          {domainPage.links.map((link, index) => {
            const target = link.pageId === "solution" ? undefined : config.solution?.pages?.find((item) => item.id === link.pageId);
            return <button key={`${link.pageId}:${link.dataset ?? ""}:${link.recordId ?? index}`} type="button" onClick={() => {
              if (link.pageId === "solution") onNavigate?.("solution");
              else onNavigate?.(link.pageId, link.dataset, link.recordId);
            }}>
              <span>{link.label}</span><small>{target?.title ?? "方案总览"}{link.dataset ? ` · ${definition.datasets.find((dataset) => dataset.id === link.dataset)?.label ?? link.dataset}` : ""}</small><span aria-hidden="true">→</span>
            </button>;
          })}
        </nav>}
        {views.length > 0 && <>
          <div className="mw-toolbar">
            <div><h2>{title}</h2><p>{view === "overview" ? "指标由配置的数据记录计算；可以沿已配置的业务范围下钻。" : view === "records" && selectedMetric?.dataset === datasetId ? `${selectedMetric.description} · ${selectedMetric.scope === "snapshot" ? "历史快照" : "当前状态"}` : view === "records" ? "查看记录字段、数据来源与关联信息。" : "流程操作会产生模拟状态变化和回执，并更新当前运营指标。"}</p></div>
            {selectableDatasets.length > 0 && <select aria-label="当前数据集" value={datasetId} onChange={(event) => { setDatasetId(event.target.value); setSelection(undefined); setMetricDetailId(null); navigateWithinDomain({ pageId: domainPage?.id ?? "solution", dataset: event.target.value }); }}>
              {selectableDatasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.label}</option>)}
            </select>}
          </div>

          {config.execution?.data === "bigquery" && result?.dataBackend === "local" && <p className="mw-origin" role="note">本地治理统计 · 仅反映浏览器模拟任务，不是BigQuery经营事实。</p>}
          {scopedDatasets.length > 0 && <form className="mw-filter" onSubmit={addFilter}>
            <label>字段筛选
              <select aria-label="筛选字段" value={filterField} onChange={(event) => setFilterField(event.target.value)}>
                <option value="">选择字段</option>
                {selectedDataset?.fields.map((field) => <option key={field.id} value={field.id}>{field.label}</option>)}
              </select>
            </label>
            <input aria-label="筛选值" value={filterValue} onChange={(event) => setFilterValue(event.target.value)} placeholder="输入匹配值" />
            <button className="mw-button" type="submit" disabled={!filterField || !filterValue.trim()}>应用筛选</button>
            {selectedDataset?.fields.some((field) => field.type === "date") && <>
              <label>开始日期<input aria-label="开始日期" type="date" value={String(filters.find((filter) => filter.dataset === selectedDataset.id && selectedDataset.fields.some((field) => field.id === filter.field && field.type === "date") && filter.op === "gte")?.value ?? "").slice(0, 10)} onChange={(event) => updateDateBound("from", event.target.value)} /></label>
              <label>结束日期<input aria-label="结束日期" type="date" value={String(filters.find((filter) => filter.dataset === selectedDataset.id && selectedDataset.fields.some((field) => field.id === filter.field && field.type === "date") && filter.op === "lte")?.value ?? "").slice(0, 10)} onChange={(event) => updateDateBound("to", event.target.value)} /></label>
            </>}
            <select aria-label="数据来源" value={query.origin ?? "separate"} onChange={(event) => setOrigin(event.target.value as "separate" | "combined" | "synthetic" | "customer")}>
              <option value="separate">按来源分别统计</option><option value="synthetic">仅合成数据</option><option value="customer">仅客户资料</option><option value="combined">合并不同来源</option>
            </select>
            <span className="mw-origin">数据源与样本量会随结果展示</span>
          </form>}
          {filters.length > 0 && <div className="mw-action-row" aria-label="已选筛选条件">{filters.map((filter, index) => {
            const field = scopedDatasets.find((dataset) => dataset.id === filter.dataset)?.fields.find((candidate) => candidate.id === filter.field);
            return <button className="mw-button" type="button" key={`${filter.dataset}-${filter.field}-${index}`} onClick={() => removeFilter(index)}> {field?.label ?? filter.field} · {String(filter.value)} ×</button>;
          })}<button className="mw-button" type="button" onClick={() => setQuery((current) => ({ ...current, filters: [] }))}>清除筛选</button></div>}
          {loading && <p className="mw-metric-foot" role="status">正在刷新数据…</p>}

          {domainPage && definition && config.capabilities && <CapabilityPanel bindings={config.capabilities} pageId={domainPage.id} definition={definition} result={scopedResult} state={state} resetKey={resetKey} onState={updateState} />}

          {view === "overview" && <Overview result={scopedResult} allowRecords={!domainPage || domainPage.components.includes("records")} onSelect={(selectedDataset, row) => selectRecord(selectedDataset, row)} onMetric={(metricId, metricDatasetId, partition) => {
            if(partition) setQuery(current=>({...current,filters:[...(current.filters??[]).filter(item=>!(item.field===partition.field && item.dataset===metricDatasetId)),{field:partition.field,op:"eq",value:partition.value,dataset:metricDatasetId}]}));
            if (domainPage && !domainPage.components.includes("records")) return;
            setMetricDetailId(metricId); setDatasetId(metricDatasetId); setSelection(undefined); setView("records");
            navigateWithinDomain({ pageId: domainPage?.id ?? "solution", dataset: metricDatasetId });
          }} onViewRecords={() => { if (!domainPage || domainPage.components.includes("records")) setView("records"); }} />}
          {view === "records" && <Records result={scopedResult} dataset={selectedDataset} selected={metricRecord ?? selectedDataRow} metric={selectedMetric?.dataset === datasetId ? selectedMetric : undefined} onSelect={(row) => {
            const metricView = selectedMetric?.dataset === datasetId ? selectedMetric : undefined;
            const data = metricView ? metricDataset : filteredDataset;
            if (data) {
              const recordId = String(row[data.key]);
              setSelection({ dataset: data.id, id: recordId, scope: metricView?.scope ?? "current" });
              navigateWithinDomain({ pageId: domainPage?.id ?? "solution", dataset: data.id, recordId });
            }
          }} onNavigate={navigateRelation} />}
          {view === "workflow" && <WorkflowView definition={definition} result={scopedResult} workflow={workflow} dataset={workflowDataset} selected={workflowRecord} role={role} onRole={setRole} transitions={allowedTransitions} onSelect={(row) => {
            if (!workflowDataset) return;
            const recordId = String(row[workflowDataset.key]);
            setSelection({ dataset: workflowDataset.id, id: recordId, scope: "current" });
            navigateWithinDomain({ pageId: domainPage?.id ?? "solution", dataset: workflowDataset.id, recordId });
          }} onAction={requestAction} receipt={receipt} state={state} />}
        </>}
        {domainPage && views.length === 0 && <div className="v3-assistant-intro"><span>智能辅助</span><p>在页面下方与 {config.assistantName} 交流，围绕“{domainPage.title}”继续澄清和问答。</p></div>}
      </div>
      {transition && activeRecord && <div className="mw-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) setTransition(null); }}>
        <form className="mw-dialog" role="dialog" aria-modal="true" aria-labelledby="mw-dialog-title" onSubmit={confirmAction}>
          <h3 id="mw-dialog-title">确认模拟操作：{transition.label}</h3>
          <p>此操作只更新当前演示案例，并生成可回读的本地模拟回执。</p>
          <div className="mw-form-grid">{dialogFields.map((field) => { const required = field.required === true || transition.requiredFields?.includes(field.id) === true; return <label key={field.id}>{field.label}{required && <span aria-hidden="true"> · 必填</span>}{field.type === "boolean" ? <select value={String(draft[field.id] ?? false)} onChange={(event) => setDraft((current) => ({ ...current, [field.id]: event.target.value === "true" }))}><option value="false">否</option><option value="true">是</option></select> : field.type === "number" ? <input type="number" value={String(draft[field.id] ?? "")} required={required} onChange={(event) => setDraft((current) => ({ ...current, [field.id]: event.target.value === "" ? "" : Number(event.target.value) }))} /> : field.type === "date" ? <input type="date" value={String(draft[field.id] ?? "").slice(0, 10)} required={required} onChange={(event) => setDraft((current) => ({ ...current, [field.id]: event.target.value }))} /> : <textarea value={String(draft[field.id] ?? "")} required={required} onChange={(event) => setDraft((current) => ({ ...current, [field.id]: event.target.value }))} />}</label>; })}</div>
          {error && <p className="mw-error" role="alert">{error}</p>}
          <div className="mw-dialog-actions"><button className="mw-button" type="button" disabled={submitting} onClick={() => setTransition(null)}>取消</button><button className="mw-button primary" type="submit" disabled={submitting}>{submitting ? "处理中…" : "确认操作"}</button></div>
        </form>
      </div>}
    </>
  );

  return domainPage
    ? <section className="mw-domain-instance" aria-label={`${config.customer} · ${domainPage.title}`}>{content}</section>
    : <section className="me-workspace mw-frame" aria-label={`${config.customer}业务工作区`}><div className="mw-panel">
      <div className="mw-topline"><div className="mw-title-row"><span className="mw-mark"><IconChartBar size={18} /></span><div><h1>{config.customer}业务工作区</h1><p>{config.title} · 数据、处理与结果在同一案例中联动</p></div></div><span className="mw-demo-label">演示数据 · 本地模拟处理</span></div>
      {views.length > 0 && <div className="mw-tabs" role="tablist" aria-label="业务工作区">{views.map((item) => <button key={item} type="button" role="tab" aria-selected={view === item} onClick={() => setView(item)}>{viewTitle[item]}</button>)}</div>}
      {content}
    </div></section>;
}

function Overview({ result, allowRecords, onSelect, onMetric, onViewRecords }: { result: AnalysisResult | null; allowRecords: boolean; onSelect: (dataset: AnalysisResult["datasets"][number], row: DataRow) => void; onMetric: (metricId: string, datasetId: string, partition?: {field:string;value:string}) => void; onViewRecords: () => void }) {
  if (!result) return <div className="mw-empty">等待分析结果…</div>;
  const metrics = result.metrics.flatMap(metric => metric.partitions?.length ? metric.partitions.map(partition=>({...partition,label:`${metric.label} · ${partition.currency}`,unit:partition.currency,partitionField:metric.partitions ? (metric as AnalysisMetric & {currencyField?:string}).currencyField : undefined})) : [metric]);
  const trend = metrics.find((metric) => metric.trendGroups.length > 0);
  const categorical = metrics.find((metric) => metric.groups.length > 0);
  const rows = result.datasets.flatMap((dataset) => dataset.rows.map((row) => ({ row, dataset })));
  const trendGroups = trend?.trendGroups ?? [];
  const maxValue = Math.max(1, ...trendGroups.map((group) => Math.abs(group.value ?? 0)));
  const points = trendGroups.map((group, index) => {
    const x = trendGroups.length <= 1 ? 28 : 28 + index * (284 / (trendGroups.length - 1));
    const y = 145 - (Math.abs(group.value ?? 0) / maxValue) * 112;
    return `${x},${y}`;
  }).join(" ");
  const barMax = Math.max(1, ...(categorical?.groups ?? []).map((group) => Math.abs(group.value ?? 0)));
  const trendLabelEvery = Math.max(1, Math.ceil(trendGroups.length / 6));
  return <>
    <div className="mw-metrics">{metrics.map((metric) => allowRecords ? <button className="mw-metric" type="button" key={`${metric.id}:${metric.unit ?? ""}`} onClick={() => onMetric(metric.id, metric.dataset, "partitionField" in metric && metric.partitionField ? {field:String(metric.partitionField),value:metric.unit ?? ""} : undefined)} aria-label={`查看指标${metric.label}明细，${metric.sampleSize}条记录`}>
      <span className="mw-metric-label">{metric.label}</span>
      <div className="mw-metric-value">{formatMetricValue(metric.value, metric.unit)}</div>
      <p className="mw-metric-foot">{metric.notice ?? metric.description} · 样本 {metric.sampleSize} · {metric.scope === "snapshot" ? "历史快照" : "当前状态"} · {sourceLabel(metric.origin, metric.source)}</p>
    </button> : <article className="mw-metric" key={`${metric.id}:${metric.unit ?? ""}`}>
      <span className="mw-metric-label">{metric.label}</span>
      <div className="mw-metric-value">{formatMetricValue(metric.value, metric.unit)}</div>
      <p className="mw-metric-foot">{metric.notice ?? metric.description} · 样本 {metric.sampleSize} · {metric.scope === "snapshot" ? "历史快照" : "当前状态"} · {sourceLabel(metric.origin, metric.source)}</p>
    </article>)}</div>
    <div className="mw-chart-grid">
      <article className="mw-card"><h3>{trend?.label ?? "趋势分析"}</h3><p>{trend?.description ?? "配置 timeField 后展示时间趋势"}</p>
        {trendGroups.length > 0 ? <svg className="mw-chart" viewBox="0 0 320 175" role="img" aria-label={`${trend?.label ?? "指标"}趋势图`}>
          {[35, 72, 109, 146].map((y) => <line className="mw-gridline" key={y} x1="24" x2="310" y1={y} y2={y} />)}
          {points && <polyline className="mw-line" points={points} />}
          {trendGroups.map((group, index) => { const x = trendGroups.length <= 1 ? 28 : 28 + index * (284 / (trendGroups.length - 1)); const y = 145 - (Math.abs(group.value ?? 0) / maxValue) * 112; return <g key={group.label}><title>{`${group.label}：${formatMetricValue(group.value, trend?.unit)}，样本 ${group.sampleSize}`}</title><circle className="mw-point" cx={x} cy={y} r="3.5" />{index % trendLabelEvery === 0 || index === trendGroups.length - 1 ? <text x={x} y="165" textAnchor="middle">{group.label.slice(-5)}</text> : null}</g>; })}
        </svg> : <div className="mw-empty">此指标未配置时间维度，暂无趋势图。</div>}
      </article>
      <article className="mw-card"><h3>{categorical?.label ?? "分类分析"}</h3><p>{categorical?.description ?? "配置 groupBy 后展示分类对比"}</p>
        {(categorical?.groups.length ?? 0) > 0 ? <div className="mw-bars">{categorical!.groups.slice(0, 7).map((group) => <div className="mw-bar-item" key={group.label}><span title={group.label}>{group.label || "未标注"}</span><span className="mw-bar-rail"><span className="mw-bar-fill" style={{ width: `${Math.max(1, Math.abs(group.value ?? 0) / barMax * 100)}%` } as CSSProperties} /></span><span className="mw-bar-value">{formatMetricValue(group.value, categorical?.unit)}</span></div>)}</div> : <div className="mw-empty">当前筛选范围没有可对比的分类数据。</div>}
      </article>
    </div>
    {allowRecords && <div className="mw-card"><div className="mw-toolbar"><div><h3>关联业务记录</h3><p>从指标摘要下钻到对应记录，查看来源与处理状态。</p></div><button className="mw-button" type="button" onClick={onViewRecords}><IconTable size={14} /> 查看全部</button></div>
      {rows.length ? <DataTable rows={rows.slice(0, 8)} onSelect={(row) => { const entry = rows.find((item) => item.row === row); if (entry) onSelect(entry.dataset, row); }} /> : <div className="mw-empty">当前筛选没有匹配记录。</div>}
    </div>}
  </>;
}

function DataTable({ rows, onSelect }: { rows: Array<{ row: DataRow; dataset: DatasetDefinition }>; onSelect: (row: DataRow) => void }) {
  if (!rows.length) return <div className="mw-empty">此数据集暂无记录。</div>;
  const columns = [...new Map(rows.flatMap(({ dataset }) => dataset.fields.slice(0, 5).map((field) => [`${dataset.id}:${field.id}`, { dataset, field }] as const))).values()];
  return <div className="mw-table-wrap"><table className="mw-data-table"><thead><tr>{columns.map(({ dataset, field }) => <th key={`${dataset.id}:${field.id}`}>{field.label}</th>)}<th>数据来源</th></tr></thead><tbody>
    {rows.map(({ row, dataset }, index) => <tr key={`${dataset.id}:${String(row[dataset.key])}:${index}`} tabIndex={0} onClick={() => onSelect(row)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(row); } }}>
      {columns.map(({ dataset: owner, field }) => <td key={`${owner.id}:${field.id}`}>{owner.id === dataset.id ? formatValue(row[field.id], field.unit) : "—"}</td>)}<td><span className="mw-source">{dataset.origin === "customer" ? "客户资料" : "合成数据"}</span></td>
    </tr>)}
  </tbody></table></div>;
}

function Records({ result, dataset, selected, metric, onSelect, onNavigate }: { result: AnalysisResult | null; dataset: DatasetDefinition | undefined; selected: DataRow | undefined; metric: AnalysisResult["metrics"][number] | undefined; onSelect: (row: DataRow) => void; onNavigate: (dataset: string, id: string) => void }) {
  const data = result?.datasets.find((item) => item.id === dataset?.id);
  const rows = metric && metric.dataset === dataset?.id ? metric.rows : data?.rows ?? [];
  const current = selected && data && rows.find((row) => row[data.key] === selected[data.key]);
  if (!dataset || !data) return <div className="mw-empty">此数据集暂时没有可查看的记录。</div>;
  return <div className="mw-record-layout">
    <div><div className="mw-card"><h3>{metric ? `${metric.label} · ${dataset.label}` : dataset.label}</h3><p>{sourceLabel(dataset.origin, metric?.sources.join("、") || metric?.source || dataset.source)} · {metric ? `${metric.scope === "snapshot" ? "历史快照" : "当前状态"} · 指标匹配 ${rows.length} 条` : `共 ${data.total} 条记录`}</p><div style={{ marginTop: 14 }}><DataTable rows={rows.map((row) => ({ row, dataset }))} onSelect={onSelect} /></div></div>
      {dataset.relations?.length ? <div className="mw-card" style={{ marginTop: 12 }}><h3>关联业务记录</h3>{current ? dataset.relations.map((relation) => {
        const target = result?.datasets.find((item) => item.id === relation.dataset);
        const value = current[relation.field];
        const matches = target?.rows.filter((row) => row[relation.target] === value) ?? [];
        return <div className="mw-relation" key={`${relation.field}:${relation.dataset}`}><p>{dataset.fields.find((field) => field.id === relation.field)?.label ?? relation.field} = {formatValue(value)} · {target?.label ?? relation.dataset}</p>{matches.length ? matches.map((row) => <button className="mw-button" type="button" key={String(row[target!.key])} onClick={() => onNavigate(target!.id, String(row[target!.key]))}>打开关联记录 {String(row[target!.key])} →</button>) : <p className="mw-metric-foot">当前筛选范围内没有匹配记录。</p>}</div>;
      }) : <p className="mw-metric-foot">选择一条记录后，可查看并打开关联对象。</p>}</div> : null}
    </div>
    <aside className="mw-record-detail"><h3>{current ? `记录 ${formatValue(current[data.key])}` : "选择一条记录"}</h3><p>{current ? sourceLabel(dataset.origin, dataset.source) : "点击左侧记录查看字段详情。"}</p>{current && <dl className="mw-detail-list">{dataset.fields.map((field) => <div className="mw-detail-row" key={field.id}><dt>{field.label}</dt><dd>{formatValue(current[field.id], field.unit)}</dd></div>)}</dl>}</aside>
  </div>;
}

function WorkflowView({ definition, result, workflow, dataset, selected, role, onRole, transitions, onSelect, onAction, receipt, state }: {
  definition: WorkspaceDefinition; result: AnalysisResult | null; workflow: WorkspaceDefinition["workflow"];
  dataset: AnalysisResult["datasets"][number] | undefined; selected: DataRow | undefined; role: string;
  onRole: (role: string) => void; transitions: ActionTransition[]; onSelect: (row: DataRow) => void;
  onAction: (transition: ActionTransition) => void; receipt: ActionResult["receipt"] | null; state: WorkspaceState;
}) {
  if (!workflow || !dataset) return <div className="mw-empty">此业务方案未配置模拟处理流程。</div>;
  const current = selected && dataset.rows.find((row) => row[dataset.key] === selected[dataset.key]);
  const stage = String(current?.[workflow.statusField] ?? "");
  const stale = current?.[workflow.staleField ?? "__stale"] === true;
  const latestEvents = [...state.events].reverse().slice(0, 8);
  return <div className="mw-workflow">
    <div><div className="mw-toolbar"><div><h3>待处理记录</h3><p>处理动作会回写到此演示会话，并重新计算相关指标。</p></div>
      <label className="mw-metric-foot">演示视角 <select aria-label="演示角色视角" value={role} onChange={(event) => onRole(event.target.value)}>{definition.roles.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    </div>
      <div className="mw-flow-list">{dataset.rows.map((row) => <button className="mw-flow-item" data-selected={current?.[dataset.key] === row[dataset.key]} key={String(row[dataset.key])} type="button" onClick={() => onSelect(row)}>
        <span><strong>{formatValue(row[dataset.key])} · {formatValue(row["title"] ?? row["customer"] ?? row["issue"] ?? row["name"] ?? "业务记录")}</strong><small>{row[workflow.staleField ?? "__stale"] === true ? "建议需重新核对" : "查看进度与可用操作"}</small></span>
        <span className="mw-status">{definition.stages.find((item) => item.id === row[workflow.statusField])?.label ?? formatValue(row[workflow.statusField])}</span>
      </button>)}</div>
    </div>
    <div className="mw-flow-detail">{current ? <>
      <h3>记录 {formatValue(current[dataset.key])}</h3><p>{sourceLabel(dataset.origin, dataset.source)} · 更新版本 {formatValue(current.__revision ?? state.revision)}</p>
      <div className="mw-stage-line">{definition.stages.map((item, index) => <span key={item.id} style={{ display: "contents" }}><span className="mw-stage-chip" aria-current={item.id === stage ? "step" : undefined}>{item.label}</span>{index < definition.stages.length - 1 && <span className="mw-stage-arrow"><IconChevronRight size={12} /></span>}</span>)}</div>
      {stale && <div className="mw-access-hint">业务条件已修改，当前建议已失效。请先重新核对再继续后续动作。</div>}
      {transitions.length ? <div className="mw-action-row">{transitions.map((item) => <button className="mw-button primary" type="button" key={item.id} onClick={() => onAction(item)}>{item.label}</button>)}</div> : <p>当前角色在此阶段没有可执行的演示操作。</p>}
      {receipt && receipt.recordId === String(current[dataset.key]) && <div className="mw-receipt" role="status"><IconCircleCheck size={14} /> {receipt.label}已完成。状态：{definition.stages.find((item) => item.id === receipt.from)?.label ?? receipt.from} → {definition.stages.find((item) => item.id === receipt.to)?.label ?? receipt.to}。此操作仅在演示会话中模拟。</div>}
      <div className="mw-detail-list">{dataset.fields.map((field) => <div className="mw-detail-row" key={field.id}><dt>{field.label}</dt><dd>{formatValue(current[field.id], field.unit)}</dd></div>)}</div>
    </> : <><h3>选择待处理记录</h3><p>左侧记录会显示共享案例中的阶段和处理状态。</p></>}
      <div className="mw-activity"><h3>操作记录 · {latestEvents.length} 条</h3>{latestEvents.length ? latestEvents.map((event, index) => <p className="mw-activity-item" key={`${event.requestId}:${index}`}><strong>{workflow.transitions.find((item) => item.id === event.actionId)?.label ?? event.actionId}</strong> · {event.recordId} · {definition.roles.find((item) => item.id === event.role)?.label ?? event.role} · {new Date(event.at).toLocaleString("zh-CN")}</p>) : <p className="mw-activity-item">尚无处理记录。</p>}</div>
    </div>
  </div>;
}
