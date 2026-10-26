import type {
  AppendMessage,
  ThreadMessageLike,
} from "@assistant-ui/react";
import type { ChatMessage } from "../shared/contracts.ts";

function nativeStatus(message: ChatMessage): ThreadMessageLike["status"] {
  if (message.role !== "assistant") return undefined;
  switch (message.status) {
    case "running":
      return { type: "running" };
    case "complete":
      return { type: "complete", reason: "stop" };
    case "interrupted":
      return { type: "incomplete", reason: "other" };
    default:
      return undefined;
  }
}

export function toAssistantChatMessage(
  message: ChatMessage,
): ThreadMessageLike {
  const status = nativeStatus(message);
  return {
    id: message.id,
    role: message.role,
    content: message.text ? [{ type: "text", text: message.text }] : [],
    ...(status ? { status } : {}),
    metadata: {
      custom: {
        ...(message.card ? { card: message.card } : {}),
        ...(message.source ? { source: message.source } : {}),
        ...(message.followups ? { followups: message.followups } : {}),
      },
    },
  };
}

export function toAssistantChatMessages(
  messages: readonly ChatMessage[],
): ThreadMessageLike[] {
  return messages.map((message) => toAssistantChatMessage(message));
}

export function textFromAppendMessage(
  message: Pick<AppendMessage, "role" | "content">,
): string | null {
  if (message.role !== "user") return null;
  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
  return text || null;
}
