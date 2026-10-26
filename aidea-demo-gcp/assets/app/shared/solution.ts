import type { AnalysisQuery, WorkspaceData, WorkspaceDefinition } from './workspace.ts';

export type DemoComponent = 'metrics' | 'records' | 'workflow' | 'assistant';

export interface DomainPage {
  id: string;
  title: string;
  goal: string;
  datasets: string[];
  metrics: string[];
  actions: string[];
  components: DemoComponent[];
  claimIds: string[];
  links: Array<{ label: string; pageId: string; dataset?: string; recordId?: string }>;
}

export interface SolutionBlueprint {
  objectives: Array<{ id: string; title: string; measure: string }>;
  sources: Array<{
    id: string;
    title: string;
    url?: string;
    checkedAt?: string;
    kind: 'website' | 'customer' | 'assumption';
    finding: string;
    status: 'observed' | 'confirmed' | 'hypothesis' | 'unavailable';
    region?: string;
    evidence?: string;
  }>;
  journey: Array<{ id: string; title: string; role: string; description: string; domainId?: string; next?: string[] }>;
  systems: Array<{ id: string; name: string; responsibility: string; status: 'simulated' | 'planned' | 'connected' }>;
  dataNotes: string[];
  phases: Array<{ id: string; title: string; description: string }>;
}

export interface DomainChatContext {
  domainId?: string;
  query?: AnalysisQuery;
  selectedRecord?: { dataset: string; id: string; scope?: 'snapshot' | 'current' };
}

export interface ResolvedDomainContext {
  domainId: string;
  query: AnalysisQuery;
  selectedRecord?: { dataset: string; id: string; scope?: 'snapshot' | 'current' };
}

type SolutionSpec = {
  version: number;
  solution?: string;
  pages?: DomainPage[];
  blueprint?: SolutionBlueprint;
  workspace?: WorkspaceDefinition;
  design?: { coverage: Array<{ id?: string; claim: string; status?: string }> };
};

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

function list<T>(value: unknown, name: string, parse: (item: unknown, path: string) => T, allowEmpty = true): T[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new Error(`${name} 必须是${allowEmpty ? '' : '非空'}数组`);
  return value.map((item, index) => parse(item, `${name}[${index}]`));
}

function id(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(result) || ['__proto__', 'constructor', 'prototype'].includes(result)) {
    throw new Error(`${name} 格式无效`);
  }
  return result;
}

function unique(values: string[], name: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${name} 不得重复`);
}

function stringList(value: unknown, name: string): string[] {
  const result = list(value, name, text);
  unique(result, name);
  return result;
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, name: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new Error(`${name} 不受支持`);
  return value as T[number];
}

export function parseDomainPages(value: unknown): DomainPage[] {
  const pages = list(value, 'demo-spec.pages', (raw, name): DomainPage => {
    const page = object(raw, name);
    onlyKeys(page, ['id', 'title', 'goal', 'datasets', 'metrics', 'actions', 'components', 'claimIds', 'links'], name);
    const pageId = id(page.id, `${name}.id`);
    if (pageId === 'solution') throw new Error('demo-spec.pages 不得声明固定首页 solution');
    if (pageId === 'chat') throw new Error('demo-spec.pages 不得声明内置导航 ID chat');
    const components = list(page.components, `${name}.components`, (item, path) => enumValue(item,
      ['metrics', 'records', 'workflow', 'assistant'] as const, path));
    unique(components, `${name}.components`);
    const links = list(page.links, `${name}.links`, (rawLink, path) => {
      const link = object(rawLink, path);
      onlyKeys(link, ['label', 'pageId', 'dataset', 'recordId'], path);
      const dataset = link.dataset === undefined ? undefined : id(link.dataset, `${path}.dataset`);
      const recordId = link.recordId === undefined ? undefined : text(link.recordId, `${path}.recordId`);
      if (recordId !== undefined && dataset === undefined) throw new Error(`${path}.recordId 需要同时指定 dataset`);
      return { label: text(link.label, `${path}.label`), pageId: id(link.pageId, `${path}.pageId`),
        ...(dataset ? { dataset } : {}), ...(recordId ? { recordId } : {}) };
    });
    if (!components.length) throw new Error(`${name}.components 至少需要一项`);
    return { id: pageId, title: text(page.title, `${name}.title`), goal: text(page.goal, `${name}.goal`),
      datasets: stringList(page.datasets, `${name}.datasets`), metrics: stringList(page.metrics, `${name}.metrics`),
      actions: stringList(page.actions, `${name}.actions`), components, claimIds: stringList(page.claimIds, `${name}.claimIds`), links };
  }, false);
  unique(pages.map(page => page.id), 'demo-spec.pages.id');
  return pages;
}

export function parseSolutionBlueprint(value: unknown): SolutionBlueprint {
  const blueprint = object(value, 'demo-spec.blueprint');
  onlyKeys(blueprint, ['objectives', 'sources', 'journey', 'systems', 'dataNotes', 'phases'], 'demo-spec.blueprint');
  const objectives = list(blueprint.objectives, 'demo-spec.blueprint.objectives', (raw, name) => {
    const item = object(raw, name); onlyKeys(item, ['id', 'title', 'measure'], name);
    return { id: id(item.id, `${name}.id`), title: text(item.title, `${name}.title`), measure: text(item.measure, `${name}.measure`) };
  }, false);
  unique(objectives.map(item => item.id), 'demo-spec.blueprint.objectives.id');
  const sources = list(blueprint.sources, 'demo-spec.blueprint.sources', (raw, name) => {
    const item = object(raw, name); onlyKeys(item, ['id', 'title', 'url', 'checkedAt', 'kind', 'finding', 'status', 'region', 'evidence'], name);
    const kind = enumValue(item.kind, ['website', 'customer', 'assumption'] as const, `${name}.kind`);
    const status = enumValue(item.status, ['observed', 'confirmed', 'hypothesis', 'unavailable'] as const, `${name}.status`);
    const url = item.url === undefined ? undefined : text(item.url, `${name}.url`);
    const checkedAt = item.checkedAt === undefined ? undefined : text(item.checkedAt, `${name}.checkedAt`);
    if (url !== undefined) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error(`${name}.url 必须是有效网址`); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`${name}.url 仅支持公开 HTTP(S) 地址`);
    }
    if (kind === 'website' && (!url || !checkedAt || !Number.isFinite(Date.parse(checkedAt)))) {
      throw new Error(`${name} website 来源必须包含有效 url 和 checkedAt`);
    }
    if (kind !== 'website' && checkedAt !== undefined) throw new Error(`${name}.checkedAt 仅用于网站检查来源`);
    if (status === 'unavailable' && kind !== 'website') throw new Error(`${name}.status=unavailable 仅用于网站来源`);
    return { id: id(item.id, `${name}.id`), title: text(item.title, `${name}.title`), kind,
      finding: text(item.finding, `${name}.finding`), status,
      ...(url ? { url } : {}), ...(checkedAt ? { checkedAt } : {}),
      ...(item.region !== undefined ? { region: text(item.region, `${name}.region`) } : {}),
      ...(item.evidence !== undefined ? { evidence: text(item.evidence, `${name}.evidence`) } : {}) };
  });
  unique(sources.map(item => item.id), 'demo-spec.blueprint.sources.id');
  const journey = list(blueprint.journey, 'demo-spec.blueprint.journey', (raw, name) => {
    const item = object(raw, name); onlyKeys(item, ['id', 'title', 'role', 'description', 'domainId', 'next'], name);
    return { id: id(item.id, `${name}.id`), title: text(item.title, `${name}.title`), role: text(item.role, `${name}.role`),
      description: text(item.description, `${name}.description`),
      ...(item.domainId !== undefined ? { domainId: id(item.domainId, `${name}.domainId`) } : {}),
      ...(item.next !== undefined ? { next: stringList(item.next, `${name}.next`) } : {}) };
  }, false);
  unique(journey.map(item => item.id), 'demo-spec.blueprint.journey.id');
  const systems = list(blueprint.systems, 'demo-spec.blueprint.systems', (raw, name) => {
    const item = object(raw, name); onlyKeys(item, ['id', 'name', 'responsibility', 'status'], name);
    return { id: id(item.id, `${name}.id`), name: text(item.name, `${name}.name`), responsibility: text(item.responsibility, `${name}.responsibility`),
      status: enumValue(item.status, ['simulated', 'planned', 'connected'] as const, `${name}.status`) };
  });
  unique(systems.map(item => item.id), 'demo-spec.blueprint.systems.id');
  const phases = list(blueprint.phases, 'demo-spec.blueprint.phases', (raw, name) => {
    const item = object(raw, name); onlyKeys(item, ['id', 'title', 'description'], name);
    return { id: id(item.id, `${name}.id`), title: text(item.title, `${name}.title`), description: text(item.description, `${name}.description`) };
  }, false);
  unique(phases.map(item => item.id), 'demo-spec.blueprint.phases.id');
  return { objectives, sources, journey, systems, dataNotes: list(blueprint.dataNotes, 'demo-spec.blueprint.dataNotes', text), phases };
}

export function validateSolutionReferences(spec: SolutionSpec, data?: WorkspaceData): void {
  if (spec.version < 3) return;
  const pages = spec.pages ?? [];
  const assistantEnabled = getSolutionOverviewPage(spec).components.includes('assistant');
  const pageIds = new Set(['solution', ...(assistantEnabled ? ['chat'] : []), ...pages.map(page => page.id)]);
  const datasetIds = new Set(spec.workspace?.datasets.map(dataset => dataset.id) ?? []);
  const metricIds = new Set(spec.workspace?.metrics.map(metric => metric.id) ?? []);
  const actionIds = new Set(spec.workspace?.workflow?.transitions.map(action => action.id) ?? []);
  const roles = new Set(spec.workspace?.roles.map(role => role.id) ?? []);
  const claims = new Set(spec.design?.coverage.map(item => item.id).filter((item): item is string => Boolean(item)) ?? []);
  const dataRows = new Map(data?.datasets.map(dataset => [dataset.id, new Set(dataset.rows.map(row => String(row[spec.workspace!.datasets.find(schema => schema.id === dataset.id)!.key])))]) ?? []);
  const assertSet = (values: string[], known: Set<string>, name: string) => {
    for (const value of values) if (!known.has(value)) throw new Error(`${name} 引用了不存在的配置：${value}`);
  };
  for (const page of pages) {
    assertSet(page.datasets, datasetIds, `页面 ${page.id}.datasets`);
    assertSet(page.metrics, metricIds, `页面 ${page.id}.metrics`);
    assertSet(page.actions, actionIds, `页面 ${page.id}.actions`);
    assertSet(page.claimIds, claims, `页面 ${page.id}.claimIds`);
    for (const metricId of page.metrics) {
      const metric = spec.workspace?.metrics.find(item => item.id === metricId)!;
      if (!page.datasets.includes(metric.dataset)) throw new Error(`页面 ${page.id} 未声明指标 ${metricId} 的数据集 ${metric.dataset}`);
      for (const filter of [...(metric.filters ?? []), ...(metric.numerator ?? []), ...(metric.denominator ?? [])]) {
        if (filter.dataset && !page.datasets.includes(filter.dataset)) throw new Error(`页面 ${page.id} 未声明指标 ${metricId} 的关联数据集 ${filter.dataset}`);
      }
    }
    if (page.actions.length && spec.workspace?.workflow && !page.datasets.includes(spec.workspace.workflow.dataset)) {
      throw new Error(`页面 ${page.id} 未声明工作流数据集 ${spec.workspace.workflow.dataset}`);
    }
    if (page.actions.length && !page.components.includes('workflow')) {
      throw new Error(`页面 ${page.id} 声明了动作但未启用 workflow 组件`);
    }
    if (page.components.includes('records') && page.datasets.length === 0) throw new Error(`页面 ${page.id} 的 records 组件需要数据集`);
    if (page.components.includes('metrics') && page.metrics.length === 0) throw new Error(`页面 ${page.id} 的 metrics 组件需要指标`);
    if (page.components.includes('workflow') && (!spec.workspace?.workflow || page.actions.length === 0)) throw new Error(`页面 ${page.id} 的 workflow 组件需要工作流和动作`);
    for (const link of page.links) {
      if (link.pageId === 'chat' && !assistantEnabled) throw new Error(`页面 ${page.id} 的链接目标 chat 需要该 Demo 启用 assistant`);
      if (['solution', 'chat'].includes(link.pageId) && (link.dataset || link.recordId)) {
        throw new Error(`页面 ${page.id} 不得为内置导航 ${link.pageId} 指定业务数据`);
      }
      if (link.pageId !== 'solution' && link.pageId !== 'chat' && !pages.some(target => target.id === link.pageId)) throw new Error(`页面 ${page.id} 的链接目标不存在：${link.pageId}`);
      if (link.dataset) {
        assertSet([link.dataset], datasetIds, `页面 ${page.id}.links.dataset`);
        if (link.pageId !== 'solution' && link.pageId !== 'chat' && !pages.find(target => target.id === link.pageId)?.datasets.includes(link.dataset)) {
          throw new Error(`页面 ${page.id} 的数据链接目标页面未声明数据集 ${link.dataset}`);
        }
      }
      if (link.recordId && data) {
        const rowKeys = dataRows.get(link.dataset!);
        if (!rowKeys?.has(link.recordId)) throw new Error(`页面 ${page.id} 的链接记录不存在：${link.dataset}/${link.recordId}`);
      }
    }
  }
  const steps = spec as SolutionSpec & { steps?: Array<{ id?: string; pageId?: string; role?: string; claimIds?: string[] }> };
  const stepIds = (steps.steps ?? []).map(step => step.id).filter((item): item is string => Boolean(item));
  unique(stepIds, 'demo-spec.steps.id');
  for (const step of steps.steps ?? []) {
    if (step.pageId === 'chat' && !assistantEnabled) throw new Error(`步骤 ${step.id ?? ''} 引用了内置 chat，但该 Demo 未启用 assistant`);
    if (!step.pageId || !pageIds.has(step.pageId)) throw new Error(`步骤 ${step.id ?? ''} 引用了不存在的页面：${step.pageId ?? ''}`);
    if (!step.role || !roles.has(step.role)) throw new Error(`步骤 ${step.id ?? ''} 引用了不存在的角色：${step.role ?? ''}`);
    assertSet(step.claimIds ?? [], claims, `步骤 ${step.id ?? ''}.claimIds`);
  }
  const journeyIds = new Set(spec.blueprint?.journey.map(item => item.id) ?? []);
  for (const item of spec.blueprint?.journey ?? []) {
    if (!roles.has(item.role)) throw new Error(`旅程 ${item.id} 引用了不存在的角色：${item.role}`);
    if (item.domainId === 'chat' && !assistantEnabled) throw new Error(`旅程 ${item.id} 引用了内置 chat，但该 Demo 未启用 assistant`);
    if (item.domainId && item.domainId !== 'chat' && !pages.some(page => page.id === item.domainId)) throw new Error(`旅程 ${item.id} 引用了不存在的领域页面：${item.domainId}`);
    assertSet(item.next ?? [], journeyIds, `旅程 ${item.id}.next`);
  }
}

export function validateSolutionData(spec: SolutionSpec, data: WorkspaceData): void {
  validateSolutionReferences(spec, data);
}

export function isPlannedDomain(page: DomainPage, coverage: Array<{ id?: string; status?: string }>): boolean {
  return page.claimIds.length > 0 && page.claimIds.every(id => coverage.find(claim => claim.id === id)?.status === 'planned');
}

/**
 * Builds the fixed, read-only overview page from domains that are available in
 * this demo. Planned-only domains remain visible in the blueprint, but do not
 * contribute queryable data or knowledge until their claims are implemented.
 */
export function getSolutionOverviewPage(spec: SolutionSpec): DomainPage {
  if (spec.version < 3 || !spec.pages) throw new Error('方案总览仅支持V3配置');
  const coverage = spec.design?.coverage ?? [];
  const pages = spec.pages.filter(page => !isPlannedDomain(page, coverage));
  const unique = (values: string[]) => [...new Set(values)];
  const metrics = unique(pages.flatMap(page => page.metrics));
  const datasets = unique(pages.flatMap(page => page.datasets));
  const claimIds = unique(pages.flatMap(page => page.claimIds.filter(claimId =>
    coverage.find(claim => claim.id === claimId)?.status !== 'planned')));
  return {
    id: 'solution',
    title: '方案总览',
    goal: spec.solution ?? '查看已确认方案与本次演示范围',
    datasets,
    metrics,
    actions: [],
    components: [...(pages.some(page => page.components.includes('assistant')) ? ['assistant' as const] : []), ...(metrics.length ? ['metrics' as const] : []), ...(datasets.length ? ['records' as const] : [])],
    claimIds,
    links: pages.map(page => ({ label: page.title, pageId: page.id })),
  };
}

/** Resolves the fixed overview or one configured business page. */
export function resolveDomainPage(spec: SolutionSpec, domainId: string | undefined): DomainPage | undefined {
  if (!domainId || spec.version < 3) return undefined;
  if (domainId === 'chat') return undefined;
  if (domainId === 'solution') return getSolutionOverviewPage(spec);
  return spec.pages?.find(page => page.id === domainId);
}

/** Knowledge is exposed only for configured, non-planned domains. */
export function getDomainKnowledgeIds(spec: SolutionSpec, domainId: string | undefined): string[] {
  if (spec.version < 3 || !domainId) return [];
  if (domainId === 'solution') return getSolutionOverviewPage(spec).links.map(link => link.pageId);
  const page = resolveDomainPage(spec, domainId);
  if (!page || isPlannedDomain(page, spec.design?.coverage ?? [])) return [];
  return [page.id];
}

export function validateDomainAction(spec: SolutionSpec, domainId: string | undefined, actionId: string): void {
  if (spec.version < 3) return;
  if (!domainId) throw new Error('V3 业务操作必须指定 domainId');
  if (domainId === 'solution') throw new Error('方案总览仅支持只读问答，不能执行业务操作');
  const page = resolveDomainPage(spec, domainId);
  if (!page) throw new Error(`业务操作领域不存在：${domainId}`);
  if (isPlannedDomain(page, spec.design?.coverage ?? [])) throw new Error('该领域为后续接入，当前不能执行操作');
  if (!page.actions.includes(actionId)) throw new Error(`动作 ${actionId} 未在领域 ${domainId} 中启用`);
}

export function resolveDomainContext(spec: SolutionSpec, input?: DomainChatContext): ResolvedDomainContext | undefined {
  if (!input) return undefined;
  if (spec.version < 3) {
    return { domainId: input.domainId ?? '', query: input.query ?? {}, ...(input.selectedRecord ? { selectedRecord: input.selectedRecord } : {}) };
  }
  if (!input.domainId) {
    if (input.query || input.selectedRecord) throw new Error('V3 业务上下文必须指定 domainId');
    return undefined;
  }
  const page = resolveDomainPage(spec, input.domainId);
  if (!page) throw new Error(`领域不存在：${input.domainId}`);
  const query = input.query ?? {};
  const allowedDatasets = new Set(page.datasets);
  if (query.dataset && !allowedDatasets.has(query.dataset)) throw new Error(`分析数据集不属于当前领域：${query.dataset}`);
  for (const filter of query.filters ?? []) {
    if (filter.dataset && !allowedDatasets.has(filter.dataset)) throw new Error(`分析筛选不属于当前领域：${filter.dataset}`);
    if (!filter.dataset && !page.datasets.some(datasetId => spec.workspace?.datasets.find(dataset => dataset.id === datasetId)?.fields.some(field => field.id === filter.field))) {
      throw new Error(`分析字段不属于当前领域：${filter.field}`);
    }
  }
  if (query.timeField && !page.datasets.some(datasetId => spec.workspace?.datasets.find(dataset => dataset.id === datasetId)?.fields.some(field => field.id === query.timeField && field.type === 'date'))) {
    throw new Error(`分析日期字段不属于当前领域：${query.timeField}`);
  }
  if (input.selectedRecord && !allowedDatasets.has(input.selectedRecord.dataset)) {
    throw new Error(`选中记录不属于当前领域：${input.selectedRecord.dataset}`);
  }
  return { domainId: page.id, query, ...(input.selectedRecord ? { selectedRecord: input.selectedRecord } : {}) };
}
