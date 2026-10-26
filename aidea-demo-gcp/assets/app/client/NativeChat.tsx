import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AssistantRuntimeProvider, useAuiState } from '@assistant-ui/react';
import type { AssistantRuntime } from '@assistant-ui/react';
import { useAdkRuntime } from '@assistant-ui/react-google-adk';
import type { ChatMessage, PublicConfig, WorkspaceChatContext } from '../shared/contracts.ts';
import { AssistantChat } from './AssistantChat.tsx';
import { createAdkPersistence } from './adk-history.ts';
import { createMeAdkStream } from './adk-transport.ts';
import type { PendingComposerDraft } from "./chat-interactions.ts";
import { createChatInteractionStore, createPendingComposerDraft, serializeQuotedPrompt } from './chat-interactions.ts';

interface Props {
  config: PublicConfig;
  context?: WorkspaceChatContext;
  demoMode: string;
  contextLabel?: string;
  onUnauthorized: (draft?: PendingComposerDraft) => void;
  initialDraft?: PendingComposerDraft;
  onDraftRestored?: () => void;
  onCancelReady: (cancel: (() => void) | null) => void;
  onStopReady?: (stop: (() => void) | null) => void;
  onRunningChange?: (running: boolean) => void;
}

export function NativeChat({ config, context, demoMode, contextLabel, onUnauthorized, onCancelReady, initialDraft, onDraftRestored, onStopReady, onRunningChange }: Props) {
  const contextRef = useRef(context);
  contextRef.current = context;
  const requestContext = useRef<WorkspaceChatContext | undefined>(undefined);
  const [notice, setNotice] = useState('');
  const [ready, setReady] = useState(false);
  const [settledVersion, setSettledVersion] = useState(0);
  const [feedbackVersion, setFeedbackVersion] = useState(0);
  const persistence = useMemo(() => createAdkPersistence(config), [config.id, config.mode]);
  const interactions = useMemo(() => createChatInteractionStore(config), [config.id, config.mode]);
  const feedbackAdapter = useMemo(() => interactions.feedbackAdapter(() => setFeedbackVersion(value => value + 1)), [interactions]);
  const feedbackByMessageId = useMemo(() => interactions.read(), [interactions, feedbackVersion]);
  const pendingDraft = useRef(createPendingComposerDraft());
  const stream = useMemo(() => createMeAdkStream(persistence, () => requestContext.current, () => {
    pendingDraft.current.settle();
    setSettledVersion(value => value + 1);
  }), [persistence]);
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const restoreDraft = useCallback(() => {
    const currentRuntime = runtimeRef.current;
    if (!currentRuntime) return;
    const composer = currentRuntime.thread.composer;
    pendingDraft.current.restoreIfEmpty(composer.getState().text, draft => {
      composer.setText(draft.text);
      if (draft.quote?.messageId) composer.setQuote({ text: draft.quote.text, messageId: draft.quote.messageId });
    });
  }, []);
  const onError = useCallback((value: unknown) => {
    restoreDraft();
    const error = value instanceof Error ? value : new Error(typeof value === "string" ? value : "回复未完成，未自动重试。");
    if (/\b401\b/.test(error.message)) {
      const composer = runtimeRef.current?.thread.composer.getState();
      onUnauthorized(composer && (composer.text || composer.quote)
        ? { text: composer.text, ...(composer.quote ? { quote: composer.quote } : {}) } : undefined);
    }
    setNotice(error.message || '回复未完成，未自动重试。');
  }, [onUnauthorized, restoreDraft]);
  const runtime = useAdkRuntime({ unstable_allowCancellation: true, stream, load: persistence.load, sessionAdapter: persistence.adapter,
    adapters: { feedback: feedbackAdapter }, eventHandlers: { onError } });
  runtimeRef.current = runtime;
  useLayoutEffect(() => {
    const cancel = () => {
      pendingDraft.current.discard();
      const activeRuntime = runtimeRef.current;
      if (activeRuntime?.thread.getState().isRunning) activeRuntime.thread.cancelRun();
    };
    onCancelReady(cancel);
    return () => { cancel(); onCancelReady(null); };
  }, [onCancelReady]);
  useEffect(() => {
    let active = true;
    const current = runtimeRef.current;
    if (!current) return;
    void current.threads.getLoadThreadsPromise().then(() => current.threads.switchToThread(persistence.threadId)).then(() => {
      if (active) {
        const composer = current.thread.composer;
        if (initialDraft && !composer.getState().text) {
          composer.setText(initialDraft.text);
          if (initialDraft.quote?.messageId) composer.setQuote({ text: initialDraft.quote.text, messageId: initialDraft.quote.messageId });
        }
        onDraftRestored?.();
        setReady(true);
      }
    }).catch(error => { if (active) setNotice(error instanceof Error ? error.message : '会话恢复失败。'); });
    return () => {
      active = false;
      pendingDraft.current.discard();
      if (current.thread.getState().isRunning) current.thread.cancelRun();
    };
  }, [persistence]);
  const cards = useMemo(() => persistence.read().cards, [persistence, settledVersion]);
  const send = useCallback(async (text: string) => {
    if (!ready || runtime.thread.getState().isRunning) return;
    setNotice('');
    const composer = runtime.thread.composer;
    const quote = composer.getState().quote;
    const userText = serializeQuotedPrompt(text, quote);
    if (!userText) return;
    const savedDraft = { text, ...(quote ? { quote: { text: quote.text, messageId: quote.messageId } } : {}) };
    pendingDraft.current.begin(savedDraft);
    composer.setQuote(undefined);
    composer.setText('');
    try {
      // append() is fire-and-forget in this runtime. Keep the draft until the
      // stream's explicit settled callback, error handler, or cancel path.
      requestContext.current = contextRef.current ? structuredClone(contextRef.current) : undefined;
      runtime.thread.append({ role: 'user', content: [{ type: 'text', text: userText }] });
    } catch (error) {
      restoreDraft();
      onError(error instanceof Error ? error : new Error('提问未完成。'));
      throw error;
    }
  }, [ready, runtime, onError, restoreDraft]);
  const cancelAndRestoreDraft = useCallback(() => {
    runtime.thread.cancelRun();
    restoreDraft();
    setNotice('本轮已停止；未完成的回复不会进入后续对话。');
  }, [runtime, restoreDraft]);
  useEffect(() => { onStopReady?.(cancelAndRestoreDraft); return () => onStopReady?.(null); }, [onStopReady, cancelAndRestoreDraft]);
  return <AssistantRuntimeProvider runtime={runtime}>
    <NativeThreadView config={config} runtime={runtime} cards={cards} feedbackByMessageId={feedbackByMessageId} ready={ready} notice={notice}
      storageAvailable={persistence.available()} demoMode={demoMode} contextLabel={contextLabel} onSend={send}
      onCancel={cancelAndRestoreDraft} onRunningChange={onRunningChange} />
  </AssistantRuntimeProvider>;
}

interface ViewProps {
  config: PublicConfig; runtime: AssistantRuntime;
  cards: ReturnType<ReturnType<typeof createAdkPersistence>['read']>['cards'];
  feedbackByMessageId: ReturnType<ReturnType<typeof createChatInteractionStore>['read']>;
  ready: boolean; notice: string; storageAvailable: boolean; demoMode: string; contextLabel?: string;
  onSend: (text: string) => Promise<void>; onCancel: () => void;
  onRunningChange?: (running: boolean) => void;
}
function NativeThreadView({ config, cards, feedbackByMessageId, ready, notice, storageAvailable, demoMode, contextLabel, onSend, onCancel, onRunningChange }: ViewProps) {
  const nativeMessages = useAuiState(state => state.thread.messages);
  const isRunning = useAuiState(state => state.thread.isRunning);
  useEffect(() => { onRunningChange?.(isRunning); }, [isRunning, onRunningChange]);
  const messages = useMemo(() => {
    let turnId = '';
    return nativeMessages.flatMap((message, index): ChatMessage[] => {
      if (message.role !== 'user' && message.role !== 'assistant') return [];
      const text = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
      if (message.role === 'user') turnId = message.id;
      let hasLaterText = false;
      for (const next of nativeMessages.slice(index + 1)) {
        if (next.role === 'user') break;
        if (next.content.some(part => part.type === 'text' && part.text)) hasLaterText = true;
      }
      const card = message.role === 'assistant' && text && !hasLaterText ? cards[turnId] : undefined;
      return [{ id: message.id, role: message.role, text,
        ...(message.role === 'assistant' ? { status: message.status.type === 'running' ? 'running' : message.status.type === 'incomplete' ? 'interrupted' : 'complete' } : {}),
        ...(card ?? {}) }];
    });
  }, [nativeMessages, cards]);
  return <AssistantChat config={config} messages={messages} busy={!ready || isRunning} notice={notice}
    feedbackByMessageId={feedbackByMessageId} storageAvailable={storageAvailable} demoMode={demoMode}
    contextLabel={contextLabel} onSend={onSend} onCancel={onCancel} />;
}
