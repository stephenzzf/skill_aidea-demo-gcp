import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseScenario, parseSpec } from '../shared/spec.ts';
import type { AccessConfig } from './auth.ts';
import type { DemoSpec } from '../shared/spec.ts';

export interface RuntimeConfig {
  mode: 'test' | 'simulated' | 'vertex';
  access: AccessConfig;
  project: string;
  location: string;
  model: string;
  requestTimeoutMs: number;
}
export async function loadConfig(root = process.cwd(), env = process.env) {
  const spec = parseSpec(JSON.parse(await readFile(resolve(root, 'demo-spec.json'), 'utf8')));
  const scenario = parseScenario(JSON.parse(await readFile(resolve(root, 'scenario.json'), 'utf8')), spec.workspace, spec);
  return { spec, scenario, config: parseRuntimeConfig(spec.model, env, spec.execution) };
}

export function parseRuntimeConfig(model: DemoSpec['model'], env: NodeJS.ProcessEnv, execution?: DemoSpec['execution']): RuntimeConfig {
  if (!['test', 'simulated', 'vertex'].includes(env.DEMO_MODEL_MODE ?? '')) throw new Error('显式设置 DEMO_MODEL_MODE=simulated、vertex 或内部 test；不会自动切换模式');
  const expiresAt = Date.parse(env.DEMO_ACCESS_EXPIRES_AT ?? '');
  if (!/^[a-f0-9]{64}$/.test(env.DEMO_ACCESS_CODE_HASH ?? '') || !Number.isFinite(expiresAt) || (env.DEMO_COOKIE_SECRET?.length ?? 0) < 32) {
    throw new Error('缺少有效访问码配置；先运行 npm run access -- /绝对路径/私有.env');
  }
  const config: RuntimeConfig = {
    mode: env.DEMO_MODEL_MODE as RuntimeConfig['mode'],
    access: { codeHash: env.DEMO_ACCESS_CODE_HASH!, expiresAt, cookieSecret: env.DEMO_COOKIE_SECRET!, secure: env.NODE_ENV === 'production' || Boolean(env.K_SERVICE) },
    project: env.GOOGLE_CLOUD_PROJECT || model.project,
    location: env.GOOGLE_CLOUD_LOCATION || model.location,
    model: env.DEMO_MODEL || model.model,
    requestTimeoutMs: Number(env.DEMO_REQUEST_TIMEOUT_MS ?? 240000),
  };
  if (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs <= 0) throw new Error('DEMO_REQUEST_TIMEOUT_MS 必须是正整数');
  if (config.mode === 'vertex') {
    if (![config.project, config.location, config.model].every(s => s.trim())) throw new Error('Vertex 模式必须指定 project、location 和 model');
  }
  if (execution && config.mode !== 'test' && execution.model !== config.mode) throw new Error('运行模式与已确认 execution.model 不一致；请通过 Codex 确认后更新配置，不自动降级');
  return config;
}
