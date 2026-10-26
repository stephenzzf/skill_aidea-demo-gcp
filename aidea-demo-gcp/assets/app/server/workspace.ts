import type {
  ActionEvent, ActionRequest, ActionResult, AnalysisMetric, AnalysisQuery, AnalysisResult,
  DataFilter, DataOrigin, DataRow, DatasetDefinition, FieldDefinition, MetricDefinition,
  WorkspaceData, WorkspaceDefinition, WorkspaceState,
} from '../shared/workspace.ts';
import { isValidIsoDate } from '../shared/workspace.ts';

const keyOf = (value: unknown) => `${typeof value}:${String(value)}`;
const rowsFor = (data: WorkspaceData, id: string) => data.datasets.find(dataset => dataset.id === id)?.rows ?? [];
const schemaFor = (workspace: WorkspaceDefinition, id: string) => workspace.datasets.find(dataset => dataset.id === id);
const cloneData = (data: WorkspaceData): WorkspaceData => ({ datasets: data.datasets.map(d => ({ id: d.id, rows: d.rows.map(row => ({ ...row })) })) });

export function stateValid(state: WorkspaceState): void {
  if (!state || !Number.isSafeInteger(state.revision) || state.revision !== state.events?.length || !Array.isArray(state.events)) {
    throw new Error('演示状态版本无效，请刷新后重试');
  }
  const ids = new Set<string>();
  for (const [i, event] of state.events.entries()) {
    if (!event || !/^[a-zA-Z0-9_-]{8,100}$/.test(event.requestId) || !event.recordId || !event.actionId || !event.role || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(event.at) || !Number.isFinite(Date.parse(event.at)) || !event.input || typeof event.input !== 'object' || Array.isArray(event.input)) throw new Error(`演示状态第 ${i + 1} 条记录无效`);
    if (ids.has(event.requestId)) throw new Error('演示状态包含重复 requestId');
    ids.add(event.requestId);
  }
}

function transitionFor(workflow: NonNullable<WorkspaceDefinition['workflow']>, actionId: string) {
  return workflow.transitions.find(transition => transition.id === actionId);
}
function inputField(workflow: NonNullable<WorkspaceDefinition['workflow']>, transition: NonNullable<WorkspaceDefinition['workflow']>['transitions'][number], schema: DatasetDefinition, name: string): FieldDefinition | undefined {
  return transition.inputFields?.find(field => field.id === name) ?? ((workflow.editableFields ?? []).includes(name) ? schema.fields.find(field => field.id === name) : undefined);
}
function validValue(value: unknown, field: FieldDefinition): boolean {
  if (field.type === 'string') return typeof value === 'string';
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type !== 'date') return false;
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function normalizedInput(workflow: NonNullable<WorkspaceDefinition['workflow']>, transition: NonNullable<WorkspaceDefinition['workflow']>['transitions'][number], schema: DatasetDefinition, input: Record<string, string | number | boolean> = {}) {
  const result: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(input)) {
    const field = inputField(workflow, transition, schema, name);
    if (!field || ['__proto__', 'constructor', 'prototype'].includes(name) || !validValue(value, field)) throw new Error(`动作 ${transition.label} 的输入 ${name} 无效`);
    result[name] = value;
  }
  for (const field of transition.inputFields ?? []) {
    if (field.required && (result[field.id] === undefined || result[field.id] === '')) throw new Error(`请填写${field.label}`);
  }
  return result;
}

export function applyEvent(workspace: WorkspaceDefinition, data: WorkspaceData, event: ActionEvent, revision: number) {
  const workflow = workspace.workflow;
  if (!workflow) throw new Error('当前演示没有可执行的业务操作');
  const schema = schemaFor(workspace, workflow.dataset)!;
  const rows = rowsFor(data, workflow.dataset);
  const transition = transitionFor(workflow, event.actionId);
  if (!transition || transition.role !== event.role) throw new Error('当前角色不能执行此操作');
  const row = rows.find(candidate => String(candidate[schema.key]) === String(event.recordId));
  if (!row) throw new Error('找不到对应的演示记录');
  const from = row[workflow.statusField];
  if (typeof from !== 'string' || !transition.from.includes(from)) throw new Error(`记录当前状态无法执行“${transition.label}”`);
  if (transition.requireFresh && workflow.staleField && row[workflow.staleField] === true) throw new Error('需求有更新，请先重新核对当前建议');
  const input = normalizedInput(workflow, transition, schema, event.input);
  const next = { ...row, ...input, [workflow.statusField]: transition.to, __revision: revision };
  if (workflow.staleField) {
    if (transition.invalidates) next[workflow.staleField] = true;
    if (transition.clearsStale) next[workflow.staleField] = false;
  }
  for (const name of transition.requiredFields ?? []) {
    const value = next[name];
    if (value === null || value === undefined || value === '') throw new Error(`执行“${transition.label}”前需要补齐 ${name}`);
  }
  for (const relation of schema.relations ?? []) {
    const reference = next[relation.field];
    if (reference === null || reference === undefined) continue;
    const targetRows = rowsFor(data, relation.dataset);
    if (!targetRows.some(target => keyOf(target[relation.target]) === keyOf(reference))) throw new Error(`输入的 ${relation.field} 无法关联到 ${schemaFor(workspace, relation.dataset)!.label}，操作未生效`);
  }
  rows[rows.indexOf(row)] = next;
  const receipt = { requestId: event.requestId, recordId: event.recordId, actionId: event.actionId, label: transition.label, from, to: transition.to, revision, simulated: true as const, at: event.at };
  return receipt;
}

/** Replays only declared transitions against immutable scenario seed rows. */
export function materialize(workspace: WorkspaceDefinition, data: WorkspaceData, state: WorkspaceState = { revision: 0, events: [] }): WorkspaceData {
  stateValid(state);
  const result = cloneData(data);
  const workflow = workspace.workflow;
  if (!workflow) {
    if (state.events.length) throw new Error('当前演示不支持业务状态事件');
    return result;
  }
  const rows = rowsFor(result, workflow.dataset);
  for (let index = 0; index < state.events.length; index++) applyEvent(workspace, result, state.events[index], index + 1);
  if (workflow.staleField) for (const row of rows) if (row[workflow.staleField] === undefined) row[workflow.staleField] = false;
  return result;
}

function compare(left: unknown, op: DataFilter['op'], right: string | number | boolean): boolean {
  if (left === null || left === undefined) return false;
  if (op === 'eq') return left === right;
  if (op === 'contains') return typeof left === 'string' && typeof right === 'string' && left.toLocaleLowerCase().includes(right.toLocaleLowerCase());
  if (typeof left === 'number' && typeof right === 'number') return op === 'gte' ? left >= right : left <= right;
  if (typeof left === 'string' && typeof right === 'string') return op === 'gte' ? left >= right : left <= right;
  return false;
}
function compareField(left: unknown, op: DataFilter['op'], right: string | number | boolean, type: FieldDefinition['type']): boolean {
  if (type !== 'date') return compare(left, op, right);
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const actual = Date.parse(left);
  if (!Number.isFinite(actual) || !isValidIsoDate(right)) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(right)) {
    const start = Date.parse(`${right}T00:00:00.000Z`);
    const end = start + 86400000 - 1;
    if (op === 'eq') return actual >= start && actual <= end;
    if (op === 'gte') return actual >= start;
    if (op === 'lte') return actual <= end;
    return false;
  }
  const expected = Date.parse(right);
  if (op === 'eq') return actual === expected;
  if (op === 'gte') return actual >= expected;
  if (op === 'lte') return actual <= expected;
  return false;
}

function matchesFilters(workspace: WorkspaceDefinition, data: WorkspaceData, schema: DatasetDefinition, row: DataRow, filters: DataFilter[]): boolean {
  for (const filter of filters) {
    const targetId = filter.dataset ?? schema.id;
    const target = schemaFor(workspace, targetId);
    if (!target) throw new Error(`筛选字段所属数据集不存在：${targetId}`);
    const field = target.fields.find(candidate => candidate.id === filter.field);
    if (!field) throw new Error(`筛选字段不存在：${targetId}.${filter.field}`);
    if (targetId === schema.id) {
      if (!compareField(row[filter.field], filter.op, filter.value, field.type)) return false;
      continue;
    }
    const relation = (schema.relations ?? []).find(r => r.dataset === targetId);
    if (!relation) throw new Error(`${schema.label} 未配置到 ${target.label} 的关联`);
    const value = row[relation.field];
    const matches = rowsFor(data, targetId).some(targetRow => keyOf(targetRow[relation.target]) === keyOf(value) && compareField(targetRow[filter.field], filter.op, filter.value, field.type));
    if (!matches) return false;
  }
  return true;
}

function dateMatches(row: DataRow, field: string | undefined, from?: string, to?: string): boolean {
  if (!from && !to) return true;
  if (!field) return false;
  const value = row[field];
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  const date = Date.parse(value);
  const end = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? Date.parse(to) + 86400000 - 1 : to ? Date.parse(to) : undefined;
  return (!from || date >= Date.parse(from)) && (end === undefined || date <= end);
}
function metricSources(workspace: WorkspaceDefinition, schema: DatasetDefinition, filters: DataFilter[]): DatasetDefinition[] {
  const sources = new Map<string, DatasetDefinition>([[schema.id, schema]]);
  for (const filter of filters) if (filter.dataset) {
    const related = schemaFor(workspace, filter.dataset);
    if (related) sources.set(related.id, related);
  }
  return [...sources.values()];
}
function originFor(workspace: WorkspaceDefinition, schema: DatasetDefinition, filters: DataFilter[]): DataOrigin | 'combined' {
  const origins = new Set(metricSources(workspace, schema, filters).map(dataset => dataset.origin));
  return origins.size > 1 ? 'combined' : schema.origin;
}
function originAllows(query: AnalysisQuery, origin: DataOrigin | 'combined') {
  if (query.origin === 'combined') return true;
  if (origin === 'combined' && query.origin === undefined) return false;
  return query.origin === undefined || query.origin === origin;
}
function matchingRows(workspace: WorkspaceDefinition, data: WorkspaceData, schema: DatasetDefinition, filters: DataFilter[], timeField?: string, query: AnalysisQuery = {}): DataRow[] {
  return rowsFor(data, schema.id).filter(row => {
    const applies = filters.filter(filter => filter.dataset
      ? filter.dataset === schema.id || (schema.relations ?? []).some(r => r.dataset === filter.dataset)
      : schema.fields.some(field => field.id === filter.field));
    if (!matchesFilters(workspace, data, schema, row, applies)) return false;
    return dateMatches(row, timeField, query.from, query.to);
  });
}
function aggregate(metric: MetricDefinition, rows: DataRow[], workspace: WorkspaceDefinition, data: WorkspaceData): { value: number | null; sampleSize: number; rows: DataRow[] } {
  if (metric.operation === 'ratio') {
    const schema = schemaFor(workspace, metric.dataset)!;
    const denominatorRows = rows.filter(row => matchesFilters(workspace, data, schema, row, metric.denominator ?? []));
    const numeratorRows = denominatorRows.filter(row => matchesFilters(workspace, data, schema, row, metric.numerator ?? []));
    const denominator = denominatorRows.length;
    return { value: denominator ? numeratorRows.length / denominator : null, sampleSize: denominator, rows: denominatorRows };
  }
  if (metric.operation === 'count') return { value: rows.length, sampleSize: rows.length, rows };
  const validRows = rows.filter(row => row[metric.field!] !== null && row[metric.field!] !== undefined);
  const values = validRows.map(row => row[metric.field!]);
  if (metric.operation === 'distinct') return { value: new Set(values.map(keyOf)).size, sampleSize: validRows.length, rows: validRows };
  const numericRows = validRows.filter(row => typeof row[metric.field!] === 'number' && Number.isFinite(row[metric.field!]));
  const numbers = numericRows.map(row => row[metric.field!] as number);
  if (metric.operation === 'sum') return { value: numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : null, sampleSize: numbers.length, rows: numericRows };
  return { value: numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null, sampleSize: numbers.length, rows: numericRows };
}

/** Calculates all chart values from the exact rows returned for the selected data scope. */
export function analyze(workspace: WorkspaceDefinition, data: WorkspaceData, query: AnalysisQuery = {}, state: WorkspaceState = { revision: 0, events: [] }, scope?: { datasets: string[]; metrics: string[] }, materializedCurrent?: WorkspaceData): AnalysisResult {
  if (query.from && !isValidIsoDate(query.from) || query.to && !isValidIsoDate(query.to) || query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) throw new Error('分析日期范围无效');
  if (query.origin && !['synthetic', 'customer', 'combined'].includes(query.origin)) throw new Error('数据来源筛选无效');
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1000)) throw new Error('明细 limit 必须在 1 到 1000 之间');
  const current = materializedCurrent ?? materialize(workspace, data, state);
  // A V3 domain includes reference datasets so record relationships remain navigable.
  // Legacy callers keep the original single-dataset response contract.
  const outputData = scope?.datasets ?? (query.dataset ? [query.dataset] : workspace.datasets.map(d => d.id));
  const queryTargets = query.dataset ? [query.dataset] : outputData;
  for (const id of outputData) if (!schemaFor(workspace, id)) throw new Error(`分析数据集不存在：${id}`);
  if (query.timeField && queryTargets.some(id => schemaFor(workspace, id)?.fields.find(field => field.id === query.timeField)?.type !== 'date')) throw new Error('timeField 必须是所选数据集中的日期字段');
  if ((query.from || query.to) && queryTargets.some(id => !query.timeField && !schemaFor(workspace, id)?.fields.some(field => field.type === 'date'))) throw new Error('日期范围筛选需要数据集配置日期字段');
  for (const filter of query.filters ?? []) {
    const schema = filter.dataset ? schemaFor(workspace, filter.dataset) : workspace.datasets.find(d => d.fields.some(field => field.id === filter.field));
    const field = schema?.fields.find(candidate => candidate.id === filter.field);
    if (!field) throw new Error(`分析筛选字段不存在：${filter.dataset ?? ''}.${filter.field}`);
    if (filter.op === 'contains' && field.type !== 'string' || ['gte', 'lte'].includes(filter.op) && !['number', 'date'].includes(field.type)) throw new Error(`筛选操作与字段 ${field.label} 的类型不匹配`);
    if (field.type === 'string' && typeof filter.value !== 'string' || field.type === 'number' && typeof filter.value !== 'number' || field.type === 'boolean' && typeof filter.value !== 'boolean' || field.type === 'date' && typeof filter.value !== 'string') throw new Error(`筛选值与字段 ${field.label} 的类型不匹配`);
    if (field.type === 'date' && !isValidIsoDate(filter.value)) throw new Error(`日期筛选值无效：${filter.value}`);
  }
  const datasets = outputData.map(id => {
    const schema = schemaFor(workspace, id)!;
    const reference = scope && query.dataset && id !== query.dataset;
    const datasetQuery = reference ? { ...query, from: undefined, to: undefined, timeField: undefined } : query;
    const timeField = datasetQuery.timeField ?? schema.fields.find(field => field.type === 'date')?.id;
    const rows = query.origin && query.origin !== 'combined' && query.origin !== schema.origin
      ? []
      : matchingRows(workspace, current, schema, query.filters ?? [], timeField, datasetQuery);
    return { id, label: schema.label, key: schema.key, origin: schema.origin, source: schema.source, fields: schema.fields,
      total: rows.length, rows: query.limit ? rows.slice(0, query.limit) : rows };
  });
  const metrics: AnalysisMetric[] = workspace.metrics.filter(metric => !scope || scope.metrics.includes(metric.id)).map(metric => {
    const schema = schemaFor(workspace, metric.dataset)!;
    const timeField = metric.timeField ?? query.timeField;
    const applicableQueryFilters = (query.filters ?? []).filter(filter => !filter.dataset || filter.dataset === schema.id || (schema.relations ?? []).some(relation => relation.dataset === filter.dataset));
    const sources = metricSources(workspace, schema, [...applicableQueryFilters, ...(metric.filters ?? []), ...(metric.numerator ?? []), ...(metric.denominator ?? [])]);
    const sourceNames = sources.map(source => source.source);
    const sourceLabel = sourceNames.join('、');
    const currentOrigin: DataOrigin | 'combined' = new Set(sources.map(source => source.origin)).size > 1 ? 'combined' : schema.origin;
    if ((query.from || query.to) && (!timeField || schema.fields.find(field => field.id === timeField)?.type !== 'date')) return {
      id: metric.id, label: metric.label, dataset: metric.dataset, rows: [], value: null, ...(metric.unit ? { unit: metric.unit } : {}), description: metric.description,
      origin: currentOrigin, source: sourceLabel, sources: sourceNames, sampleSize: 0, groups: [], trendGroups: [], scope: metric.scope, notice: '该指标没有可用的日期字段，无法应用所选日期范围。',
    };
    if (!originAllows(query, currentOrigin)) return { id: metric.id, label: metric.label, dataset: metric.dataset, rows: [], value: null, ...(metric.unit ? { unit: metric.unit } : {}), description: metric.description,
      origin: currentOrigin, source: sourceLabel, sources: sourceNames, sampleSize: 0, groups: [], trendGroups: [], scope: metric.scope,
      ...(currentOrigin === 'combined' && query.origin !== 'combined' ? { notice: '该指标关联多种来源，明确选择“合并来源”后查看。' } : {}) };
    const metricData = metric.scope === 'snapshot' ? data : current;
    const rows = matchingRows(workspace, metricData, schema, [...(query.filters ?? []), ...(metric.filters ?? [])], timeField, query);
    const { value, sampleSize, rows: sourceRows } = aggregate(metric, rows, workspace, metricData);
    const groups = metric.groupBy ? [...new Set(rows.map(row => row[metric.groupBy!] === null || row[metric.groupBy!] === undefined ? '未分类' : String(row[metric.groupBy!])))].sort().map(label => {
      const groupRows = rows.filter(row => String(row[metric.groupBy!] ?? '未分类') === label);
      const result = aggregate(metric, groupRows, workspace, metricData);
      return { label, value: result.value, sampleSize: result.sampleSize };
    }) : [];
    const dateBucket = (row: DataRow) => { const value = metric.timeField ? row[metric.timeField] : undefined; return typeof value === 'string' ? value.slice(0, 10) : undefined; };
    const trendGroups = metric.timeField ? [...new Set(rows.map(dateBucket).filter((value): value is string => Boolean(value)))].sort().map(label => {
      const groupRows = rows.filter(row => dateBucket(row) === label);
      const result = aggregate(metric, groupRows, workspace, metricData);
      return { label, value: result.value, sampleSize: result.sampleSize };
    }) : [];
    return { id: metric.id, label: metric.label, dataset: metric.dataset, rows: query.limit ? sourceRows.slice(0, query.limit) : sourceRows, value, ...(metric.unit ? { unit: metric.unit } : {}), description: metric.description,
      origin: currentOrigin, source: sourceLabel, sources: sourceNames, sampleSize, groups, trendGroups, scope: metric.scope };
  });
  return { filters: { ...query }, metrics, datasets, revision: state.revision };
}

export function applyAction(workspace: WorkspaceDefinition, data: WorkspaceData, request: ActionRequest): ActionResult {
  const workflow = workspace.workflow;
  if (!workflow) throw new Error('当前演示没有可执行的业务操作');
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(request.requestId)) throw new Error('requestId 格式无效');
  stateValid(request.state);
  const current = materialize(workspace, data, request.state);
  const duplicate = request.state.events.find(event => event.requestId === request.requestId);
  if (duplicate) {
    if (duplicate.recordId !== request.recordId || duplicate.actionId !== request.actionId || duplicate.role !== request.role || JSON.stringify(duplicate.input) !== JSON.stringify(request.input ?? {})) throw new Error('requestId 已用于其他操作');
    const rows = rowsFor(data, workflow.dataset).map(row => ({ ...row }));
    let receipt: ActionResult['receipt'] | undefined;
    for (let index = 0; index < request.state.events.length; index++) {
      const event = request.state.events[index];
      const candidate = applyEvent(workspace, { datasets: [{ id: workflow.dataset, rows }, ...data.datasets.filter(d => d.id !== workflow.dataset)] }, event, index + 1);
      if (event.requestId === request.requestId) receipt = candidate;
    }
    return { state: { revision: request.state.revision, events: request.state.events.map(event => ({ ...event, input: { ...event.input } })) }, receipt: receipt! };
  }
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision !== request.state.revision) throw new Error('演示状态已变化，请刷新后重试');
  const transition = transitionFor(workflow, request.actionId);
  if (!transition || transition.role !== request.role) throw new Error('当前角色不能执行此操作');
  if (typeof request.recordId !== 'string' || !request.recordId.trim()) throw new Error('recordId 无效');
  const schema = schemaFor(workspace, workflow.dataset)!;
  const input = normalizedInput(workflow, transition, schema, request.input);
  const row = rowsFor(current, workflow.dataset).find(candidate => String(candidate[schema.key]) === request.recordId);
  if (!row) throw new Error('找不到对应的演示记录');
  const at = new Date().toISOString();
  const event: ActionEvent = { requestId: request.requestId, recordId: request.recordId, actionId: request.actionId, role: request.role, input, at };
  const nextRows = rowsFor(current, workflow.dataset).map(candidate => ({ ...candidate }));
  const nextData = { datasets: [{ id: workflow.dataset, rows: nextRows }, ...current.datasets.filter(d => d.id !== workflow.dataset)] };
  const receipt = applyEvent(workspace, nextData, event, request.state.revision + 1);
  const state = { revision: request.state.revision + 1, events: [...request.state.events.map(item => ({ ...item, input: { ...item.input } })), event] };
  return { state, receipt };
}
