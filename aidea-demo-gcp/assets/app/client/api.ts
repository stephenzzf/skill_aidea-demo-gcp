import type {
  PublicConfig,
  StreamEvent,
  WorkspaceChatContext,
} from "../shared/contracts.ts";
import { streamEventSchema } from "../shared/contracts.ts";

export class ApiRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

async function requestError(response: Response) {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
    ) {
      return body.error;
    }
  } catch {
    // A non-JSON response still gets a useful, bounded message.
  }
  return "请求未能完成，请重试。";
}

export async function loadPublicConfig() {
  const response = await fetch("/api/config", { credentials: "same-origin" });
  if (!response.ok) {
    throw new ApiRequestError(await requestError(response), response.status);
  }
  return (await response.json()) as PublicConfig;
}

export async function redeemAccessCode(code: string) {
  const response = await fetch("/api/access", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) {
    throw new ApiRequestError(await requestError(response), response.status);
  }
}

function parseEvent(value: unknown): StreamEvent | null {
  const parsed = streamEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function streamReply(
  message: string,
  history: Array<{ role: "user" | "assistant"; text: string }>,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
  context?: WorkspaceChatContext,
) {
  const response = await fetch("/api/chat", {
    method: "POST",
    credentials: "same-origin",
    signal,
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ message, history, ...(context ? { context } : {}) }),
  });
  if (!response.ok) {
    throw new ApiRequestError(await requestError(response), response.status);
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("服务端没有开启流式响应。" );
  }
  if (!response.body) throw new Error("服务端未返回流式内容。" );

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  let serverError = "";

  const consumeFrame = (frame: string) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return;
    let event: StreamEvent | null;
    try {
      event = parseEvent(JSON.parse(data));
    } catch {
      throw new Error("服务端返回了无法读取的演示内容。" );
    }
    if (!event) throw new Error("服务端返回了不支持的演示事件。" );
    onEvent(event);
    if (event.type === "error") {
      serverError = event.message;
      throw new Error(serverError);
    }
    if (event.type === "done") finished = true;
  };

  try {
    while (!finished) {
      if (signal.aborted) throw new DOMException("请求已停止。", "AbortError");
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let separator = /\r?\n\r?\n/.exec(buffer);
      while (separator && !finished) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        consumeFrame(frame);
        separator = /\r?\n\r?\n/.exec(buffer);
      }
      if (done) break;
    }
    if (!finished && buffer.trim()) consumeFrame(buffer);
    if (!finished) throw new Error("连接提前结束，当前回复尚未完成。" );
    if (serverError) throw new Error(serverError);
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
