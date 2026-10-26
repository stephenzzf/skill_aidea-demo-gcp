import assert from "node:assert/strict";
import test from "node:test";
import {
  chatInteractionsStorageKey,
  createChatInteractionStore,
  createPendingComposerDraft,
  serializeQuotedPrompt,
} from "../client/chat-interactions.ts";

const config = { id: "interaction-fixture", mode: "vertex" } as const;

function fakeStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test("quoted reply is sent as clearly marked ordinary user text", () => {
  assert.equal(serializeQuotedPrompt("请解释这一点", {
    messageId: "reply-1",
    text: "第一行\n第二行",
  }), "请解释这一点\n\n引用的对话内容（作为用户提供的上下文）：\n> 第一行\n> 第二行");
  assert.equal(serializeQuotedPrompt("  普通追问  "), "普通追问");
  assert.equal(serializeQuotedPrompt("追问", { text: "  " }), "追问");
});

test("accepted composer drafts remain recoverable until stream terminal events", () => {
  const pending = createPendingComposerDraft();
  const draft = { text: "解释这段内容", quote: { messageId: "answer-1", text: "引用内容" } };
  pending.begin(draft);

  // The runtime append call returns immediately; no settle event has occurred.
  let restored: typeof draft | undefined;
  assert.equal(pending.restoreIfEmpty("", value => { restored = value as typeof draft; }), true);
  assert.deepEqual(restored, draft);

  pending.begin(draft);
  assert.equal(pending.restoreIfEmpty("用户已开始输入的新草稿", () => assert.fail("must not replace user edits")), false);
  assert.equal(pending.restoreIfEmpty("", () => assert.fail("failed draft must not be restored twice")), false);

  pending.begin(draft);
  pending.settle();
  assert.equal(pending.restoreIfEmpty("", () => assert.fail("settled draft must not return")), false);
});

test("feedback adapter persists only a message rating and can replace it", () => {
  const storage = fakeStorage();
  const store = createChatInteractionStore(config, () => storage);
  let changes = 0;
  const adapter = store.feedbackAdapter(() => { changes++; });
  const message = { id: "assistant-1", role: "assistant" } as Parameters<typeof adapter.submit>[0]["message"];
  adapter.submit({ message, type: "positive" });
  adapter.submit({ message, type: "negative" });

  assert.deepEqual(store.read(), { "assistant-1": "negative" });
  assert.equal(changes, 2);
  assert.deepEqual(JSON.parse(storage.values.get(chatInteractionsStorageKey(config))!), {
    version: 1,
    feedbackByMessageId: { "assistant-1": "negative" },
  });
});

test("feedback restores from session storage and reset clears memory and storage", () => {
  const storage = fakeStorage();
  const first = createChatInteractionStore(config, () => storage);
  first.setFeedback("assistant-2", "positive");

  // A newly initialized instance hydrates the versioned browser session record.
  assert.deepEqual(createChatInteractionStore(config, () => storage).read(), { "assistant-2": "positive" });
  first.clear();
  assert.equal(storage.values.has(chatInteractionsStorageKey(config)), false);
  assert.deepEqual(first.read(), {});
});

test("blocked storage remains usable in memory and reports clear failure", () => {
  const blocked = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  const store = createChatInteractionStore({ id: "blocked-interaction-fixture", mode: "vertex" }, () => blocked);
  store.setFeedback("assistant-3", "negative");
  assert.deepEqual(store.read(), { "assistant-3": "negative" });
  assert.equal(store.clear(), false);
  assert.deepEqual(store.read(), {});
});
