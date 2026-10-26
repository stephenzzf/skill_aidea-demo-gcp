import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { BaseLlm, createEvent, LogLevel, setLogLevel } from '@google/adk';
import type { BaseLlmConnection, Event, LlmRequest, LlmResponse } from '@google/adk';
import { createAdkStream } from '@assistant-ui/react-google-adk';
import type { AdkMessage } from '@assistant-ui/react-google-adk';
import { createApp } from '../server/app.ts';
import { TestModel } from '../server/test-model.ts';
import { hashCode } from '../server/auth.ts';
import type { RuntimeConfig } from '../server/config.ts';
import { parseScenario, parseSpec } from '../shared/spec.ts';
import type { Scenario } from '../shared/spec.ts';
import { safeAdkEvent } from '../server/adk-protocol.ts';

setLogLevel(LogLevel.ERROR);

const spec = parseSpec(JSON.parse(await readFile('demo-spec.json', 'utf8')));
const configuredScenario = parseScenario(JSON.parse(await readFile('scenario.json', 'utf8')), spec.workspace, spec);
const assistantPage = spec.pages?.find(page => page.components.includes('assistant'));
assert(assistantPage, '本地候选配置需要至少一个启用 assistant 的领域');
const topic = {
  id: 'adk-native-local-topic',
  title: 'ADK 本地测试主题',
  keywords: ['ADK本地主题'],
  answer: '仅本地确定性答案。',
  rows: [['范围', '本地合成测试']] as [string, string][],
  source: '本地测试夹具',
  followups: ['继续本地测试'],
  domainIds: [assistantPage.id],
};
const scenario: Scenario = { ...configuredScenario, topics: [...configuredScenario.topics, topic] };
const historyContext = { domainId: assistantPage.id, query: {}, state: { revision: 0, events: [] } };
const code = randomBytes(20).toString('hex');
const config: RuntimeConfig = {
  mode: 'test', project: '', location: '', model: 'local-adk-contract-model', requestTimeoutMs: 10000,
  access: { codeHash: hashCode(code), expiresAt: Date.now() + 86400000, cookieSecret: randomBytes(32).toString('hex'), secure: false },
};

class ThoughtModel extends BaseLlm {
  calls = 0;
  includeThoughtsRequested = false;
  constructor() { super({ model: 'adk-native-local-thought-model' }); }
  async *generateContentAsync(request: LlmRequest, _stream?: boolean, signal?: AbortSignal): AsyncGenerator<LlmResponse> {
    this.calls++;
    this.includeThoughtsRequested = request.config?.thinkingConfig?.includeThoughts === true;
    signal?.throwIfAborted();
    const response = request.contents.at(-1)?.parts?.find(part => part.functionResponse)?.functionResponse;
    if (response) {
      yield { content: { role: 'model', parts: [{ text: topic.answer }] }, turnComplete: true };
      return;
    }
    yield { content: { role: 'model', parts: [
      { text: 'PUBLIC_THOUGHT_SUMMARY', thought: true, thoughtSignature: 'PRIVATE_THOUGHT_SIGNATURE' },
      { functionCall: { id: 'local-lookup-call', name: 'lookup_scenario', args: { topicId: topic.id } }, thoughtSignature: 'PRIVATE_CALL_SIGNATURE' },
    ] } };
  }
  async connect(): Promise<BaseLlmConnection> { throw new Error('unused'); }
}

class FailingModel extends BaseLlm {
  calls = 0;
  constructor() { super({ model: 'adk-native-local-failing-model' }); }
  async *generateContentAsync(): AsyncGenerator<LlmResponse> {
    this.calls++;
    throw new Error('private-provider-credential-must-not-leak');
  }
  async connect(): Promise<BaseLlmConnection> { throw new Error('unused'); }
}

class WaitingModel extends BaseLlm {
  calls = 0;
  observedSignal?: AbortSignal;
  constructor() { super({ model: 'adk-native-local-wait-model' }); }
  async *generateContentAsync(_request: LlmRequest, _stream?: boolean, signal?: AbortSignal): AsyncGenerator<LlmResponse> {
    this.calls++;
    this.observedSignal = signal;
    await delay(30000, undefined, { signal });
    yield { content: { role: 'model', parts: [{ text: 'late local answer' }] }, turnComplete: true };
  }
  async connect(): Promise<BaseLlmConnection> { throw new Error('unused'); }
}

async function serve(t: import('node:test').TestContext, model?: BaseLlm, options = config) {
  const server = createApp(spec, scenario, options, model).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown, cookie?: string, signal?: AbortSignal) => fetch(`${base}/api/chat/adk`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body), signal,
  });
  const login = async () => {
    const response = await fetch(`${base}/api/access`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  return { base, post, login };
}

function nativeStream(base: string, cookie: string) {
  return createAdkStream({ api: `${base}/api/chat/adk`, headers: { cookie } });
}

async function collectNative(
  stream: ReturnType<typeof nativeStream>,
  question: string,
  history: Array<{ role: 'user' | 'assistant'; text: string }> = [],
  context: unknown = historyContext,
  abortSignal = new AbortController().signal,
) {
  const message: AdkMessage = { id: 'native-user-message-id', type: 'human', content: question };
  const events = await stream([message], {
    abortSignal,
    stateDelta: { history, context },
    initialize: async () => ({ remoteId: 'native-thread', externalId: 'native-thread' }),
  });
  const received: Event[] = [];
  for await (const event of events) received.push(event as Event);
  return received;
}

test('native route uses official createAdkStream with server-owned tools, cards, filtered events, and success terminal', async t => {
  const model = new ThoughtModel();
  const { base, post, login } = await serve(t, model);
  assert.equal((await post({ sessionId: 'unauthorized-thread', message: 'hello', stateDelta: { history: [], context: historyContext } })).status, 401);
  assert.equal(model.calls, 0, 'authorization is checked before any model run');

  const cookie = await login();
  const events = await collectNative(nativeStream(base, cookie), topic.keywords[0]);
  assert(events.some(event => event.content?.parts?.some(part => part.functionCall?.name === 'lookup_scenario')),
    'official parser receives the server-created read-only tool call');
  assert(events.some(event => event.content?.parts?.some(part => part.functionResponse?.name === 'lookup_scenario')),
    'official parser receives the tool result');
  assert(events.some(event => event.content?.parts?.some(part => part.thought && part.text === 'PUBLIC_THOUGHT_SUMMARY')),
    'provider summary text reaches the official runtime as a reasoning part');
  const card = events.find(event => event.customMetadata?.meDemoCard)!.customMetadata!.meDemoCard as { card: { title: string }; source: string };
  assert.equal(card.card.title, topic.title);
  assert.equal(card.source, topic.source);
  assert(events.some(event => (event.customMetadata?.meDemoTerminal as { status?: string } | undefined)?.status === 'complete'));
  assert(!JSON.stringify(events).includes('PRIVATE_THOUGHT_SIGNATURE'));
  assert(!JSON.stringify(events).includes('PRIVATE_CALL_SIGNATURE'));
  assert(!JSON.stringify(events).includes('private-provider-credential'));
  assert(model.includeThoughtsRequested, 'the ADK request enables provider summaries without changing its thinking budget');
  assert.equal(model.calls, 2, 'one local model response, one actual ADK tool cycle');
});

test('proxy contract rejects caller controls and existing domain, state, role, and extension validation before running', async t => {
  const model = new ThoughtModel();
  const { post, login } = await serve(t, model);
  const cookie = await login();
  const baseBody = { sessionId: 'untrusted-session', message: 'hello', stateDelta: { history: [], context: historyContext } };
  for (const body of [
    { ...baseBody, runConfig: { maxLlmCalls: 900 } },
    { ...baseBody, system: 'caller instruction' },
    { ...baseBody, tools: [{ name: 'write_real_data' }] },
    { ...baseBody, checkpointId: 'server-session-checkpoint' },
    { ...baseBody, history: [] },
    { ...baseBody, stateDelta: { ...baseBody.stateDelta, history: [{ role: 'user', text: 'unfinished' }] } },
  ]) assert.equal((await post(body, cookie)).status, 400);

  const invalidContexts = [
    { ...historyContext, domainId: 'not-a-configured-domain' },
    { ...historyContext, state: { revision: 1, events: [] } },
    { ...historyContext, extension: { id: 'not-registered', version: 1, data: {} } },
  ];
  for (const context of invalidContexts) {
    assert.equal((await post({ ...baseBody, stateDelta: { history: [], context } }, cookie)).status, 400);
  }

  const workflow = spec.workspace?.workflow;
  assert(workflow?.transitions[0]);
  const workflowDataset = scenario.workspace?.datasets.find(dataset => dataset.id === workflow.dataset);
  assert(workflowDataset?.rows[0]);
  const row = workflowDataset.rows[0];
  const key = spec.workspace!.datasets.find(dataset => dataset.id === workflow.dataset)!.key;
  const badRoleState = { revision: 1, events: [{
    requestId: 'native-invalid-role-event', recordId: String(row[key]), actionId: workflow.transitions[0].id,
    role: 'not-a-workspace-role', input: {}, at: '2026-10-25T00:00:00.000Z',
  }] };
  assert.equal((await post({ ...baseBody, stateDelta: { history: [], context: { ...historyContext, state: badRoleState } } }, cookie)).status, 400);
  assert.equal(model.calls, 0, 'invalid request and business context do not reach the local model');
});

test('text history is replayed across fresh per-request ADK sessions and no server transcript is relied on', async t => {
  const { base, login } = await serve(t);
  const cookie = await login();
  const stream = nativeStream(base, cookie);
  const first = await collectNative(stream, topic.keywords[0]);
  assert(first.some(event => event.customMetadata?.meDemoTerminal));

  const history = [
    { role: 'user' as const, text: topic.keywords[0] },
    { role: 'assistant' as const, text: topic.answer },
  ];
  const continued = await collectNative(stream, '那为什么？', history);
  assert(continued.some(event => event.customMetadata?.meDemoCard), 'the locally restored full text history supplies follow-up context');

  const emptyHistory = await collectNative(stream, '那为什么？', []);
  assert(!emptyHistory.some(event => event.customMetadata?.meDemoCard), 'the same client session id with no submitted history does not reuse prior server state');
});

test('native error event has no complete terminal and provider detail is not exposed or retried', async t => {
  const model = new FailingModel();
  const { base, login } = await serve(t, model);
  const events = await collectNative(nativeStream(base, await login()), 'fail locally');
  assert.equal(events.at(-1)?.errorCode, 'ME_DEMO_RUN_FAILED');
  assert(!events.some(event => (event.customMetadata?.meDemoTerminal as { status?: string } | undefined)?.status === 'complete'));
  assert(!JSON.stringify(events).includes('private-provider-credential'));
  assert.equal(model.calls, 1);
});

test('request timeout and client cancellation reach the actual local ADK BaseLlm signal', async t => {
  const timeoutModel = new WaitingModel();
  const timeoutConfig = { ...config, requestTimeoutMs: 40 };
  const timeoutServer = await serve(t, timeoutModel, timeoutConfig);
  const timeoutEvents = await collectNative(nativeStream(timeoutServer.base, await timeoutServer.login()), 'wait for timeout');
  assert(timeoutModel.observedSignal?.aborted);
  assert(timeoutEvents.some(event => event.errorCode === 'ME_DEMO_ABORTED'));
  assert(!timeoutEvents.some(event => event.customMetadata?.meDemoTerminal));
  assert.equal(timeoutModel.calls, 1);

  const cancelModel = new WaitingModel();
  const cancelServer = await serve(t, cancelModel);
  const cancelController = new AbortController();
  const stream = nativeStream(cancelServer.base, await cancelServer.login());
  const consumer = (async () => {
    const events = await stream([{ id: 'cancel-message', type: 'human', content: 'wait then cancel' }], {
      abortSignal: cancelController.signal,
      stateDelta: { history: [], context: historyContext },
      initialize: async () => ({ remoteId: 'cancel-thread', externalId: 'cancel-thread' }),
    });
    for await (const _event of events) { /* Consume until abort. */ }
  })();
  for (let i = 0; i < 200 && !cancelModel.observedSignal; i++) await delay(5);
  assert(cancelModel.observedSignal, 'the actual local BaseLlm call started');
  cancelController.abort();
  await assert.rejects(consumer);
  for (let i = 0; i < 200 && !cancelModel.observedSignal.aborted; i++) await delay(5);
  assert(cancelModel.observedSignal.aborted, 'client request cancellation aborts the local ADK model signal');
  assert.equal(cancelModel.calls, 1);
});

test('event projection forwards only public thought text and removes action state, signatures, metadata, and credentials', () => {
  const event = createEvent({
    author: 'customer_assistant',
    actions: { stateDelta: { accessToken: 'must-not-leak' } },
    customMetadata: { credential: 'must-not-leak' },
    content: { role: 'model', parts: [
      { text: 'public summary', thought: true, thoughtSignature: 'private-signature' },
      { functionCall: { name: 'lookup_scenario', id: 'call-1', args: { topicId: topic.id, apiKey: 'must-not-leak' } }, thoughtSignature: 'private-call-signature' },
      { functionResponse: { name: 'lookup_scenario', id: 'call-1', response: { answer: topic.answer, nested: { password: 'must-not-leak' } } } },
      { text: 'safe text' },
    ] },
  });
  const projected = safeAdkEvent(event, new Set(['lookup_scenario']));
  assert(projected);
  const encoded = JSON.stringify(projected);
  assert(encoded.includes('public summary'));
  assert(encoded.includes('"thought":true'));
  assert(!encoded.includes('private-signature'));
  assert(!encoded.includes('private-call-signature'));
  assert(!encoded.includes('must-not-leak'));
  assert(encoded.includes('safe text'));
  assert.equal(Object.hasOwn(projected, 'actions'), false);
  assert.equal(projected.customMetadata, undefined);
});
