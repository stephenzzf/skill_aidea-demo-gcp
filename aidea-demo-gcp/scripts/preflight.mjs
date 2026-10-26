#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join, resolve} from 'node:path';

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const TIMEOUT_MS = 6000;
const MAX_BUFFER = 1024 * 1024;

function parseArgs(argv) {
  let project;
  let explicitProject = false;
  let checkServices = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check-services') {
      checkServices = true;
    } else if (arg === '--project') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) return {error: 'PROJECT_VALUE_REQUIRED'};
      project = argv[++i];
      explicitProject = true;
    } else if (arg.startsWith('--project=')) {
      project = arg.slice('--project='.length);
      explicitProject = true;
    } else {
      return {error: 'UNKNOWN_ARGUMENT'};
    }
  }
  return {project, explicitProject, checkServices};
}

function invoke(runCommand, command, args) {
  try {
    const result = runCommand(command, args, {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: {...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1'},
    });
    if (result?.error) {
      const code = result.error.code === 'ENOENT' ? 'COMMAND_NOT_FOUND' : 'COMMAND_UNAVAILABLE';
      return {ok: false, code};
    }
    if (result?.status !== 0) return {ok: false, code: 'COMMAND_FAILED'};
    return {ok: true, stdout: typeof result.stdout === 'string' ? result.stdout : ''};
  } catch {
    return {ok: false, code: 'COMMAND_UNAVAILABLE'};
  }
}

function cliStatus(result, prefix) {
  if (result.ok) return {status: 'available'};
  if (result.code === 'COMMAND_NOT_FOUND') return {status: 'absent', diagnosticCode: `${prefix}_NOT_FOUND`};
  return {status: 'unknown', diagnosticCode: `${prefix}_CHECK_FAILED`};
}

function safeVersion(stdout, name) {
  const expression = name === 'gcloud'
    ? /(?:^|\n)Google Cloud SDK\s+([0-9]+(?:\.[0-9]+){1,3})(?:\s|$)/
    : /(?:^|\n)(?:This is )?(?:BigQuery (?:command line tool|CLI)|bq)(?:\s+version)?\s*[: ]?\s*([0-9]+(?:\.[0-9]+){1,3})(?:\s|$)/i;
  return stdout.match(expression)?.[1];
}

function isProjectId(value) {
  return typeof value === 'string' && PROJECT_ID.test(value);
}

function selectTarget(args, gcloud, runCommand) {
  if (args.explicitProject) {
    if (!isProjectId(args.project)) {
      return {projectId: null, source: 'invalid-explicit', discovery: 'invalid', requiresConfirmation: false, diagnosticCode: 'PROJECT_ID_INVALID'};
    }
    return {projectId: args.project, source: 'explicit', discovery: 'candidate', requiresConfirmation: true};
  }
  if (gcloud.status !== 'available') {
    return {projectId: null, source: 'none', discovery: 'unknown', requiresConfirmation: false, diagnosticCode: 'ACTIVE_PROJECT_UNAVAILABLE'};
  }
  const result = invoke(runCommand, 'gcloud', ['config', 'get-value', 'project']);
  if (!result.ok) {
    return {projectId: null, source: 'none', discovery: 'unknown', requiresConfirmation: false, diagnosticCode: 'ACTIVE_PROJECT_UNAVAILABLE'};
  }
  const value = result.stdout.trim();
  if (value === '(unset)' || value === 'unset' || value === '') {
    return {projectId: null, source: 'none', discovery: 'not-configured', requiresConfirmation: false};
  }
  if (!isProjectId(value)) {
    return {projectId: null, source: 'none', discovery: 'unknown', requiresConfirmation: false, diagnosticCode: 'ACTIVE_PROJECT_ID_UNRECOGNIZED'};
  }
  return {projectId: value, source: 'gcloud-active-configuration', discovery: 'candidate', requiresConfirmation: true};
}

function inspectAuth(gcloud, runCommand) {
  if (gcloud.status !== 'available') return {status: 'unknown', diagnosticCode: 'GCLOUD_UNAVAILABLE'};
  // The CLI's list output exposes the active principal through `account`; capture it only
  // to determine presence and never include the value in the report or diagnostics.
  const result = invoke(runCommand, 'gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
  if (!result.ok) return {status: 'unknown', diagnosticCode: 'GCLOUD_AUTH_STATUS_UNAVAILABLE'};
  const output = result.stdout.trim();
  if (output === '') return {status: 'inactive'};
  return {status: 'active'};
}

function inspectAdc(env, home, fileExists, platform = process.platform) {
  if (typeof env.GOOGLE_APPLICATION_CREDENTIALS === 'string' && env.GOOGLE_APPLICATION_CREDENTIALS.trim() !== '') {
    return {status: 'configured-unverified', source: 'environment-variable', verified: false};
  }
  const path = platform === 'win32'
    ? env.APPDATA ? join(env.APPDATA, 'gcloud', 'application_default_credentials.json') : undefined
    : join(home, '.config', 'gcloud', 'application_default_credentials.json');
  try {
    if (path && fileExists(path)) {
      return {status: 'present-unverified', source: 'local-default-file', verified: false};
    }
  } catch {
    return {status: 'unknown', source: 'local-check-unavailable', verified: false};
  }
  // ADC can also come from an attached service identity; the local check cannot rule that out.
  return {status: 'unknown', source: 'not-detected-locally', verified: false};
}

function inspectService(result, serviceName) {
  if (!result.ok) return {status: 'unknown', diagnosticCode: 'SERVICE_STATUS_UNAVAILABLE'};
  const enabled = result.stdout.split(/\r?\n/).some(line => line.trim() === serviceName);
  return {status: enabled ? 'enabled-unverified' : 'not-enabled-in-target', verified: false};
}

function inspectServices(args, target, gcloud, runCommand) {
  const notChecked = {status: 'not-checked', verified: false};
  if (!args.checkServices) return {checked: false, gemini: notChecked, bigquery: notChecked};
  if (!target.projectId || gcloud.status !== 'available') {
    const reason = target.projectId ? 'GCLOUD_UNAVAILABLE' : 'PROJECT_TARGET_UNAVAILABLE';
    const unknown = {status: 'unknown', diagnosticCode: reason, verified: false};
    return {checked: true, gemini: unknown, bigquery: {...unknown}};
  }
  const result = invoke(runCommand, 'gcloud', [
    'services', 'list', '--enabled', `--project=${target.projectId}`, '--format=value(config.name)',
  ]);
  return {
    checked: true,
    gemini: inspectService(result, 'aiplatform.googleapis.com'),
    bigquery: inspectService(result, 'bigquery.googleapis.com'),
  };
}

/**
 * Read local Google Cloud CLI state and, only when opted in, enabled service names.
 * `runCommand` is injected so tests can prove the command boundary without contacting Google.
 */
export function collectEnvironment({
  argv = [],
  runCommand = spawnSync,
  env = process.env,
  home = homedir(),
  fileExists = existsSync,
  platform = process.platform,
  now = () => new Date(),
} = {}) {
  const args = parseArgs(argv);
  if (args.error) return {error: args.error, usage: 'preflight.mjs [--project PROJECT_ID] [--check-services]'};

  const gcloudResult = invoke(runCommand, 'gcloud', ['--version']);
  const gcloud = cliStatus(gcloudResult, 'GCLOUD');
  if (gcloudResult.ok) {
    const version = safeVersion(gcloudResult.stdout, 'gcloud');
    if (version) gcloud.version = version;
  }

  const bqResult = invoke(runCommand, 'bq', ['version']);
  const bq = cliStatus(bqResult, 'BQ');
  if (bqResult.ok) {
    const version = safeVersion(bqResult.stdout, 'bq');
    if (version) bq.version = version;
  }

  const target = selectTarget(args, gcloud, runCommand);
  const auth = inspectAuth(gcloud, runCommand);
  const adc = inspectAdc(env, home, fileExists, platform);
  const services = inspectServices(args, target, gcloud, runCommand);
  const projectSelected = Boolean(target.projectId);
  const recommendationReason = projectSelected
    ? '发现一个 Project 候选，可在方案中讨论 Gemini/BigQuery 接入；候选、CLI 认证、ADC 和 enabled 状态均未证明 API 可用。分别确认方案并完成必要验证前，Demo 使用模拟对话与合成数据。'
    : '未取得可确认的 Project 候选；这不证明账号没有其他 Project。Demo 可先使用模拟对话与合成数据经营看板，真实接入条件保留在完整方案中。';
  const execution = {
    model: 'simulated',
    data: 'local',
    reason: recommendationReason,
  };

  return {
    version: 1,
    checkedAt: now().toISOString(),
    target,
    cli: {gcloud, bq},
    auth,
    adc,
    services,
    capabilities: {
      gemini: services.gemini.status === 'enabled-unverified' ? 'candidate-unverified' : services.gemini.status,
      bigquery: services.bigquery.status === 'enabled-unverified' ? 'candidate-unverified' : services.bigquery.status,
    },
    recommendedExecution: execution,
    requiresConfirmation: projectSelected,
    boundaries: [
      'CLI、活动配置、认证状态、ADC 文件和已启用服务只表示本地可见配置，不证明 API 权限或实际可用性。',
      '不会列举项目、登录、切换项目、启用服务、创建资源、调用模型或提交 BigQuery 作业。',
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = collectEnvironment({argv: process.argv.slice(2)});
  if (report.error) {
    process.stderr.write(`${report.error}: ${report.usage}\n`);
    process.exitCode = 2;
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}
