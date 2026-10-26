import type { DomainPage } from './solution.ts';
import { isValidIsoDate } from './workspace.ts';
import type { DatasetDefinition, FieldDefinition, WorkspaceDefinition } from './workspace.ts';

export type CapabilityKind = 'partitioned-analysis' | 'mapping-review' | 'work-items';

interface CapabilityBase {
  id: string;
  kind: CapabilityKind;
  version: 1;
  label: string;
  pages: string[];
}

export interface PartitionedAnalysisCapability extends CapabilityBase {
  kind: 'partitioned-analysis';
  dataset: string;
  currencyField: string;
}

export interface MappingReviewCapability extends CapabilityBase {
  kind: 'mapping-review';
  role: string;
  dataset: string;
  targetField: string;
  targetDataset: string;
  evidenceField: string;
  statusField?: string;
  resolvedStatus?: string;
}

export interface WorkItemsCapability extends CapabilityBase {
  kind: 'work-items';
  role: string;
  dataset: string;
  inputFields: string[];
  defaults: Record<string, string | number | boolean | null>;
}

export type CapabilityBinding = PartitionedAnalysisCapability | MappingReviewCapability | WorkItemsCapability;

export const CAPABILITY_REGISTRY = [
  { kind: 'partitioned-analysis', label: '分项分析', summary: '按数据记录中的币种分别计算指标，不生成跨币种合计。' },
  { kind: 'mapping-review', label: '映射复核', summary: '为待复核记录选择已配置的关联目标并记录依据。' },
  { kind: 'work-items', label: '工作项', summary: '按已配置字段创建工作项，并沿用工作区现有流程。' },
] as const satisfies ReadonlyArray<{ kind: CapabilityKind; label: string; summary: string }>;

type RecordValue = Record<string, unknown>;

function object(value: unknown, name: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须是对象`);
  return value as RecordValue;
}

function onlyKeys(value: RecordValue, allowed: readonly string[], name: string): void {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key));
  if (unexpected) throw new Error(`${name}.${unexpected} 不受支持，请核对配置版本`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
  return value;
}

function safeId(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(result) || ['__proto__', 'constructor', 'prototype'].includes(result)) {
    throw new Error(`${name} 格式无效`);
  }
  return result;
}

function stringList(value: unknown, name: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new Error(`${name} 必须是${allowEmpty ? '' : '非空'}数组`);
  const result = value.map((item, index) => text(item, `${name}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${name} 不得重复`);
  return result;
}

function fieldOf(dataset: DatasetDefinition, fieldId: string, name: string): FieldDefinition {
  const field = dataset.fields.find(candidate => candidate.id === fieldId);
  if (!field) throw new Error(`${name} 引用了不存在的字段 ${dataset.id}.${fieldId}`);
  return field;
}

function valueMatches(value: unknown, field: FieldDefinition): boolean {
  if (value === null) return true;
  if (field.type === 'string') return typeof value === 'string';
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (field.type === 'boolean') return typeof value === 'boolean';
  return isValidIsoDate(value);
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

function requirePageDependencies(pages: DomainPage[], capabilityPages: string[], datasets: string[], name: string): void {
  for (const pageId of capabilityPages) {
    const page = pages.find(candidate => candidate.id === pageId);
    if (!page) throw new Error(`${name}.pages 引用了不存在的页面 ${pageId}`);
    const missing = datasets.find(datasetId => !page.datasets.includes(datasetId));
    if (missing) throw new Error(`页面 ${pageId} 未声明能力 ${name} 所需数据集 ${missing}`);
  }
}

function parseBase(value: RecordValue, name: string) {
  return {
    id: safeId(value.id, `${name}.id`),
    version: 1 as const,
    label: text(value.label, `${name}.label`),
    pages: stringList(value.pages, `${name}.pages`),
  };
}

function parsePartitioned(value: RecordValue, name: string, workspace: WorkspaceDefinition, pages: DomainPage[]): PartitionedAnalysisCapability {
  onlyKeys(value, ['id', 'kind', 'version', 'label', 'pages', 'dataset', 'currencyField'], name);
  const base = parseBase(value, name);
  const datasetId = safeId(value.dataset, `${name}.dataset`);
  const currencyField = safeId(value.currencyField, `${name}.currencyField`);
  const dataset = workspace.datasets.find(candidate => candidate.id === datasetId);
  if (!dataset) throw new Error(`${name}.dataset 引用了不存在的数据集 ${datasetId}`);
  if (fieldOf(dataset, currencyField, `${name}.currencyField`).type !== 'string') throw new Error(`${name}.currencyField 必须是字符串字段`);
  requirePageDependencies(pages, base.pages, [datasetId], name);
  return { ...base, kind: 'partitioned-analysis', dataset: datasetId, currencyField };
}

function parseMappingReview(value: RecordValue, name: string, workspace: WorkspaceDefinition, pages: DomainPage[]): MappingReviewCapability {
  onlyKeys(value, ['id', 'kind', 'version', 'label', 'pages', 'role', 'dataset', 'targetField', 'targetDataset', 'evidenceField', 'statusField', 'resolvedStatus'], name);
  const base = parseBase(value, name);
  const role = safeId(value.role, `${name}.role`);
  if (!workspace.roles.some(candidate => candidate.id === role)) throw new Error(`${name}.role 引用了不存在的角色 ${role}`);
  const datasetId = safeId(value.dataset, `${name}.dataset`);
  const targetDatasetId = safeId(value.targetDataset, `${name}.targetDataset`);
  const targetField = safeId(value.targetField, `${name}.targetField`);
  const evidenceField = safeId(value.evidenceField, `${name}.evidenceField`);
  const dataset = workspace.datasets.find(candidate => candidate.id === datasetId);
  const targetDataset = workspace.datasets.find(candidate => candidate.id === targetDatasetId);
  if (!dataset) throw new Error(`${name}.dataset 引用了不存在的数据集 ${datasetId}`);
  if (!targetDataset) throw new Error(`${name}.targetDataset 引用了不存在的数据集 ${targetDatasetId}`);
  fieldOf(dataset, dataset.key, `${name}.dataset.key`);
  if (targetField === dataset.key) throw new Error(`${name}.targetField 不得修改数据集主键 ${dataset.key}`);
  const relation = (dataset.relations ?? []).find(candidate => candidate.field === targetField && candidate.dataset === targetDatasetId);
  if (!relation) throw new Error(`${name}.targetField 必须是关联到 ${targetDatasetId} 的关系字段`);
  fieldOf(targetDataset, relation.target, `${name}.targetField relation`);
  if (evidenceField === dataset.key) throw new Error(`${name}.evidenceField 不得修改数据集主键 ${dataset.key}`);
  if (fieldOf(dataset, evidenceField, `${name}.evidenceField`).type !== 'string') throw new Error(`${name}.evidenceField 必须是字符串字段`);
  if (evidenceField === targetField) throw new Error(`${name}.evidenceField 不得与 targetField 相同`);
  const statusField = value.statusField === undefined ? undefined : safeId(value.statusField, `${name}.statusField`);
  const resolvedStatus = value.resolvedStatus === undefined ? undefined : text(value.resolvedStatus, `${name}.resolvedStatus`);
  if ((statusField === undefined) !== (resolvedStatus === undefined)) throw new Error(`${name}.statusField 与 resolvedStatus 必须同时配置`);
  if (statusField) {
    if (statusField === dataset.key) throw new Error(`${name}.statusField 不得修改数据集主键 ${dataset.key}`);
    if (statusField === targetField || statusField === evidenceField) throw new Error(`${name}.statusField 不得与映射字段或依据字段相同`);
    if (fieldOf(dataset, statusField, `${name}.statusField`).type !== 'string') throw new Error(`${name}.statusField 必须是字符串字段`);
  }
  requirePageDependencies(pages, base.pages, [datasetId, targetDatasetId], name);
  return { ...base, kind: 'mapping-review', role, dataset: datasetId, targetField, targetDataset: targetDatasetId, evidenceField,
    ...(statusField ? { statusField, resolvedStatus } : {}) };
}

function parseDefaults(value: unknown, dataset: DatasetDefinition, name: string): Record<string, string | number | boolean | null> {
  const raw = object(value, `${name}.defaults`);
  const result: Record<string, string | number | boolean | null> = {};
  for (const [fieldId, fieldValue] of Object.entries(raw)) {
    if (['__proto__', 'constructor', 'prototype', '__revision'].includes(fieldId)) throw new Error(`${name}.defaults 包含保留字段 ${fieldId}`);
    const field = fieldOf(dataset, fieldId, `${name}.defaults`);
    if (!(fieldValue === null || typeof fieldValue === 'string' || typeof fieldValue === 'number' || typeof fieldValue === 'boolean')) {
      throw new Error(`${name}.defaults.${fieldId} 必须是字符串、数值、布尔值或 null`);
    }
    if (!valueMatches(fieldValue, field)) throw new Error(`${name}.defaults.${fieldId} 与字段类型不匹配`);
    result[fieldId] = fieldValue;
  }
  return result;
}

function parseWorkItems(value: RecordValue, name: string, workspace: WorkspaceDefinition, pages: DomainPage[]): WorkItemsCapability {
  onlyKeys(value, ['id', 'kind', 'version', 'label', 'pages', 'role', 'dataset', 'inputFields', 'defaults'], name);
  const base = parseBase(value, name);
  const role = safeId(value.role, `${name}.role`);
  if (!workspace.roles.some(candidate => candidate.id === role)) throw new Error(`${name}.role 引用了不存在的角色 ${role}`);
  const workflow = workspace.workflow;
  if (!workflow) throw new Error(`${name} 需要已配置 workspace.workflow`);
  const datasetId = safeId(value.dataset, `${name}.dataset`);
  if (datasetId !== workflow.dataset) throw new Error(`${name}.dataset 必须与 workspace.workflow.dataset 一致`);
  const dataset = workspace.datasets.find(candidate => candidate.id === datasetId);
  if (!dataset) throw new Error(`${name}.dataset 引用了不存在的数据集 ${datasetId}`);
  const keyField = fieldOf(dataset, dataset.key, `${name}.dataset.key`);
  if (keyField.type !== 'string') throw new Error(`${name}.dataset.key 当前只支持字符串主键`);
  const inputFields = stringList(value.inputFields, `${name}.inputFields`, true).map(fieldId => safeId(fieldId, `${name}.inputFields`));
  const defaults = parseDefaults(value.defaults, dataset, name);
  const forbiddenInputs = new Set([dataset.key, workflow.statusField, workflow.staleField, '__revision'].filter((field): field is string => Boolean(field)));
  for (const fieldId of inputFields) {
    fieldOf(dataset, fieldId, `${name}.inputFields`);
    if (forbiddenInputs.has(fieldId)) throw new Error(`${name}.inputFields 不得包含由服务端控制的字段 ${fieldId}`);
  }
  const statusField = fieldOf(dataset, workflow.statusField, `${name}.workflow.statusField`);
  if (statusField.type !== 'string') throw new Error(`${name} 的 workflow 状态字段必须是字符串类型`);
  const initialStatus = defaults[workflow.statusField];
  if (typeof initialStatus !== 'string' || !workspace.stages.some(stage => stage.id === initialStatus) || !workflow.transitions.some(transition => transition.from.includes(initialStatus))) {
    throw new Error(`${name}.defaults 必须为 workflow.statusField 提供可执行流程的初始状态`);
  }
  const available = new Set([...inputFields, ...Object.keys(defaults), dataset.key]);
  for (const field of dataset.fields) {
    if (field.required && !available.has(field.id)) throw new Error(`${name} 无法填充必填字段 ${field.id}；请配置 inputFields 或 defaults`);
    if (field.required && field.id !== dataset.key && Object.hasOwn(defaults, field.id) && !present(defaults[field.id]) && !inputFields.includes(field.id)) {
      throw new Error(`${name}.defaults.${field.id} 不能以空值覆盖必填字段`);
    }
  }
  const relatedDependencies = (dataset.relations ?? []).filter(relation => inputFields.includes(relation.field) || present(defaults[relation.field])).map(relation => relation.dataset);
  requirePageDependencies(pages, base.pages, [...new Set([datasetId, ...relatedDependencies])], name);
  return { ...base, kind: 'work-items', role, dataset: datasetId, inputFields, defaults };
}

/** Strictly validates V4 capabilities against the canonical workspace and page scopes. */
export function parseCapabilities(value: unknown, workspace: WorkspaceDefinition, pages: DomainPage[]): CapabilityBinding[] {
  if (!Array.isArray(value)) throw new Error('demo-spec.capabilities 必须是数组');
  const capabilities = value.map((raw, index): CapabilityBinding => {
    const name = `demo-spec.capabilities[${index}]`;
    const item = object(raw, name);
    const kind = item.kind;
    if (item.version !== 1) throw new Error(`${name}.version 仅支持 1`);
    if (kind === 'partitioned-analysis') return parsePartitioned(item, name, workspace, pages);
    if (kind === 'mapping-review') return parseMappingReview(item, name, workspace, pages);
    if (kind === 'work-items') return parseWorkItems(item, name, workspace, pages);
    throw new Error(`${name}.kind 不受支持`);
  });
  const ids = capabilities.map(capability => capability.id);
  if (new Set(ids).size !== ids.length) throw new Error('demo-spec.capabilities.id 不得重复');
  const workflowActions = new Set(workspace.workflow?.transitions.map(transition => transition.id) ?? []);
  const partitionFields = new Map<string, string>();
  for (const capability of capabilities) {
    const actionId = capability.kind === 'mapping-review' ? `review-${capability.id}` : capability.kind === 'work-items' ? `create-${capability.id}` : undefined;
    if (actionId && workflowActions.has(actionId)) throw new Error(`能力动作 ${actionId} 与 workspace.workflow 动作重复`);
    if (capability.kind === 'partitioned-analysis') {
      const previous = partitionFields.get(capability.dataset);
      if (previous && previous !== capability.currencyField) throw new Error(`数据集 ${capability.dataset} 只能配置一个币种字段`);
      partitionFields.set(capability.dataset, capability.currencyField);
    }
  }
  return capabilities;
}

/** Returns the capability actions that are enabled for a domain page. */
export function capabilityActions(bindings: readonly CapabilityBinding[], pageId: string): string[] {
  return bindings.flatMap(binding => {
    if (!binding.pages.includes(pageId)) return [];
    if (binding.kind === 'mapping-review') return [`review-${binding.id}`];
    if (binding.kind === 'work-items') return [`create-${binding.id}`];
    return [];
  });
}
