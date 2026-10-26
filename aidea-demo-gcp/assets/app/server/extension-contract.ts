import type { FunctionTool } from '@google/adk';
import type { Router } from 'express';
import { extensionContextSchema } from '../shared/contracts.ts';
import type { StreamEvent } from '../shared/contracts.ts';
import type { DemoSpec, Scenario } from '../shared/spec.ts';

export interface DemoExtensionAuthoritativeAnalysis {
  authority: 'authoritative';
  summary: string;
  tools: readonly FunctionTool[];
}

export interface DemoExtensionChatBinding {
  systemSummary?: string;
  /** Server-owned mapping into the registered read-only record tool's arguments. */
  simulation?: { selectedRecord?: { dataset: string; id: string } };
  /** Read-only tools only; each tool should check the supplied abort signal. */
  tools?: readonly FunctionTool[];
  /**
   * When present, this is the sole workspace-analysis source for the turn:
   * built-in analysis snapshots and tools are omitted.
   */
  analysis?: DemoExtensionAuthoritativeAnalysis;
}

export interface DemoServerExtension {
  id: string;
  /** Required when paired with a new explicit execution configuration. */
  dataBackend?: 'local' | 'bigquery';
  /** Explicit browser-only governance domains allowed to use the built-in local analysis API. */
  localWorkspaceDomains?: readonly string[];
  /** Parse `data` with a strict, customer-module-owned schema. */
  parseContext(data: unknown): Record<string, unknown>;
  /** Routes are mounted below `/api` after the existing access-code middleware. */
  registerRoutes?: (router: Router, input: { spec: DemoSpec; scenario: Scenario }) => void;
  createChatBinding?: (input: {
    context?: Record<string, unknown>;
    spec: DemoSpec;
    scenario: Scenario;
    signal: AbortSignal;
    emit: (event: StreamEvent) => void;
  }) => DemoExtensionChatBinding | undefined;
}

export function validateDemoExtensionContext(
  extension: DemoServerExtension | undefined,
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const envelope = extensionContextSchema.safeParse(value);
  if (!envelope.success) throw new Error('扩展上下文格式无效');
  if (!extension) throw new Error('扩展上下文未注册');
  if (envelope.data.id !== extension.id) throw new Error('扩展上下文 ID 未注册');
  const parsed = extension.parseContext(envelope.data.data);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('扩展上下文解析器必须返回对象');
  }
  return parsed;
}
