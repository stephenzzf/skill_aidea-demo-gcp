import { randomUUID } from 'node:crypto';
import type { Event } from '@google/adk';

const sensitiveKey = /(?:secret|credential|token|password|authorization|api.?key|private.?key|access.?key)/i;

export type NativeAdkEvent = {
  id: string;
  invocationId?: string;
  author?: string;
  partial?: boolean;
  turnComplete?: boolean;
  interrupted?: boolean;
  finishReason?: string;
  timestamp?: number;
  content?: { role?: string; parts?: Array<Record<string, unknown>> };
  errorCode?: string;
  errorMessage?: string;
  customMetadata?: Record<string, unknown>;
};

function redactSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveFields);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => !sensitiveKey.test(key))
    .map(([key, child]) => [key, redactSensitiveFields(child)]));
}

/** Project Runner events onto public text, provider thought summaries, and read-only tools. */
export function safeAdkEvent(event: Event, allowedToolNames: ReadonlySet<string>): NativeAdkEvent | undefined {
  const content = event.content;
  const role = content?.role;
  if (!content) return undefined;
  if (role !== 'model' && role !== 'user') return undefined;

  const parts: Array<Record<string, unknown>> = [];
  for (const part of content.parts ?? []) {
    // Gemini may return a public thought summary when includeThoughts is enabled.
    // Forward only its text and marker. Never serialize signatures or other model metadata.
    if (role === 'model' && part.thought === true) {
      if (typeof part.text === 'string') parts.push({ text: part.text, thought: true });
      continue;
    }
    if (role === 'model' && typeof part.text === 'string') parts.push({ text: part.text });

    const call = part.functionCall;
    if (role === 'model' && call && typeof call.name === 'string' && allowedToolNames.has(call.name)) {
      parts.push({ functionCall: {
        name: call.name,
        ...(typeof call.id === 'string' ? { id: call.id } : {}),
        ...(call.args ? { args: redactSensitiveFields(call.args) } : {}),
      } });
    }

    const response = part.functionResponse;
    if (role === 'user' && response && typeof response.name === 'string' && allowedToolNames.has(response.name)) {
      parts.push({ functionResponse: {
        name: response.name,
        ...(typeof response.id === 'string' ? { id: response.id } : {}),
        response: redactSensitiveFields(response.response),
      } });
    }
  }

  if (!parts.length) return undefined;
  return {
    id: typeof event.id === 'string' ? event.id : randomUUID(),
    ...(typeof event.invocationId === 'string' ? { invocationId: event.invocationId } : {}),
    author: 'customer_assistant',
    partial: event.partial,
    turnComplete: event.turnComplete,
    interrupted: event.interrupted,
    ...(typeof event.finishReason === 'string' ? { finishReason: event.finishReason } : {}),
    ...(typeof event.timestamp === 'number' ? { timestamp: event.timestamp } : {}),
    content: { role, parts },
  };
}

export function customAdkEvent(customMetadata: Record<string, unknown>): NativeAdkEvent {
  return { id: randomUUID(), customMetadata };
}

export function errorAdkEvent(errorCode: string, errorMessage: string): NativeAdkEvent {
  return { id: randomUUID(), errorCode, errorMessage };
}
