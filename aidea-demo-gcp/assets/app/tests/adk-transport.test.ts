import test from 'node:test';
import assert from 'node:assert/strict';
import { AdkEventAccumulator } from '@assistant-ui/react-google-adk';
import type { AdkEvent, AdkStreamCallback } from '@assistant-ui/react-google-adk';
import { createMeAdkStream } from '../client/adk-transport.ts';
import type { createAdkPersistence } from '../client/adk-history.ts';

function fixture() {
  const saved = { messages: [
    { id: 'old-u', type: 'human' as const, content: '上一问' },
    { id: 'old-a', type: 'ai' as const, content: '上一答', status: { type: 'complete' as const, reason: 'stop' as const } },
  ], cards: {} };
  let writes = 0;
  const persistence = { read: () => saved, write: () => { writes++; return true; } } as unknown as ReturnType<typeof createAdkPersistence>;
  const controller = new AbortController();
  const config = { abortSignal: controller.signal, initialize: async () => ({ remoteId: 'local', externalId: 'local' }) };
  const input = [{ id: 'new-u', type: 'human' as const, content: '新问题' }];
  return { persistence, controller, config, input, writes: () => writes };
}
async function drain(stream: ReturnType<AdkStreamCallback>) {
  const events: AdkEvent[] = [];
  for await (const event of await stream) events.push(event);
  return events;
}

test('official stream wrapper restores complete text history and commits only after the application terminal', async () => {
  const f = fixture(); let settled = 0;
  const transport: AdkStreamCallback = async function* (_messages, config) {
    assert.deepEqual(config.stateDelta, { history: [{ role: 'user', text: '上一问' }, { role: 'assistant', text: '上一答' }] });
    assert.equal(config.runConfig, undefined);
    yield { id: 'a', author: 'customer_assistant', content: { role: 'model', parts: [{ text: '完整答案' }] } };
    assert.equal(f.writes(), 0);
    yield { id: 'terminal', customMetadata: { meDemoTerminal: { version: 1, status: 'complete' } } };
  };
  await drain(createMeAdkStream(f.persistence, () => undefined, () => settled++, transport)(f.input, { ...f.config, runConfig: { maxLlmCalls: 1 } }));
  assert.equal(f.writes(), 1); assert.equal(settled, 1);
});

test('partial-only clean EOF is incomplete and cannot persist or auto-retry', async () => {
  const f = fixture(); let calls = 0;
  const transport: AdkStreamCallback = async function* () { calls++; yield { id: 'partial', partial: true, content: { role: 'model', parts: [{ text: '片段' }] } }; };
  await assert.rejects(drain(createMeAdkStream(f.persistence, () => undefined, () => {}, transport)(f.input, f.config)), /连接提前结束/);
  assert.equal(f.writes(), 0); assert.equal(calls, 1);
});

test('server errors and invalid terminal markers cannot create completed history', async () => {
  for (const event of [
    { id: 'error', errorCode: 'MODEL_INCOMPLETE', errorMessage: '回复未完成' },
    { id: 'bad-terminal', customMetadata: { meDemoTerminal: { version: 2, status: 'complete' } } },
  ] satisfies AdkEvent[]) {
    const f = fixture(); const transport: AdkStreamCallback = async function* () { yield event; };
    await assert.rejects(drain(createMeAdkStream(f.persistence, () => undefined, () => {}, transport)(f.input, f.config)));
    assert.equal(f.writes(), 0);
  }
});

test('cancellation before the server terminal is not committed', async () => {
  const f = fixture(); const transport: AdkStreamCallback = async function* () {
    yield { id: 'partial', partial: true, content: { role: 'model', parts: [{ text: '片段' }] } };
    f.controller.abort();
    yield { id: 'terminal', customMetadata: { meDemoTerminal: { version: 1, status: 'complete' } } };
  };
  await assert.rejects(drain(createMeAdkStream(f.persistence, () => undefined, () => {}, transport)(f.input, f.config)), error => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(f.writes(), 0);
});


test('EOF failure is delivered as an official incomplete message, not only an error notice', async () => {
  const f = fixture();
  const accumulator = new AdkEventAccumulator(f.input);
  const transport: AdkStreamCallback = async function* () { yield { id: 'partial-ui', author: 'customer_assistant', partial: true, content: { role: 'model', parts: [{ text: '未完成片段' }] } }; };
  const run = async () => { for await (const event of await createMeAdkStream(f.persistence, () => undefined, () => {}, transport)(f.input, f.config)) accumulator.processEvent(event); };
  await assert.rejects(run(), /连接提前结束/);
  const last = accumulator.getMessages().at(-1);
  assert.equal(last?.type === 'ai' && last.status?.type, 'incomplete');
  assert.equal(f.writes(), 0);
});
