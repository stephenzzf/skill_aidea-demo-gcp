import test from "node:test";
import assert from "node:assert/strict";
import { allowedRecordActions, findActionReceipt, isAnalysisToolResult, parseWorkspaceRecordResult } from "../client/ChatBusinessModel.ts";
import type { DomainPage } from "../shared/solution.ts";
import type { WorkspaceDefinition, WorkspaceState } from "../shared/workspace.ts";

const definition: WorkspaceDefinition = {
  views: ["records", "workflow"], roles: [{ id: "staff", label: "业务人员" }],
  stages: [{ id: "new", label: "新建" }, { id: "done", label: "已完成" }],
  datasets: [{ id: "cases", label: "服务案例", key: "caseId", origin: "synthetic", source: "固定种子",
    fields: [{ id: "caseId", label: "编号", type: "string" }, { id: "status", label: "状态", type: "string" }, { id: "stale", label: "需复核", type: "boolean" }] }],
  metrics: [], workflow: { dataset: "cases", statusField: "status", staleField: "stale", transitions: [
    { id: "complete", label: "完成处理", role: "staff", from: ["new"], to: "done", requireFresh: true },
    { id: "close", label: "结束受理", role: "staff", from: ["new"], to: "done" },
  ] },
};
const page: DomainPage = { id: "service", title: "服务受理", goal: "处理服务记录", datasets: ["cases"], metrics: [],
  actions: ["complete", "close"], components: ["records", "workflow"], claimIds: [], links: [] };
const record = { caseId: "case-1", status: "new", stale: false };

test("record result must match requested dataset, primary key and scalar schema", () => {
  const valid = { dataset: "cases", record, scope: "current", revision: 0, source: "固定种子" };
  assert.deepEqual(parseWorkspaceRecordResult(JSON.stringify(valid), { dataset: "cases", id: "case-1" }, definition), {
    dataset: "cases", record, revision: 0, source: "固定种子",
  });
  assert.equal(parseWorkspaceRecordResult(valid, { dataset: "cases", id: "case-2" }, definition), null);
  assert.equal(parseWorkspaceRecordResult({ ...valid, dataset: "other" }, { dataset: "cases", id: "case-1" }, definition), null);
  assert.equal(parseWorkspaceRecordResult({ ...valid, scope: "snapshot" }, { dataset: "cases", id: "case-1" }, definition), null);
  assert.equal(parseWorkspaceRecordResult({ ...valid, record: { ...record, nested: { unsafe: true } } }, { dataset: "cases", id: "case-1" }, definition), null);
});

test("analysis summary requires a structured metric and source list", () => {
  assert.equal(isAnalysisToolResult({ metrics: [{ id: "open", label: "未结", dataset: "cases", value: 1 }], sources: [{ id: "cases", source: "固定种子" }] }), true);
  assert.equal(isAnalysisToolResult({ metrics: [{ label: "未结" }], sources: [] }), false);
  assert.equal(isAnalysisToolResult("{broken"), false);
});

test("actions follow configured page scope, record state and freshness requirement", () => {
  assert.deepEqual(allowedRecordActions("cases", record, definition, [page]).map(item => item.transition.id), ["complete", "close"]);
  assert.deepEqual(allowedRecordActions("other", record, definition, [page]), []);
  assert.deepEqual(allowedRecordActions("cases", { ...record, stale: true }, definition, [page]).map(item => item.transition.id), ["close"]);
  assert.deepEqual(allowedRecordActions("cases", { ...record, status: "done" }, definition, [page]), []);
  assert.deepEqual(allowedRecordActions("cases", record, definition, [{ ...page, actions: ["close"] }]).map(item => item.transition.id), ["close"]);
});

test("only action events after the record snapshot render as an action receipt", () => {
  const state: WorkspaceState = { revision: 2, events: [
    { requestId: "older", recordId: "case-1", actionId: "close", role: "staff", input: {}, at: "2026-10-25T00:00:00.000Z" },
    { requestId: "other", recordId: "case-2", actionId: "close", role: "staff", input: {}, at: "2026-10-25T00:01:00.000Z" },
  ] };
  assert.equal(findActionReceipt(state, "cases", record, definition, 1), null);
  const receipt = findActionReceipt(state, "cases", record, definition, 0);
  assert.equal(receipt?.event.requestId, "older");
  assert.equal(receipt?.revision, 1);
});
