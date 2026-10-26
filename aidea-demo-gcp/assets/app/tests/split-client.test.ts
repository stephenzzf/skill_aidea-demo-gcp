import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SPLIT_LAYOUT, describeChatScope, readSplitLayout, shouldClearExtensionContext } from "../client/split-layout.ts";
import { createMeAdkStream } from "../client/adk-transport.ts";
import type { WorkspaceChatContext } from "../shared/contracts.ts";
import type { AdkStreamCallback } from "@assistant-ui/react-google-adk";
import type { createAdkPersistence } from "../client/adk-history.ts";

test("split layout tolerates unavailable and invalid browser storage while restoring valid session preferences", () => {
  assert.deepEqual(readSplitLayout(undefined, "demo"), DEFAULT_SPLIT_LAYOUT);
  assert.deepEqual(readSplitLayout({ getItem: () => { throw new Error("storage disabled"); } }, "demo"), DEFAULT_SPLIT_LAYOUT);
  assert.deepEqual(readSplitLayout({ getItem: () => JSON.stringify({ chatPercent: 70, collapsed: true, mobileView: "unexpected" }) }, "demo"), { chatPercent: 35, collapsed: true, mobileView: "demo" });
  assert.deepEqual(readSplitLayout({ getItem: key => key === "one" ? '{"chatPercent":42,"collapsed":true,"mobileView":"chat"}' : null }, "one"), { chatPercent: 42, collapsed: true, mobileView: "chat" });
});

test("chat scope labels distinguish overview from filtered business records", () => {
  assert.equal(describeChatScope(undefined), "全方案问答 · 只读分析");
  assert.equal(describeChatScope({ domainId: "solution", query: {}, state: { revision: 0, events: [] } }), "全方案问答 · 只读分析");
  assert.match(describeChatScope({ domainId: "service", query: { from: "2026-10-01", filters: [{ field: "status", op: "eq", value: "new" }] }, selectedRecord: { dataset: "cases", id: "case-2" }, state: { revision: 0, events: [] } }), /1 项筛选.*日期范围.*case-2/);
});

test("an in-flight stream retains the submitted domain, filters and state when the workspace changes", async () => {
  const original: WorkspaceChatContext = { domainId: "service", query: { filters: [{ field: "status", op: "eq", value: "new" }] }, selectedRecord: { dataset: "cases", id: "case-2" }, state: { revision: 0, events: [] } };
  let context = original;
  let writes = 0;
  const persistence = { read: () => ({ messages: [], cards: {} }), write: () => { writes++; return true; } } as unknown as ReturnType<typeof createAdkPersistence>;
  const transport: AdkStreamCallback = async function* (_messages, config) {
    original.query.filters![0]!.value = "closed";
    original.state.revision = 1;
    context = { domainId: "solution", query: {}, state: { revision: 5, events: [] } };
    const snapshot = config.stateDelta?.context as WorkspaceChatContext;
    assert.equal(snapshot.domainId, "service");
    assert.equal(snapshot.selectedRecord?.id, "case-2");
    assert.equal(snapshot.query.filters?.[0]?.value, "new");
    assert.equal(snapshot.state.revision, 0);
    yield { id: "terminal", customMetadata: { meDemoTerminal: { version: 1, status: "complete" } } };
  };
  const stream = createMeAdkStream(persistence, () => context, () => {}, transport);
  const controller = new AbortController();
  for await (const _event of await stream([{ id: "q", type: "human", content: "核对当前记录" }], { abortSignal: controller.signal, initialize: async () => ({ remoteId: "local", externalId: "local" }) })) { /* Consume the real adapter boundary. */ }
  assert.equal(writes, 1);
});


test("real domain transitions clear extension context even when both pages use overview chat scope", () => {
  assert.equal(shouldClearExtensionContext(undefined, "extension-a"), false, "initial Provider context survives first route discovery");
  assert.equal(shouldClearExtensionContext("extension-a", "extension-a"), false, "same-page filter or record changes retain extension context");
  assert.equal(shouldClearExtensionContext("extension-a", "extension-b"), true);
  assert.equal(shouldClearExtensionContext("extension-b", "solution"), true);
  assert.equal(shouldClearExtensionContext("solution", "extension-a"), true);
});
