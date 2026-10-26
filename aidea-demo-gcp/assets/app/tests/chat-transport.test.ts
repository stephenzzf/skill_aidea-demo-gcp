import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiRequestError, streamReply } from '../client/api.ts';
import type { StreamEvent } from '../shared/contracts.ts';

function eventStream(text: string, chunkSize = 7) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

test('chat transport handles fragmented UTF-8, CRLF, heartbeat, cards and terminal completion', async t => {
  const context = { domainId: 'solution', query: {}, state: { revision: 0, events: [] } };
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, '/api/chat');
    assert.equal(init.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(String(init.body)), { message: '继续', history: [], context });
    return eventStream(': keepalive\r\n\r\ndata: {"type":"text","text":"你好，世界"}\r\n\r\ndata: {"type":"card","card":{"title":"依据","rows":[["来源","本地"]]}}\r\n\r\ndata: {"type":"done"}');
  });
  const events: StreamEvent[] = [];
  await streamReply('继续', [], new AbortController().signal, e => events.push(e), context);
  assert.deepEqual(events.map(e => e.type), ['text', 'card', 'done']);
  assert.equal(events[0].type === 'text' && events[0].text, '你好，世界');
});

test('chat transport rejects premature EOF, unsupported events and server errors without retry', async t => {
  const frames = [
    'data: {"type":"text","text":"未完成"}\n\n',
    'data: {"type":"execute","command":"not-allowed"}\n\n',
    'data: {"type":"error","message":"本地失败"}\n\n',
  ];
  let calls = 0;
  const mocked = t.mock.method(globalThis, 'fetch', async () => { calls++; return eventStream(frames[calls - 1]); });
  for (const pattern of [/尚未完成/, /不支持/, /本地失败/]) {
    await assert.rejects(streamReply('问题', [], new AbortController().signal, () => {}), pattern);
  }
  assert.equal(mocked.mock.callCount(), 3);
});

test('chat transport preserves access failures and passes caller cancellation to fetch', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(init.signal, controller.signal);
    return new Response(JSON.stringify({ error: '访问失效' }), { status: 401, headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(streamReply('问题', [], controller.signal, () => {}), error => error instanceof ApiRequestError && error.status === 401);
});

test('aborted chat does not consume pending data or retry', async t => {
  const controller = new AbortController();
  controller.abort();
  let cancelled = false;
  const mocked = t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(streamReply('问题', [], controller.signal, () => {}), error => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(cancelled, true);
  assert.equal(mocked.mock.callCount(), 1);
});
