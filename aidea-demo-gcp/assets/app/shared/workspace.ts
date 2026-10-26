// Dependency-free V2 workspace contracts and configuration/data validation.
export type FieldType = 'string' | 'number' | 'boolean' | 'date';
export type DataOrigin = 'synthetic' | 'customer';
export type FilterOperator = 'eq' | 'contains' | 'gte' | 'lte';
export type ViewId = 'overview' | 'records' | 'workflow' | 'assistant';
export type AggregateOperation = 'count' | 'distinct' | 'sum' | 'avg' | 'ratio';
export type DataRow = Record<string, string | number | boolean | null>;

export interface FieldDefinition {
  id: string;
  label: string;
  type: FieldType;
  required?: boolean;
  unit?: string;
}
export interface RelationDefinition { field: string; dataset: string; target: string }
export interface DatasetDefinition {
  id: string;
  label: string;
  key: string;
  origin: DataOrigin;
  source: string;
  fields: FieldDefinition[];
  relations?: RelationDefinition[];
}
export interface DataFilter { field: string; op: FilterOperator; value: string | number | boolean; dataset?: string }
export interface MetricDefinition {
  id: string;
  label: string;
  dataset: string;
  operation: AggregateOperation;
  field?: string;
  filters?: DataFilter[];
  numerator?: DataFilter[];
  denominator?: DataFilter[];
  unit?: string;
  description: string;
  scope: 'snapshot' | 'current';
  groupBy?: string;
  timeField?: string;
}
export interface ActionTransition {
  id: string;
  label: string;
  from: string[];
  to: string;
  role: string;
  inputFields?: FieldDefinition[];
  requiredFields?: string[];
  invalidates?: boolean;
  clearsStale?: boolean;
  requireFresh?: boolean;
}
export interface WorkflowDefinition {
  dataset: string;
  statusField: string;
  staleField?: string;
  editableFields?: string[];
  transitions: ActionTransition[];
}
export interface WorkspaceDefinition {
  views: ViewId[];
  roles: Array<{ id: string; label: string }>;
  stages: Array<{ id: string; label: string }>;
  datasets: DatasetDefinition[];
  metrics: MetricDefinition[];
  workflow?: WorkflowDefinition;
}
export interface WorkspaceData { datasets: Array<{ id: string; rows: DataRow[] }> }
export interface ActionEvent {
  requestId: string;
  recordId: string;
  actionId: string;
  role: string;
  input: Record<string, string | number | boolean>;
  at: string;
}
export interface WorkspaceState { revision: number; events: ActionEvent[] }
export interface AnalysisQuery {
  dataset?: string;
  filters?: DataFilter[];
  from?: string;
  to?: string;
  timeField?: string;
  origin?: DataOrigin | 'combined';
  limit?: number;
}
export interface AnalysisMetric {
  currencyField?: string;
  partitions?: Array<Omit<AnalysisMetric, "partitions"> & { currency: string }>;
  id: string;
  label: string;
  dataset: string;
  rows: DataRow[];
  value: number | null;
  unit?: string;
  description: string;
  sources: string[];
  origin: DataOrigin | 'combined';
  source: string;
  sampleSize: number;
  scope: 'snapshot' | 'current';
  groups: Array<{ label: string; value: number | null; sampleSize: number }>;
  trendGroups: Array<{ label: string; value: number | null; sampleSize: number }>;
  notice?: string;
}
export interface AnalysisResult {
  dataBackend?: "local";
  simulated?: boolean;
  filters: AnalysisQuery;
  metrics: AnalysisMetric[];
  datasets: Array<{
    id: string;
    label: string;
    key: string;
    origin: DataOrigin;
    source: string;
    fields: FieldDefinition[];
    rows: DataRow[];
    total: number;
  }>;
  revision: number;
}
export interface ActionRequest {
  requestId: string;
  recordId: string;
  actionId: string;
  role: string;
  domainId?: string;
  expectedRevision: number;
  state: WorkspaceState;
  input?: Record<string, string | number | boolean>;
}
export interface ActionResult { state: WorkspaceState; receipt: { requestId: string; recordId: string; actionId: string; label: string; from: string; to: string; revision: number; simulated: true; at: string } }

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须是对象`);
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key));
  if (unexpected) throw new Error(`${name}.${unexpected} 不受支持，请核对配置版本`);
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
  return value;
}
function strictBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} 必须是布尔值`);
  return value;
}
function array<T>(value: unknown, name: string, parse: (item: unknown, label: string) => T): T[] {
  if (!Array.isArray(value)) throw new Error(`${name} 必须是数组`);
  return value.map((item, index) => parse(item, `${name}[${index}]`));
}
function unique(items: string[], name: string) {
  if (new Set(items).size !== items.length) throw new Error(`${name} 不得重复`);
}
function fieldDefinition(value: unknown, name: string): FieldDefinition {
  const f = object(value, name);
  onlyKeys(f, ['id', 'label', 'type', 'required', 'unit'], name);
  const type = text(f.type, `${name}.type`);
  if (!['string', 'number', 'boolean', 'date'].includes(type)) throw new Error(`${name}.type 不受支持`);
  if (f.required !== undefined && typeof f.required !== 'boolean') throw new Error(`${name}.required 必须是布尔值`);
  const id = text(f.id, `${name}.id`); assertSafeId(id, `${name}.id`);
  return { id, label: text(f.label, `${name}.label`), type: type as FieldType,
    ...(f.required !== undefined ? { required: f.required } : {}), ...(f.unit !== undefined ? { unit: text(f.unit, `${name}.unit`) } : {}) };
}
function filterDefinition(value: unknown, name: string): DataFilter {
  const f = object(value, name);
  onlyKeys(f, ['field', 'op', 'value', 'dataset'], name);
  const op = text(f.op, `${name}.op`);
  if (!['eq', 'contains', 'gte', 'lte'].includes(op)) throw new Error(`${name}.op 不受支持`);
  if (!['string', 'number', 'boolean'].includes(typeof f.value)) throw new Error(`${name}.value 必须是字符串、数值或布尔值`);
  return { field: text(f.field, `${name}.field`), op: op as FilterOperator, value: f.value as string | number | boolean,
    ...(f.dataset !== undefined ? { dataset: text(f.dataset, `${name}.dataset`) } : {}) };
}
function assertSafeId(id: string, name: string) {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error(`${name} 格式无效`);
}
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:?\d{2}))?$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  return true;
}

export function parseWorkspace(value: unknown): WorkspaceDefinition {
  const v = object(value, 'workspace');
  onlyKeys(v, ['views', 'roles', 'stages', 'datasets', 'metrics', 'workflow'], 'workspace');
  const views = array(v.views, 'workspace.views', (item, name) => {
    const view = text(item, name);
    if (!['overview', 'records', 'workflow', 'assistant'].includes(view)) throw new Error(`${name} 不受支持`);
    return view as ViewId;
  });
  unique(views, 'workspace.views');
  const roles = array(v.roles, 'workspace.roles', (item, name) => { const r = object(item, name); onlyKeys(r, ['id', 'label'], name); const id = text(r.id, `${name}.id`); assertSafeId(id, `${name}.id`); return { id, label: text(r.label, `${name}.label`) }; });
  const stages = array(v.stages, 'workspace.stages', (item, name) => { const s = object(item, name); onlyKeys(s, ['id', 'label'], name); const id = text(s.id, `${name}.id`); assertSafeId(id, `${name}.id`); return { id, label: text(s.label, `${name}.label`) }; });
  unique(roles.map(role => role.id), 'workspace.roles.id');
  unique(stages.map(stage => stage.id), 'workspace.stages.id');
  const datasets = array(v.datasets, 'workspace.datasets', (item, name): DatasetDefinition => {
    const d = object(item, name); const origin = text(d.origin, `${name}.origin`);
    onlyKeys(d, ['id', 'label', 'key', 'origin', 'source', 'fields', 'relations'], name);
    if (origin !== 'synthetic' && origin !== 'customer') throw new Error(`${name}.origin 无效`);
    const fields = array(d.fields, `${name}.fields`, fieldDefinition); unique(fields.map(f => f.id), `${name}.fields.id`);
    const relations = d.relations === undefined ? undefined : array(d.relations, `${name}.relations`, (raw, relationName) => {
      const r = object(raw, relationName); onlyKeys(r, ['field', 'dataset', 'target'], relationName); return { field: text(r.field, `${relationName}.field`), dataset: text(r.dataset, `${relationName}.dataset`), target: text(r.target, `${relationName}.target`) };
    });
    const result: DatasetDefinition = { id: text(d.id, `${name}.id`), label: text(d.label, `${name}.label`), key: text(d.key, `${name}.key`), origin: origin as DataOrigin, source: text(d.source, `${name}.source`), fields, ...(relations ? { relations } : {}) };
    assertSafeId(result.id, `${name}.id`);
    return result;
  });
  unique(datasets.map(d => d.id), 'workspace.datasets.id');
  const byId = new Map(datasets.map(d => [d.id, d]));
  for (const dataset of datasets) for (const relation of dataset.relations ?? []) {
    const target = byId.get(relation.dataset);
    if (!dataset.fields.some(f => f.id === relation.field) || !target?.fields.some(f => f.id === relation.target)) throw new Error(`关系 ${dataset.id}.${relation.field} -> ${relation.dataset}.${relation.target} 引用了不存在的字段`);
    const localType = dataset.fields.find(f => f.id === relation.field)?.type;
    const targetType = target?.fields.find(f => f.id === relation.target)?.type;
    if (localType !== targetType) throw new Error(`关系 ${dataset.id}.${relation.field} 与 ${relation.dataset}.${relation.target} 类型不一致`);
  }
  const metrics = array(v.metrics, 'workspace.metrics', (item, name): MetricDefinition => {
    const m = object(item, name); const operation = text(m.operation, `${name}.operation`);
    onlyKeys(m, ['id', 'label', 'dataset', 'operation', 'field', 'filters', 'numerator', 'denominator', 'unit', 'description', 'scope', 'groupBy', 'timeField'], name);
    if (!['count', 'distinct', 'sum', 'avg', 'ratio'].includes(operation)) throw new Error(`${name}.operation 不受支持`);
    const scope = text(m.scope, `${name}.scope`);
    if (scope !== 'snapshot' && scope !== 'current') throw new Error(`${name}.scope 无效`);
    const result: MetricDefinition = {
      id: text(m.id, `${name}.id`), label: text(m.label, `${name}.label`), dataset: text(m.dataset, `${name}.dataset`),
      operation: operation as AggregateOperation, description: text(m.description, `${name}.description`), scope,
      ...(m.field !== undefined ? { field: text(m.field, `${name}.field`) } : {}),
      ...(m.filters !== undefined ? { filters: array(m.filters, `${name}.filters`, filterDefinition) } : {}),
      ...(m.numerator !== undefined ? { numerator: array(m.numerator, `${name}.numerator`, filterDefinition) } : {}),
      ...(m.denominator !== undefined ? { denominator: array(m.denominator, `${name}.denominator`, filterDefinition) } : {}),
      ...(m.unit !== undefined ? { unit: text(m.unit, `${name}.unit`) } : {}),
      ...(m.groupBy !== undefined ? { groupBy: text(m.groupBy, `${name}.groupBy`) } : {}),
      ...(m.timeField !== undefined ? { timeField: text(m.timeField, `${name}.timeField`) } : {}),
    };
    assertSafeId(result.id, `${name}.id`);
    if (result.operation === 'ratio' && (!result.numerator || !result.denominator)) throw new Error(`${name} 的 ratio 必须同时定义 numerator 和 denominator`);
    if ((result.operation === 'sum' || result.operation === 'avg' || result.operation === 'distinct') && !result.field) throw new Error(`${name}.field 必填`);
    return result;
  });
  unique(metrics.map(m => m.id), 'workspace.metrics.id');
  const assertFilter = (filter: DataFilter, base: DatasetDefinition, name: string) => {
    const target = filter.dataset ? byId.get(filter.dataset) : base;
    if (!target?.fields.some(f => f.id === filter.field)) throw new Error(`${name} 引用不存在的字段 ${filter.dataset ?? base.id}.${filter.field}`);
    if (filter.dataset && !(base.relations ?? []).some(r => r.dataset === filter.dataset)) throw new Error(`${name} 只能筛选与 ${base.id} 直接关联的数据集`);
  };
  for (const metric of metrics) {
    const base = byId.get(metric.dataset);
    if (!base) throw new Error(`指标 ${metric.id} 引用了不存在的数据集`);
    if (metric.field && !base.fields.some(f => f.id === metric.field)) throw new Error(`指标 ${metric.id} 引用了不存在的字段`);
    if (metric.field && ['sum', 'avg'].includes(metric.operation) && base.fields.find(f => f.id === metric.field)?.type !== 'number') throw new Error(`指标 ${metric.id} 的 ${metric.operation} 字段必须为数值类型`);
    if (metric.operation === 'distinct' && !base.fields.some(f => f.id === metric.field)) throw new Error(`指标 ${metric.id}.field 引用了不存在的字段`);
    if (metric.groupBy && !base.fields.some(f => f.id === metric.groupBy)) throw new Error(`指标 ${metric.id}.groupBy 引用了不存在的字段`);
    if (metric.timeField && base.fields.find(f => f.id === metric.timeField)?.type !== 'date') throw new Error(`指标 ${metric.id}.timeField 必须是日期字段`);
    for (const [label, filters] of [['filters', metric.filters], ['numerator', metric.numerator], ['denominator', metric.denominator]] as const) for (const f of filters ?? []) {
      assertFilter(f, base, `指标 ${metric.id}.${label}`);
      const target = f.dataset ? byId.get(f.dataset)! : base;
      const type = target.fields.find(field => field.id === f.field)!.type;
      if (f.op === 'contains' && type !== 'string' || f.op !== 'contains' && f.op !== 'eq' && !['number', 'date'].includes(type)) throw new Error(`指标 ${metric.id}.${label} 的筛选操作与字段类型不匹配`);
      if (typeof f.value === 'boolean' && type !== 'boolean' || typeof f.value === 'number' && type !== 'number' || typeof f.value === 'string' && type !== 'string' && type !== 'date') throw new Error(`指标 ${metric.id}.${label} 的筛选值与字段类型不匹配`);
      if (type === 'date' && !isValidIsoDate(f.value)) throw new Error(`指标 ${metric.id}.${label} 的日期筛选值无效`);
    }
  }
  const workflow = v.workflow === undefined ? undefined : (() => {
    const w = object(v.workflow, 'workspace.workflow');
    onlyKeys(w, ['dataset', 'statusField', 'staleField', 'editableFields', 'transitions'], 'workspace.workflow');
    const transitions = array(w.transitions, 'workspace.workflow.transitions', (item, name): ActionTransition => {
      const t = object(item, name); const from = array(t.from, `${name}.from`, text);
      onlyKeys(t, ['id', 'label', 'from', 'to', 'role', 'inputFields', 'requiredFields', 'invalidates', 'clearsStale', 'requireFresh'], name);
      const id = text(t.id, `${name}.id`); assertSafeId(id, `${name}.id`);
      return { id, label: text(t.label, `${name}.label`), from, to: text(t.to, `${name}.to`), role: text(t.role, `${name}.role`),
        ...(t.inputFields !== undefined ? { inputFields: array(t.inputFields, `${name}.inputFields`, fieldDefinition) } : {}),
        ...(t.requiredFields !== undefined ? { requiredFields: array(t.requiredFields, `${name}.requiredFields`, text) } : {}),
        ...(t.invalidates !== undefined ? { invalidates: strictBoolean(t.invalidates, `${name}.invalidates`) } : {}), ...(t.clearsStale !== undefined ? { clearsStale: strictBoolean(t.clearsStale, `${name}.clearsStale`) } : {}), ...(t.requireFresh !== undefined ? { requireFresh: strictBoolean(t.requireFresh, `${name}.requireFresh`) } : {}) };
    });
    unique(transitions.map(t => t.id), 'workspace.workflow.transitions.id');
    return { dataset: text(w.dataset, 'workspace.workflow.dataset'), statusField: text(w.statusField, 'workspace.workflow.statusField'), ...(w.staleField !== undefined ? { staleField: text(w.staleField, 'workspace.workflow.staleField') } : {}), ...(w.editableFields !== undefined ? { editableFields: array(w.editableFields, 'workspace.workflow.editableFields', text) } : {}), transitions };
  })();
  if (v.workflow !== undefined) {
    const target = byId.get(workflow!.dataset);
    if (!target || !target.fields.some(f => f.id === workflow!.statusField)) throw new Error('workflow 必须引用有效数据集和状态字段');
    if (workflow!.staleField && !target.fields.some(f => f.id === workflow!.staleField)) throw new Error('workflow.staleField 必须引用有效字段');
    if (workflow!.staleField && target.fields.find(f => f.id === workflow!.staleField)?.type !== 'boolean') throw new Error('workflow.staleField 必须是布尔字段');
    if (workflow!.editableFields?.some(f => !target.fields.some(field => field.id === f))) throw new Error('workflow.editableFields 引用了无效字段');
    const roleIds = new Set(roles.map(r => r.id)); const stageIds = new Set(stages.map(s => s.id));
    for (const transition of workflow!.transitions) {
      if (!roleIds.has(transition.role) || !stageIds.has(transition.to) || transition.from.some(s => !stageIds.has(s))) throw new Error(`动作 ${transition.id} 引用了无效角色或阶段`);
      const fieldIds = new Set(transition.inputFields?.map(f => f.id) ?? []);
      if ((transition.requiredFields ?? []).some(f => !fieldIds.has(f) && !workflow!.editableFields?.includes(f))) throw new Error(`动作 ${transition.id} 的必填输入没有定义`);
      if (transition.inputFields?.some(f => !target.fields.some(field => field.id === f.id && field.type === f.type) || ['__revision', '__stale'].includes(f.id))) throw new Error(`动作 ${transition.id} 包含无效、类型不匹配或保留输入字段`);
      if ((transition.requireFresh || transition.invalidates || transition.clearsStale) && !workflow!.staleField) throw new Error(`动作 ${transition.id} 需要 workflow.staleField 字段`);
    }
  }
  if (datasets.length === 0) throw new Error('workspace.datasets 至少需要一项');
  if (workflow && (roles.length === 0 || stages.length === 0)) throw new Error('包含业务流程时 workspace.roles 和 stages 至少各需要一项');
  return { views, roles, stages, datasets, metrics, ...(workflow ? { workflow } : {}) };
}

function valueMatches(value: unknown, type: FieldType): boolean {
  if (value === null) return true;
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  return isValidIsoDate(value);
}
export function parseWorkspaceData(value: unknown, definition: WorkspaceDefinition): WorkspaceData {
  const v = object(value, 'scenario.workspace');
  onlyKeys(v, ['datasets'], 'scenario.workspace');
  const supplied = array(v.datasets, 'scenario.workspace.datasets', (item, name) => {
    const d = object(item, name); onlyKeys(d, ['id', 'rows'], name); const id = text(d.id, `${name}.id`);
    return { id, rows: array(d.rows, `${name}.rows`, (raw, rowName) => object(raw, rowName) as DataRow) };
  });
  unique(supplied.map(d => d.id), 'scenario.workspace.datasets.id');
  const actualIds = supplied.map(d => d.id);
  if (definition.datasets.some(d => !actualIds.includes(d.id)) || actualIds.some(id => !definition.datasets.some(d => d.id === id))) throw new Error('scenario.workspace.datasets 必须与 workspace.datasets 一一对应');
  const byId = new Map(supplied.map(d => [d.id, d]));
  for (const schema of definition.datasets) {
    const rows = byId.get(schema.id)!.rows; const keys = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]; const name = `${schema.id}.rows[${i}]`;
      for (const key of Object.keys(row)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`${name} 包含危险字段名`);
        if (!schema.fields.some(f => f.id === key)) throw new Error(`${name} 有未声明字段 ${key}`);
      }
      for (const field of schema.fields) {
        const value = row[field.id];
        if (field.required && (value === null || value === undefined || value === '')) throw new Error(`${name}.${field.id} 是必填字段`);
        if (value !== undefined && !valueMatches(value, field.type)) throw new Error(`${name}.${field.id} 类型无效`);
      }
      const key = row[schema.key];
      if (key === null || key === undefined || String(key).trim() === '') throw new Error(`${name}.${schema.key} 必填`);
      const serialized = `${typeof key}:${String(key)}`;
      if (keys.has(serialized)) throw new Error(`${schema.id} 主键 ${String(key)} 重复`);
      keys.add(serialized);
    }
  }
  if (definition.workflow) {
    const workflow = definition.workflow;
    const schema = definition.datasets.find(d => d.id === workflow.dataset)!;
    const allowed = new Set(definition.stages.map(stage => stage.id));
    for (const [index, row] of byId.get(schema.id)!.rows.entries()) {
      const status = row[workflow.statusField];
      if (typeof status !== 'string' || !allowed.has(status)) throw new Error(`${schema.id}.rows[${index}].${workflow.statusField} 不是已定义阶段`);
      if (workflow.staleField && row[workflow.staleField] !== undefined && typeof row[workflow.staleField] !== 'boolean') throw new Error(`${schema.id}.rows[${index}].${workflow.staleField} 必须是布尔值`);
    }
  }
  for (const schema of definition.datasets) for (const relation of schema.relations ?? []) {
    const targetRows = byId.get(relation.dataset)!.rows; const target = definition.datasets.find(d => d.id === relation.dataset)!;
    const targetValues = new Set(targetRows.map(row => row[relation.target]).filter(v => v !== null && v !== undefined).map(v => `${typeof v}:${String(v)}`));
    for (const row of byId.get(schema.id)!.rows) {
      const value = row[relation.field];
      if (value !== null && value !== undefined && !targetValues.has(`${typeof value}:${String(value)}`)) throw new Error(`${schema.id}.${relation.field} 的值 ${String(value)} 无法关联到 ${relation.dataset}.${relation.target}`);
    }
  }
  return { datasets: definition.datasets.map(d => ({ id: d.id, rows: byId.get(d.id)!.rows.map(row => ({ ...row })) })) };
}
