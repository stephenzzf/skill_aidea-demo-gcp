import type { FeedbackAdapter } from "@assistant-ui/react";
import type { PublicConfig } from "../shared/contracts.ts";

export type LocalFeedback = "positive" | "negative";
export type FeedbackByMessageId = Readonly<Record<string, LocalFeedback>>;

export interface ComposerQuote {
  text: string;
  messageId?: string;
}

export interface PendingComposerDraft {
  text: string;
  quote?: ComposerQuote;
}

/** Keep an accepted draft available until a stream settles, fails, or is stopped. */
export function createPendingComposerDraft() {
  let pending: PendingComposerDraft | null = null;
  return {
    begin(draft: PendingComposerDraft): void {
      pending = { ...draft, ...(draft.quote ? { quote: { ...draft.quote } } : {}) };
    },
    settle(): void {
      pending = null;
    },
    discard(): void {
      pending = null;
    },
    restoreIfEmpty(currentText: string, restore: (draft: PendingComposerDraft) => void): boolean {
      if (!pending) return false;
      const draft = pending;
      pending = null;
      if (currentText) return false;
      restore(draft);
      return true;
    },
  };
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredInteractions {
  version: 1;
  feedbackByMessageId: Record<string, LocalFeedback>;
}

const STORAGE_SUFFIX = "chat-interactions:v1";

function isLocalFeedback(value: unknown): value is LocalFeedback {
  return value === "positive" || value === "negative";
}

function storageForSession(): StorageLike | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function parseStored(value: string | null): StoredInteractions | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || typeof record.feedbackByMessageId !== "object" ||
      record.feedbackByMessageId === null || Array.isArray(record.feedbackByMessageId)) return undefined;
    const feedback: Record<string, LocalFeedback> = {};
    for (const [messageId, rating] of Object.entries(record.feedbackByMessageId)) {
      if (!messageId || messageId.length > 256 || !isLocalFeedback(rating)) return undefined;
      feedback[messageId] = rating;
    }
    return { version: 1, feedbackByMessageId: feedback };
  } catch {
    return undefined;
  }
}

export function chatInteractionsStorageKey(config: Pick<PublicConfig, "id" | "mode">): string {
  return `me-demo:${encodeURIComponent(config.id)}:${encodeURIComponent(config.mode)}:${STORAGE_SUFFIX}`;
}

export function clearChatInteractions(config: Pick<PublicConfig, "id" | "mode">): boolean {
  return createChatInteractionStore(config).clear();
}

/** Local-only message ratings. They are never appended to the ADK message history. */
export function createChatInteractionStore(
  config: Pick<PublicConfig, "id" | "mode">,
  getStorage: () => StorageLike | undefined = storageForSession,
) {
  const key = chatInteractionsStorageKey(config);
  let snapshot: StoredInteractions;
  try {
    snapshot = parseStored(getStorage()?.getItem(key) ?? null) ?? { version: 1, feedbackByMessageId: {} };
  } catch {
    snapshot = { version: 1, feedbackByMessageId: {} };
  }

  const persist = () => {
    try {
      getStorage()?.setItem(key, JSON.stringify(snapshot));
    } catch {
      // The in-memory snapshot still supports this page when browser storage is unavailable.
    }
  };

  return {
    read: (): FeedbackByMessageId => ({ ...snapshot!.feedbackByMessageId }),
    setFeedback(messageId: string, rating: LocalFeedback): void {
      if (!messageId || messageId.length > 256 || !isLocalFeedback(rating)) return;
      snapshot!.feedbackByMessageId[messageId] = rating;
      persist();
    },
    clear(): boolean {
      snapshot = { version: 1, feedbackByMessageId: {} };
      try {
        getStorage()?.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
    feedbackAdapter(onChange: () => void): FeedbackAdapter {
      return {
        submit(feedback) {
          if (feedback.message.role !== "assistant") return;
          const messageId = feedback.message.id;
          if (!messageId || !isLocalFeedback(feedback.type)) return;
          snapshot!.feedbackByMessageId[messageId] = feedback.type;
          persist();
          onChange();
        },
      };
    },
  };
}

/**
 * The ADK adapter transports plain user text, so make a selected quote explicit
 * in that text instead of relying on composer metadata that ADK does not retain.
 */
export function serializeQuotedPrompt(text: string, quote?: ComposerQuote): string {
  const prompt = text.trim();
  const quotedText = quote?.text.trim();
  if (!quotedText) return prompt;
  const block = quotedText.split("\n").map(line => `> ${line}`).join("\n");
  return `${prompt}\n\n引用的对话内容（作为用户提供的上下文）：\n${block}`.trim();
}
