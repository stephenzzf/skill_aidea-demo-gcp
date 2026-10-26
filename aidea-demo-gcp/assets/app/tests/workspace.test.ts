import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkspace, parseWorkspaceData } from '../shared/workspace.ts';
import type { ActionRequest, WorkspaceState } from '../shared/workspace.ts';
import { analyze, applyAction, materialize } from '../server/workspace.ts';

const workspace = parseWorkspace({
  views: ['overview', 'records', 'workflow', 'assistant'],
  roles: [{ id: 'shopper', label: '顾客' }, { id: 'advisor', label: '服务人员' }],
  stages: [
    { id: 'open', label: '新咨询' }, { id: 'assigned', label: '选购中' }, { id: 'verified', label: '待交接' },
    { id: 'handoff', label: '待接收' }, { id: 'processing', label: '处理中' }, { id: 'resolved', label: '已处理' }, { id: 'closed', label: '已反馈' },
  ],
  datasets: [
    { id: 'tickets', label: '咨询案例', key: 'id', origin: 'synthetic', source: '合成咨询记录', fields: [
      { id: 'id', label: '案例编号', type: 'string', required: true }, { id: 'status', label: '阶段', type: 'string', required: true },
      { id: 'team', label: '来源渠道', type: 'string', required: true }, { id: 'amount', label: '金额', type: 'number', unit: 'USD' },
      { id: 'createdAt', label: '建立日期', type: 'date', required: true }, { id: 'policyId', label: '政策记录', type: 'string' },
      { id: 'requirements', label: '需求', type: 'string' }, { id: 'owner', label: '负责人', type: 'string' },
      { id: 'evidence', label: '处理依据', type: 'string' }, { id: 'feedback', label: '反馈', type: 'string' }, { id: 'stale', label: '建议待复核', type: 'boolean' },
    ], relations: [{ field: 'policyId', dataset: 'policies', target: 'id' }] },
    { id: 'policies', label: '政策映射', key: 'id', origin: 'customer', source: '客户提供 policies.csv', fields: [
      { id: 'id', label: '政策编号', type: 'string', required: true }, { id: 'tier', label: '客户级别', type: 'string', required: true },
      { id: 'updatedAt', label: '更新时间', type: 'date' },
    ] },
  ],
  metrics: [
    { id: 'cases', label: '咨询量', dataset: 'tickets', operation: 'count', description: '咨询案例数', scope: 'current', groupBy: 'status', timeField: 'createdAt' },
    { id: 'snapshot-cases', label: '历史咨询量', dataset: 'tickets', operation: 'count', description: '固定初始快照', scope: 'snapshot' },
    { id: 'resolved-rate', label: '处理率', dataset: 'tickets', operation: 'ratio', numerator: [{ field: 'status', op: 'eq', value: 'resolved' }], denominator: [], description: '已处理案例占比', scope: 'current' },
    { id: 'web-within-resolved', label: '已处理咨询中的官网来源占比', dataset: 'tickets', operation: 'ratio', numerator: [{ field: 'team', op: 'eq', value: 'web' }], denominator: [{ field: 'status', op: 'eq', value: 'resolved' }], description: '官网来源案例且状态已处理的记录占全部已处理案例比例', scope: 'snapshot' },
    { id: 'policy-day-cases', label: '政策更新日内咨询量', dataset: 'tickets', operation: 'count', filters: [{ field: 'updatedAt', op: 'lte', value: '2026-10-21', dataset: 'policies' }], description: '按关联政策更新时间筛选', scope: 'snapshot' },
    { id: 'amount', label: '已知金额', dataset: 'tickets', operation: 'sum', field: 'amount', description: '金额合计', unit: 'USD', scope: 'snapshot' },
    { id: 'gold-cases', label: '高级客户关联咨询', dataset: 'tickets', operation: 'count', filters: [{ field: 'tier', op: 'eq', value: 'gold', dataset: 'policies' }], description: '关联客户政策记录', scope: 'snapshot' },
  ],
  workflow: { dataset: 'tickets', statusField: 'status', staleField: 'stale', editableFields: ['requirements'], transitions: [
    { id: 'assign', label: '开始选购', from: ['open'], to: 'assigned', role: 'shopper', inputFields: [{ id: 'owner', label: '负责人', type: 'string', required: true }] },
    { id: 'set-policy', label: '修改关联政策', from: ['open'], to: 'open', role: 'shopper', inputFields: [{ id: 'policyId', label: '政策编号', type: 'string' }] },
    { id: 'revise', label: '修改需求', from: ['assigned'], to: 'assigned', role: 'shopper', inputFields: [{ id: 'requirements', label: '新需求', type: 'string', required: true }], invalidates: true },
    { id: 'verify', label: '确认当前候选', from: ['assigned'], to: 'verified', role: 'shopper', clearsStale: true },
    { id: 'handoff', label: '确认人工交接', from: ['verified'], to: 'handoff', role: 'shopper', requireFresh: true },
    { id: 'accept', label: '接收案例', from: ['handoff'], to: 'processing', role: 'advisor' },
    { id: 'request-info', label: '退回补充', from: ['processing'], to: 'open', role: 'advisor' },
    { id: 'resolve', label: '确认处理结果', from: ['processing'], to: 'resolved', role: 'advisor', inputFields: [
      { id: 'evidence', label: '处理依据', type: 'string', required: true }, { id: 'feedback', label: '回复', type: 'string', required: true },
    ], requiredFields: ['evidence', 'feedback'] },
    { id: 'close', label: '提交运营反馈', from: ['resolved'], to: 'closed', role: 'shopper', inputFields: [{ id: 'feedback', label: '运营反馈', type: 'string' }] },
  ] },
});
const data = parseWorkspaceData({ datasets: [
  { id: 'tickets', rows: [
    { id: 'T-1', status: 'open', team: 'web', amount: 100, createdAt: '2026-10-20', policyId: 'P-1', requirements: '轻便', stale: false },
    { id: 'T-2', status: 'assigned', team: 'shop', amount: null, createdAt: '2026-10-21', policyId: 'P-2', requirements: '室外', stale: false },
    { id: 'T-3', status: 'resolved', team: 'web', amount: 50, createdAt: '2026-10-21T12:00:00Z', policyId: 'P-1', requirements: '视频', stale: false },
  ] },
  { id: 'policies', rows: [{ id: 'P-1', tier: 'gold', updatedAt: '2026-10-21T15:00:00Z' }, { id: 'P-2', tier: 'basic', updatedAt: '2026-10-22' }] },
] }, workspace);

function action(state: WorkspaceState, recordId: string, actionId: string, role: string, input: ActionRequest['input'] = {}): ActionRequest {
  return { requestId: `req-${state.revision}-${actionId}-${recordId}`, recordId, actionId, role, expectedRevision: state.revision, state, input };
}

test('configuration validation rejects unsupported operations, dangerous fields and cross-reference errors', () => {
  assert.throws(() => parseWorkspace({ ...workspace, views: ['arbitrary-html'] }), /不受支持/);
  assert.throws(() => parseWorkspace({ ...workspace, metrics: [{ ...workspace.metrics[0], operation: 'sql' }] }), /不受支持/);
  assert.throws(() => parseWorkspace({ ...workspace, metrics: [{ id: 'bad-sum', label: '错误求和', dataset: 'tickets', operation: 'sum', field: 'team', description: '必须在配置时拒绝', scope: 'snapshot' }] }), /必须为数值/);
  const altered = structuredClone(workspace) as unknown as Record<string, any>;
  altered.datasets[0].fields.push({ id: '__proto__', label: 'x', type: 'string' });
  assert.throws(() => parseWorkspace(altered), /格式无效/);
  assert.throws(() => parseWorkspaceData({ datasets: [{ id: 'tickets', rows: [{ id: 'x', status: 'open', team: 'web', amount: 3, createdAt: 'not-a-date', policyId: 'P-1' }] }, { id: 'policies', rows: [] }] }, workspace), /类型无效/);
  assert.throws(() => parseWorkspaceData({ datasets: [{ id: 'tickets', rows: [
    { id: 'same', status: 'open', team: 'web', amount: 1, createdAt: '2026-10-20', policyId: 'P-1' },
    { id: 'same', status: 'open', team: 'web', amount: 1, createdAt: '2026-10-20', policyId: 'P-1' },
  ] }, { id: 'policies', rows: [{ id: 'P-1', tier: 'gold' }] }] }, workspace), /重复/);
  assert.throws(() => parseWorkspaceData({ datasets: [{ id: 'tickets', rows: [{ id: 'bad', status: 'open', team: 'web', amount: 1, createdAt: '2026-10-20', policyId: 'MISSING' }] }, { id: 'policies', rows: [{ id: 'P-1', tier: 'gold' }] }] }, workspace), /无法关联/);
  assert.throws(() => parseWorkspaceData({ datasets: [{ id: 'tickets', rows: [{ id: 'bad', status: 'open', team: 'web', amount: 1, createdAt: '2026-02-30', policyId: 'P-1' }] }, { id: 'policies', rows: [{ id: 'P-1', tier: 'gold' }] }] }, workspace), /类型无效/);
});

test('deterministic metrics expose exact sample sizes, groups, trend buckets, filters and snapshot scope', () => {
  const result = analyze(workspace, data);
  assert.equal(result.metrics.find(m => m.id === 'cases')?.value, 3);
  assert.equal(result.metrics.find(m => m.id === 'cases')?.dataset, 'tickets');
  assert.equal(result.metrics.find(m => m.id === 'cases')?.rows.length, 3);
  assert.deepEqual(result.metrics.find(m => m.id === 'cases')?.groups.map(g => [g.label, g.value]), [['assigned', 1], ['open', 1], ['resolved', 1]]);
  assert.deepEqual(result.metrics.find(m => m.id === 'cases')?.trendGroups.map(g => [g.label, g.value]), [['2026-10-20', 1], ['2026-10-21', 2]]);
  assert.equal(result.metrics.find(m => m.id === 'resolved-rate')?.value, 1 / 3);
  assert.equal(result.metrics.find(m => m.id === 'web-within-resolved')?.value, 1);
  assert.deepEqual(result.metrics.find(m => m.id === 'web-within-resolved')?.rows.map(row => row.id), ['T-3']);
  assert.equal(result.metrics.find(m => m.id === 'amount')?.value, 150);
  assert.equal(result.metrics.find(m => m.id === 'amount')?.sampleSize, 2);
  assert.equal(result.metrics.find(m => m.id === 'amount')?.rows.length, 2);
  const filtered = analyze(workspace, data, { dataset: 'tickets', filters: [{ field: 'team', op: 'eq', value: 'web' }], from: '2026-10-21', to: '2026-10-21' });
  assert.equal(filtered.datasets[0].total, 1);
  assert.equal(filtered.datasets[0].rows[0].id, 'T-3');
  assert.equal(filtered.metrics.find(m => m.id === 'cases')?.value, 1);
  assert.equal(filtered.datasets[0].rows[0].__revision, undefined);
});

test('empty data and null measurements stay unknown, and related-source metrics require an explicit merge', () => {
  const empty = parseWorkspaceData({ datasets: [{ id: 'tickets', rows: [] }, { id: 'policies', rows: [] }] }, workspace);
  const result = analyze(workspace, empty);
  assert.equal(result.metrics.find(m => m.id === 'cases')?.value, 0);
  assert.equal(result.metrics.find(m => m.id === 'amount')?.value, null);
  assert.equal(result.metrics.find(m => m.id === 'amount')?.sampleSize, 0);
  assert.equal(result.metrics.find(m => m.id === 'resolved-rate')?.value, null);
  assert.match(result.metrics.find(m => m.id === 'gold-cases')?.notice ?? '', /明确选择/);
  assert.equal(result.metrics.find(m => m.id === 'gold-cases')?.value, null);
  assert.deepEqual(result.metrics.find(m => m.id === 'gold-cases')?.rows, []);
  const combined = analyze(workspace, data, { origin: 'combined' });
  assert.equal(combined.metrics.find(m => m.id === 'gold-cases')?.value, 2);
  assert.equal(analyze(workspace, data, { origin: 'customer' }).datasets.find(d => d.id === 'tickets')?.total, 0);
});

test('global filters only apply to datasets that contain the field; invalid query dates and unknown fields fail', () => {
  const result = analyze(workspace, data, { filters: [{ field: 'tier', op: 'eq', value: 'gold' }] });
  assert.equal(result.datasets.find(d => d.id === 'tickets')?.total, 3);
  assert.equal(result.datasets.find(d => d.id === 'policies')?.total, 1);
  assert.throws(() => analyze(workspace, data, { from: '2026-02-30' }), /日期范围无效/);
  assert.throws(() => analyze(workspace, data, { filters: [{ field: 'createdAt', op: 'eq', value: '2026-02-30' }] }), /日期筛选值无效/);
  assert.throws(() => analyze(workspace, data, { filters: [{ field: 'missing', op: 'eq', value: 'x' }] }), /筛选字段不存在/);
});

test('date-only filters cover the full day while timestamp filters compare exact instants, including joined metric filters', () => {
  const throughDay = analyze(workspace, data, { dataset: 'tickets', filters: [{ field: 'createdAt', op: 'lte', value: '2026-10-21', dataset: 'tickets' }] });
  assert.deepEqual(throughDay.datasets[0].rows.map(row => row.id), ['T-1', 'T-2', 'T-3']);
  const wholeDay = analyze(workspace, data, { dataset: 'tickets', filters: [{ field: 'createdAt', op: 'eq', value: '2026-10-21', dataset: 'tickets' }] });
  assert.deepEqual(wholeDay.datasets[0].rows.map(row => row.id), ['T-2', 'T-3']);
  const exactInstant = analyze(workspace, data, { dataset: 'tickets', filters: [{ field: 'createdAt', op: 'eq', value: '2026-10-21T12:00:00Z', dataset: 'tickets' }] });
  assert.deepEqual(exactInstant.datasets[0].rows.map(row => row.id), ['T-3']);
  const related = analyze(workspace, data, { origin: 'combined', dataset: 'tickets', filters: [{ field: 'updatedAt', op: 'lte', value: '2026-10-21', dataset: 'policies' }] });
  assert.deepEqual(related.datasets[0].rows.map(row => row.id), ['T-1', 'T-3']);
  assert.equal(related.metrics.find(metric => metric.id === 'policy-day-cases')?.value, 2);
  assert.deepEqual(related.metrics.find(metric => metric.id === 'policy-day-cases')?.rows.map(row => row.id), ['T-1', 'T-3']);
});

test('case actions preserve one record across handoff, evidence-based resolution, idempotency and analytics refresh', () => {
  let state: WorkspaceState = { revision: 0, events: [] };
  const start = applyAction(workspace, data, action(state, 'T-1', 'assign', 'shopper', { owner: '顾客' }));
  state = start.state;
  const revised = applyAction(workspace, data, action(state, 'T-1', 'revise', 'shopper', { requirements: '更换为 F38' }));
  state = revised.state;
  let result = materialize(workspace, data, state);
  assert.equal(result.datasets[0].rows[0].status, 'assigned');
  assert.equal(result.datasets[0].rows[0].stale, true);
  assert.equal(result.datasets[0].rows[0].requirements, '更换为 F38');
  assert.throws(() => applyAction(workspace, data, action(state, 'T-1', 'handoff', 'shopper')), /当前状态/);
  const verified = applyAction(workspace, data, action(state, 'T-1', 'verify', 'shopper'));
  state = verified.state;
  const handed = applyAction(workspace, data, action(state, 'T-1', 'handoff', 'shopper'));
  state = handed.state;
  const accepted = applyAction(workspace, data, action(state, 'T-1', 'accept', 'advisor'));
  state = accepted.state;
  const resolved = applyAction(workspace, data, action(state, 'T-1', 'resolve', 'advisor', { evidence: '合成政策记录 P-1', feedback: '已核对合成样例' }));
  state = resolved.state;
  result = materialize(workspace, data, state);
  assert.equal(result.datasets[0].rows[0].status, 'resolved');
  assert.equal(resolved.receipt.simulated, true);
  assert.equal(analyze(workspace, data, {}, state).metrics.find(m => m.id === 'cases')?.value, 3);
  const refreshed = analyze(workspace, data, {}, state);
  assert.equal(refreshed.metrics.find(m => m.id === 'snapshot-cases')?.value, 3);
  assert.equal(refreshed.metrics.find(m => m.id === 'resolved-rate')?.value, 2 / 3);
  assert.equal(refreshed.metrics.find(m => m.id === 'snapshot-cases')?.scope, 'snapshot');
  assert.equal(refreshed.metrics.find(m => m.id === 'cases')?.rows.find(row => row.id === 'T-1')?.status, 'resolved');
  assert.equal(refreshed.metrics.find(m => m.id === 'snapshot-cases')?.rows.find(row => row.id === 'T-1')?.status, 'open');
  const retry = applyAction(workspace, data, { ...action(state, 'T-1', 'resolve', 'advisor', { evidence: '合成政策记录 P-1', feedback: '已核对合成样例' }), requestId: resolved.receipt.requestId });
  assert.equal(retry.state.revision, state.revision);
  assert.deepEqual(retry.receipt, resolved.receipt);
  assert.throws(() => applyAction(workspace, data, { ...action(state, 'T-1', 'resolve', 'advisor', { evidence: 'changed', feedback: 'bad' }), requestId: resolved.receipt.requestId }), /requestId 已用于/);
});

test('service can return a case for more information; failed, stale and forged transitions cannot change state', () => {
  let state: WorkspaceState = { revision: 0, events: [] };
  const steps: Array<[string, string, Record<string, string>]> = [['assign', 'shopper', { owner: '顾客' }], ['verify', 'shopper', {}], ['handoff', 'shopper', {}], ['accept', 'advisor', {}]];
  for (const [id, role, fields] of steps) {
    state = applyAction(workspace, data, action(state, 'T-1', id, role, fields)).state;
  }
  const returned = applyAction(workspace, data, action(state, 'T-1', 'request-info', 'advisor'));
  assert.equal(materialize(workspace, data, returned.state).datasets[0].rows[0].status, 'open');
  const previous = returned.state;
  assert.throws(() => applyAction(workspace, data, action(previous, 'T-1', 'resolve', 'advisor', { evidence: '', feedback: '' })), /请填写/);
  assert.deepEqual(previous.events, returned.state.events);
  assert.throws(() => applyAction(workspace, data, { ...action(previous, 'T-1', 'assign', 'shopper', { owner: 'x' }), expectedRevision: 999 }), /状态已变化/);
  const forged = { revision: 1, events: [{ requestId: 'forged-001', recordId: 'T-1', actionId: 'handoff', role: 'shopper', input: {}, at: new Date().toISOString() }] };
  assert.throws(() => materialize(workspace, data, forged), /当前状态/);
  assert.throws(() => applyAction(workspace, data, action({ revision: 0, events: [] }, 'T-1', 'set-policy', 'shopper', { policyId: 'UNKNOWN' })), /无法关联/);
});
