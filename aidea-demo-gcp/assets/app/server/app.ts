import { applyCapabilityAction } from './capabilities.ts';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { BaseLlm, Event } from '@google/adk';
import { adkEventStream } from '@assistant-ui/react-google-adk/server';
import { z } from 'zod';
import { actionRequestSchema, analysisRequestSchema, chatRequestSchema } from '../shared/contracts.ts';
import type { ChatRequest, PublicConfig, StreamEvent } from '../shared/contracts.ts';
import { adkProxyRequestSchema } from '../shared/adk-contract.ts';
import type { DemoSpec, Scenario } from '../shared/spec.ts';
import { authorized, issueCookie, validCode } from './auth.ts';
import { runDemo } from './agent.ts';
import { demoServerExtension } from './demo-extension.ts';
import { validateDemoExtensionContext } from './extension-contract.ts';
import { applyAction } from './workspace.ts';
import type { RuntimeConfig } from './config.ts';
import { analyzeDomain, domainContext, selectedDomainRecord } from './domain.ts';
import { validateDomainAction } from '../shared/solution.ts';
import type { DemoServerExtension } from './extension-contract.ts';
import { customAdkEvent, errorAdkEvent, safeAdkEvent } from './adk-protocol.ts';
import type { NativeAdkEvent } from './adk-protocol.ts';

type PreparedChat =
  | { ok: true; input: ChatRequest; extensionContext?: Record<string, unknown> }
  | { ok: false; message: string };

function prepareChatRequest(body: unknown, spec: DemoSpec, scenario: Scenario, extension: DemoServerExtension | undefined): PreparedChat {
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) return { ok: false, message: '消息格式无效，请重新开始会话' };
  let extensionContext: Record<string, unknown> | undefined;
  try {
    extensionContext = validateDemoExtensionContext(extension, parsed.data.context?.extension);
  } catch {
    return { ok: false, message: '扩展上下文无效，请刷新页面后重试' };
  }
  if (spec.execution?.data === 'bigquery' && !extensionContext) return { ok: false, message: 'BigQuery范围上下文缺失；未切换为本地分析' };
  if (parsed.data.context || spec.version >= 3) {
    try {
      if (!spec.workspace || !scenario.workspace) throw new Error('工作区未启用');
      const context = domainContext(spec, parsed.data.context, true)!;
      if (spec.execution?.data !== 'bigquery' || extension?.localWorkspaceDomains?.includes(context.domainId ?? '')) {
        analyzeDomain(spec, scenario, context.query, context.state, context.domainId);
        selectedDomainRecord(spec, scenario, context);
      } else if (context.selectedRecord) throw new Error('BigQuery记录需通过扩展上下文定位');
    } catch {
      return { ok: false, message: '业务上下文无效，请检查当前记录和筛选条件' };
    }
  }
  return { ok: true, input: parsed.data, extensionContext };
}

function createNativeEventGenerator(
  run: (emit: (event: NativeAdkEvent) => void) => Promise<void>,
  controller: AbortController,
): AsyncGenerator<NativeAdkEvent, void, undefined> {
  const queue: NativeAdkEvent[] = [];
  let finished = false;
  let wake: (() => void) | undefined;
  const push = (event: NativeAdkEvent) => {
    queue.push(event);
    wake?.();
    wake = undefined;
  };
  const task = run(push)
    .then(() => {
      if (controller.signal.aborted) {
        push(errorAdkEvent('ME_DEMO_ABORTED', '请求已停止或超时，未自动重试。'));
      } else {
        push(customAdkEvent({ meDemoTerminal: { status: 'complete', version: 1 } }));
      }
    })
    .catch(() => {
      const aborted = controller.signal.aborted;
      push(errorAdkEvent(aborted ? 'ME_DEMO_ABORTED' : 'ME_DEMO_RUN_FAILED',
        aborted ? '请求已停止或超时，未自动重试。' : '回答未完成，未自动重试。请稍后重新提问。'));
    })
    .finally(() => {
      finished = true;
      wake?.();
      wake = undefined;
    });

  const events = async function* (): AsyncGenerator<NativeAdkEvent, void, undefined> {
    try {
      while (!finished || queue.length) {
        if (queue.length) {
          yield queue.shift()!;
        } else {
          await new Promise<void>(resolve => { wake = resolve; });
        }
      }
    } finally {
      if (!controller.signal.aborted) controller.abort();
      await task;
    }
  };
  return events();
}

async function bridgeAdkResponse(response: Response, res: express.Response, controller: AbortController) {
  const body = response.body;
  if (!body) { res.status(500).end(); return; }
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const reader = body.getReader();
  const cancel = () => {
    if (res.writableEnded) return;
    controller.abort();
    void reader.cancel().catch(() => undefined);
  };
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n');
  }, 15000);
  res.on('close', cancel);
  try {
    while (!res.destroyed && !res.writableEnded) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await new Promise<void>(resolve => {
          const settled = () => {
            res.off('drain', settled);
            res.off('close', settled);
            resolve();
          };
          res.once('drain', settled);
          res.once('close', settled);
        });
      }
    }
  } finally {
    clearInterval(heartbeat);
    res.off('close', cancel);
    reader.releaseLock();
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

export function createApp(
  spec: DemoSpec,
  scenario: Scenario,
  config: RuntimeConfig,
  testModel?: BaseLlm,
  extension: DemoServerExtension | undefined = demoServerExtension,
) {
  if (spec.execution?.data === 'bigquery' && !extension) throw new Error('已确认BigQuery模式需要已注册的数据扩展；未启用本地替代');
  if (spec.execution && extension && extension.dataBackend !== spec.execution.data) throw new Error('数据扩展未声明匹配的dataBackend；请确认本地/BigQuery模式，不加载不匹配的数据扩展');
  if (extension?.localWorkspaceDomains?.some(id => !spec.pages?.some(page => page.id === id))) throw new Error('本地治理领域必须属于已确认的页面配置');
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/health', (_req, res) => res.json({ ok: true, demoId: spec.id, mode: config.mode }));
  // Reject cross-origin writes before parsing bodies. SameSite cookies cover normal browsers too.
  app.use('/api', (req, res, next) => {
    const origin = req.get('origin');
    const host = req.get('host');
    if (req.method === 'POST' && (req.get('sec-fetch-site') === 'cross-site' || (origin && new URL(origin).host !== host))) {
      res.status(403).json({ error: '请从演示页面发起请求' }); return;
    }
    next();
  });
  app.use('/api', express.json({ limit: '2mb' })); // Transport size, not model/turn/token quota.
  app.post('/api/access', (req, res) => {
    const input = z.object({ code: z.string() }).strict().safeParse(req.body);
    if (!input.success || !validCode(input.data.code, config.access)) {
      res.status(401).json({ error: '访问码无效或已过期，请联系演示提供方' }); return;
    }
    res.set('Set-Cookie', issueCookie(spec.id, config.access)).json({ ok: true });
  });
  function authorizeApi(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (!authorized(req.get('cookie'), spec.id, config.access)) { res.status(401).json({ error: '请验证有效访问码' }); return; }
    next();
  }
  app.use('/api', authorizeApi);
  app.get('/api/config', (_req, res) => {
    const { id, customer, assistantName, title, subtitle, prompts } = spec;
    res.json({ id, customer, assistantName, title, subtitle, prompts, mode: config.mode, synthetic: scenario.synthetic,
      ...(spec.execution ? { execution: spec.execution } : {}),
      ...(spec.version===4 ? {capabilities:spec.capabilities,presentation:spec.presentation} : {}),
      ...(spec.workspace ? { workspace: spec.workspace } : {}),
      ...(spec.version >= 3 ? { solution: { goal: spec.goal, solution: spec.solution, design: spec.design,
        blueprint: spec.blueprint, pages: spec.pages, steps: spec.steps } } : {}) } satisfies PublicConfig);
  });
  app.get('/api/workspace', (_req, res) => {
    if (!spec.workspace) { res.status(404).json({ error: '当前演示未启用业务工作区' }); return; }
    res.json({ definition: spec.workspace, state: { revision: 0, events: [] } });
  });
  app.post('/api/analysis', (req, res) => {
    const input = analysisRequestSchema.safeParse(req.body);
    if (!input.success || !spec.workspace || !scenario.workspace) { res.status(400).json({ error: '分析参数或工作区无效' }); return; }
    if (spec.execution?.data === 'bigquery' && !extension?.localWorkspaceDomains?.includes(input.data.domainId ?? '')) {
      res.status(409).json({ error: '当前领域使用BigQuery权威数据，请通过已注册扩展查询；未返回本地替代指标' }); return;
    }
    try { res.json({ ...analyzeDomain(spec, scenario, input.data.query, input.data.state, input.data.domainId), dataBackend: 'local', simulated: true }); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '分析无法完成' }); }
  });
  app.post('/api/actions', (req, res) => {
    const input = actionRequestSchema.safeParse(req.body);
    if (!input.success || !spec.workspace || !scenario.workspace) { res.status(400).json({ error: '业务操作格式或工作区无效' }); return; }
    try {
      if(spec.version===4) res.json(applyCapabilityAction(spec,scenario,input.data));
      else {validateDomainAction(spec,input.data.domainId,input.data.actionId);res.json(applyAction(spec.workspace,scenario.workspace,input.data));}
    }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '操作未完成，输入已保留' }); }
  });
  app.post('/api/chat', async (req, res) => {
    const prepared = prepareChatRequest(req.body, spec, scenario, extension);
    if (!prepared.ok) { res.status(400).json({ error: prepared.message }); return; }
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.on('close', cancel);
    const emit = (event: StreamEvent) => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    const timer = setTimeout(() => controller.abort(new Error('timeout')), config.requestTimeoutMs);
    const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n'); }, 15000);
    try {
      await runDemo(spec, scenario, config, prepared.input, emit, controller.signal, testModel, extension, prepared.extensionContext);
      emit({ type: 'done' });
    } catch (error) {
      if (config.mode === 'vertex') console.error(JSON.stringify({ event: 'model_request_failed', code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'MODEL_INCOMPLETE', aborted: controller.signal.aborted }));
      // Never expose provider errors, credentials, system prompts or stack traces to the browser.
      emit({ type: 'error', message: controller.signal.aborted ? '请求已停止或超时，未自动重试。请确认后重新提问。' : '回答未完成，未自动重试。请稍后重新提问。' });
    } finally {
      clearTimeout(timer); clearInterval(heartbeat); res.off('close', cancel);
      res.end();
    }
  });
  app.post('/api/chat/adk', async (req, res) => {
    const native = adkProxyRequestSchema.safeParse(req.body);
    if (!native.success) { res.status(400).json({ error: 'ADK 消息格式无效，请重新开始会话' }); return; }
    // The assistant-ui session id selects a conversation in its client runtime; it is not an authorization key.
    const prepared = prepareChatRequest(native.data.chat, spec, scenario, extension);
    if (!prepared.ok) { res.status(400).json({ error: prepared.message }); return; }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), config.requestTimeoutMs);
    const stream = createNativeEventGenerator(async push => {
      const observer = (event: Event, allowedToolNames: ReadonlySet<string>) => {
        const safe = safeAdkEvent(event, allowedToolNames);
        if (safe) push(safe);
      };
      const emit = (event: StreamEvent) => {
        if (event.type === 'card') push(customAdkEvent({ meDemoCard: {
          card: event.card,
          ...(event.source !== undefined ? { source: event.source } : {}),
          ...(event.followups !== undefined ? { followups: event.followups } : {}),
        } }));
      };
      await runDemo(spec, scenario, config, prepared.input, emit, controller.signal, testModel, extension,
        prepared.extensionContext, observer, native.data.messageId);
    }, controller);
    const response = adkEventStream(stream);
    try {
      await bridgeAdkResponse(response, res, controller);
    } finally {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
    }
  });
  if (extension?.registerRoutes) {
    const extensionRoutes = express.Router();
    extension.registerRoutes(extensionRoutes, { spec, scenario });
    app.use('/api', extensionRoutes);
  }
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const tooLarge = error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? '请求内容过大，请重新开始会话' : '请求内容无效' });
  };
  app.use(errors);
  return app;
}
