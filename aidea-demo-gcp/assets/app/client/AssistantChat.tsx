import type { FormEvent } from "react";
import { ActionBarMorePrimitive, ActionBarPrimitive, ComposerPrimitive, MessagePrimitive, SelectionToolbarPrimitive, ThreadPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { IconArrowDown, IconArrowUp, IconArrowUpRight, IconCheck, IconCopy, IconDots, IconMessageCircle, IconQuote, IconSparkles, IconThumbDown, IconThumbUp, IconX } from "@tabler/icons-react";
import type { ChatMessage, PublicConfig } from "../shared/contracts.ts";
import { ChatBusinessFollowups } from "./ChatBusinessCards.tsx";
import { MarkdownText } from "./MarkdownText.tsx";
import { ChatChainOfThought } from "./ChatReasoning.tsx";
import "./assistant-chat.css";

interface AssistantChatProps {
  config: PublicConfig;
  messages: readonly ChatMessage[];
  busy: boolean;
  notice: string;
  storageAvailable: boolean;
  demoMode: string;
  contextLabel?: string;
  feedbackByMessageId?: Readonly<Record<string, "positive" | "negative">>;
  onSend: (text: string) => Promise<void>;
  onCancel: () => void;
}

function FeedbackActions({ rating }: { rating?: "positive" | "negative" }) {
  const submitted = useAuiState(state => state.message.metadata.submittedFeedback?.type);
  const positive = rating === "positive" || submitted === "positive";
  const negative = rating === "negative" || submitted === "negative";
  return <>
    <ActionBarPrimitive.FeedbackPositive aria-label="有帮助" title="有帮助" aria-pressed={positive} data-local-feedback={positive ? "selected" : undefined}>
      <IconThumbUp size={15} /><span className="sr-only">有帮助</span>
    </ActionBarPrimitive.FeedbackPositive>
    <ActionBarPrimitive.FeedbackNegative aria-label="没有帮助" title="没有帮助" aria-pressed={negative} data-local-feedback={negative ? "selected" : undefined}>
      <IconThumbDown size={15} /><span className="sr-only">没有帮助</span>
    </ActionBarPrimitive.FeedbackNegative>
    <span className="feedback-local-label" aria-live="polite">{rating ? "本地反馈" : ""}</span>
  </>;
}

function ReplyActions({ messageId, text, feedbackByMessageId }: { messageId: string; text: string; feedbackByMessageId?: AssistantChatProps["feedbackByMessageId"] }) {
  const aui = useAui();
  const setWholeQuote = () => aui.thread.composer().setQuote({ text, messageId });
  return (
    <ActionBarPrimitive.Root className="message-actions" hideWhenRunning>
      <ActionBarPrimitive.Copy aria-label="复制回复" title="复制回复" copiedDuration={1800}>
        <IconCopy className="copy-idle" size={15} />
        <IconCheck className="copy-done" size={15} />
        <span className="copy-label">复制</span>
      </ActionBarPrimitive.Copy>
      <FeedbackActions rating={feedbackByMessageId?.[messageId]} />
      <button type="button" aria-label="引用整条回复" title="引用整条回复" onClick={setWholeQuote}>
        <IconQuote size={15} /><span>引用</span>
      </button>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger aria-label="更多回复操作" title="更多回复操作">
          <IconDots size={16} /><span>更多</span>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content align="start" side="top" className="chat-action-menu">
          <ActionBarMorePrimitive.Item asChild>
            <ActionBarPrimitive.ExportMarkdown filename={`reply-${messageId}.md`}>
              导出 Markdown
            </ActionBarPrimitive.ExportMarkdown>
          </ActionBarMorePrimitive.Item>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
}

function MessageBody({ config, message, activeReply, hasNativeActivity, isLatestReply, assistantName, onSend, busy, feedbackByMessageId }: {
  config: PublicConfig;
  message: ChatMessage;
  activeReply: boolean;
  hasNativeActivity: boolean;
  isLatestReply: boolean;
  assistantName: string;
  onSend: AssistantChatProps["onSend"];
  busy: boolean;
  feedbackByMessageId?: AssistantChatProps["feedbackByMessageId"];
}) {
  return (
    <MessagePrimitive.Root className={`message ${message.role}${isLatestReply ? " is-latest-reply" : ""}`}>
      <div className="message-author">
        {message.role === "user" ? "你" : <><IconSparkles size={15} />{assistantName}</>}
      </div>
      <div className="message-body">
        <MessagePrimitive.Parts components={{ Text: MarkdownText, ChainOfThought: ChatChainOfThought }} />
        {message.card && (
          <div className="answer-card">
            <h3><IconCheck size={16} />{message.card.title}</h3>
            {message.card.rows.map(([label, value], index) => <div className="answer-row" key={`${index}:${label}`}><strong>{label}</strong><span>{value}</span></div>)}
          </div>
        )}
        {activeReply && !message.text && !message.card && !hasNativeActivity && <span className="typing-indicator" role="status">正在整理回复…</span>}
        {message.status === "interrupted" && message.role === "assistant" && !activeReply && <span className="interrupted-label">本轮未完成，可修改问题后重新发送。</span>}
      </div>
      {message.source && <small className="source">依据：{message.source}</small>}
      {message.role === "user" && <MessagePrimitive.Quote>{quote => <blockquote className="message-quote"><span>引用内容</span><p>{quote.text}</p></blockquote>}</MessagePrimitive.Quote>}
      {message.role === "assistant" && message.status === "complete" && message.text && (
        <ReplyActions messageId={message.id} text={message.text} feedbackByMessageId={feedbackByMessageId} />
      )}
      {message.role === "assistant" && message.status === "complete" && isLatestReply && message.followups && (
        <div className="followups">{message.followups.map(prompt => <button key={prompt} disabled={busy} onClick={() => void onSend(prompt)}>{prompt}<IconArrowUpRight size={14} /></button>)}</div>
      )}
      {message.role === "assistant" && message.status === "complete" && isLatestReply && !message.followups?.length && <ChatBusinessFollowups config={config} busy={busy} onSend={onSend} />}
    </MessagePrimitive.Root>
  );
}

export function AssistantChat({ config, messages, busy, notice, storageAvailable, demoMode, contextLabel, feedbackByMessageId, onSend, onCancel }: AssistantChatProps) {
  const composerText = useAuiState(state => state.thread.composer.text);
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = composerText.trim();
    if (!text || busy) return;
    void onSend(text);
  };

  const messageById = new Map(messages.map(message => [message.id, message]));
  const latestReplyId = [...messages].reverse().find(message => message.role === "assistant" && message.status === "complete")?.id;
  return (
    <section className="chat-shell" aria-label="客户业务问答">
      <div className="chat-heading">
        <div className="agent-icon"><IconSparkles size={19} /></div>
        <div className="chat-heading-copy">
          <h1>与 {config.assistantName} 对话</h1>
          <p>{contextLabel ? `当前领域：${contextLabel} · 可继续问答与澄清。` : "围绕本次方案，直接提问与体验。"}</p>
        </div>
        <span className="session-dot">临时演示会话</span>
      </div>

      <ThreadPrimitive.Root className="assistant-chat-thread">
        <ThreadPrimitive.Viewport className="chat-feed" autoScroll>
          <div className="chat-transcript" role="log" aria-live="polite" aria-relevant="additions text">
            {messages.length === 0 ? (
              <div className="welcome">
                <span className="welcome-icon"><IconMessageCircle size={28} /></span>
                <span className="eyebrow">{config.customer} · 客户演示</span>
                <h2>{config.title}</h2>
                <p>{config.subtitle}</p>
                <div className="starter-prompts">{config.prompts.map((prompt, index) => <button key={prompt} disabled={busy} onClick={() => void onSend(prompt)}><small>0{index + 1}</small><span>{prompt}</span><IconArrowUpRight size={16} /></button>)}</div>
                <span className="welcome-note">选择一个问题开始，也可以在下方继续提问。</span>
              </div>
            ) : (
              <ThreadPrimitive.Messages>
                {({ message }) => {
                  if (message.role !== "assistant" && message.role !== "user") return null;
                  const stored = messageById.get(message.id);
                  const text = stored?.text ?? message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
                  const status = stored?.status ?? (message.role === "assistant" ? message.status.type === "running" ? "running" : message.status.type === "incomplete" ? "interrupted" : "complete" : undefined);
                  const hasNativeActivity = message.content.some(part => part.type === "reasoning" || part.type === "tool-call" || (part.type === "text" && part.text.trim().length > 0));
                  const view: ChatMessage = stored ?? { id: message.id, role: message.role, text, ...(status ? { status } : {}) };
                  return <MessageBody key={message.id} config={config} message={view} activeReply={message.role === "assistant" && message.status.type === "running"} hasNativeActivity={hasNativeActivity} isLatestReply={message.id === latestReplyId} assistantName={config.assistantName} onSend={onSend} busy={busy} feedbackByMessageId={feedbackByMessageId} />;
                }}
              </ThreadPrimitive.Messages>
            )}
          </div>
          {messages.length > 0 && <ThreadPrimitive.ScrollToBottom className="chat-scroll-to-latest" behavior="smooth" type="button" aria-label="滚动到最新消息" title="滚动到最新消息"><IconArrowDown size={15} /><span>回到最新</span></ThreadPrimitive.ScrollToBottom>}
        </ThreadPrimitive.Viewport>

        <SelectionToolbarPrimitive.Root className="chat-selection-toolbar" role="toolbar" aria-label="选中文本操作">
          <SelectionToolbarPrimitive.Quote aria-label="引用选中内容" title="引用选中内容"><IconQuote size={14} />引用</SelectionToolbarPrimitive.Quote>
        </SelectionToolbarPrimitive.Root>

        <div className="composer">
          {notice && <p className="notice" role="status">{notice}</p>}
          {!storageAvailable && <p className="storage-note">浏览器临时存储不可用；刷新页面后会话不会保留。</p>}
          <ComposerPrimitive.Root onSubmit={handleSubmit}>
            <ComposerPrimitive.Quote className="composer-quote">
              <span className="composer-quote-label">引用内容将随问题发送</span>
              <ComposerPrimitive.QuoteText />
              <ComposerPrimitive.QuoteDismiss aria-label="移除引用" title="移除引用"><IconX size={14} /></ComposerPrimitive.QuoteDismiss>
            </ComposerPrimitive.Quote>
            <label className="sr-only" htmlFor="question">向 {config.assistantName} 提问</label>
            <ComposerPrimitive.Input id="question" minRows={2} maxRows={5} placeholder="围绕本次方案继续提问…" disabled={busy} onKeyDown={event => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (composerText.trim() && !busy) void onSend(composerText.trim());
              }
            }} />
            <div className="composer-bottom">
              <span>Enter 发送 · Shift + Enter 换行</span>
              {busy ? <button className="stop-button" type="button" onClick={onCancel} aria-label="停止回复"><IconX size={17} /><span>停止</span></button> : <ComposerPrimitive.Send aria-label="发送消息" onClick={event => {
                event.preventDefault();
                if (composerText.trim() && !busy) void onSend(composerText.trim());
              }}><IconArrowUp size={19} /></ComposerPrimitive.Send>}
            </div>
          </ComposerPrimitive.Root>
          <p className="chat-disclaimer">{demoMode} · 仅供方案体验，不代表线上业务数据。</p>
        </div>
      </ThreadPrimitive.Root>
    </section>
  );
}
