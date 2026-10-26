import { z } from 'zod';
import { chatRequestSchema } from './contracts.ts';

/**
 * The proxy request emitted by assistant-ui's createAdkStream, narrowed to the
 * one message shape this application supports. ADK session ids are transport
 * identifiers only; the server reconstructs each run from the submitted text
 * history and validated business context.
 */
const replayStateSchema = z.object({
  history: chatRequestSchema.shape.history,
  context: chatRequestSchema.shape.context,
}).strict();

export const adkProxyRequestSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string(),
  messageId: z.string().min(1).optional(),
  stateDelta: replayStateSchema,
}).strict().transform(({ sessionId, message, messageId, stateDelta }) => ({
  sessionId,
  messageId,
  chat: chatRequestSchema.parse({
    message,
    history: stateDelta.history,
    ...(stateDelta.context ? { context: stateDelta.context } : {}),
  }),
}));

export type AdkProxyRequest = z.infer<typeof adkProxyRequestSchema>;
