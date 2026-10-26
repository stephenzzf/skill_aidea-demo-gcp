import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScenario, parseSpec } from '../shared/spec.ts';
import type { DemoSpec } from '../shared/spec.ts';
import type { WorkspaceData } from '../shared/workspace.ts';
import { getDomainKnowledgeIds, getSolutionOverviewPage, resolveDomainContext, resolveDomainPage, validateDomainAction, validateSolutionData } from '../shared/solution.ts';

const workspace = {
  views: ['overview', 'records', 'workflow', 'assistant'],
  roles: [{ id: 'operator', label: '运营人员' }],
  stages: [
    { id: 'idea', label: '待处理' }, { id: 'planned', label: '已计划' },
    { id: 'processing', label: '处理中' }, { id: 'closed', label: '已完成' },
  ],
  datasets: [
    { id: 'observations', label: '观察记录', key: 'id', origin: 'synthetic', source: '合成观察数据', fields: [
      { id: 'id', label: '记录编号', type: 'string', required: true },
      { id: 'brand', label: '品牌', type: 'string', required: true },
      { id: 'day', label: '日期', type: 'date', required: true },
      { id: 'mentioned', label: '是否提及', type: 'boolean', required: true },
      { id: 'score', label: '质量分', type: 'number', required: true },
    ] },
    { id: 'actions', label: '模拟行动', key: 'id', origin: 'synthetic', source: '合成行动数据', fields: [
      { id: 'id', label: '行动编号', type: 'string', required: true },
      { id: 'status', label: '状态', type: 'string', required: true },
      { id: 'day', label: '日期', type: 'date', required: true },
      { id: 'proposal', label: '行动草稿', type: 'string' },
      { id: 'evidence', label: '验收证据', type: 'string' },
      { id: 'response', label: '处理结果', type: 'string' },
    ] },
  ],
  metrics: [
    { id: 'observations', label: '观察样本', dataset: 'observations', operation: 'count', description: '观察记录数', scope: 'snapshot', timeField: 'day', groupBy: 'brand' },
    { id: 'mention_rate', label: '提及率', dataset: 'observations', operation: 'ratio', description: '提及记录占比', scope: 'snapshot', numerator: [{ field: 'mentioned', op: 'eq', value: true }], denominator: [], timeField: 'day' },
    { id: 'average_score', label: '平均质量分', dataset: 'observations', operation: 'avg', field: 'score', description: '平均质量分', scope: 'snapshot', timeField: 'day' },
    { id: 'closed_actions', label: '已完成行动', dataset: 'actions', operation: 'count', description: '已完成行动数', scope: 'current', filters: [{ field: 'status', op: 'eq', value: 'closed' }], timeField: 'day', groupBy: 'status' },
  ],
  workflow: {
    dataset: 'actions', statusField: 'status', editableFields: ['proposal', 'evidence', 'response'],
    transitions: [
      { id: 'prepare', label: '建立行动', from: ['idea'], to: 'planned', role: 'operator', inputFields: [{ id: 'proposal', label: '行动草稿', type: 'string', required: true }], requiredFields: ['proposal'] },
      { id: 'start', label: '开始处理', from: ['planned'], to: 'processing', role: 'operator', inputFields: [], requiredFields: [] },
      { id: 'finish', label: '记录结果', from: ['processing'], to: 'closed', role: 'operator', inputFields: [
        { id: 'evidence', label: '验收证据', type: 'string', required: true },
        { id: 'response', label: '处理结果', type: 'string', required: true },
      ], requiredFields: ['evidence', 'response'] },
    ],
  },
};

function baseSpec(version: 1 | 2): Record<string, any> {
  const raw: Record<string, any> = {
    version,
    id: `solution-test-v${version}`,
    customer: '测试客户',
    assistantName: '方案助手',
    title: '分析与行动工作台',
    subtitle: '测试用的跨领域方案配置。',
    audience: '运营人员',
    goal: '验证方案配置与领域边界。',
    solution: '从指标追溯到来源记录并验证模拟行动。',
    confirmed: true,
    prompts: ['解释当前分析结果'],
    steps: [{ question: '查看指标', expected: '指标可追溯' }],
    acceptance: ['配置有效'],
    model: { project: '', location: '', model: '' },
  };
  if (version === 2) {
    raw.workspace = structuredClone(workspace);
    raw.design = {
      facts: ['本文件中的内容是测试夹具，不是客户事实。'],
      assumptions: ['无真实业务数据。'],
      implementation: ['仅验证本地配置解析。'],
      coverage: [{ claim: '测试覆盖配置解析', status: 'unverified', evidence: '测试夹具' }],
    };
  }
  return raw;
}

function v3Raw(): Record<string, any> {
  const raw = baseSpec(2);
  raw.version = 3;
  raw.design.coverage = [
    { id: 'C-ANALYSIS', claim: '分析可追溯', status: 'unverified', evidence: '本地测试夹具' },
    { id: 'C-ACTION', claim: '行动产生回执', status: 'simulated', evidence: '本地测试夹具' },
  ];
  raw.pages = [
    { id: 'insights', title: '洞察分析', goal: '观察指标并定位来源', datasets: ['observations'], metrics: ['observations', 'mention_rate', 'average_score'], actions: [], components: ['metrics', 'records', 'assistant'], claimIds: ['C-ANALYSIS'], links: [{ label: '建立行动', pageId: 'operations', dataset: 'actions', recordId: 'GEO-A001' }] },
    { id: 'operations', title: '运营行动', goal: '处理分析发现并查看回执', datasets: ['actions'], metrics: ['closed_actions'], actions: ['prepare', 'start', 'finish'], components: ['records', 'workflow'], claimIds: ['C-ACTION'], links: [] },
  ];
  raw.steps = [
    { id: 'step-inspect', question: '筛选并检查指标', expected: '结果与来源可回读', role: 'operator', pageId: 'insights', preconditions: [], inputs: ['品牌', '日期范围'], observation: '指标样本与来源记录一致', claimIds: ['C-ANALYSIS'] },
    { id: 'step-action', question: '记录模拟行动', expected: '展示状态和回执', role: 'operator', pageId: 'operations', preconditions: ['已选中来源记录'], inputs: ['行动草稿'], observation: '行动状态改变，快照指标不变', claimIds: ['C-ACTION'] },
  ];
  raw.blueprint = {
    objectives: [{ id: 'objective-1', title: '改善发现到行动的可追溯性', measure: '能从指标进入来源记录并回读模拟结果' }],
    sources: [{ id: 'source-fixture', title: '测试夹具（非真实网站检查）', url: 'https://example.invalid', checkedAt: '2026-10-24T08:00:00.000Z', kind: 'website', finding: '仅用于验证配置格式；本测试未检查网站。', status: 'observed', region: 'fixture', evidence: '测试夹具；非真实检查证据。' }],
    journey: [
      { id: 'journey-inspect', title: '查看指标', role: 'operator', description: '筛选观察记录', domainId: 'insights', next: ['journey-act'] },
      { id: 'journey-act', title: '创建行动', role: 'operator', description: '确认模拟回执', domainId: 'operations', next: [] },
    ],
    systems: [{ id: 'demo-data', name: '测试数据集', responsibility: '提供确定性测试记录', status: 'simulated' }],
    dataNotes: ['全部数据为测试夹具，不代表真实业务表现。'],
    phases: [{ id: 'phase-demo', title: '本地配置验证', description: '验证解析和引用关系。' }],
  };
  return raw;
}

function v3Spec(): DemoSpec { return parseSpec(v3Raw()); }

function workspaceData(): WorkspaceData {
  return {
    datasets: [
      { id: 'observations', rows: [{ id: 'O-1', brand: 'A', day: '2026-10-24', mentioned: true, score: 80 }] },
      { id: 'actions', rows: [{ id: 'GEO-A001', status: 'idea', day: '2026-10-24' }] },
    ],
  };
}

function scenarioRaw(domainIds?: string[]): Record<string, any> {
  return {
    version: 2,
    synthetic: true,
    instruction: '测试夹具说明。',
    topics: [{ id: 'catalog', title: '测试主题', keywords: ['测试'], answer: '仅供测试', rows: [['来源', '测试夹具']], source: '测试夹具', followups: [], ...(domainIds ? { domainIds } : {}) }],
    workspace: workspaceData(),
  };
}

test('V1/V2 stay compatible while V3 requires the confirmed solution and domain pages', () => {
  const legacyV1 = parseSpec(baseSpec(1));
  const legacyV2 = parseSpec(baseSpec(2));
  assert.equal(legacyV1.version, 1);
  assert.equal(legacyV2.version, 2);
  const spec = v3Spec();
  assert.equal(spec.version, 3);
  assert.equal(spec.pages?.[0].id, 'insights');
  assert.equal(spec.blueprint?.sources[0].kind, 'website');
  const incomplete = baseSpec(2);
  incomplete.version = 3;
  assert.throws(() => parseSpec(incomplete), /必须提供 workspace、design、blueprint 与 pages/);
});

test('V3 rejects unknown fields, invalid tabs, and dangling domain, claim, journey and record references', () => {
  const spec = v3Spec();
  const mutate = (fn: (raw: Record<string, any>) => void) => {
    const raw = v3Raw();
    fn(raw);
    return raw;
  };
  assert.throws(() => parseSpec(mutate(raw => { raw.pages[0].tabType = 'unknown'; })), /pages\[0\]\.tabType 不受支持/);
  assert.throws(() => parseSpec(mutate(raw => { raw.pages[0].id = 'solution'; })), /不得声明固定首页/);
  assert.throws(() => parseSpec(mutate(raw => { raw.pages[0].id = 'chat'; })), /不得声明内置导航 ID chat/);
  assert.throws(() => parseSpec(mutate(raw => { raw.pages[1].components = ['records']; })), /声明了动作但未启用 workflow 组件/);
  assert.throws(() => parseSpec(mutate(raw => { raw.pages[0].datasets = ['missing']; })), /引用了不存在的配置/);
  assert.throws(() => parseSpec(mutate(raw => { raw.pages[0].claimIds = ['missing']; })), /引用了不存在的配置/);
  assert.throws(() => parseSpec(mutate(raw => { raw.steps[0].pageId = 'missing'; })), /步骤 .* 引用了不存在的页面/);
  assert.throws(() => parseSpec(mutate(raw => { raw.blueprint.journey[0].next = ['missing']; })), /旅程 .* 引用了不存在的配置/);
  assert.throws(() => parseSpec(mutate(raw => { raw.workspace.futureField = true; })), /workspace\.futureField 不受支持/);
  assert.throws(() => parseSpec(mutate(raw => { raw.workspace.metrics[0].typo = true; })), /metrics\[0\]\.typo 不受支持/);
  assert.throws(() => parseSpec(mutate(raw => { raw.steps[0].typo = true; })), /steps\[0\]\.typo 不受支持/);
  assert.throws(() => parseSpec(mutate(raw => { raw.blueprint.sources = [{ id: 'bad', title: '测试夹具（非真实网站检查）', kind: 'website', finding: '测试夹具；非真实检查', status: 'observed' }]; })), /website 来源必须包含有效 url 和 checkedAt/);
  assert.doesNotThrow(() => validateSolutionData(spec, workspaceData()));
  const missingLinkedRecord = workspaceData();
  missingLinkedRecord.datasets.find(dataset => dataset.id === 'actions')!.rows = [];
  assert.throws(() => validateSolutionData(spec, missingLinkedRecord), /链接记录不存在/);
});

test('domain context and actions remain inside the selected V3 page', () => {
  const spec = v3Spec();
  const valid = resolveDomainContext(spec, { domainId: 'insights', query: { dataset: 'observations', filters: [{ field: 'brand', op: 'eq', value: 'A' }] }, selectedRecord: { dataset: 'observations', id: 'O-1' } });
  assert.equal(valid?.domainId, 'insights');
  assert.equal(valid?.selectedRecord?.id, 'O-1');
  assert.throws(() => resolveDomainContext(spec, { domainId: 'missing', query: {} }), /领域不存在/);
  assert.throws(() => resolveDomainContext(spec, { domainId: 'insights', query: { dataset: 'actions' } }), /不属于当前领域/);
  assert.throws(() => resolveDomainContext(spec, { query: { dataset: 'observations' } }), /必须指定 domainId/);
  assert.throws(() => resolveDomainContext(spec, { domainId: 'insights', selectedRecord: { dataset: 'actions', id: 'GEO-A001' } }), /选中记录不属于当前领域/);
  assert.doesNotThrow(() => validateDomainAction(spec, 'operations', 'prepare'));
  assert.throws(() => validateDomainAction(spec, 'insights', 'prepare'), /未在领域 .* 中启用/);
  assert.throws(() => validateDomainAction(spec, undefined, 'prepare'), /必须指定 domainId/);
  const legacy = parseSpec(baseSpec(2));
  assert.deepEqual(resolveDomainContext(legacy, { query: { dataset: 'observations' } })?.query, { dataset: 'observations' });
});

test('the fixed solution overview aggregates only available domains and stays read-only', () => {
  const spec = v3Spec();
  const overview = getSolutionOverviewPage(spec);
  assert.equal(overview.id, 'solution');
  assert.deepEqual(overview.datasets, ['observations', 'actions']);
  assert.deepEqual(overview.metrics, ['observations', 'mention_rate', 'average_score', 'closed_actions']);
  assert.deepEqual(overview.actions, []);
  assert.deepEqual(getDomainKnowledgeIds(spec, 'solution'), ['insights', 'operations']);
  const context = resolveDomainContext(spec, { domainId: 'solution', query: { dataset: 'actions' }, selectedRecord: { dataset: 'actions', id: 'GEO-A001' } });
  assert.equal(context?.domainId, 'solution');
  assert.equal(context?.selectedRecord?.dataset, 'actions');
  assert.throws(() => resolveDomainContext(spec, { domainId: 'solution', query: { dataset: 'missing' } }), /不属于当前领域/);
  assert.throws(() => validateDomainAction(spec, 'solution', 'prepare'), /只读问答/);

  const withoutAssistant = structuredClone(spec);
  for (const page of withoutAssistant.pages!) page.components = page.components.filter(component => component !== 'assistant');
  assert.equal(getSolutionOverviewPage(withoutAssistant).components.includes('assistant'), false, 'read-only overview does not force AI into a non-AI demo');

  const planned = structuredClone(spec);
  planned.design!.coverage.find(claim => claim.id === 'C-ACTION')!.status = 'planned';
  const plannedOverview = getSolutionOverviewPage(planned);
  assert.deepEqual(plannedOverview.datasets, ['observations']);
  assert.deepEqual(plannedOverview.metrics, ['observations', 'mention_rate', 'average_score']);
  assert.deepEqual(getDomainKnowledgeIds(planned, 'solution'), ['insights']);
  assert.deepEqual(planned.blueprint?.systems.map(system => system.status), ['simulated'], 'overview does not rewrite configured system status');
});

test('chat is a built-in navigation target only when an available domain enables assistant', () => {
  const enabled = v3Raw();
  enabled.steps[0].pageId = 'chat';
  enabled.blueprint.journey[0].domainId = 'chat';
  enabled.pages[0].links.push({ label: '打开方案对话', pageId: 'chat' });
  assert.doesNotThrow(() => parseSpec(enabled), 'steps, journey and links may target the built-in chat tab');
  const spec = v3Spec();
  assert.equal(resolveDomainPage(spec, 'chat'), undefined, 'chat is not an API domain or model context');
  assert.throws(() => resolveDomainContext(spec, { domainId: 'chat', query: {} }), /领域不存在/);
  assert.throws(() => parseSpec({ ...enabled, pages: enabled.pages.map((page: Record<string, any>, index: number) => ({
    ...page,
    links: index === 0 ? [...page.links, { label: '带业务数据打开对话', pageId: 'chat', dataset: 'observations', recordId: 'O-1' }] : page.links,
  })) }), /不得为内置导航 chat 指定业务数据/);

  const withoutAssistant = v3Raw();
  for (const page of withoutAssistant.pages) page.components = page.components.filter((component: string) => component !== 'assistant');
  assert.throws(() => parseSpec({ ...withoutAssistant, steps: withoutAssistant.steps.map((step: Record<string, any>) => ({ ...step, pageId: 'chat' })) }), /步骤 .*引用了内置 chat，但该 Demo 未启用 assistant/);
  const noAssistantLink = structuredClone(withoutAssistant);
  noAssistantLink.pages[0].links.push({ label: '打开方案对话', pageId: 'chat' });
  assert.throws(() => parseSpec(noAssistantLink), /链接目标 chat 需要该 Demo 启用 assistant/);
  const noAssistantJourney = structuredClone(withoutAssistant);
  noAssistantJourney.blueprint.journey[0].domainId = 'chat';
  assert.throws(() => parseSpec(noAssistantJourney), /旅程 .*引用了内置 chat，但该 Demo 未启用 assistant/);
});

test('V3 scenario knowledge must be explicitly bound to one or more known domains', () => {
  const spec = v3Spec();
  const parsed = parseScenario(scenarioRaw(['insights', 'operations']), spec.workspace, spec);
  assert.deepEqual(parsed.topics[0].domainIds, ['insights', 'operations']);

  assert.throws(() => parseScenario(scenarioRaw(), spec.workspace, spec), /V3 中必填且至少指定一个领域/);
  assert.throws(() => parseScenario(scenarioRaw([]), spec.workspace, spec), /domainIds 必须是非空数组/);
  assert.throws(() => parseScenario(scenarioRaw(['unknown']), spec.workspace, spec), /引用了不存在的领域/);
  assert.throws(() => parseScenario(scenarioRaw(['insights', 'insights']), spec.workspace, spec), /domainIds 不得重复/);

  const legacy = parseSpec(baseSpec(2));
  assert.throws(() => parseScenario(scenarioRaw(['insights']), legacy.workspace, legacy), /domainIds 不受支持/);
});
