import type { WorkspaceChatContext } from "../shared/contracts.ts";

export interface SplitLayoutState { chatPercent: number; collapsed: boolean; mobileView: "chat" | "demo" }
export const DEFAULT_SPLIT_LAYOUT: SplitLayoutState = { chatPercent: 35, collapsed: false, mobileView: "demo" };
export function readSplitLayout(storage: Pick<Storage, "getItem"> | undefined, key: string): SplitLayoutState {
  try {
    const value: unknown = JSON.parse(storage?.getItem(key) ?? "null");
    if (!value || typeof value !== "object") return { ...DEFAULT_SPLIT_LAYOUT };
    const item = value as Record<string, unknown>;
    return {
      chatPercent: typeof item.chatPercent === "number" && Number.isFinite(item.chatPercent) && item.chatPercent >= 1 && item.chatPercent <= 50 ? item.chatPercent : 35,
      collapsed: item.collapsed === true,
      mobileView: item.mobileView === "chat" ? "chat" : "demo",
    };
  } catch { return { ...DEFAULT_SPLIT_LAYOUT }; }
}
export function describeChatScope(context: WorkspaceChatContext | undefined): string {
  if (!context || context.domainId === "solution") return "全方案问答 · 只读分析";
  const parts: string[] = [];
  if (context.query?.dataset) parts.push(`数据集：${context.query.dataset}`);
  if (context.query?.filters?.length) parts.push(`${context.query.filters.length} 项筛选`);
  if (context.query?.from || context.query?.to) parts.push("已限定日期范围");
  if (context.selectedRecord) parts.push(`记录：${context.selectedRecord.id}`);
  return parts.length ? parts.join(" · ") : "当前领域 · 未选中记录";
}

/** Initial discovery must not erase extension data published by its Provider. */
export function shouldClearExtensionContext(previousDomain: string | undefined, nextDomain: string): boolean {
  return previousDomain !== undefined && previousDomain !== nextDomain;
}
