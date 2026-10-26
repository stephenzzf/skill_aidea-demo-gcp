import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, PublicConfig } from "../shared/contracts.ts";
import {
  clearConversationStorage,
  completeHistory,
  completeMessages,
  conversationStorageKey,
  createChatMessageId,
  getConversationStorage,
  hasCompleteMessagesChanged,
  loadConversation,
  persistConversation,
  type ConversationStorage,
} from "../client/conversation.ts";

class MemoryStorage implements ConversationStorage {
  readonly values = new Map<string, string>();
  writes = 0;

  get length() {
    return this.values.size;
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.writes += 1;
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
}

const config = {
  id: "demo",
  mode: "test",
  solution: {} as NonNullable<PublicConfig["solution"]>,
} satisfies Pick<PublicConfig, "id" | "mode" | "solution">;

test("new message IDs are unique and independent of array positions", () => {
  const first = createChatMessageId();
  const second = createChatMessageId();
  assert.ok(first.length > 0);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /^me-demo-chat-message-\d+$/u);
});

test("migrates legacy complete messages once and retains their new IDs", () => {
  const storage = new MemoryStorage();
  const key = conversationStorageKey(config, "orders");
  storage.values.set(key, JSON.stringify({
    version: 1,
    messages: [
      { role: "user", text: "旧问题" },
      { role: "assistant", text: "旧回复", status: "complete" },
      { role: "user", text: "未完成问题" },
      { role: "assistant", text: "未完成内容", status: "interrupted" },
    ],
  }));
  let nextId = 0;
  const idFactory = () => `migrated-${++nextId}`;

  const firstLoad = loadConversation(storage, key, idFactory);
  assert.equal(firstLoad.available, true);
  assert.equal(firstLoad.migrated, true);
  assert.deepEqual(firstLoad.messages.map(({ id }) => id), ["migrated-1", "migrated-2"]);
  assert.equal(firstLoad.messages.length, 2);
  assert.equal(storage.writes, 1);

  const secondLoad = loadConversation(storage, key, idFactory);
  assert.equal(secondLoad.migrated, false);
  assert.deepEqual(secondLoad.messages.map(({ id }) => id), ["migrated-1", "migrated-2"]);
  assert.equal(storage.writes, 1);
});

test("replaces old positional IDs during the one-time storage migration", () => {
  const storage = new MemoryStorage();
  const key = conversationStorageKey(config, "orders");
  storage.values.set(key, JSON.stringify({
    version: 1,
    messages: [
      { id: "me-demo-chat-message-0", role: "user", text: "问题" },
      { id: "me-demo-chat-message-1", role: "assistant", text: "回复", status: "complete" },
    ],
  }));

  const loaded = loadConversation(storage, key, (() => {
    let next = 0;
    return () => `stable-${++next}`;
  })());

  assert.equal(loaded.migrated, true);
  assert.deepEqual(loaded.messages.map(({ id }) => id), ["stable-1", "stable-2"]);
});

test("persists only complete user/assistant pairs and ignores streaming fragments", () => {
  const previous: ChatMessage[] = [
    { id: "u-1", role: "user", text: "第一问" },
    { id: "a-1", role: "assistant", text: "第一答", status: "complete" },
  ];
  const duringStream: ChatMessage[] = [
    ...previous,
    { id: "u-2", role: "user", text: "第二问" },
    { id: "a-2", role: "assistant", text: "片段一", status: "running" },
  ];
  const laterStreamFragment: ChatMessage[] = [
    ...previous,
    duringStream[2]!,
    { ...duringStream[3]!, text: "片段一片段二" },
  ];

  assert.equal(
    hasCompleteMessagesChanged(completeMessages(duringStream), completeMessages(laterStreamFragment)),
    false,
  );
  assert.deepEqual(completeHistory(duringStream), [
    { role: "user", text: "第一问" },
    { role: "assistant", text: "第一答" },
  ]);

  const storage = new MemoryStorage();
  const key = conversationStorageKey(config, "orders");
  assert.equal(persistConversation(storage, key, laterStreamFragment), true);
  const saved = JSON.parse(storage.getItem(key)!) as { messages: ChatMessage[] };
  assert.deepEqual(saved.messages.map(({ id }) => id), ["u-1", "a-1"]);
});

test("persists a round only after its assistant message becomes complete", () => {
  const storage = new MemoryStorage();
  const key = conversationStorageKey(config, "orders");
  const complete: ChatMessage[] = [
    { id: "u-1", role: "user", text: "问题" },
    { id: "a-1", role: "assistant", text: "回复", status: "complete" },
  ];
  const incomplete: ChatMessage[] = [
    { id: "u-1", role: "user", text: "问题" },
    { id: "a-1", role: "assistant", text: "中断的回复", status: "interrupted" },
  ];

  assert.equal(persistConversation(storage, key, incomplete), true);
  assert.deepEqual(JSON.parse(storage.getItem(key)!).messages, []);
  assert.equal(persistConversation(storage, key, complete), true);
  assert.deepEqual(JSON.parse(storage.getItem(key)!).messages, complete);
  assert.equal(hasCompleteMessagesChanged([], completeMessages(complete)), true);
});

test("clears every domain conversation for the matching solution demo", () => {
  const storage = new MemoryStorage();
  const base = `me-demo-session:${config.id}:${config.mode}`;
  storage.values.set(`${base}:domain:orders`, "orders");
  storage.values.set(`${base}:domain:solution`, "solution");
  storage.values.set("me-demo-session:other:test:domain:orders", "other");

  assert.equal(clearConversationStorage(storage, config), true);
  assert.deepEqual([...storage.values.keys()], ["me-demo-session:other:test:domain:orders"]);
});

test("treats a throwing sessionStorage getter as unavailable storage", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const key = conversationStorageKey(config, "orders");
  try {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("Storage is blocked", "SecurityError");
      },
    });

    const storage = getConversationStorage();
    assert.equal(storage, null);
    assert.deepEqual(loadConversation(storage, key), {
      messages: [],
      available: false,
      migrated: false,
    });
    assert.equal(persistConversation(storage, key, []), false);
    assert.equal(clearConversationStorage(storage, config), false);
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "sessionStorage", previous);
    } else {
      Reflect.deleteProperty(globalThis, "sessionStorage");
    }
  }
});
