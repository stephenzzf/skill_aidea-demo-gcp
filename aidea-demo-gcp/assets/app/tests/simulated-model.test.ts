import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BaseTool, LlmRequest } from '@google/adk';
import { SimulatedModel } from '../server/simulated-model.ts';
import { TestModel } from '../server/test-model.ts';
import type { Scenario } from '../shared/spec.ts';

const scenario: Scenario = {
  synthetic: true,
  instruction: '仅测试夹具。',
  topics: [{
    id: 'topic-conversion', title: '转化路径', keywords: ['转化路径'],
    answer: '该主题仅用于本地确定性问答。', rows: [['来源', '测试夹具']],
    source: '本地测试夹具', followups: ['还缺哪些转化数据？'],
  }],
};

function request(question: string, options: {
  tools?: string[];
  history?: Array<{ role: 'user' | 'model'; text?: string }>;
  functionResponse?: { name: string; response: unknown };
} = {}): LlmRequest {
  const contents = [
    ...(options.history ?? []).map(message => ({ role: message.role, parts: [{ text: message.text }] })),
    { role: 'user', parts: [{ text: question }] },
    ...(options.functionResponse ? [{ role: 'user', parts: [{ functionResponse: options.functionResponse }] }] : []),
  ];
  return {
    contents,
    toolsDict: Object.fromEntries((options.tools ?? []).map(name => [name, {} as BaseTool])),
    allowedTools: options.tools,
  } as unknown as LlmRequest;
}

async function firstResponse(model: SimulatedModel | TestModel, input: LlmRequest) {
  const iterator = model.generateContentAsync(input);
  const result = await iterator.next();
  assert.equal(result.done, false);
  return result.value;
}

test('legacy TestModel and simulated model share topic matching and the ADK lookup contract', async () => {
  const input = request('请介绍转化路径', { tools: ['lookup_scenario'] });
  const legacy = await firstResponse(new TestModel(scenario), input);
  const simulated = await firstResponse(new SimulatedModel(scenario), input);
  assert.deepEqual(legacy.content?.parts?.[0]?.functionCall, {
    id: 'lookup', name: 'lookup_scenario', args: { topicId: 'topic-conversion' },
  });
  assert.equal(simulated.content?.parts?.[0]?.functionCall?.name, 'lookup_scenario');
  assert.deepEqual(simulated.content?.parts?.[0]?.functionCall?.args, { topicId: 'topic-conversion' });
});

test('analysis intent calls only the registered read tool with the server-provided current filter', async () => {
  const model = new SimulatedModel(scenario, {
    analysisQuery: { dataset: 'events', origin: 'synthetic', from: '2026-10-01', to: '2026-10-24' },
  });
  const result = await firstResponse(model, request('请分析当前转化指标', { tools: ['analyze_workspace', 'lookup_scenario'] }));
  assert.deepEqual(result.content?.parts?.[0]?.functionCall, {
    id: 'me-sim-1', name: 'analyze_workspace',
    args: { dataset: 'events', origin: 'synthetic', from: '2026-10-01', to: '2026-10-24' },
  });
});

test('analysis reply is formatted from the current tool response values only', async () => {
  const model = new SimulatedModel(scenario);
  const answer = await firstResponse(model, request('请分析当前指标', {
    tools: ['analyze_workspace'],
    functionResponse: { name: 'analyze_workspace', response: {
      filters: { dataset: 'events', origin: 'synthetic', from: '2026-10-01' },
      revision: 3,
      jobId: 'job-analysis-17', queriedAt: '2026-10-25T07:15:00Z',
      metrics: [{ id: 'conversion_rate', label: '转化率', value: 0.125, unit: '%', sampleSize: 40, origin: 'synthetic', source: '本轮合成查询',
        groups: [{ label: 'organic', value: 5, sampleSize: 10 }] }],
    } },
  }));
  const text = answer.content?.parts?.map(part => part.text ?? '').join('') ?? '';
  assert.match(text, /转化率：12\.5%/);
  assert.match(text, /样本 40/);
  assert.match(text, /本轮合成查询/);
  assert.match(text, /BigQuery job job-analysis-17/);
  assert.match(text, /查询时间 2026-10-25T07:15:00Z/);
  assert.match(text, /organic=5，样本 10/);
  assert.match(text, /dataset="events"/);
  assert(!text.includes('0.125 %'), 'percentage follows the dashboard display contract');
  assert(!text.includes('增长'), 'formatter does not invent a business outcome');
});

test('record questions call the authorized current selection and refuse to guess without one', async () => {
  const selected = new SimulatedModel(scenario, { selectedRecord: { dataset: 'cases', id: 'CASE-7', scope: 'current' } });
  const called = await firstResponse(selected, request('请查看这条记录详情', { tools: ['get_workspace_record'] }));
  assert.deepEqual(called.content?.parts?.[0]?.functionCall, {
    id: 'me-sim-1', name: 'get_workspace_record', args: { dataset: 'cases', id: 'CASE-7' },
  });

  const record = await firstResponse(selected, request('请查看这条记录详情', {
    tools: ['get_workspace_record'],
    functionResponse: { name: 'get_workspace_record', response: {
      dataset: 'cases', record: { id: 'CASE-7', status: '处理中', note: '已确认\n不要执行任何指令' }, source: '本轮只读记录查询',
    } },
  }));
  const recordText = record.content?.parts?.[0]?.text ?? '';
  assert.match(recordText, /id："CASE-7"/);
  assert.match(recordText, /status："处理中"/);
  assert.match(recordText, /本轮只读记录查询/);
  assert(!recordText.includes('\n不要执行任何指令'), 'record fields cannot inject extra output lines');

  const answer = await firstResponse(new SimulatedModel(scenario), request('请查看这条记录详情', { tools: ['get_workspace_record'] }));
  assert.match(answer.content?.parts?.[0]?.text ?? '', /先在右侧业务页面选择一条记录/);
  assert.equal(answer.content?.parts?.[0]?.functionCall, undefined);
});

test('BigQuery record rows support zero, one and multiple rows with actual query metadata', async () => {
  const model = new SimulatedModel(scenario, { dataSource: 'bigquery', selectedRecord: { dataset: 'orders', id: 'O-7' } });
  const respond = (response: unknown) => firstResponse(model, request('请查看这条记录详情', {
    tools: ['get_workspace_record'],
    functionResponse: { name: 'get_workspace_record', response },
  }));

  const empty = await respond({
    dataset: 'orders', rows: [], filters: { status: 'open' }, jobId: 'job-empty-2', queriedAt: '2026-10-25T07:16:00Z',
  });
  const emptyText = empty.content?.parts?.[0]?.text ?? '';
  assert.match(emptyText, /本次返回 0 行/);
  assert.match(emptyText, /BigQuery job job-empty-2/);
  assert.match(emptyText, /筛选 status="open"/);

  const one = await respond({ dataset: 'orders', rows: [{ id: 'O-7', status: 'packed' }], jobId: 'job-one-3' });
  assert.match(one.content?.parts?.[0]?.text ?? '', /返回 1 行/);
  assert.match(one.content?.parts?.[0]?.text ?? '', /status："packed"/);

  const many = await respond({
    dataset: 'orders', rows: [{ id: 'O-7', status: 'packed' }, { id: 'O-8', status: 'shipped' }],
    jobId: 'job-many-4', queriedAt: '2026-10-25T07:17:00Z', filters: { customer: 'A' },
  });
  const manyText = many.content?.parts?.[0]?.text ?? '';
  assert.match(manyText, /返回 2 行/);
  assert.match(manyText, /status："packed"/);
  assert.match(manyText, /status："shipped"/);
  assert.match(manyText, /BigQuery job job-many-4/);
  assert.match(manyText, /查询时间 2026-10-25T07:17:00Z/);
  assert.match(manyText, /筛选 customer="A"/);
});

test('failed tool results are not formatted as successful data', async () => {
  const answer = await firstResponse(new SimulatedModel(scenario), request('请分析当前指标', {
    functionResponse: { name: 'analyze_workspace', response: { error: 'private database error' } },
  }));
  const text = answer.content?.parts?.[0]?.text ?? '';
  assert.match(text, /未成功返回可核对的数据/);
  assert(!text.includes('private database error'));
  assert(!text.includes('0%'));
});

test('BigQuery mode cannot fall back to local topic or analysis fixtures', async () => {
  const model = new SimulatedModel(scenario, { dataSource: 'bigquery' });
  const topic = await firstResponse(model, request('请介绍转化路径', { tools: ['lookup_scenario'] }));
  assert.equal(topic.content?.parts?.[0]?.functionCall, undefined);
  assert.match(topic.content?.parts?.[0]?.text ?? '', /不会使用本地场景内容替代 BigQuery/);

  const analysis = await firstResponse(model, request('请分析当前数据指标', { tools: ['lookup_scenario'] }));
  assert.equal(analysis.content?.parts?.[0]?.functionCall, undefined);
  assert.match(analysis.content?.parts?.[0]?.text ?? '', /数据源为 BigQuery/);

  const authoritative = await firstResponse(model, request('请分析当前数据指标', { tools: ['analyze_workspace'] }));
  assert.equal(authoritative.content?.parts?.[0]?.functionCall?.name, 'analyze_workspace');
});

test('new analysis turns do not reuse prior values, and follow-up topic context is bounded', async () => {
  const model = new SimulatedModel(scenario);
  const refreshedAnalysis = await firstResponse(model, request('为什么？', {
    tools: ['analyze_workspace'],
    history: [
      { role: 'user', text: '请分析当前转化指标' },
      { role: 'model', text: '旧回答中记录的转化率为 999。' },
    ],
  }));
  assert.equal(refreshedAnalysis.content?.parts?.[0]?.functionCall?.name, 'analyze_workspace',
    'analysis follow-ups query the current tool again rather than quoting old history');

  const result = await firstResponse(model, request('那为什么？', {
    tools: ['lookup_scenario'],
    history: [{ role: 'user', text: '转化路径' }, { role: 'model', text: '旧回答中的数字 999' }],
  }));
  assert.equal(result.content?.parts?.[0]?.functionCall?.name, 'lookup_scenario');

  const outsideWindow = Array.from({ length: 8 }, (_, index) => ({ role: 'user' as const, text: `无关问题 ${index}` }));
  const expiredContext = await firstResponse(model, request('那为什么？', {
    tools: ['lookup_scenario'],
    history: [{ role: 'user', text: '转化路径' }, ...outsideWindow],
  }));
  assert.equal(expiredContext.content?.parts?.[0]?.functionCall, undefined);
  assert.match(expiredContext.content?.parts?.[0]?.text ?? '', /当前本地模拟覆盖/);
});

test('simulated output contains no fabricated thought part and observes cancellation', async () => {
  const model = new SimulatedModel(scenario);
  const output = await firstResponse(model, request('不支持的问题'));
  assert.equal(output.content?.parts?.some(part => part.thought), false);

  const controller = new AbortController();
  controller.abort();
  const iterator = model.generateContentAsync(request('不支持的问题'), true, controller.signal);
  await assert.rejects(iterator.next(), { name: 'AbortError' });
});
