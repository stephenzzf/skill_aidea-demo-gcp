import assert from "node:assert/strict";
import test from "node:test";
import type { AppendMessage } from "@assistant-ui/react";
import type { ChatMessage } from "../shared/contracts.ts";
import {
  textFromAppendMessage,
  toAssistantChatMessages,
} from "../client/chat-adapter.ts";

test("adapts persistent IDs and keeps assistant-owned card metadata", () => {
  const messages: ChatMessage[] = [
    { id: "user-stable-id", role: "user", text: "问题 <b>保持原文</b>" },
    {
      id: "assistant-stable-id",
      role: "assistant",
      text: "纯文本回复",
      status: "complete",
      card: { title: "摘要", rows: [["状态", "已验证"]] },
      source: "演示资料",
      followups: ["继续查看"],
    },
  ];

  const adapted = toAssistantChatMessages(messages);

  assert.deepEqual(adapted[0], {
    id: "user-stable-id",
    role: "user",
    content: [{ type: "text", text: "问题 <b>保持原文</b>" }],
    metadata: { custom: {} },
  });
  assert.deepEqual(adapted[1], {
    id: "assistant-stable-id",
    role: "assistant",
    content: [{ type: "text", text: "纯文本回复" }],
    status: { type: "complete", reason: "stop" },
    metadata: {
      custom: {
        card: { title: "摘要", rows: [["状态", "已验证"]] },
        source: "演示资料",
        followups: ["继续查看"],
      },
    },
  });
  assert.notEqual(adapted[0].id, adapted[1].id);
});

test("maps all assistant response states to assistant-ui native statuses", () => {
  const [running, complete, interrupted] = toAssistantChatMessages([
    { id: "running", role: "assistant", text: "正在生成", status: "running" },
    { id: "complete", role: "assistant", text: "已完成", status: "complete" },
    { id: "interrupted", role: "assistant", text: "未完成", status: "interrupted" },
  ]);

  assert.deepEqual(running.status, { type: "running" });
  assert.deepEqual(complete.status, { type: "complete", reason: "stop" });
  assert.deepEqual(interrupted.status, { type: "incomplete", reason: "other" });
  assert.deepEqual(interrupted.content, [{ type: "text", text: "未完成" }]);
});

test("accepts only non-empty user text from assistant-ui composer messages", () => {
  const withOtherContent = {
    role: "user",
    content: [
      { type: "text", text: "第一行" },
      { type: "image", image: "ignored" },
      { type: "text", text: "第二行" },
    ],
  } as unknown as Pick<AppendMessage, "role" | "content">;

  assert.equal(textFromAppendMessage(withOtherContent), "第一行\n第二行");
  assert.equal(
    textFromAppendMessage({ role: "user", content: [] }),
    null,
  );
  assert.equal(
    textFromAppendMessage({
      role: "assistant",
      content: [{ type: "text", text: "not a user prompt" }],
    }),
    null,
  );
});
