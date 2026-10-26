import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import type {
  AdkMessage,
  AdkThreadSnapshot,
} from "@assistant-ui/react-google-adk";
import {
  cardSchema,
  type Card,
  type ChatMessage,
  type PublicConfig,
} from "../shared/contracts.ts";
import {
  clearConversationStorage,
  conversationStorageKey,
  getConversationStorage,
  loadConversation,
} from "./conversation.ts";

export interface AdkHistoryCard {
  card: Card;
  source?: string;
  followups?: string[];
}

export interface AdkPersistenceSnapshot {
  messages: AdkMessage[];
  cards: Record<string, AdkHistoryCard>;
}

export interface AdkPersistence {
  threadId: string;
  adapter: RemoteThreadListAdapter;
  load: (
    threadId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<AdkThreadSnapshot>;
  read: () => AdkPersistenceSnapshot;
  write: (snapshot: AdkPersistenceSnapshot) => boolean;
  available: () => boolean;
  clear: () => boolean;
}

const NATIVE_RECORD_VERSION = 1;
const NATIVE_STORAGE_SUFFIX = "adk-history:v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid = value.every((item) => isJsonValue(item, ancestors));
  } else {
    const prototype = Object.getPrototypeOf(value);
    valid =
      (prototype === Object.prototype || prototype === null) &&
      Object.values(value).every((item) => isJsonValue(item, ancestors));
  }
  ancestors.delete(value);
  return valid;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isJsonValue(value);
}

function isContentPart(value: unknown, allowReasoning = false): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  return (
    (value.type === "text" || (allowReasoning && value.type === "reasoning")) &&
    hasExactKeys(value, ["type", "text"]) &&
    typeof value.text === "string"
  );
}

function isMessageContent(value: unknown, allowReasoning = false): boolean {
  return (
    typeof value === "string" ||
    (Array.isArray(value) && value.every(part => isContentPart(part, allowReasoning)))
  );
}

function isCompleteStatus(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["type", "reason"]) &&
    value.type === "complete" &&
    (value.reason === "stop" || value.reason === "unknown")
  );
}

function isToolCall(value: unknown): value is {
  id: string;
  name: string;
  args: Record<string, unknown>;
  argsText?: string;
} {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["id", "name", "args"], ["argsText"]) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    isJsonObject(value.args) &&
    (value.argsText === undefined || typeof value.argsText === "string")
  );
}

function isAdkMessage(value: unknown): value is AdkMessage {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.trim().length === 0 ||
    typeof value.type !== "string"
  ) {
    return false;
  }

  if (value.type === "human") {
    return (
      hasExactKeys(value, ["id", "type", "content"]) &&
      isMessageContent(value.content)
    );
  }
  if (value.type === "ai") {
    return (
      hasExactKeys(
        value,
        ["id", "type", "content"],
        ["tool_calls", "author", "branch", "status"],
      ) &&
      isMessageContent(value.content, true) &&
      (value.tool_calls === undefined ||
        (Array.isArray(value.tool_calls) && value.tool_calls.every(isToolCall))) &&
      (value.author === undefined || typeof value.author === "string") &&
      (value.branch === undefined || typeof value.branch === "string") &&
      (value.status === undefined || isCompleteStatus(value.status))
    );
  }
  if (value.type === "tool") {
    return (
      hasExactKeys(
        value,
        ["id", "type", "content", "tool_call_id", "name"],
        ["status", "artifact"],
      ) &&
      typeof value.content === "string" &&
      typeof value.tool_call_id === "string" &&
      value.tool_call_id.trim().length > 0 &&
      typeof value.name === "string" &&
      value.name.trim().length > 0 &&
      (value.status === undefined ||
        value.status === "success" ||
        value.status === "error") &&
      (value.artifact === undefined || isJsonValue(value.artifact))
    );
  }
  return false;
}

function isSettledHistory(messages: readonly AdkMessage[]): boolean {
  if (messages.length === 0) return true;
  const ids = new Set<string>();
  const toolCalls = new Set<string>();
  const toolResults = new Set<string>();
  let hasHuman = false;
  let lastAssistantComplete = false;

  for (const message of messages) {
    if (ids.has(message.id)) return false;
    ids.add(message.id);

    if (message.type === "human") {
      if (hasHuman && !lastAssistantComplete) return false;
      hasHuman = true;
      lastAssistantComplete = false;
      continue;
    }

    if (message.type === "ai") {
      if (!hasHuman) return false;
      for (const call of message.tool_calls ?? []) {
        if (toolCalls.has(call.id)) return false;
        toolCalls.add(call.id);
      }
      if (message.status?.type === "complete") {
        lastAssistantComplete = true;
      } else if (message.status === undefined) {
        // Accumulated agent/tool steps may precede the final complete answer.
        lastAssistantComplete = false;
      } else {
        return false;
      }
      continue;
    }

    if (!toolCalls.has(message.tool_call_id) || toolResults.has(message.tool_call_id)) {
      return false;
    }
    toolResults.add(message.tool_call_id);
  }

  if (!hasHuman || !lastAssistantComplete) return false;
  return [...toolCalls].every((id) => toolResults.has(id));
}

function isCardEntry(value: unknown): value is AdkHistoryCard {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["card"], ["source", "followups"]) &&
    cardSchema.safeParse(value.card).success &&
    (value.source === undefined || typeof value.source === "string") &&
    (value.followups === undefined ||
      (Array.isArray(value.followups) &&
        value.followups.every((item) => typeof item === "string")))
  );
}

function isCardDictionary(
  value: unknown,
  messages: readonly AdkMessage[],
): value is Record<string, AdkHistoryCard> {
  if (!isRecord(value)) return false;
  const humanIds = new Set(
    messages.flatMap((message) => (message.type === "human" ? [message.id] : [])),
  );
  return Object.entries(value).every(
    ([humanId, entry]) => humanIds.has(humanId) && isCardEntry(entry),
  );
}

function parseNativeRecord(value: unknown): AdkPersistenceSnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "messages", "cards"]) ||
    value.version !== NATIVE_RECORD_VERSION ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isAdkMessage)
  ) {
    return null;
  }
  const messages = value.messages as AdkMessage[];
  if (!isSettledHistory(messages) || !isCardDictionary(value.cards, messages)) {
    return null;
  }
  return {
    messages,
    cards: value.cards as Record<string, AdkHistoryCard>,
  };
}

function emptySnapshot(): AdkPersistenceSnapshot {
  return { messages: [], cards: {} };
}

function makeLegacyCardMap(
  messages: readonly ChatMessage[],
): Record<string, AdkHistoryCard> {
  const cards: Record<string, AdkHistoryCard> = {};
  for (let index = 0; index + 1 < messages.length; index += 2) {
    const human = messages[index];
    const assistant = messages[index + 1];
    if (
      human?.role !== "user" ||
      assistant?.role !== "assistant" ||
      assistant.status !== "complete" ||
      !assistant.card
    ) {
      continue;
    }
    cards[human.id] = {
      card: assistant.card,
      ...(assistant.source !== undefined ? { source: assistant.source } : {}),
      ...(assistant.followups !== undefined
        ? { followups: assistant.followups }
        : {}),
    };
  }
  return cards;
}

function legacyToNative(messages: readonly ChatMessage[]): AdkMessage[] {
  const native: AdkMessage[] = [];
  for (let index = 0; index + 1 < messages.length; index += 2) {
    const human = messages[index];
    const assistant = messages[index + 1];
    if (
      human?.role !== "user" ||
      assistant?.role !== "assistant" ||
      assistant.status !== "complete"
    ) {
      continue;
    }
    native.push(
      { id: human.id, type: "human", content: human.text },
      {
        id: assistant.id,
        type: "ai",
        content: assistant.text,
        status: { type: "complete", reason: "stop" },
      },
    );
  }
  return native;
}

function isLegacyV1Record(raw: string): boolean {
  try {
    const value: unknown = JSON.parse(raw);
    return (
      isRecord(value) &&
      value.version === 1 &&
      Array.isArray(value.messages)
    );
  } catch {
    return false;
  }
}

function textContent(content: AdkMessage["content"]): string {
  if (typeof content === "string") return content.trim();
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

export function nativeHistory(
  messages: readonly AdkMessage[],
): { role: "user" | "assistant"; text: string }[] {
  const history: { role: "user" | "assistant"; text: string }[] = [];
  let userText: string | null = null;
  let assistantTexts: string[] = [];
  let lastAssistantComplete = false;

  const flushTurn = () => {
    const assistantText = assistantTexts.join("\n").trim();
    if (userText && lastAssistantComplete && assistantText) {
      history.push(
        { role: "user", text: userText },
        { role: "assistant", text: assistantText },
      );
    }
  };

  for (const message of messages) {
    if (message.type === "human") {
      flushTurn();
      userText = textContent(message.content);
      assistantTexts = [];
      lastAssistantComplete = false;
      continue;
    }
    if (message.type !== "ai" || userText === null) continue;

    const text = textContent(message.content);
    if (message.status?.type === "complete") {
      if (text) assistantTexts.push(text);
      lastAssistantComplete = true;
    } else if (message.status === undefined) {
      if (text) assistantTexts.push(text);
      lastAssistantComplete = false;
    } else {
      lastAssistantComplete = false;
    }
  }
  flushTurn();
  return history;
}

export function createAdkPersistence(
  config: PublicConfig,
  domainId = "solution",
): AdkPersistence {
  const storage = getConversationStorage();
  const legacyKey = conversationStorageKey(config, domainId);
  const nativeKey = `${legacyKey}:${NATIVE_STORAGE_SUFFIX}:${encodeURIComponent(domainId)}`;
  const threadId = `me-demo-adk:${encodeURIComponent(config.id)}:${config.mode}:${encodeURIComponent(domainId)}`;
  let storageUsable = storage !== null;
  let invalidNativeRecord = false;
  let initialized = false;
  let memorySnapshot = emptySnapshot();

  const readNative = (): AdkPersistenceSnapshot | null => {
    if (!storage || !storageUsable) return null;
    let raw: string | null;
    try {
      raw = storage.getItem(nativeKey);
    } catch {
      storageUsable = false;
      return null;
    }
    if (raw === null) {
      invalidNativeRecord = false;
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      invalidNativeRecord = true;
      return null;
    }
    const snapshot = parseNativeRecord(parsed);
    invalidNativeRecord = snapshot === null;
    return snapshot;
  };

  const persist = (snapshot: AdkPersistenceSnapshot): boolean => {
    if (!storage || !storageUsable) return false;
    if (readNative() === null && invalidNativeRecord) return false;
    try {
      const raw = JSON.stringify({
        version: NATIVE_RECORD_VERSION,
        messages: snapshot.messages,
        cards: snapshot.cards,
      });
      storage.setItem(nativeKey, raw);
      invalidNativeRecord = false;
      return true;
    } catch {
      storageUsable = false;
      return false;
    }
  };

  const initialize = (): void => {
    if (initialized) return;
    initialized = true;

    const native = readNative();
    if (native) {
      memorySnapshot = native;
      return;
    }
    if (!storage || !storageUsable || invalidNativeRecord) return;

    let legacyRaw: string | null;
    try {
      legacyRaw = storage.getItem(legacyKey);
    } catch {
      storageUsable = false;
      return;
    }
    if (legacyRaw === null || !isLegacyV1Record(legacyRaw)) {
      return;
    }

    const legacy = loadConversation(storage, legacyKey);
    if (!legacy.available) {
      storageUsable = false;
      return;
    }
    const snapshot: AdkPersistenceSnapshot = {
      messages: legacyToNative(legacy.messages),
      cards: makeLegacyCardMap(legacy.messages),
    };
    if (
      !isSettledHistory(snapshot.messages) ||
      !isCardDictionary(snapshot.cards, snapshot.messages)
    ) {
      return;
    }
    memorySnapshot = snapshot;
    if (snapshot.messages.length > 0) persist(snapshot);
  };

  const read = (): AdkPersistenceSnapshot => {
    initialize();
    return memorySnapshot;
  };

  const write = (snapshot: AdkPersistenceSnapshot): boolean => {
    initialize();
    if (
      !isRecord(snapshot) ||
      !hasExactKeys(snapshot, ["messages", "cards"]) ||
      !Array.isArray(snapshot.messages) ||
      !snapshot.messages.every(isAdkMessage) ||
      !isSettledHistory(snapshot.messages) ||
      !isCardDictionary(snapshot.cards, snapshot.messages)
    ) {
      return false;
    }

    let settled: AdkPersistenceSnapshot;
    try {
      settled = JSON.parse(JSON.stringify(snapshot)) as AdkPersistenceSnapshot;
    } catch {
      return false;
    }
    memorySnapshot = settled;
    return persist(settled);
  };

  const load = async (
    requestedThreadId: string,
    options?: { signal?: AbortSignal },
  ): Promise<AdkThreadSnapshot> => {
    if (requestedThreadId !== threadId) {
      throw new Error(`Unknown ADK thread: ${requestedThreadId}`);
    }
    if (options?.signal?.aborted) {
      throw new DOMException("The ADK thread load was aborted.", "AbortError");
    }
    return { messages: read().messages };
  };

  const clear = (): boolean => {
    memorySnapshot = emptySnapshot();
    initialized = true;
    if (!storage) return false;
    let nativeCleared = false;
    try {
      storage.removeItem(nativeKey);
      nativeCleared = true;
    } catch {
      storageUsable = false;
    }
    const legacyCleared = clearConversationStorage(storage, config);
    if (nativeCleared && legacyCleared) {
      storageUsable = true;
      invalidNativeRecord = false;
      return true;
    }
    return false;
  };

  const threadMetadata = {
    status: "regular" as const,
    remoteId: threadId,
    externalId: threadId,
  };
  const adapter: RemoteThreadListAdapter = {
    async list() {
      return { threads: [threadMetadata] };
    },
    async rename() {},
    async archive() {},
    async delete(remoteId) {
      if (remoteId === threadId) clear();
    },
    async initialize() {
      return { remoteId: threadId, externalId: threadId };
    },
    async generateTitle() {
      return new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    },
    async fetch(requestedThreadId) {
      if (requestedThreadId !== threadId) {
        throw new Error(`Unknown ADK thread: ${requestedThreadId}`);
      }
      return threadMetadata;
    },
  };

  return {
    threadId,
    adapter,
    load,
    read,
    write,
    available: () => {
      if (!storage || !storageUsable) return false;
      readNative();
      return storageUsable && !invalidNativeRecord;
    },
    clear,
  };
}
