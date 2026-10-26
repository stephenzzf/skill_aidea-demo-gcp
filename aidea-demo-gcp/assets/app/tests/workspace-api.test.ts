import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { BaseLlm, FunctionTool } from '@google/adk';
import type { BaseLlmConnection, LlmRequest, LlmResponse } from '@google/adk';
import { createApp } from '../server/app.ts';
import { hashCode } from '../server/auth.ts';
import { analyze } from '../server/workspace.ts';
import { analysisQuerySchema } from '../shared/contracts.ts';
import { parseSpec, parseScenario } from '../shared/spec.ts';
import type { RuntimeConfig } from '../server/config.ts';

const spec = parseSpec(JSON.parse(await readFile('demo-spec.json', 'utf8')));
const scenario = parseScenario(JSON.parse(await readFile('scenario.json', 'utf8')), spec.workspace, spec);
const initialState = { revision: 0, events: [] };
class AnalysisModel extends BaseLlm {
  calls = 0;
  instructions = '';
  constructor() { super({ model: 'local-context-test' }); }
  async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse> {
    this.calls++;
    this.instructions = JSON.stringify(request.config?.systemInstruction);
    const response = request.contents.at(-1)?.parts?.find(p => p.functionResponse)?.functionResponse;
    if (!response) {
      yield { content: { role: 'model', parts: [{ functionCall: { id: 'analysis', name: 'analyze_workspace', args: { origin: 'synthetic' } } }] } };
    } else {
      const data = response.response as { metrics: { value: number | null }[] };
      yield { content: { role: 'model', parts: [{ text: `分析值=${data.metrics[0].value}` }] }, turnComplete: true };
    }
  }
  async connect(): Promise<BaseLlmConnection> { throw new Error('unused'); }
}

test('legacy protected analysis/action APIs and actual ADK analysis tool share server-computed scope', { skip: !spec.workspace || spec.version >= 3 }, async t => {
  const code = randomBytes(20).toString('hex');
  const config: RuntimeConfig = { mode: 'vertex', project: 'local-test-only', location: 'global', model: 'local-context-test', requestTimeoutMs: 5000,
    access: { codeHash: hashCode(code), expiresAt: Date.now() + 86400000, cookieSecret: randomBytes(32).toString('hex'), secure: false } };
  const model = new AnalysisModel();
  const server = createApp(spec, scenario, config, model).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  assert.equal((await post('/api/analysis', { query: {}, state: initialState })).status, 401);
  assert.equal((await post('/api/actions', {})).status, 401);
  const login = await post('/api/access', { code });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  const payload = await (await fetch(base + '/api/workspace', { headers: { cookie } })).json();
  assert.deepEqual(payload.state, initialState);
  const query = { origin: 'synthetic' as const };
  const expected = analyze(spec.workspace!, scenario.workspace!, query, initialState);
  assert.deepEqual(await (await post('/api/analysis', { query, state: initialState })).json(), expected);
  const dataset = expected.datasets[0];
  const context = { query, state: initialState, selectedRecord: { dataset: dataset.id, id: String(dataset.rows[0][dataset.key]) } };
  const reply = await post('/api/chat', { message: '解释这个范围的数据', history: [], context });
  const body = await reply.text();
  assert.match(body, /"type":"done"/);
  assert(body.includes(`分析值=${expected.metrics[0].value}`));
  assert.equal(model.calls, 2, '真实ADK Runner调用分析工具与本地模型，不访问Google');
  assert(model.instructions.includes(dataset.id));
  assert(!model.instructions.includes('"recordIds"'));
  const priorCalls = model.calls;
  for (const invalid of [
    { ...context, state: { revision: 4, events: [] } },
    { ...context, metrics: [{ value: 999999 }] },
    { ...context, query: { sql: 'select *' } },
  ]) assert.equal((await post('/api/chat', { message: '伪造', history: [], context: invalid })).status, 400);
  assert.equal(model.calls, priorCalls);
  assert.equal((await post('/api/actions', { state: initialState, requestId: 'test-unknown', recordId: 'missing', actionId: 'send-real', role: 'admin', expectedRevision: 0 })).status, 400);
  assert.deepEqual((await (await post('/api/analysis', { query, state: initialState })).json()).metrics, expected.metrics);
});

test('ADK analysis function declaration uses Vertex-compatible inclusive numeric bounds', () => {
  assert(!analysisQuerySchema.safeParse({ limit: 0 }).success);
  assert(analysisQuerySchema.safeParse({ limit: 1 }).success);
  const tool = new FunctionTool({ name: 'analysis', description: 'read-only analysis', parameters: analysisQuerySchema, execute: () => ({}) });
  const declaration = tool._getDeclaration();
  const limit = declaration.parameters?.properties?.limit;
  assert.equal(limit?.minimum, 1);
  assert(!('exclusiveMinimum' in (limit ?? {})), 'Vertex Schema rejects exclusiveMinimum before inference');
});
