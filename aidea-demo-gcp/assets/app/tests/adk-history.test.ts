import assert from "node:assert/strict";
import test from "node:test";
import type { AdkMessage } from "@assistant-ui/react-google-adk";
import type { PublicConfig } from "../shared/contracts.ts";
import { conversationStorageKey, type ConversationStorage } from "../client/conversation.ts";
import {
  createAdkPersistence,
  nativeHistory,
  type AdkPersistenceSnapshot,
} from "../client/adk-history.ts";

class MemoryStorage implements ConversationStorage {
  readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
}

const config: PublicConfig = {
  id: "history-demo",
  customer: "Demo customer",
  assistantName: "Demo assistant",
  title: "Demo title",
  subtitle: "Demo subtitle",
  prompts: [],
  mode: "test",
  synthetic: true,
  solution: { goal: "demo" } as NonNullable<PublicConfig["solution"]>,
};

function installSessionStorage(storage: ConversationStorage): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: storage,
  });
  return () => {
    if (previous) {
      Object.defineProperty(globalThis, "sessionStorage", previous);
    } else {
      Reflect.deleteProperty(globalThis, "sessionStorage");
    }
  };
}

function nativeKey(domainId: string) {
  return `${conversationStorageKey(config, domainId)}:adk-history:v1:${encodeURIComponent(domainId)}`;
}

const completeToolTurn: AdkMessage[] = [
  { id: "human-1", type: "human", content: "查询订单" },
  {
    id: "ai-call-1",
    type: "ai",
    content: [{ type: "text", text: "我先查询订单。" }],
    tool_calls: [{ id: "call-1", name: "lookup_order", args: { orderId: "o-1" } }],
  },
  {
    id: "tool-1",
    type: "tool",
    content: "{\"status\":\"shipped\"}",
    tool_call_id: "call-1",
    name: "lookup_order",
    status: "success",
  },
  { id: "ai-step-1", type: "ai", content: [{ type: "text", text: "已找到记录。" }] },
  {
    id: "ai-final-1",
    type: "ai",
    content: [{ type: "text", text: "订单已发货。" }],
    status: { type: "complete", reason: "stop" },
  },
];

const snapshot: AdkPersistenceSnapshot = {
  messages: completeToolTurn,
  cards: {
    "human-1": {
      card: { title: "订单状态", rows: [["状态", "已发货"]] },
      source: "订单记录",
      followups: ["查看物流"],
    },
  },
};

test("exposes one stable local ADK thread and a title stream that emits nothing", async () => {
  const storage = new MemoryStorage();
  const restore = installSessionStorage(storage);
  try {
    const persistence = createAdkPersistence(config, "orders");
    const repeated = createAdkPersistence(config, "orders");
    const otherDomain = createAdkPersistence(config, "inventory");

    assert.equal(persistence.threadId, repeated.threadId);
    assert.notEqual(persistence.threadId, otherDomain.threadId);
    assert.deepEqual(await persistence.adapter.list(), {
      threads: [
        {
          status: "regular",
          remoteId: persistence.threadId,
          externalId: persistence.threadId,
        },
      ],
    });
    assert.deepEqual(await persistence.adapter.initialize("ephemeral"), {
      remoteId: persistence.threadId,
      externalId: persistence.threadId,
    });
    assert.equal((await persistence.adapter.fetch(persistence.threadId)).remoteId, persistence.threadId);
    await assert.rejects(persistence.adapter.fetch("other-thread"), /Unknown ADK thread/u);

    const titleStream = await persistence.adapter.generateTitle(persistence.threadId, []);
    assert.equal((await titleStream.getReader().read()).done, true);
  } finally {
    restore();
  }
});

test("round-trips strict native messages and loads them through the ADK snapshot", async () => {
  const storage = new MemoryStorage();
  const restore = installSessionStorage(storage);
  try {
    const persistence = createAdkPersistence(config, "orders");
    assert.equal(persistence.write(snapshot), true);
    assert.deepEqual(persistence.read(), snapshot);
    assert.deepEqual(await persistence.load(persistence.threadId), {
      messages: completeToolTurn,
    });
    assert.equal(persistence.available(), true);
    assert.ok(storage.getItem(nativeKey("orders")));
  } finally {
    restore();
  }
});

test("migrates complete legacy chat pairs while keeping their cards and old key", () => {
  const storage = new MemoryStorage();
  const restore = installSessionStorage(storage);
  try {
    const oldKey = conversationStorageKey(config, "orders");
    storage.setItem(
      oldKey,
      JSON.stringify({
        version: 1,
        messages: [
          {
            id: "legacy-user",
            role: "user",
            text: "旧问题",
          },
          {
            id: "legacy-assistant",
            role: "assistant",
            text: "旧回复",
            status: "complete",
            card: { title: "旧卡片", rows: [["项目", "保留"]] },
            source: "旧来源",
            followups: ["旧追问"],
          },
          { id: "pending-user", role: "user", text: "未完成问题" },
          {
            id: "pending-assistant",
            role: "assistant",
            text: "中断内容",
            status: "interrupted",
          },
        ],
      }),
    );

    const persistence = createAdkPersistence(config, "orders");
    const migrated = persistence.read();
    assert.deepEqual(migrated.messages, [
      { id: "legacy-user", type: "human", content: "旧问题" },
      {
        id: "legacy-assistant",
        type: "ai",
        content: "旧回复",
        status: { type: "complete", reason: "stop" },
      },
    ]);
    assert.deepEqual(migrated.cards, {
      "legacy-user": {
        card: { title: "旧卡片", rows: [["项目", "保留"]] },
        source: "旧来源",
        followups: ["旧追问"],
      },
    });
    assert.ok(storage.getItem(oldKey));
    assert.ok(storage.getItem(nativeKey("orders")));
  } finally {
    restore();
  }
});

test("rejects unknown, malformed, duplicated, or unsettled native records without overwriting them", () => {
  const malformedRecords: unknown[] = [
    { version: 2, messages: completeToolTurn, cards: {} },
    {
      version: 1,
      messages: [
        { id: "h", type: "system", content: "unknown role" },
        { id: "a", type: "ai", content: "reply", status: { type: "complete", reason: "stop" } },
      ],
      cards: {},
    },
    {
      version: 1,
      messages: [
        { id: "h", type: "human", content: "question" },
        { id: "h", type: "ai", content: "reply", status: { type: "complete", reason: "stop" } },
      ],
      cards: {},
    },
    {
      version: 1,
      messages: [
        { id: "h", type: "human", content: [{ type: "unknown", value: "bad" }] },
        { id: "a", type: "ai", content: "reply", status: { type: "complete", reason: "stop" } },
      ],
      cards: {},
    },
    {
      version: 1,
      messages: [
        { id: "h", type: "human", content: "question" },
        { id: "a", type: "ai", content: [{ type: "reasoning", text: "not stored", thoughtSignature: "private" }], status: { type: "complete", reason: "stop" } },
      ],
      cards: {},
    },
    {
      version: 1,
      messages: [
        { id: "h", type: "human", content: "question" },
        { id: "a", type: "ai", content: "partial", status: { type: "incomplete", reason: "other" } },
      ],
      cards: {},
    },
    {
      version: 1,
      messages: [
        { id: "h", type: "human", content: "question" },
        { id: "a", type: "ai", content: "call", tool_calls: [{ id: "call", name: "lookup", args: {} }] },
      ],
      cards: {},
    },
  ];

  for (const malformed of malformedRecords) {
    const storage = new MemoryStorage();
    const restore = installSessionStorage(storage);
    try {
      const raw = JSON.stringify(malformed);
      storage.setItem(nativeKey("orders"), raw);
      const persistence = createAdkPersistence(config, "orders");

      assert.deepEqual(persistence.read(), { messages: [], cards: {} });
      assert.equal(persistence.available(), false);
      assert.equal(persistence.write(snapshot), false);
      assert.equal(storage.getItem(nativeKey("orders")), raw);
    } finally {
      restore();
    }
  }
});

test("exports only complete plain-text user/assistant turns and folds tool calls", () => {
  const messages: AdkMessage[] = [
    ...completeToolTurn.slice(0, 4),
    {
      id: "ai-final-1",
      type: "ai",
      content: [
        { type: "reasoning", text: "不要发送这段思考。" },
        { type: "text", text: "订单已发货。" },
      ],
      status: { type: "complete", reason: "stop" },
    },
    { id: "human-2", type: "human", content: "第二问" },
    {
      id: "ai-partial-2",
      type: "ai",
      content: [{ type: "text", text: "未完成的第二答" }],
      status: { type: "incomplete", reason: "cancelled" },
    },
  ];

  assert.deepEqual(nativeHistory(messages), [
    { role: "user", text: "查询订单" },
    { role: "assistant", text: "我先查询订单。\n已找到记录。\n订单已发货。" },
  ]);
});

test("clear removes the new native record and legacy conversations for the demo", () => {
  const storage = new MemoryStorage();
  const restore = installSessionStorage(storage);
  try {
    const persistence = createAdkPersistence(config, "orders");
    const oldKey = conversationStorageKey(config, "orders");
    storage.setItem(oldKey, "legacy");
    storage.setItem(nativeKey("orders"), "native");
    storage.setItem(conversationStorageKey(config, "inventory"), "other-domain");
    storage.setItem("me-demo-session:other-demo:test:domain:orders", "other-demo");

    assert.equal(persistence.clear(), true);
    assert.equal(storage.getItem(oldKey), null);
    assert.equal(storage.getItem(nativeKey("orders")), null);
    assert.equal(storage.getItem(conversationStorageKey(config, "inventory")), null);
    assert.equal(storage.getItem("me-demo-session:other-demo:test:domain:orders"), "other-demo");
  } finally {
    restore();
  }
});

test("keeps settled rounds in memory when a throwing sessionStorage getter disables persistence", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  try {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("Storage is blocked", "SecurityError");
      },
    });
    const persistence = createAdkPersistence(config, "orders");

    assert.equal(persistence.available(), false);
    assert.deepEqual(persistence.read(), { messages: [], cards: {} });
    assert.equal(persistence.write(snapshot), false);
    assert.deepEqual(persistence.read(), snapshot);

    const continued: AdkPersistenceSnapshot = {
      messages: [
        ...snapshot.messages,
        { id: "human-2", type: "human", content: "继续追问" },
        {
          id: "ai-2",
          type: "ai",
          content: "第二轮回答",
          status: { type: "complete", reason: "stop" },
        },
      ],
      cards: snapshot.cards,
    };
    assert.equal(persistence.write(continued), false);
    assert.deepEqual(persistence.read(), continued);
    assert.deepEqual(await persistence.load(persistence.threadId), {
      messages: continued.messages,
    });
    assert.equal(persistence.available(), false);
    assert.equal(persistence.clear(), false);
    assert.deepEqual(persistence.read(), { messages: [], cards: {} });
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "sessionStorage", previous);
    } else {
      Reflect.deleteProperty(globalThis, "sessionStorage");
    }
  }
});

 test("restores public assistant summaries but never sends them in model history", () => {
  const restore = installSessionStorage(new MemoryStorage());
  try {
    const persistence = createAdkPersistence(config, "orders");
    const messages: AdkMessage[] = [
      { id: "h-summary", type: "human", content: "question" },
      { id: "a-summary", type: "ai", content: [{type:"reasoning",text:"public summary"},{type:"text",text:"answer"}], status:{type:"complete",reason:"stop"} },
    ];
    assert.equal(persistence.write({messages,cards:{}}), true);
    assert.deepEqual(persistence.read().messages, messages);
    assert.equal(JSON.stringify(nativeHistory(persistence.read().messages)).includes("public summary"), false);
  } finally { restore(); }
});
