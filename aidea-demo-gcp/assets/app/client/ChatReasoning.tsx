import { useContext, useEffect } from "react";
import { ChainOfThoughtPrimitive, useAui, useAuiState, type PartState, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { IconAlertCircle, IconCheck, IconChevronDown, IconLoader2, IconSparkles, IconX } from "@tabler/icons-react";
import { canRenderChatBusinessTool, ChatBusinessContext, ChatBusinessTool } from "./ChatBusinessCards.tsx";
import { MarkdownText } from "./MarkdownText.tsx";
import { ChatToolProcessStep, ToolCallResult } from "./ChatTools.tsx";
import type { WorkspaceDefinition } from "../shared/workspace.ts";

function isBusinessTool(part: PartState): part is Extract<PartState, { type: "tool-call" }> {
  return part.type === "tool-call" && (part.toolName === "analyze_workspace" || part.toolName === "get_workspace_record");
}

function ProcessPart({ part, definition }: { part: PartState; definition?: WorkspaceDefinition }) {
  if (part.type === "reasoning") {
    return <div className="chat-reasoning-summary"><div className="chat-reasoning-label"><IconSparkles size={14} />AI 思考摘要</div><MarkdownText /></div>;
  }
  if (part.type !== "tool-call") return null;

  const toolPart = part as ToolCallMessagePartProps;
  if (isBusinessTool(part) && canRenderChatBusinessTool(toolPart, definition)) {
    return <div className="chat-process-business"><ChatToolProcessStep part={toolPart} /><ChatBusinessTool part={toolPart} /></div>;
  }
  return <ToolCallResult part={toolPart} />;
}

/** assistant-ui's official chain groups provider reasoning summaries and actual tool calls. */
export function ChatChainOfThought() {
  const aui = useAui();
  const businessContext = useContext(ChatBusinessContext);
  const parts = useAuiState(state => state.chainOfThought.parts);
  const status = useAuiState(state => state.chainOfThought.status);
  const collapsed = useAuiState(state => state.chainOfThought.collapsed);
  const hasBusinessTool = parts.some(part => part.type === "tool-call" && (part.toolName === "analyze_workspace" || part.toolName === "get_workspace_record"));
  const toolCount = parts.filter(part => part.type === "tool-call").length;
  const reasoningCount = parts.filter(part => part.type === "reasoning").length;
  const cancelled = (status.type === "incomplete" && status.reason === "cancelled") || parts.some(part => part.type === "tool-call" && part.status.type === "incomplete" && part.status.reason === "cancelled");
  const failed = (status.type === "incomplete" && status.reason !== "cancelled") || parts.some(part => part.type === "tool-call" && (part.isError || (part.status.type === "incomplete" && part.status.reason !== "cancelled")));
  const active = status.type === "running" || parts.some(part => part.status.type === "running");

  useEffect(() => {
    if (active || hasBusinessTool) aui.chainOfThought.setCollapsed(false);
  }, [active, aui.chainOfThought, hasBusinessTool]);

  const label = cancelled ? "执行过程已取消" : failed ? "执行过程未完成"
    : active ? toolCount ? `正在调用工具 · ${toolCount} 项` : "正在整理思考摘要"
      : toolCount ? `查看执行过程 · ${toolCount} 项工具调用` : `查看 AI 思考摘要 · ${reasoningCount} 段`;
  const StatusIcon = cancelled ? IconX : failed ? IconAlertCircle : active ? IconLoader2 : toolCount ? IconCheck : IconSparkles;
  return (
    <ChainOfThoughtPrimitive.Root className={`chat-chain-of-thought${active ? " is-running" : ""}${failed ? " is-failed" : ""}${cancelled ? " is-cancelled" : ""}`}>
      <ChainOfThoughtPrimitive.AccordionTrigger className="chat-chain-trigger" aria-label={label} aria-expanded={!collapsed} data-state={collapsed ? "closed" : "open"}>
        <StatusIcon className={active ? "chat-tool-spin" : ""} size={15} />
        <span>{label}</span>
        <IconChevronDown className={`chat-chain-chevron${collapsed ? "" : " is-open"}`} size={15} />
      </ChainOfThoughtPrimitive.AccordionTrigger>
      <div className="chat-chain-parts" hidden={collapsed}>
        <ChainOfThoughtPrimitive.Parts>{({ part }) => <ProcessPart part={part} definition={businessContext?.definition} />}</ChainOfThoughtPrimitive.Parts>
      </div>
    </ChainOfThoughtPrimitive.Root>
  );
}
