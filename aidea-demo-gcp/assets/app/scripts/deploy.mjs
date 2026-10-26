#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appRoot, privateFilePath } from './private-path.mjs';
import { parseRuntimeConfig } from '../server/config.ts';
import { parseSpec } from '../shared/spec.ts';

// Default to a reviewable command. Public invocation is part of deploy; no project-level IAM grants.
const values = new Map();
let execute = false;
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i];
  if (name === '--execute') execute = true;
  else if (['--project', '--region', '--service', '--service-account', '--env-file'].includes(name) && process.argv[i + 1]) values.set(name, process.argv[++i]);
  else throw new Error(`未知参数：${name}`);
}
for (const name of ['--project', '--region', '--service', '--service-account', '--env-file']) {
  if (!values.get(name) || values.get(name).startsWith('-')) throw new Error(`需要显式提供 ${name}`);
}
if (await realpath(process.cwd()) !== appRoot) throw new Error('请在生成应用的根目录运行部署脚本');
const envFile = await privateFilePath(values.get('--env-file'));
if ((await stat(envFile)).mode & 0o077) throw new Error('部署环境文件必须仅当前用户可读写（600）');
if (!envFile.endsWith('.json')) throw new Error('部署环境文件使用 JSON 对象格式（.json），不是本地 .env 文件');
const env = JSON.parse(await readFile(envFile, 'utf8'));
if (!env || Array.isArray(env) || typeof env !== 'object' || Object.values(env).some(v => typeof v !== 'string')) throw new Error('部署环境文件必须是字符串值的 JSON 对象');
const spec = parseSpec(JSON.parse(await readFile(resolve(appRoot, 'demo-spec.json'), 'utf8')));
if (env.DEMO_MODEL_MODE !== 'vertex' || env.GOOGLE_CLOUD_PROJECT !== values.get('--project') || !env.GOOGLE_CLOUD_LOCATION || !env.DEMO_MODEL) {
  throw new Error('部署文件必须显式配置 vertex 模式、匹配的 GOOGLE_CLOUD_PROJECT、GOOGLE_CLOUD_LOCATION、DEMO_MODEL');
}
const datasetPattern = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;
const bigQueryPatterns = {
  BQ_PROJECT: /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/,
  BQ_LOCATION: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/,
  BQ_DATASET: datasetPattern,
  BQ_RAW_DATASET: datasetPattern,
  BQ_MART_DATASET: datasetPattern,
};
for (const [name, pattern] of Object.entries(bigQueryPatterns)) {
  if (env[name] !== undefined && (!env[name].trim() || env[name] !== env[name].trim() || !pattern.test(env[name]))) {
    throw new Error(`${name} 格式无效；请提供有效的 BigQuery 项目、区域或数据集标识`);
  }
}
const hasRawDataset = Boolean(env.BQ_RAW_DATASET);
const hasMartDataset = Boolean(env.BQ_MART_DATASET);
if (hasRawDataset !== hasMartDataset) throw new Error('BQ_RAW_DATASET 和 BQ_MART_DATASET 必须成对配置');
if (env.BQ_DATASET && (hasRawDataset || hasMartDataset)) throw new Error('BQ_DATASET 与 BQ_RAW_DATASET/BQ_MART_DATASET 只能选择一种配置形式');
if (spec.execution?.data === 'bigquery') {
  const missing = ['BQ_PROJECT', 'BQ_LOCATION'].filter(name => !env[name]);
  if (!env.BQ_DATASET && !(hasRawDataset && hasMartDataset)) missing.push('BQ_DATASET 或 BQ_RAW_DATASET+BQ_MART_DATASET');
  if (missing.length) throw new Error(`execution.data=bigquery 时必须显式配置：${missing.join(', ')}`);
}
const config = parseRuntimeConfig(spec.model, env, spec.execution);
if (config.access.expiresAt <= Date.now()) throw new Error('访问码配置已经过期；请先生成新的访问配置');
const timeoutSeconds = Math.max(300, Math.ceil(config.requestTimeoutMs / 1000) + 30);
if (timeoutSeconds > 3600) throw new Error('请求超时加缓冲后超过 Cloud Run 的 3600 秒平台上限');
const allowedEnvironmentKeys = new Set([
  'DEMO_MODEL_MODE', 'DEMO_ACCESS_CODE_HASH', 'DEMO_COOKIE_SECRET', 'DEMO_ACCESS_EXPIRES_AT', 'DEMO_REQUEST_TIMEOUT_MS',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'DEMO_MODEL', ...Object.keys(bigQueryPatterns),
]);
if (Object.keys(env).some(key => !allowedEnvironmentKeys.has(key))) {
  throw new Error('部署文件含不需要的变量；不要放入原始访问码、ADC 文件或其他凭据');
}
// gcloud accepts JSON as a YAML-compatible env vars file. Keep secrets out of argv/logs.
const command = [
  'run', 'deploy', values.get('--service'), '--source=.', `--project=${values.get('--project')}`, `--region=${values.get('--region')}`,
  `--service-account=${values.get('--service-account')}`, `--env-vars-file=${envFile}`, '--allow-unauthenticated',
  '--cpu-throttling', '--min=0', '--min-instances=0', `--timeout=${timeoutSeconds}`,
];
const note = '默认仅输出命令，不调用云端。--allow-unauthenticated 会配置服务公开入口并影响服务级 IAM；业务 API 仍由访问码保护。不自动授予项目级 IAM；授权后加 --execute 才调用 gcloud。';
if (!execute) console.log(JSON.stringify({ program: 'gcloud', args: command, note }, null, 2));
else {
  const result = spawnSync('gcloud', command, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
