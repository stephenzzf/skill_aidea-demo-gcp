import type { DomainPage } from "../shared/solution.ts";
import type { ActionEvent, ActionTransition, DataRow, WorkspaceDefinition, WorkspaceState } from "../shared/workspace.ts";

export interface WorkspaceRecordResult {
  dataset: string;
  record: DataRow;
  revision: number;
  source: string;
}

export interface ActionReceiptEvent {
  event: ActionEvent;
  transition: ActionTransition;
  revision: number;
}

function object(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function parseToolResult(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { return object(JSON.parse(value)); } catch { return null; }
  }
  return object(value);
}

export function parseWorkspaceRecordResult(value: unknown, args: unknown, definition: WorkspaceDefinition): WorkspaceRecordResult | null {
  const result = parseToolResult(value);
  const input = object(args);
  if (!result || !input || result.scope !== "current" || typeof result.dataset !== "string" ||
    result.dataset !== input.dataset || typeof input.id !== "string" || !Number.isSafeInteger(result.revision) ||
    (result.revision as number) < 0 || typeof result.source !== "string") return null;
  const dataset = definition.datasets.find(item => item.id === result.dataset);
  const record = object(result.record);
  if (!dataset || !record || String(record[dataset.key]) !== input.id) return null;
  for (const value of Object.values(record)) {
    if (!(value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")) return null;
  }
  return { dataset: dataset.id, record: record as DataRow, revision: result.revision as number, source: result.source };
}

export function isAnalysisToolResult(value: unknown): boolean {
  const result = parseToolResult(value);
  if (!result || !Array.isArray(result.metrics) || !Array.isArray(result.sources)) return false;
  return result.metrics.every(item => {
    const metric = object(item);
    return Boolean(metric && typeof metric.id === "string" && typeof metric.label === "string" &&
      typeof metric.dataset === "string" && (metric.value === null || typeof metric.value === "number"));
  }) && result.sources.every(item => {
    const source = object(item);
    return Boolean(source && typeof source.id === "string" && typeof source.source === "string");
  });
}

export function allowedRecordActions(
  datasetId: string,
  record: DataRow,
  definition: WorkspaceDefinition,
  pages: readonly DomainPage[],
): Array<{ page: DomainPage; transition: ActionTransition }> {
  const workflow = definition.workflow;
  if (!workflow || workflow.dataset !== datasetId) return [];
  const status = record[workflow.statusField];
  if (typeof status !== "string") return [];
  return pages.flatMap(page => {
    if (!page.datasets.includes(datasetId) || !page.components.includes("workflow")) return [];
    return workflow.transitions
      .filter(transition => page.actions.includes(transition.id) && transition.from.includes(status) &&
        (!transition.requireFresh || record[workflow.staleField ?? "__stale"] !== true))
      .map(transition => ({ page, transition }));
  });
}

/** A persisted event is a receipt only when it occurred after the read-only tool snapshot. */
export function findActionReceipt(
  state: WorkspaceState,
  datasetId: string,
  record: DataRow,
  definition: WorkspaceDefinition,
  snapshotRevision: number,
): ActionReceiptEvent | null {
  const workflow = definition.workflow;
  if (!workflow || workflow.dataset !== datasetId || !Number.isSafeInteger(snapshotRevision) || snapshotRevision < 0) return null;
  const recordId = String(record[definition.datasets.find(item => item.id === datasetId)?.key ?? ""]);
  const transitions = new Map(workflow.transitions.map(transition => [transition.id, transition]));
  for (let index = state.events.length - 1; index >= snapshotRevision; index -= 1) {
    const event = state.events[index];
    const transition = transitions.get(event.actionId);
    if (event.recordId === recordId && transition) return { event, transition, revision: index + 1 };
  }
  return null;
}

export function chatActionUnknownKey(config: { id: string; mode: string }, dataset: string, recordId: string): string {
  return `me-demo-chat-action-unknown:${config.id}:${config.mode}:${encodeURIComponent(dataset)}:${encodeURIComponent(recordId)}`;
}
