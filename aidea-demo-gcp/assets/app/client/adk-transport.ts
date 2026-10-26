import { AdkEventAccumulator, createAdkStream } from '@assistant-ui/react-google-adk';
import type { AdkStreamCallback } from '@assistant-ui/react-google-adk';
import type { WorkspaceChatContext } from '../shared/contracts.ts';
import { cardSchema } from '../shared/contracts.ts';
import { nativeHistory } from './adk-history.ts';
import type { createAdkPersistence } from './adk-history.ts';

type Persistence = ReturnType<typeof createAdkPersistence>;

/** The accumulator is a settled persistence projection, never a second UI store. */
export function createMeAdkStream(
  persistence: Persistence,
  getContext: () => WorkspaceChatContext | undefined,
  onSettled: () => void,
  transport: AdkStreamCallback = createAdkStream({ api: '/api/chat/adk' }),
): AdkStreamCallback {
  return async function* (messages, config) {
    const context = getContext();
    const contextSnapshot = context ? structuredClone(context) : undefined;
    const saved = persistence.read();
    const accumulator = new AdkEventAccumulator([...saved.messages, ...messages]);
    const cards = { ...saved.cards };
    const turnId = messages.findLast(message => message.type === 'human')?.id;
    if (!turnId || messages.some(message => message.type !== 'human')) throw new Error('当前演示仅接受新的文本问题。');
    let errorDelivered = false;
    try {
    const events = await transport(messages, {
      abortSignal: config.abortSignal,
      initialize: config.initialize,
      stateDelta: { history: nativeHistory(saved.messages), ...(contextSnapshot ? { context: contextSnapshot } : {}) },
    });
    for await (const event of events) {
      config.abortSignal.throwIfAborted();
      if (event.errorCode || event.interrupted) {
        errorDelivered = true;
        yield event;
        throw new Error(event.errorMessage || '回复未完成，未自动重试。');
      }
      const metadata = event.customMetadata;
      if (metadata?.meDemoCard) {
        const value = metadata.meDemoCard as Record<string, unknown>;
        const card = cardSchema.safeParse(value.card);
        if (!card.success || (value.source !== undefined && typeof value.source !== 'string') ||
          (value.followups !== undefined && (!Array.isArray(value.followups) || value.followups.some(item => typeof item !== 'string')))) {
          throw new Error('服务端卡片格式无效。');
        }
        cards[turnId] = { card: card.data, ...(typeof value.source === 'string' ? { source: value.source } : {}),
          ...(Array.isArray(value.followups) ? { followups: value.followups as string[] } : {}) };
      }
      accumulator.processEvent(event);
      yield event;
      if (metadata?.meDemoTerminal !== undefined) {
        const terminal = metadata.meDemoTerminal as Record<string, unknown>;
        if (terminal.version !== 1 || terminal.status !== 'complete' || Object.keys(terminal).some(key => !['version', 'status'].includes(key))) {
          throw new Error('服务端完成标记无效。');
        }
        config.abortSignal.throwIfAborted();
        persistence.write({ messages: accumulator.getMessages(), cards });
        onSettled();
        return;
      }
    }
    throw new Error('连接提前结束，当前回复尚未完成；未自动重试。');
    } catch (error) {
      if (!config.abortSignal.aborted && !errorDelivered) {
        yield { id: crypto.randomUUID(), errorCode: 'CLIENT_INCOMPLETE', errorMessage: error instanceof Error ? error.message : '回复未完成，未自动重试。' };
      }
      throw error;
    }
  };
}
