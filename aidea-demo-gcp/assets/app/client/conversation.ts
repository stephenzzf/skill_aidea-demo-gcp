import type { ChatMessage, PublicConfig } from "../shared/contracts.ts";

const STORAGE_PREFIX = "me-demo-session:";
const STORED_CONVERSATION_VERSION = 1;

export interface ConversationStorage {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
}

type StoredChatMessage = Omit<ChatMessage, "id"> & { id?: string };
type StoredConversation = { version: 1; messages: ChatMessage[] };

export interface LoadedConversation {
  messages: ChatMessage[];
  available: boolean;
  migrated: boolean;
}

let fallbackIdSequence = 0;

export function getConversationStorage(): ConversationStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function createChatMessageId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return `chat-${cryptoApi.randomUUID()}`;
  fallbackIdSequence += 1;
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${fallbackIdSequence.toString(36)}`;
}

export function conversationStorageKey(
  config: Pick<PublicConfig, "id" | "mode" | "solution">,
  domainId?: string,
): string {
  const base = `${STORAGE_PREFIX}${config.id}:${config.mode}`;
  return config.solution ? `${base}:domain:${domainId ?? "solution"}` : base;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStoredChatMessage(value: unknown): value is StoredChatMessage {
  if (!isRecord(value)) return false;
  if (
    (value.role !== "user" && value.role !== "assistant") ||
    typeof value.text !== "string" ||
    (value.id !== undefined && typeof value.id !== "string") ||
    (value.status !== undefined &&
      value.status !== "running" &&
      value.status !== "complete" &&
      value.status !== "interrupted")
  ) {
    return false;
  }
  if (value.card !== undefined) {
    if (!isRecord(value.card) || typeof value.card.title !== "string") return false;
    if (
      !Array.isArray(value.card.rows) ||
      !value.card.rows.every(
        (row) =>
          Array.isArray(row) &&
          row.length === 2 &&
          row.every((cell) => typeof cell === "string"),
      )
    ) {
      return false;
    }
  }
  return (
    (value.source === undefined || typeof value.source === "string") &&
    (value.followups === undefined ||
      (Array.isArray(value.followups) &&
        value.followups.every((item) => typeof item === "string")))
  );
}

function completePairs<T extends { role: ChatMessage["role"]; status?: ChatMessage["status"] }>(
  messages: readonly T[],
): T[] {
  const completed: T[] = [];
  for (let index = 0; index + 1 < messages.length; index += 2) {
    const user = messages[index];
    const assistant = messages[index + 1];
    if (
      user?.role === "user" &&
      assistant?.role === "assistant" &&
      assistant.status === "complete"
    ) {
      completed.push(user, assistant);
    }
  }
  return completed;
}

export function completeMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return completePairs(messages);
}

export function completeHistory(messages: readonly ChatMessage[]) {
  return completeMessages(messages).map(({ role, text }) => ({ role, text }));
}

function needsNewId(id: string | undefined): boolean {
  return !id?.trim() || /^me-demo-chat-message-\d+$/u.test(id);
}

function nextUnusedId(idFactory: () => string, used: Set<string>): string {
  let id = idFactory();
  while (!id.trim() || used.has(id)) id = idFactory();
  return id;
}

export function persistConversation(
  storage: ConversationStorage | null,
  storageKey: string,
  messages: readonly ChatMessage[],
): boolean {
  if (!storage) return false;
  try {
    const record: StoredConversation = {
      version: STORED_CONVERSATION_VERSION,
      messages: completeMessages(messages),
    };
    storage.setItem(storageKey, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function loadConversation(
  storage: ConversationStorage | null,
  storageKey: string,
  idFactory: () => string = createChatMessageId,
): LoadedConversation {
  if (!storage) return { messages: [], available: false, migrated: false };
  let raw: string | null;
  try {
    raw = storage.getItem(storageKey);
  } catch {
    return { messages: [], available: false, migrated: false };
  }
  if (!raw) return { messages: [], available: true, migrated: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { messages: [], available: true, migrated: false };
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== STORED_CONVERSATION_VERSION ||
    !Array.isArray(parsed.messages)
  ) {
    return { messages: [], available: true, migrated: false };
  }

  const validMessages = parsed.messages.filter(isStoredChatMessage);
  const completed = completePairs(validMessages);
  const usedIds = new Set<string>();
  let migrated = false;
  const messages = completed.map((message): ChatMessage => {
    let id = message.id?.trim();
    if (needsNewId(id) || usedIds.has(id!)) {
      id = nextUnusedId(idFactory, usedIds);
      migrated = true;
    } else if (message.id !== id) {
      migrated = true;
    }
    usedIds.add(id!);
    return message.id === id ? (message as ChatMessage) : { ...message, id: id! };
  });

  const available = !migrated || persistConversation(storage, storageKey, messages);
  return { messages, available, migrated };
}

export function hasCompleteMessagesChanged(
  previous: readonly ChatMessage[],
  next: readonly ChatMessage[],
): boolean {
  if (previous.length !== next.length) return true;
  return previous.some((message, index) => message !== next[index]);
}

export function clearConversationStorage(
  storage: ConversationStorage | null,
  config: Pick<PublicConfig, "id" | "mode" | "solution">,
): boolean {
  if (!storage) return false;
  try {
    const base = `${STORAGE_PREFIX}${config.id}:${config.mode}`;
    if (!config.solution) {
      storage.removeItem(base);
      return true;
    }
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key && (key === base || key.startsWith(`${base}:`))) storage.removeItem(key);
    }
    return true;
  } catch {
    return false;
  }
}
