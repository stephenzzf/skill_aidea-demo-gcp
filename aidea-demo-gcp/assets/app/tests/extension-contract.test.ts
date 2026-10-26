import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { BaseLlm, FunctionTool } from '@google/adk';
import type { BaseLlmConnection, LlmRequest, LlmResponse } from '@google/adk';
import type { Router } from 'express';
import { z } from 'zod';
import { createApp } from '../server/app.ts';
import type { RuntimeConfig } from '../server/config.ts';
import { runConfig, runDemo } from '../server/agent.ts';
import { validateDemoExtensionContext } from '../server/extension-contract.ts';
import type { DemoServerExtension } from '../server/extension-contract.ts';
import { extensionContextSchema, workspaceContextSchema } from '../shared/contracts.ts';
import { reduceExtensionContext } from '../shared/extensions/context.ts';
import { parseScenario, parseSpec } from '../shared/spec.ts';
import { hashCode } from '../server/auth.ts';

const workspace = {
  views: ['overview', 'assistant'],
  roles: [],
  stages: [],
  datasets: [{ id: 'records', label: '测试记录', key: 'id', origin: 'synthetic', source: '本地测试', fields: [
    { id: 'id', label: '编号', type: 'string', required: true },
    { id: 'amount', label: '金额', type: 'number' },
  ] }],
  metrics: [{ id: 'record-count', label: '记录数', dataset: 'records', operation: 'count', description: '本地测试记录数', scope: 'snapshot' }],
};
const spec = parseSpec({
  version: 2, id: 'extension-test', customer: '测试客户', assistantName: '测试助手', title: '测试', subtitle: '测试',
  audience: '本地测试', goal: '验证扩展合同', solution: '仅本地测试', confirmed: true, prompts: ['本地测试'],
  steps: [{ question: '本地问题', expected: '本地答案' }], acceptance: ['本地验收'],
  design: { facts: [], assumptions: [], implementation: ['本地测试'], coverage: [{ claim: '本地模拟范围', status: 'simulated', evidence: '测试夹具' }] }, workspace,
  model: { project: '', location: '', model: '' },
});
const scenario = parseScenario({
  version: 2, synthetic: true, instruction: '本地测试场景。',
  topics: [{ id: 'local-topic', title: '本地主题', keywords: ['本地'], answer: '本地回答', rows: [['来源', '本地测试']], source: '本地测试', followups: [] }],
  workspace: { datasets: [{ id: 'records', rows: [{ id: 'record-1', amount: 7 }] }] },
}, spec.workspace, spec);
const runtime: RuntimeConfig = {
  mode: 'test', project: '', location: '', model: 'local-extension-test', requestTimeoutMs: 5000,
  access: { codeHash: hashCode('not-used'), expiresAt: Date.now() + 60000, cookieSecret: randomBytes(32).toString('hex'), secure: false },
};

const strictContext = z.object({ range: z.enum(['week', 'month']), scope: z.string().min(1) }).strict();
const extension: DemoServerExtension = {
  id: 'analytics',
  parseContext(value) {
    const parsed = strictContext.safeParse(value);
    if (!parsed.success) throw new Error('上下文字段无效');
    return parsed.data;
  },
};

test('extension context is an optional strict envelope and requires a matching static registration', () => {
  const envelope = { id: 'analytics', version: 1, data: { range: 'week', scope: 'sample' } } as const;
  const baseContext = { query: {}, state: { revision: 0, events: [] } };
  assert(workspaceContextSchema.safeParse({ ...baseContext, extension: envelope }).success);
  assert(!extensionContextSchema.safeParse({ ...envelope, version: 2 }).success, 'unknown envelope versions are rejected');
  assert(!extensionContextSchema.safeParse({ ...envelope, unexpected: true }).success, 'envelope keys are strict');
  assert.deepEqual(validateDemoExtensionContext(extension, envelope), envelope.data);
  assert.throws(() => validateDemoExtensionContext(undefined, envelope), /未注册/);
  assert.throws(() => validateDemoExtensionContext({ ...extension, id: 'another-extension' }, envelope), /ID/);
  assert.throws(() => validateDemoExtensionContext(extension, { ...envelope, version: 2 }), /格式/);
  assert.throws(() => validateDemoExtensionContext(extension, { ...envelope, data: { ...envelope.data, extra: true } }), /字段无效/);
});

test('extension context reset clears the active envelope', () => {
  const context = { id: 'analytics', version: 1, data: { range: 'week', scope: 'sample' } } as const;
  const current = reduceExtensionContext(undefined, { type: 'set', context });
  assert.deepEqual(current, context);
  assert.equal(reduceExtensionContext(current, { type: 'reset' }), undefined);
});

test('extension routes are mounted under the authenticated /api middleware', () => {
  let registeredRouter: Router | undefined;
  const routeExtension: DemoServerExtension = {
    ...extension,
    registerRoutes(router) {
      registeredRouter = router;
      router.get('/reports', (_req, res) => res.json({ ok: true }));
    },
  };
  const app = createApp(spec, scenario, runtime, undefined, routeExtension);
  assert(registeredRouter, 'the extension router should be provided to its static registration callback');
  const layers = (app as unknown as { router: { stack: Array<{ handle: unknown; matchers: Array<(path: string) => unknown> }> } }).router.stack;
  const apiAuthIndex = layers.findIndex(layer => typeof layer.handle === 'function' && layer.handle.name === 'authorizeApi');
  const extensionIndex = layers.findIndex(layer => layer.handle === registeredRouter);
  assert(apiAuthIndex >= 0);
  assert(extensionIndex > apiAuthIndex, 'extension routes are registered after the access-code middleware');
  assert(layers[apiAuthIndex].matchers.some(match => Boolean(match('/api/reports'))));
  assert(layers[extensionIndex].matchers.some(match => Boolean(match('/api/reports'))));
  const routes = (registeredRouter as unknown as { stack: Array<{ route?: { path?: string } }> }).stack;
  assert(routes.some(layer => layer.route?.path === '/reports'));
});

class CaptureModel extends BaseLlm {
  request?: LlmRequest;
  constructor() { super({ model: 'extension-capture-model' }); }
  async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse> {
    this.request = request;
    yield { content: { role: 'model', parts: [{ text: '本地模型回答' }] }, turnComplete: true };
  }
  async connect(): Promise<BaseLlmConnection> { throw new Error('unused'); }
}

function readOnlyTool(name: string) {
  return new FunctionTool({ name, description: '本地只读测试工具', parameters: z.object({}).strict(), execute: () => ({ ok: true }) });
}

test('authoritative analysis binding replaces built-in snapshots and analysis tools; default binding keeps them', async () => {
  const authoritativeTool = readOnlyTool('extension_authoritative_analysis');
  const extraTool = readOnlyTool('extension_read_only_lookup');
  const authoritativeExtension: DemoServerExtension = {
    ...extension,
    createChatBinding({ context }) {
      assert.deepEqual(context, { range: 'week', scope: 'sample' });
      return {
        systemSummary: 'extension-system-summary-marker',
        tools: [extraTool],
        analysis: { authority: 'authoritative', summary: 'authoritative-analysis-marker', tools: [authoritativeTool] },
      };
    },
  };
  const model = new CaptureModel();
  const events: Array<{ type: string; text?: string }> = [];
  await runDemo(spec, scenario, runtime, { message: '说明当前分析', history: [] }, event => events.push(event), new AbortController().signal,
    model, authoritativeExtension, { range: 'week', scope: 'sample' });
  const request = model.request;
  assert(request, 'the local model should receive the assembled request');
  const instruction = JSON.stringify(request.config?.systemInstruction);
  assert(instruction.includes('extension-system-summary-marker'));
  assert(instruction.includes('authoritative-analysis-marker'));
  assert(!instruction.includes('当前看板确定性分析'), 'the conflicting built-in snapshot is omitted');
  const names = Object.keys(request.toolsDict);
  assert(names.includes('extension_read_only_lookup'));
  assert(names.includes('extension_authoritative_analysis'));
  assert(!names.includes('analyze_workspace'), 'the conflicting built-in analysis tool is omitted');
  assert.equal(runConfig.maxLlmCalls, 0);
  assert(events.some(event => event.type === 'text'));

  const defaultModel = new CaptureModel();
  await runDemo(spec, scenario, runtime, { message: '说明当前分析', history: [], context: { query: {}, state: { revision: 0, events: [] } } },
    () => undefined, new AbortController().signal, defaultModel, { ...extension, createChatBinding: () => ({ systemSummary: 'augment-only' }) });
  const defaultRequest = defaultModel.request;
  assert(defaultRequest);
  assert(JSON.stringify(defaultRequest.config?.systemInstruction).includes('当前看板确定性分析'));
  assert(Object.keys(defaultRequest.toolsDict).includes('analyze_workspace'));
});


test('summary-only authoritative binding needs no tool and never advertises the removed default tool', async () => {
  const model = new CaptureModel();
  await runDemo(spec, scenario, runtime, {message:'解释当前快照',history:[]}, () => undefined, new AbortController().signal, model,
    {...extension,createChatBinding:()=>({analysis:{authority:'authoritative',summary:'snapshot-only',tools:[]}})});
  assert(model.request);
  assert(JSON.stringify(model.request.config?.systemInstruction).includes('snapshot-only'));
  assert(!JSON.stringify(model.request.config?.systemInstruction).includes('调用 analyze_workspace'));
  assert(!Object.keys(model.request.toolsDict).includes('analyze_workspace'));
});
