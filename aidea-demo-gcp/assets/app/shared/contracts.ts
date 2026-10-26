import { z } from 'zod';
import type { WorkspaceDefinition } from './workspace.ts';
import type { DemoSpec, Presentation } from './spec.ts';
import type { CapabilityBinding } from './capabilities.ts';

export const cardSchema = z.object({ title: z.string(), rows: z.array(z.tuple([z.string(), z.string()])) }).strict();
export type Card = z.infer<typeof cardSchema>;
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  card?: Card;
  source?: string;
  followups?: string[];
  status?: 'running' | 'complete' | 'interrupted';
}
export interface PublicConfig {
  id: string;
  customer: string;
  assistantName: string;
  title: string;
  subtitle: string;
  prompts: string[];
  mode: 'test' | 'simulated' | 'vertex';
  execution?: DemoSpec['execution'];
  synthetic: boolean;
  capabilities?: CapabilityBinding[];
  presentation?: Presentation;
  workspace?: WorkspaceDefinition;
  solution?: Pick<DemoSpec, 'goal' | 'solution' | 'design' | 'blueprint' | 'pages' | 'steps'>;
}
const cellSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const eventSchema = z.object({
  requestId: z.string().min(1), recordId: z.string().min(1), actionId: z.string().min(1), role: z.string().min(1),
  input: z.record(z.string(), cellSchema), at: z.string().datetime(),
}).strict();
export const workspaceStateSchema = z.object({ revision: z.number().int().nonnegative(), events: z.array(eventSchema) }).strict();
export const extensionContextSchema = z.object({
  id: z.string().min(1).max(120),
  version: z.literal(1),
  data: z.record(z.string(), z.unknown()),
}).strict();
export type ExtensionChatContext = z.infer<typeof extensionContextSchema>;
const filterSchema = z.object({ field: z.string().min(1), op: z.enum(['eq', 'contains', 'gte', 'lte']), value: cellSchema, dataset: z.string().optional() }).strict();
export const analysisQuerySchema = z.object({
  dataset: z.string().optional(), timeField: z.string().optional(), filters: z.array(filterSchema).optional(), from: z.string().optional(), to: z.string().optional(),
  origin: z.enum(['synthetic', 'customer', 'combined']).optional(), limit: z.number().int().min(1).optional(),
}).strict();
export const analysisRequestSchema = z.object({ query: analysisQuerySchema, state: workspaceStateSchema, domainId: z.string().min(1).optional() }).strict();
export const actionRequestSchema = z.object({
  requestId: z.string().min(1), recordId: z.string().min(1), actionId: z.string().min(1), role: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(), input: z.record(z.string(), cellSchema).optional(), state: workspaceStateSchema,
  domainId: z.string().min(1).optional(),
}).strict();
export const workspaceContextSchema = z.object({
  query: analysisQuerySchema, state: workspaceStateSchema,
  domainId: z.string().min(1).optional(),
  selectedRecord: z.object({ dataset: z.string(), id: z.string(), scope: z.enum(['snapshot', 'current']).optional() }).strict().optional(),
  extension: extensionContextSchema.optional(),
}).strict();
export type WorkspaceChatContext = z.infer<typeof workspaceContextSchema>;
export const chatRequestSchema = z.object({
  message: z.string().trim().min(1),
  context: workspaceContextSchema.optional(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() }).strict()),
}).strict().superRefine(({ history }, context) => {
  if (history.length % 2 || history.some((m, i) => m.role !== (i % 2 ? 'assistant' : 'user'))) {
    context.addIssue({ code: 'custom', message: 'history 必须是完整的 user/assistant 消息对' });
  }
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export const streamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('card'), card: cardSchema, source: z.string().optional(), followups: z.array(z.string()).optional() }).strict(),
  z.object({ type: z.literal('done') }).strict(),
  z.object({ type: z.literal('error'), message: z.string() }).strict(),
]);
export type StreamEvent = z.infer<typeof streamEventSchema>;
