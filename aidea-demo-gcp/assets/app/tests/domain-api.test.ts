import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { BaseLlm } from '@google/adk';
import type { BaseLlmConnection, LlmRequest, LlmResponse } from '@google/adk';
import { createApp } from '../server/app.ts';
import { hashCode } from '../server/auth.ts';
import { parseSpec, parseScenario } from '../shared/spec.ts';
import type { RuntimeConfig } from '../server/config.ts';
import { domainContext } from '../server/domain.ts';
import { getDomainKnowledgeIds, getSolutionOverviewPage, validateDomainAction } from '../shared/solution.ts';

const spec = parseSpec(JSON.parse(await readFile('demo-spec.json', 'utf8')));
const scenario = parseScenario(JSON.parse(await readFile('scenario.json', 'utf8')), spec.workspace, spec);

class DomainModel extends BaseLlm {
  calls = 0;
  instruction = '';
  toolResult: unknown;
  constructor() { super({ model: 'local-domain-model' }); }
  async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse> {
    this.calls++;
    this.instruction = JSON.stringify(request.config?.systemInstruction);
    const result = request.contents.at(-1)?.parts?.find(part => part.functionResponse)?.functionResponse;
    if (!result) yield { content: { role: 'model', parts: [{ functionCall: { id: 'domain-analysis', name: 'analyze_workspace', args: {} } }] } };
    else {
      this.toolResult = result.response;
      yield { content: { role: 'model', parts: [{ text: '已按当前领域的服务端数据解释。本地测试模型。' }] }, turnComplete: true };
    }
  }
  async connect(): Promise<BaseLlmConnection> { throw new Error('unused'); }
}

test('V3 protected config, analysis, actions and ADK tools retain the selected domain and reject cross-domain records before inference', { skip: spec.version < 3 }, async t => {
  const model = new DomainModel();
  const code = randomBytes(20).toString('hex');
  const config: RuntimeConfig = { mode: 'vertex', project: 'local-only', location: 'global', model: 'local-domain-model', requestTimeoutMs: 5000,
    access: { codeHash: hashCode(code), expiresAt: Date.now() + 60000, cookieSecret: randomBytes(32).toString('hex'), secure: false } };
  const firstAssistant = spec.pages!.find(page => page.components.includes('assistant') && page.datasets.length)!;
  const otherDomain = spec.pages!.find(page => page.id !== firstAssistant.id)!;
  const domainScenario = { ...scenario, topics: [...scenario.topics, { id: 'private-other-domain', title: '其他领域测试知识', keywords: ['other'], answer: 'OTHER_DOMAIN_SENTINEL', rows: [['事实', 'OTHER_DOMAIN_SENTINEL']] as [string, string][], source: '仅本地测试', followups: [], domainIds: [otherDomain.id] }] };
  const server = createApp(spec, domainScenario, config, model).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + '/api/config')).status, 401);
  const login = await post('/api/access', { code });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  const publicConfig = await (await fetch(base + '/api/config', { headers: { cookie } })).json();
  assert.deepEqual(publicConfig.solution.pages, spec.pages);
  assert.deepEqual(publicConfig.solution.blueprint, spec.blueprint);
  const initial = { revision: 0, events: [] };
  for (const page of spec.pages!) {
    const response = await post('/api/analysis', { domainId: page.id, query: {}, state: initial });
    assert.equal(response.status, 200);
    const analysis = await response.json();
    assert(analysis.datasets.every((dataset: { id: string }) => page.datasets.includes(dataset.id)));
    assert.deepEqual(analysis.metrics.map((metric: { id: string }) => metric.id), spec.workspace!.metrics.filter(metric => page.metrics.includes(metric.id)).map(metric => metric.id));
  }
  const availablePages = spec.pages!.filter(page => getDomainKnowledgeIds(spec, page.id).length > 0);
  const overviewPage = getSolutionOverviewPage(spec);
  const overviewResponse = await post('/api/analysis', { domainId: 'solution', query: {}, state: initial });
  assert.equal(overviewResponse.status, 200, 'the fixed solution tab has a deterministic, read-only analysis scope');
  const overviewAnalysis = await overviewResponse.json();
  assert.deepEqual(overviewAnalysis.datasets.map((dataset: { id: string }) => dataset.id).sort(), [...overviewPage.datasets].sort());
  assert.deepEqual(overviewAnalysis.metrics.map((metric: { id: string }) => metric.id).sort(), [...overviewPage.metrics].sort());
  assert.equal((await post('/api/analysis', { query: {}, state: initial })).status, 400);
  const page = spec.pages!.find(page => page.components.includes('assistant') && page.datasets.length)!;
  assert(page, 'this sample must verify an assistant with business records');
  const dataset = spec.workspace!.datasets.find(dataset => page.datasets.includes(dataset.id))!;
  const rows = scenario.workspace!.datasets.find(item => item.id === dataset.id)!.rows;
  const context = { domainId: page.id, query: { dataset: dataset.id }, state: initial, selectedRecord: { dataset: dataset.id, id: String(rows[0][dataset.key]) } };
  const related = await (await post('/api/analysis', { domainId: page.id, query: { dataset: dataset.id }, state: initial })).json();
  assert.deepEqual(related.datasets.map((item: { id: string }) => item.id), page.datasets,
    'selected table does not remove configured reference data needed by record relationships');
  const reply = await post('/api/chat', { message: '解释当前领域和选中记录', history: [], context });
  assert.match(await reply.text(), /"type":"done"/);
  assert.equal(model.calls, 2, 'uses the real ADK Runner with a local test model, no provider request');
  assert(model.instruction.includes(page.id));
  assert(model.instruction.includes(String(rows[0][dataset.key])));
  assert(!model.instruction.includes('OTHER_DOMAIN_SENTINEL'), 'knowledge from another domain is not injected');
  const domainToolResult = model.toolResult as { datasets?: { id: string }[]; sources?: { id: string }[]; metrics: { id: string }[] };
  const beforeOverview = model.calls;
  const overviewReply = await post('/api/chat', { message: '请概述已确认方案和各领域数据', history: [], context: { domainId: 'solution', query: {}, state: initial } });
  assert.match(await overviewReply.text(), /"type":"done"/);
  assert.equal(model.calls, beforeOverview + 2, 'overview question runs through the local ADK model and deterministic analysis tool');
  assert(model.instruction.includes('当前为全方案问答的只读上下文'));
  assert(model.instruction.includes('planned'));
  const overviewToolResult = model.toolResult as { sources?: { id: string }[]; metrics: { id: string }[] };
  assert.deepEqual(overviewToolResult.sources?.map(source => source.id).sort(), [...overviewPage.datasets].sort());
  assert.deepEqual(overviewToolResult.metrics.map(metric => metric.id).sort(), [...overviewPage.metrics].sort());
  assert(availablePages.length > 0, 'the overview uses configured, non-planned domain knowledge');
  const result = domainToolResult;
  assert(result.metrics.every(metric => page.metrics.includes(metric.id)));
  assert(result.sources?.every(source => page.datasets.includes(source.id)));
  const before = model.calls;
  for (const invalid of [undefined, { ...context, domainId: 'not-configured' }, { ...context, selectedRecord: { dataset: dataset.id, id: 'missing-record' } }]) {
    assert.equal((await post('/api/chat', { message: '无效上下文', history: [], ...(invalid ? { context: invalid } : {}) })).status, 400);
  }
  const outside = spec.workspace!.datasets.find(dataset => !page.datasets.includes(dataset.id));
  if (outside) {
    assert.equal((await post('/api/analysis', { domainId: page.id, query: { dataset: outside.id }, state: initial })).status, 400);
    assert.equal((await post('/api/chat', { message: '跨域', history: [], context: { ...context, selectedRecord: { dataset: outside.id, id: 'any' } } })).status, 400);
  }
  const unavailableAction = spec.workspace!.workflow?.transitions.find(action => !page.actions.includes(action.id));
  if (unavailableAction) assert.equal((await post('/api/actions', { domainId: page.id, state: initial, requestId: 'domain-reject', recordId: 'any', actionId: unavailableAction.id, role: unavailableAction.role, expectedRevision: 0 })).status, 400);
  assert.equal(model.calls, before, 'invalid context never reaches the model');
  const planned = structuredClone(spec);
  for (const claim of planned.design!.coverage) claim.status = 'planned';
  assert.throws(() => domainContext(planned, context, true), /后续接入/);
  assert.throws(() => validateDomainAction(planned, page.id, page.actions[0] ?? 'not-enabled'), /后续接入/);
});
