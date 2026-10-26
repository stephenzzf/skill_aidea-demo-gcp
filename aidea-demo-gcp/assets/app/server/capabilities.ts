import type { DemoSpec, Scenario } from '../shared/spec.ts';
import type { CapabilityBinding, MappingReviewCapability, WorkItemsCapability } from '../shared/capabilities.ts';
import { isPlannedDomain, resolveDomainContext, resolveDomainPage } from '../shared/solution.ts';
import type {
  ActionEvent, ActionRequest, ActionResult, AnalysisMetric, AnalysisQuery, AnalysisResult, DataFilter, DataRow,
  DatasetDefinition, FieldDefinition, WorkspaceData, WorkspaceDefinition, WorkspaceState,
} from '../shared/workspace.ts';
import { isValidIsoDate } from '../shared/workspace.ts';
import { analyze, applyEvent, materialize, stateValid } from './workspace.ts';

type CapabilitySpec = DemoSpec & { capabilities?: CapabilityBinding[] };
type Receipt = ActionResult['receipt'];

const rowsFor = (data: WorkspaceData, datasetId: string) => data.datasets.find(dataset => dataset.id === datasetId)?.rows ?? [];
const schemaFor = (workspace: WorkspaceDefinition, datasetId: string) => workspace.datasets.find(dataset => dataset.id === datasetId);
const keyOf = (value: unknown) => `${typeof value}:${String(value)}`;
const cloneData = (data: WorkspaceData): WorkspaceData => ({ datasets: data.datasets.map(dataset => ({ id: dataset.id, rows: dataset.rows.map(row => ({ ...row })) })) });
const emptyState = (): WorkspaceState => ({ revision: 0, events: [] });

function configuredWorkspace(spec: DemoSpec): WorkspaceDefinition {
  if (!spec.workspace) throw new Error('工作区未启用');
  return spec.workspace;
}

function capabilitiesOf(spec: DemoSpec): CapabilityBinding[] {
  return (spec as CapabilitySpec).capabilities ?? [];
}

function capabilityForAction(spec: DemoSpec, actionId: string): CapabilityBinding | undefined {
  return capabilitiesOf(spec).find(binding => binding.kind === 'mapping-review' ? `review-${binding.id}` === actionId
    : binding.kind === 'work-items' ? `create-${binding.id}` === actionId : false);
}

function pageFor(spec: DemoSpec, domainId: string) {
  const page = resolveDomainPage(spec, domainId);
  if (!page) throw new Error(`业务页面未配置：${domainId}`);
  if (page.id !== 'solution' && isPlannedDomain(page, spec.design?.coverage ?? [])) throw new Error('该领域为后续接入，当前仅展示方案说明');
  return page;
}

function validateCapabilityScope(spec: DemoSpec, binding: CapabilityBinding, domainId: string | undefined): void {
  if (spec.version !== 4) throw new Error('业务能力仅支持 V4 演示');
  if (!domainId) throw new Error('请选择已配置的业务页面');
  const page = pageFor(spec, domainId);
  if (!binding.pages.includes(page.id)) throw new Error(`能力 ${binding.id} 未在页面 ${page.id} 启用`);
}

function hasActiveCapabilityPage(spec: DemoSpec, binding: CapabilityBinding): boolean {
  const pages = spec.pages ?? [];
  const byId = new Map(pages.map(page => [page.id, page] as const));
  const activeIds = new Set(pages.filter(page => !isPlannedDomain(page, spec.design?.coverage ?? [])).map(page => page.id));
  for (const pageId of binding.pages) if (!byId.has(pageId)) throw new Error(`能力 ${binding.id} 引用了不存在的页面 ${pageId}`);
  return binding.pages.some(pageId => activeIds.has(pageId));
}

function capabilityInAnalysisScope(spec: DemoSpec, binding: CapabilityBinding, pageId?: string): boolean {
  if (pageId && pageId !== 'solution') return binding.pages.includes(pageId);
  return hasActiveCapabilityPage(spec, binding);
}

function validateWorkspaceData(workspace: WorkspaceDefinition, data: WorkspaceData): void {
  const dataIds = new Set(data.datasets.map(dataset => dataset.id));
  if (dataIds.size !== data.datasets.length || workspace.datasets.some(dataset => !dataIds.has(dataset.id)) || data.datasets.some(dataset => !schemaFor(workspace, dataset.id))) {
    throw new Error('场景数据集必须与工作区配置一一对应');
  }
}

function valueMatches(value: unknown, field: FieldDefinition): boolean {
  if (value === null) return true;
  if (field.type === 'string') return typeof value === 'string';
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (field.type === 'boolean') return typeof value === 'boolean';
  return isValidIsoDate(value);
}

function safeKeyValue(recordId: string, field: FieldDefinition): string | number | boolean {
  if (!recordId.trim()) throw new Error('recordId 无效');
  if (field.type === 'string') return recordId;
  if (field.type === 'number') {
    const value = Number(recordId);
    if (!Number.isFinite(value) || String(value) !== recordId) throw new Error('recordId 与主键类型不匹配');
    return value;
  }
  if (field.type === 'boolean' && (recordId === 'true' || recordId === 'false')) return recordId === 'true';
  if (field.type === 'date' && isValidIsoDate(recordId)) return recordId;
  throw new Error('recordId 与主键类型不匹配');
}

function validateRelations(workspace: WorkspaceDefinition, data: WorkspaceData, schema: DatasetDefinition, row: DataRow): void {
  for (const relation of schema.relations ?? []) {
    const reference = row[relation.field];
    if (reference === null || reference === undefined || reference === '') continue;
    const targetSchema = schemaFor(workspace, relation.dataset);
    if (!targetSchema) throw new Error(`关系 ${schema.id}.${relation.field} 的目标数据集不存在`);
    const targetRows = rowsFor(data, relation.dataset);
    if (!targetRows.some(target => keyOf(target[relation.target]) === keyOf(reference))) {
      throw new Error(`输入的 ${relation.field} 无法关联到 ${targetSchema.label}，操作未生效`);
    }
  }
}

function assertRequiredFields(schema: DatasetDefinition, row: DataRow, label: string): void {
  for (const field of schema.fields) {
    const value = row[field.id];
    if (field.required && (value === null || value === undefined || value === '')) throw new Error(`${label}需要补齐 ${field.label}`);
    if (value !== undefined && !valueMatches(value, field)) throw new Error(`${label}的 ${field.label} 类型无效`);
  }
}

function assertEventInput(input: unknown): Record<string, string | number | boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('动作输入必须是对象');
  const normalized: Record<string, string | number | boolean> = {};
  for (const [field, value] of Object.entries(input as Record<string, unknown>)) {
    if (['__proto__', 'constructor', 'prototype'].includes(field) || !(typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean')) {
      throw new Error(`动作输入 ${field} 无效`);
    }
    normalized[field] = value;
  }
  return normalized;
}

function mappingReviewInput(binding: MappingReviewCapability, workspace: WorkspaceDefinition, input: unknown): { target: string | number | boolean; evidence: string } {
  const values = assertEventInput(input ?? {});
  const unexpected = Object.keys(values).find(field => field !== 'target' && field !== 'evidence');
  if (unexpected) throw new Error(`映射复核不支持输入 ${unexpected}`);
  const target = values.target;
  const evidence = values.evidence;
  const schema = schemaFor(workspace, binding.dataset)!;
  const targetField = schema.fields.find(field => field.id === binding.targetField)!;
  if (target === undefined || !valueMatches(target, targetField) || target === '') throw new Error('请选择有效的映射目标');
  if (typeof evidence !== 'string' || !evidence.trim()) throw new Error('请填写映射依据');
  return { target, evidence };
}

function workItemInput(binding: WorkItemsCapability, workspace: WorkspaceDefinition, input: unknown): Record<string, string | number | boolean> {
  const values = assertEventInput(input ?? {});
  const allowed = new Set(binding.inputFields);
  for (const [fieldId, value] of Object.entries(values)) {
    if (!allowed.has(fieldId)) throw new Error(`工作项不支持输入字段 ${fieldId}`);
    const field = schemaFor(workspace, binding.dataset)!.fields.find(candidate => candidate.id === fieldId)!;
    if (!valueMatches(value, field)) throw new Error(`工作项输入 ${fieldId} 与字段类型不匹配`);
  }
  return values;
}

function markLinkedWorkItemsStale(spec: DemoSpec, workspace: WorkspaceDefinition, data: WorkspaceData, binding: MappingReviewCapability, mappingRow: DataRow): void {
  const workflow = workspace.workflow;
  if (!workflow?.staleField) return;
  const mappingSchema = schemaFor(workspace, binding.dataset)!;
  const mappingKey = mappingRow[mappingSchema.key];
  const workItems = capabilitiesOf(spec).filter((candidate): candidate is WorkItemsCapability => candidate.kind === 'work-items' && candidate.dataset === workflow.dataset);
  if (!workItems.length) return;
  const workSchema = schemaFor(workspace, workflow.dataset)!;
  const linksToMapping = (workSchema.relations ?? []).filter(relation => relation.dataset === binding.dataset);
  const affectedRows = binding.dataset === workflow.dataset ? [mappingRow] : linksToMapping.length
    ? rowsFor(data, workflow.dataset).filter(row => linksToMapping.some(relation => keyOf(row[relation.field]) === keyOf(mappingKey)))
    : [];
  for (const row of affectedRows) row[workflow.staleField] = true;
}

function executeMappingReview(spec: DemoSpec, workspace: WorkspaceDefinition, data: WorkspaceData, binding: MappingReviewCapability, event: ActionEvent, revision: number): Receipt {
  if (event.role !== binding.role) throw new Error('当前角色不能执行此操作');
  const schema = schemaFor(workspace, binding.dataset)!;
  const rows = rowsFor(data, binding.dataset);
  const row = rows.find(candidate => String(candidate[schema.key]) === event.recordId);
  if (!row) throw new Error('找不到对应的映射记录');
  if (binding.statusField && row[binding.statusField] === binding.resolvedStatus) throw new Error('该映射已核实，不能覆盖');
  if (!binding.statusField && row[binding.targetField] !== null && row[binding.targetField] !== undefined && row[binding.targetField] !== '') {
    throw new Error('该映射已有目标，不能覆盖');
  }
  const { target, evidence } = mappingReviewInput(binding, workspace, event.input);
  const relation = (schema.relations ?? []).find(candidate => candidate.field === binding.targetField && candidate.dataset === binding.targetDataset)!;
  const targetSchema = schemaFor(workspace, binding.targetDataset)!;
  if (!rowsFor(data, binding.targetDataset).some(candidate => keyOf(candidate[relation.target]) === keyOf(target))) {
    throw new Error(`目标无法关联到 ${targetSchema.label}`);
  }
  const from = row[binding.targetField] === null || row[binding.targetField] === undefined ? '' : String(row[binding.targetField]);
  const changed = keyOf(row[binding.targetField]) !== keyOf(target);
  row[binding.targetField] = target;
  row[binding.evidenceField] = evidence;
  if (binding.statusField && binding.resolvedStatus) row[binding.statusField] = binding.resolvedStatus;
  if (changed) markLinkedWorkItemsStale(spec, workspace, data, binding, row);
  return { requestId: event.requestId, recordId: event.recordId, actionId: event.actionId, label: binding.label,
    from, to: String(target), revision, simulated: true, at: event.at };
}

function executeWorkItemCreate(workspace: WorkspaceDefinition, data: WorkspaceData, binding: WorkItemsCapability, event: ActionEvent, revision: number): Receipt {
  const workflow = workspace.workflow;
  if (!workflow || workflow.dataset !== binding.dataset) throw new Error('工作项没有绑定到当前工作流数据集');
  if (event.role !== binding.role) throw new Error('当前角色不能执行此操作');
  const schema = schemaFor(workspace, binding.dataset)!;
  const keyField = schema.fields.find(field => field.id === schema.key)!;
  const key = safeKeyValue(event.recordId, keyField);
  const rows = rowsFor(data, binding.dataset);
  if (rows.some(row => keyOf(row[schema.key]) === keyOf(key))) throw new Error('工作项 recordId 已存在');
  const input = workItemInput(binding, workspace, event.input);
  const row: DataRow = { ...binding.defaults, ...input, [schema.key]: key };
  if (workflow.staleField && row[workflow.staleField] === undefined) row[workflow.staleField] = false;
  const status = row[workflow.statusField];
  if (typeof status !== 'string' || !workflow.transitions.some(transition => transition.from.includes(status))) throw new Error('工作项初始状态不能执行已配置流程');
  assertRequiredFields(schema, row, '工作项');
  validateRelations(workspace, data, schema, row);
  row.__revision = revision;
  rows.push(row);
  return { requestId: event.requestId, recordId: event.recordId, actionId: event.actionId, label: binding.label,
    from: '', to: status, revision, simulated: true, at: event.at };
}

function executeCapabilityEvent(spec: DemoSpec, workspace: WorkspaceDefinition, data: WorkspaceData, event: ActionEvent, revision: number): Receipt {
  const binding = capabilityForAction(spec, event.actionId);
  if (!binding) throw new Error(`能力动作未配置：${event.actionId}`);
  if (spec.version !== 4 || !hasActiveCapabilityPage(spec, binding)) throw new Error(`能力 ${binding.id} 没有可执行的非 planned 页面`);
  if (binding.kind === 'mapping-review') return executeMappingReview(spec, workspace, data, binding, event, revision);
  if (binding.kind === 'work-items') return executeWorkItemCreate(workspace, data, binding, event, revision);
  throw new Error(`能力动作类型不支持写入：${binding.kind}`);
}

function validateState(state: WorkspaceState | undefined): WorkspaceState {
  const actual = state ?? emptyState();
  stateValid(actual);
  return actual;
}

/** Replays capability and ordinary workflow events in their original order on a detached copy. */
export function materializeCapabilities(spec: DemoSpec, data: WorkspaceData, state: WorkspaceState): WorkspaceData {
  const workspace = configuredWorkspace(spec);
  validateWorkspaceData(workspace, data);
  const actualState = validateState(state);
  const capabilities = capabilitiesOf(spec);
  if (capabilities.length && spec.version !== 4) throw new Error('业务能力仅支持 V4 演示');
  if (!capabilities.length) return materialize(workspace, data, actualState);
  const result = cloneData(data);
  const workflowActions = new Set(workspace.workflow?.transitions.map(transition => transition.id) ?? []);
  for (const [index, event] of actualState.events.entries()) {
    const revision = index + 1;
    if (workflowActions.has(event.actionId)) applyEvent(workspace, result, event, revision);
    else executeCapabilityEvent(spec, workspace, result, event, revision);
  }
  const workflow = workspace.workflow;
  if (workflow?.staleField) for (const row of rowsFor(result, workflow.dataset)) if (row[workflow.staleField] === undefined) row[workflow.staleField] = false;
  return result;
}

function analysisScope(spec: DemoSpec, query: AnalysisQuery, domainId?: string) {
  if (!domainId) return { query, scope: undefined as { datasets: string[]; metrics: string[] } | undefined, pageId: undefined };
  const page = pageFor(spec, domainId);
  const resolved = resolveDomainContext(spec, { domainId, query });
  if (!resolved) throw new Error(`业务页面上下文无效：${domainId}`);
  return { query: resolved.query, scope: { datasets: page.datasets, metrics: page.metrics }, pageId: page.id };
}

function partitionCurrencies(metric: AnalysisMetric, currencyField: string): { currencies: string[]; missing: number } {
  const currencies = new Set<string>();
  let missing = 0;
  for (const row of metric.rows) {
    const value = row[currencyField];
    if (typeof value !== 'string' || !value.trim()) missing++;
    else currencies.add(value);
  }
  return { currencies: [...currencies].sort((left, right) => left.localeCompare(right)), missing };
}

/** Uses the canonical analyzer for every currency partition and leaves snapshot data untouched. */
export function analyzeCapabilities(spec: DemoSpec, scenario: Scenario, query: AnalysisQuery, state: WorkspaceState, domainId?: string): AnalysisResult {
  const workspace = configuredWorkspace(spec);
  if (!scenario.workspace) throw new Error('场景未配置工作区数据');
  if (capabilitiesOf(spec).length && spec.version !== 4) throw new Error('业务能力仅支持 V4 演示');
  const actualState = validateState(state);
  const { query: scopedQuery, scope, pageId } = analysisScope(spec, query, domainId);
  const current = materializeCapabilities(spec, scenario.workspace, actualState);
  const result = analyze(workspace, scenario.workspace, scopedQuery, actualState, scope, current);
  const applicable = capabilitiesOf(spec).filter((binding): binding is Extract<CapabilityBinding, { kind: 'partitioned-analysis' }> =>
    binding.kind === 'partitioned-analysis' && capabilityInAnalysisScope(spec, binding, pageId));
  if (!applicable.length) return result;
  const byDataset = new Map<string, string>();
  for (const binding of applicable) {
    const currentField = byDataset.get(binding.dataset);
    if (currentField && currentField !== binding.currencyField) throw new Error(`数据集 ${binding.dataset} 配置了多个币种字段`);
    byDataset.set(binding.dataset, binding.currencyField);
  }
  const fullResult = scopedQuery.limit === undefined ? result : analyze(workspace, scenario.workspace,
    { ...scopedQuery, limit: undefined }, actualState, scope, current);
  const metrics = result.metrics.map(metric => {
    const currencyField = byDataset.get(metric.dataset);
    if (!currencyField) return metric;
    const fullMetric = fullResult.metrics.find(candidate => candidate.id === metric.id) ?? metric;
    const { currencies, missing } = partitionCurrencies(fullMetric, currencyField);
    const partitions = currencies.map(currency => {
      const filter: DataFilter = { dataset: metric.dataset, field: currencyField, op: 'eq', value: currency };
      const partitionResult = analyze(workspace, scenario.workspace!, { ...scopedQuery, filters: [...(scopedQuery.filters ?? []), filter] }, actualState, scope, current);
      const partition = partitionResult.metrics.find(candidate => candidate.id === metric.id);
      if (!partition) throw new Error(`币种分区未返回指标 ${metric.id}`);
      return { ...partition, currency };
    });
    const notices = [metric.notice, '按原币种分区展示，不计算跨币种合计。'];
    if (missing) notices.push(`${missing} 条符合条件的记录缺少币种，未计入币种分区。`);
    return { ...metric, value: null, groups: [], trendGroups: [], partitions, currencyField,
      notice: notices.filter(Boolean).join(' ') };
  });
  return { ...result, metrics };
}

function actionEventFromRequest(request: ActionRequest, input: Record<string, string | number | boolean>): ActionEvent {
  return { requestId: request.requestId, recordId: request.recordId, actionId: request.actionId, role: request.role, input, at: new Date().toISOString() };
}

function sameCommand(event: ActionEvent, request: ActionRequest, input: Record<string, string | number | boolean>): boolean {
  const storedKeys = Object.keys(event.input).sort();
  const requestKeys = Object.keys(input).sort();
  return event.recordId === request.recordId && event.actionId === request.actionId && event.role === request.role
    && storedKeys.length === requestKeys.length && storedKeys.every((key, index) => key === requestKeys[index] && event.input[key] === input[key]);
}

function inputForRequest(spec: DemoSpec, workspace: WorkspaceDefinition, request: ActionRequest): Record<string, string | number | boolean> {
  const binding = capabilityForAction(spec, request.actionId);
  if (binding?.kind === 'mapping-review') return mappingReviewInput(binding, workspace, request.input);
  if (binding?.kind === 'work-items') return workItemInput(binding, workspace, request.input);
  return assertEventInput(request.input ?? {});
}

function domainScopeForAction(spec: DemoSpec, request: ActionRequest, binding?: CapabilityBinding): void {
  if (binding) {
    validateCapabilityScope(spec, binding, request.domainId);
    return;
  }
  if (spec.version === 4) {
    if (!request.domainId) throw new Error('请选择已配置的业务页面');
    const page = pageFor(spec, request.domainId);
    if (!page.actions.includes(request.actionId)) throw new Error(`动作 ${request.actionId} 未在页面 ${page.id} 启用`);
  }
}

function executeWorkflowEvent(workspace: WorkspaceDefinition, data: WorkspaceData, event: ActionEvent, revision: number): Receipt {
  return applyEvent(workspace, data, event, revision);
}

/** Applies an existing workflow transition or a declared V4 capability action. */
export function applyCapabilityAction(spec: DemoSpec, scenario: Scenario, request: ActionRequest): ActionResult {
  const workspace = configuredWorkspace(spec);
  if (!scenario.workspace) throw new Error('场景未配置工作区数据');
  validateWorkspaceData(workspace, scenario.workspace);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(request.requestId)) throw new Error('requestId 格式无效');
  const state = validateState(request.state);
  const binding = capabilityForAction(spec, request.actionId);
  const workflowTransition = workspace.workflow?.transitions.find(transition => transition.id === request.actionId);
  if (!binding && !workflowTransition) throw new Error(`动作未配置：${request.actionId}`);
  domainScopeForAction(spec, request, binding);
  const expectedRole = binding && binding.kind !== 'partitioned-analysis' ? binding.role : workflowTransition?.role;
  if (!expectedRole || expectedRole !== request.role) throw new Error('当前角色不能执行此操作');
  if (binding?.kind === 'partitioned-analysis') throw new Error('分析能力不能作为业务动作执行');
  if (typeof request.recordId !== 'string' || !request.recordId.trim()) throw new Error('recordId 无效');
  const input = inputForRequest(spec, workspace, request);
  const duplicateIndex = state.events.findIndex(event => event.requestId === request.requestId);
  if (duplicateIndex >= 0) {
    const duplicate = state.events[duplicateIndex];
    if (!sameCommand(duplicate, request, input)) throw new Error('requestId 已用于其他操作');
    materializeCapabilities(spec, scenario.workspace, state);
    const prefix = { revision: duplicateIndex, events: state.events.slice(0, duplicateIndex) };
    const replayData = materializeCapabilities(spec, scenario.workspace, prefix);
    const replayEvent = { ...duplicate, input: { ...duplicate.input } };
    const receipt = binding ? executeCapabilityEvent(spec, workspace, replayData, replayEvent, duplicateIndex + 1)
      : executeWorkflowEvent(workspace, replayData, replayEvent, duplicateIndex + 1);
    return { state: { revision: state.revision, events: state.events.map(event => ({ ...event, input: { ...event.input } })) }, receipt };
  }
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision !== state.revision) throw new Error('演示状态已变化，请刷新后重试');
  const current = materializeCapabilities(spec, scenario.workspace, state);
  const event = actionEventFromRequest(request, input);
  const nextData = cloneData(current);
  const revision = state.revision + 1;
  const receipt = binding ? executeCapabilityEvent(spec, workspace, nextData, event, revision)
    : executeWorkflowEvent(workspace, nextData, event, revision);
  return { state: { revision, events: [...state.events.map(item => ({ ...item, input: { ...item.input } })), event] }, receipt };
}

type ChatMetricPartition = Omit<AnalysisMetric, 'rows' | 'partitions'> & {
  currency?: string;
};
type ChatMetric = Omit<AnalysisMetric, 'rows' | 'partitions'> & {
  partitions?: ChatMetricPartition[];
};

/** Removes record-level rows before sending analysis context to chat. */
export function capabilityChatSummary(result: AnalysisResult): {
  filters: AnalysisResult['filters'];
  metrics: ChatMetric[];
  sources: Array<{ id: string; label: string; origin: string; source: string; total: number }>;
} {
  const metrics: ChatMetric[] = result.metrics.map(metric => {
    const { rows: _rows, partitions, ...summary } = metric;
    return { ...summary, ...(partitions ? { partitions: partitions.map(({ rows: _partitionRows, ...partition }) => partition) } : {}) };
  });
  return { filters: result.filters, metrics, sources: result.datasets.map(dataset => ({ id: dataset.id, label: dataset.label,
    origin: dataset.origin, source: dataset.source, total: dataset.total })) };
}
