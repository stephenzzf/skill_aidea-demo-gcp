import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCapabilities, capabilityActions } from '../shared/capabilities.ts';
import type { CapabilityBinding } from '../shared/capabilities.ts';
import { parseWorkspace, parseWorkspaceData } from '../shared/workspace.ts';
import type { ActionRequest, WorkspaceState } from '../shared/workspace.ts';
import { analyzeCapabilities, applyCapabilityAction, capabilityChatSummary, materializeCapabilities } from '../server/capabilities.ts';
import type { DemoSpec, Scenario } from '../shared/spec.ts';

const workspace = parseWorkspace({
  views: ['overview', 'records', 'workflow'],
  roles: [{ id: 'reviewer', label: '复核人' }, { id: 'operator', label: '操作员' }],
  stages: [{ id: 'open', label: '待处理' }, { id: 'done', label: '已完成' }],
  datasets: [
    { id: 'orders', label: '订单', key: 'id', origin: 'synthetic', source: '合成订单样例', fields: [
      { id: 'id', label: '编号', type: 'string', required: true }, { id: 'currency', label: '币种', type: 'string' },
      { id: 'amount', label: '金额', type: 'number', required: true }, { id: 'channel', label: '渠道', type: 'string', required: true },
      { id: 'createdAt', label: '日期', type: 'date', required: true },
    ] },
    { id: 'catalog', label: '目录', key: 'id', origin: 'customer', source: '客户目录记录', fields: [
      { id: 'id', label: '编号', type: 'string', required: true }, { id: 'label', label: '名称', type: 'string', required: true },
    ] },
    { id: 'mappings', label: '映射', key: 'id', origin: 'synthetic', source: '合成映射样例', fields: [
      { id: 'id', label: '编号', type: 'string', required: true }, { id: 'targetId', label: '目标', type: 'string' },
      { id: 'evidence', label: '依据', type: 'string' }, { id: 'reviewStatus', label: '复核状态', type: 'string', required: true },
    ], relations: [{ field: 'targetId', dataset: 'catalog', target: 'id' }] },
    { id: 'workItems', label: '工作项', key: 'id', origin: 'synthetic', source: '合成工作项', fields: [
      { id: 'id', label: '编号', type: 'string', required: true }, { id: 'status', label: '状态', type: 'string', required: true },
      { id: 'title', label: '标题', type: 'string', required: true }, { id: 'mappingId', label: '映射', type: 'string', required: true },
      { id: 'ownerId', label: '负责人', type: 'string' }, { id: 'dueAt', label: '截止日期', type: 'date' }, { id: 'stale', label: '需要复核', type: 'boolean' },
    ], relations: [{ field: 'mappingId', dataset: 'mappings', target: 'id' }, { field: 'ownerId', dataset: 'catalog', target: 'id' }] },
  ],
  metrics: [
    { id: 'revenue', label: '订单金额', dataset: 'orders', operation: 'sum', field: 'amount', description: '订单金额', unit: 'amount', scope: 'current', groupBy: 'channel', timeField: 'createdAt' },
    { id: 'work-current', label: '当前工作项', dataset: 'workItems', operation: 'count', description: '当前工作项', scope: 'current' },
    { id: 'work-snapshot', label: '初始工作项', dataset: 'workItems', operation: 'count', description: '初始工作项', scope: 'snapshot' },
  ],
  workflow: { dataset: 'workItems', statusField: 'status', staleField: 'stale', transitions: [
    { id: 'verify', label: '重新核对', from: ['open'], to: 'open', role: 'operator', clearsStale: true },
    { id: 'finish', label: '完成', from: ['open'], to: 'done', role: 'operator', requireFresh: true, clearsStale: true },
  ] },
});

const pages = [
  { id: 'analytics', title: '分析', goal: '按币种查看金额', datasets: ['orders'], metrics: ['revenue'], actions: [], components: ['metrics', 'records'], claimIds: ['claim-analytics'], links: [] },
  { id: 'operations', title: '运营', goal: '复核映射并创建工作项', datasets: ['mappings', 'catalog', 'workItems'], metrics: ['work-current', 'work-snapshot'], actions: ['verify', 'finish'], components: ['metrics', 'records', 'workflow'], claimIds: ['claim-operations'], links: [] },
  { id: 'planned', title: '后续页面', goal: '尚未接入', datasets: ['mappings', 'catalog'], metrics: [], actions: [], components: ['records'], claimIds: ['claim-planned'], links: [] },
] as const;

const rawCapabilities = [
  { id: 'currency', kind: 'partitioned-analysis', version: 1, label: '分币种金额', pages: ['analytics'], dataset: 'orders', currencyField: 'currency' },
  { id: 'map', kind: 'mapping-review', version: 1, label: '映射复核', pages: ['operations'], role: 'reviewer', dataset: 'mappings', targetField: 'targetId', targetDataset: 'catalog', evidenceField: 'evidence', statusField: 'reviewStatus', resolvedStatus: 'resolved' },
  { id: 'followup', kind: 'work-items', version: 1, label: '新建工作项', pages: ['operations'], role: 'operator', dataset: 'workItems', inputFields: ['title', 'ownerId', 'dueAt'], defaults: { status: 'open', mappingId: 'M-1' } },
] as const;

const bindings = parseCapabilities(rawCapabilities, workspace, pages as unknown as Parameters<typeof parseCapabilities>[2]);
const data = parseWorkspaceData({ datasets: [
  { id: 'orders', rows: [
    { id: 'O-1', currency: 'USD', amount: 10, channel: 'online', createdAt: '2026-10-24' },
    { id: 'O-2', currency: 'EUR', amount: 20, channel: 'online', createdAt: '2026-10-24' },
    { id: 'O-3', currency: 'USD', amount: 5, channel: 'store', createdAt: '2026-10-23' },
    { id: 'O-4', amount: 7, channel: 'online', createdAt: '2026-10-24' },
  ] },
  { id: 'catalog', rows: [{ id: 'C-1', label: '目标一' }, { id: 'C-2', label: '目标二' }] },
  { id: 'mappings', rows: [{ id: 'M-1', targetId: null, evidence: '', reviewStatus: 'pending' }] },
  { id: 'workItems', rows: [{ id: 'W-1', status: 'open', title: '已有工作项', mappingId: 'M-1', stale: false }] },
] }, workspace);
const scenario = { synthetic: false, instruction: '仅用于本地能力测试', topics: [], workspace: data } as Scenario;

function makeSpec(capabilities: CapabilityBinding[] = bindings, planned = false): DemoSpec {
  const spec = {
    version: 4, id: 'capability-test', customer: '测试', assistantName: '助手', title: '能力测试', subtitle: '本地', audience: '测试',
    goal: '验证能力适配', solution: '本地模拟', confirmed: true, prompts: [], steps: [], acceptance: [], workspace,
    pages: pages.map(page => ({ ...page, datasets: [...page.datasets], metrics: [...page.metrics], actions: [...page.actions], components: [...page.components], claimIds: [...page.claimIds], links: [] })),
    design: { facts: [], assumptions: [], implementation: ['本地模拟'], coverage: [
      { id: 'claim-analytics', claim: '分析', status: 'simulated', evidence: '本地样例' },
      { id: 'claim-operations', claim: '运营', status: 'simulated', evidence: '本地样例' },
      { id: 'claim-planned', claim: '后续页面', status: planned ? 'planned' : 'unverified', evidence: '本地样例' },
    ] },
    blueprint: { objectives: [], sources: [], journey: [], systems: [], dataNotes: [], phases: [] },
    capabilities,
    model: { project: '', location: '', model: '' },
  };
  return spec as unknown as DemoSpec;
}

function request(state: WorkspaceState, actionId: string, recordId: string, role: string, input: Record<string, string | number | boolean> = {}, overrides: Partial<ActionRequest> = {}): ActionRequest {
  return { requestId: `request-${state.revision + 1}`, expectedRevision: state.revision, state, recordId, actionId, role,
    domainId: actionId.startsWith('review-') || actionId.startsWith('create-') || ['verify', 'finish'].includes(actionId) ? 'operations' : 'analytics', input, ...overrides };
}

test('capability parser is strict and actions are derived only for configured pages', () => {
  assert.deepEqual(capabilityActions(bindings, 'operations'), ['review-map', 'create-followup']);
  assert.deepEqual(capabilityActions(bindings, 'analytics'), []);
  assert.deepEqual(parseCapabilities([], workspace, pages as unknown as Parameters<typeof parseCapabilities>[2]), []);
  assert.throws(() => parseCapabilities(undefined, workspace, pages as unknown as Parameters<typeof parseCapabilities>[2]), /必须是数组/);
  assert.throws(() => parseCapabilities([{ ...rawCapabilities[0], version: '1' }], workspace, pages as unknown as Parameters<typeof parseCapabilities>[2]), /version/);
  assert.throws(() => parseCapabilities([{ ...rawCapabilities[0], extra: true }], workspace, pages as unknown as Parameters<typeof parseCapabilities>[2]), /不受支持/);
  assert.throws(() => parseCapabilities([{ ...rawCapabilities[0], pages: ['unknown'] }], workspace, pages as unknown as Parameters<typeof parseCapabilities>[2]), /不存在的页面/);
  assert.throws(() => parseCapabilities([{ ...rawCapabilities[0], pages: ['operations'] }], workspace, pages as unknown as Parameters<typeof parseCapabilities>[2]), /未声明能力.*orders/);
  assert.throws(() => parseCapabilities([{ ...rawCapabilities[1], role: 'missing' }], workspace, pages as unknown as Parameters<typeof parseCapabilities>[2]), /不存在的角色/);
  assert.throws(() => parseCapabilities([{ ...rawCapabilities[1], targetField: 'reviewStatus' }], workspace, pages as unknown as Parameters<typeof parseCapabilities>[2]), /关系字段/);
  assert.throws(() => parseCapabilities([{ ...rawCapabilities[2], dataset: 'orders' }], workspace, pages as unknown as Parameters<typeof parseCapabilities>[2]), /workflow.dataset/);
  assert.throws(() => parseCapabilities([{ ...rawCapabilities[2], inputFields: [], defaults: { status: 'open' } }], workspace, pages as unknown as Parameters<typeof parseCapabilities>[2]), /必填字段 title/);
  assert.throws(() => parseCapabilities([{ ...rawCapabilities[2], inputFields: 'title' }], workspace, pages as unknown as Parameters<typeof parseCapabilities>[2]), /必须是数组/);
  assert.throws(() => parseCapabilities([{ ...rawCapabilities[2], defaults: { status: 'open', dueAt: '2026-02-30' } }], workspace, pages as unknown as Parameters<typeof parseCapabilities>[2]), /类型不匹配/);
  assert.throws(() => parseCapabilities([{ ...rawCapabilities[2], pages: ['operations'], inputFields: ['title', 'ownerId'], defaults: { status: 'open', mappingId: 'M-1' } }],
    workspace, [{ ...pages[1], datasets: ['workItems', 'mappings'] }] as unknown as Parameters<typeof parseCapabilities>[2]), /未声明能力.*catalog/);
  assert.throws(() => parseCapabilities([rawCapabilities[0], { ...rawCapabilities[0], id: 'currency-2', currencyField: 'channel' }], workspace, pages as unknown as Parameters<typeof parseCapabilities>[2]), /只能配置一个币种字段/);
});

test('mapping review cannot mutate primary keys and work-item creation requires string keys', () => {
  const keyRelationWorkspace = {
    ...workspace,
    datasets: workspace.datasets.map(dataset => dataset.id === 'mappings'
      ? { ...dataset, relations: [{ field: 'id', dataset: 'catalog', target: 'id' }] }
      : dataset),
  };
  assert.throws(() => parseCapabilities([{ ...rawCapabilities[1], targetField: 'id' }], keyRelationWorkspace,
    pages as unknown as Parameters<typeof parseCapabilities>[2]), /targetField 不得修改数据集主键/);
  assert.throws(() => parseCapabilities([{ ...rawCapabilities[1], evidenceField: 'id' }], workspace,
    pages as unknown as Parameters<typeof parseCapabilities>[2]), /evidenceField 不得修改数据集主键/);
  assert.throws(() => parseCapabilities([{ ...rawCapabilities[1], statusField: 'id' }], workspace,
    pages as unknown as Parameters<typeof parseCapabilities>[2]), /statusField 不得修改数据集主键/);

  const numericKeyWorkspace = {
    ...workspace,
    datasets: workspace.datasets.map(dataset => dataset.id === 'workItems'
      ? { ...dataset, fields: dataset.fields.map(field => field.id === 'id' ? { ...field, type: 'number' as const } : field) }
      : dataset),
  };
  assert.throws(() => parseCapabilities([rawCapabilities[2]], numericKeyWorkspace,
    pages as unknown as Parameters<typeof parseCapabilities>[2]), /只支持字符串主键/);
});

test('mapping review validates scope, role, evidence and target, preserves verified rows, and marks linked work fresh-state stale', () => {
  const spec = makeSpec();
  const initial: WorkspaceState = { revision: 0, events: [] };
  const reviewed = applyCapabilityAction(spec, scenario, request(initial, 'review-map', 'M-1', 'reviewer', { target: 'C-1', evidence: '依据记录 R-7' }));
  assert.equal(reviewed.state.revision, 1);
  assert.equal(reviewed.receipt.to, 'C-1');
  const materialized = materializeCapabilities(spec, data, reviewed.state);
  const mapping = materialized.datasets.find(dataset => dataset.id === 'mappings')!.rows[0];
  const workItem = materialized.datasets.find(dataset => dataset.id === 'workItems')!.rows[0];
  assert.equal(mapping.targetId, 'C-1');
  assert.equal(mapping.evidence, '依据记录 R-7');
  assert.equal(mapping.reviewStatus, 'resolved');
  assert.equal(workItem.stale, true);
  assert.equal(data.datasets.find(dataset => dataset.id === 'mappings')!.rows[0].targetId, null, 'source scenario remains unchanged');
  assert.throws(() => applyCapabilityAction(spec, scenario, request(reviewed.state, 'review-map', 'M-1', 'reviewer', { target: 'C-2', evidence: '替换依据' })), /已核实/);
  assert.throws(() => applyCapabilityAction(spec, scenario, request(initial, 'review-map', 'M-1', 'operator', { target: 'C-1', evidence: '无权限' })), /角色/);
  assert.throws(() => applyCapabilityAction(spec, scenario, request(initial, 'review-map', 'M-1', 'reviewer', { target: 'missing', evidence: '无目标' })), /无法关联/);
  assert.throws(() => applyCapabilityAction(spec, scenario, request(initial, 'review-map', 'M-1', 'reviewer', { target: 'C-1', evidence: '' })), /填写映射依据/);
  assert.throws(() => applyCapabilityAction(spec, scenario, request(initial, 'review-map', 'M-1', 'reviewer', { target: 'C-1', evidence: '依据', other: '拒绝' })), /不支持输入/);
  assert.throws(() => applyCapabilityAction(spec, scenario, request(initial, 'review-map', 'M-1', 'reviewer', { target: 'C-1', evidence: '依据' }, { domainId: 'analytics' })), /未在页面 analytics 启用/);
  assert.throws(() => applyCapabilityAction(spec, scenario, request(initial, 'finish', 'W-1', 'operator', {}, { domainId: 'analytics' })), /未在页面 analytics 启用/);
  const plannedSpec = makeSpec(bindings, true);
  assert.throws(() => applyCapabilityAction(plannedSpec, scenario, request(initial, 'review-map', 'M-1', 'reviewer', { target: 'C-1', evidence: '依据' }, { domainId: 'planned' })), /后续接入/);
  const plannedOnly = makeSpec([{ ...bindings[1], pages: ['planned'] }], true);
  const forgedPlannedEvent: WorkspaceState = { revision: 1, events: [{ requestId: 'forged-001', recordId: 'M-1', actionId: 'review-map', role: 'reviewer',
    input: { target: 'C-1', evidence: '伪造页面事件' }, at: new Date().toISOString() }] };
  assert.throws(() => materializeCapabilities(plannedOnly, data, forgedPlannedEvent), /非 planned 页面/);
});

test('capability events preserve order, idempotent readback, optimistic revision and existing workflow transitions', () => {
  const spec = makeSpec();
  let state: WorkspaceState = { revision: 0, events: [] };
  const reviewRequest = request(state, 'review-map', 'M-1', 'reviewer', { target: 'C-1', evidence: '依据记录 R-7' });
  const reviewed = applyCapabilityAction(spec, scenario, reviewRequest);
  const retry = applyCapabilityAction(spec, scenario, { ...reviewRequest, state: reviewed.state, expectedRevision: 0 });
  assert.deepEqual(retry.receipt, reviewed.receipt);
  assert.deepEqual(retry.state, reviewed.state);
  assert.throws(() => applyCapabilityAction(spec, scenario, { ...reviewRequest, state: reviewed.state, expectedRevision: 0, input: { target: 'C-2', evidence: '改写' } }), /requestId 已用于/);
  const badTail: WorkspaceState = { revision: 2, events: [...reviewed.state.events, { requestId: 'forged-tail', recordId: 'W-1', actionId: 'unknown', role: 'operator', input: {}, at: new Date().toISOString() }] };
  assert.throws(() => applyCapabilityAction(spec, scenario, { ...reviewRequest, state: badTail, expectedRevision: 0 }), /能力动作未配置/);
  assert.throws(() => applyCapabilityAction(spec, scenario, request(reviewed.state, 'review-map', 'M-1', 'reviewer', { target: 'C-2', evidence: 'new' }, { expectedRevision: 0 })), /状态已变化/);
  state = reviewed.state;
  assert.throws(() => applyCapabilityAction(spec, scenario, request(state, 'finish', 'W-1', 'operator')), /先重新核对/);
  state = applyCapabilityAction(spec, scenario, request(state, 'verify', 'W-1', 'operator')).state;
  state = applyCapabilityAction(spec, scenario, request(state, 'finish', 'W-1', 'operator')).state;
  const createRequest = request(state, 'create-followup', 'W-2', 'operator', { title: '后续处理', ownerId: 'C-1' });
  const created = applyCapabilityAction(spec, scenario, createRequest);
  state = created.state;
  assert.equal(created.receipt.to, 'open');
  const createRetry = applyCapabilityAction(spec, scenario, { ...createRequest, state, expectedRevision: 3, input: { ownerId: 'C-1', title: '后续处理' } });
  assert.deepEqual(createRetry.receipt, created.receipt);
  const createdAndFinished = applyCapabilityAction(spec, scenario, request(state, 'finish', 'W-2', 'operator'));
  state = createdAndFinished.state;
  const materialized = materializeCapabilities(spec, data, state);
  const workItems = materialized.datasets.find(dataset => dataset.id === 'workItems')!.rows;
  assert.equal(workItems.find(row => row.id === 'W-1')?.status, 'done');
  assert.equal(workItems.find(row => row.id === 'W-2')?.status, 'done');
  assert.equal(workItems.find(row => row.id === 'W-2')?.title, '后续处理');
  assert.equal(workItems.find(row => row.id === 'W-2')?.mappingId, 'M-1');
  assert.equal(data.datasets.find(dataset => dataset.id === 'workItems')!.rows.length, 1, 'creation is derived from event state');
  assert.throws(() => applyCapabilityAction(spec, scenario, request(state, 'create-followup', 'W-2', 'operator', { title: '重复' })), /已存在/);
  assert.throws(() => applyCapabilityAction(spec, scenario, request(state, 'create-followup', 'W-3', 'operator', { title: '无效', mappingId: 'missing' })), /不支持输入字段 mappingId/);
  assert.throws(() => applyCapabilityAction(spec, scenario, request(state, 'create-followup', 'W-3', 'operator', { title: '无效', ownerId: 5 })), /类型不匹配/);
  assert.throws(() => applyCapabilityAction(spec, scenario, request(state, 'create-followup', 'W-3', 'operator', { title: '无效', ownerId: 'missing' })), /无法关联到 目录/);
  assert.throws(() => applyCapabilityAction(spec, scenario, request(state, 'create-followup', 'W-3', 'operator', { title: '无效', dueAt: '2026-02-30' })), /类型不匹配/);
  const wrongKey = request(state, 'create-followup', 'W-4', 'operator', { title: '' });
  assert.throws(() => applyCapabilityAction(spec, scenario, wrongKey), /需要补齐 标题/);
});

test('partitioned analysis reruns the canonical query per currency and never exposes a mixed-currency total', () => {
  const spec = makeSpec();
  const result = analyzeCapabilities(spec, scenario, { dataset: 'orders', filters: [{ field: 'channel', op: 'eq', value: 'online' }], limit: 1 }, { revision: 0, events: [] }, 'analytics');
  const metric = result.metrics.find(candidate => candidate.id === 'revenue')!;
  assert.equal(metric.value, null);
  assert.equal(metric.currencyField, 'currency');
  assert.deepEqual(metric.rows.map(row => row.id), ['O-1'], 'base drilldown rows retain the requested detail scope');
  assert.deepEqual(metric.partitions?.map(partition => [partition.currency, partition.value]), [['EUR', 20], ['USD', 10]]);
  assert(metric.partitions?.every(partition => partition.id === metric.id));
  assert(metric.partitions?.every(partition => partition.rows.every(row => row.currency === partition.currency && row.channel === 'online')));
  assert(metric.partitions?.every(partition => partition.groups.length === 1 && partition.trendGroups.length === 1));
  assert.match(metric.notice ?? '', /原币种分区展示/);
  assert.match(metric.notice ?? '', /1 条.*缺少币种/);
  assert.deepEqual(result.datasets[0].rows.map(row => row.id), ['O-1'], 'the requested detail limit applies to the result dataset');
  const overview = analyzeCapabilities(spec, scenario, { dataset: 'orders' }, { revision: 0, events: [] }, 'solution');
  assert.deepEqual(overview.metrics.find(candidate => candidate.id === 'revenue')?.partitions?.map(partition => partition.currency), ['EUR', 'USD'],
    'solution overview inherits capabilities from its active domain pages');
});

test('snapshot metrics remain on original rows and chat summary drops all record rows', () => {
  const spec = makeSpec();
  const state: WorkspaceState = { revision: 0, events: [] };
  const created = applyCapabilityAction(spec, scenario, request(state, 'create-followup', 'W-2', 'operator', { title: '摘要敏感行' }));
  const result = analyzeCapabilities(spec, scenario, {}, created.state);
  assert.equal(result.metrics.find(metric => metric.id === 'work-current')?.value, 2);
  assert.equal(result.metrics.find(metric => metric.id === 'work-snapshot')?.value, 1);
  const summary = capabilityChatSummary(result);
  assert.equal(summary.sources.length, result.datasets.length);
  assert.equal('datasets' in summary, false);
  assert.equal('revision' in summary, false);
  assert.equal(summary.metrics.find(metric => metric.id === 'revenue')?.partitions?.[0].currency, 'EUR');
  assert.equal(summary.metrics.some(metric => 'rows' in metric), false);
  assert.equal(JSON.stringify(summary).includes('摘要敏感行'), false);
});
