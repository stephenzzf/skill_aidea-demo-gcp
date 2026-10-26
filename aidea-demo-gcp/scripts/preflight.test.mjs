import test from 'node:test';
import assert from 'node:assert/strict';
import {collectEnvironment} from './preflight.mjs';

const commandKey = (command, args) => `${command} ${args.join(' ')}`;
const ok = stdout => ({status: 0, stdout, stderr: 'private-error@example.com token=do-not-print'});
const failed = (code = 'EACCES') => ({status: null, stdout: '', stderr: 'private-error@example.com token=do-not-print', error: {code}});

function fixture({project = 'demo-project-123', auth = 'ACTIVE', services, commands = {}} = {}) {
  const calls = [];
  const runCommand = (command, args) => {
    calls.push({command, args});
    const key = commandKey(command, args);
    if (Object.hasOwn(commands, key)) return commands[key];
    if (command === 'gcloud' && args[0] === '--version') return ok('Google Cloud SDK 552.0.0\nsecret output that must not leak');
    if (command === 'bq' && args[0] === 'version') return ok('BigQuery CLI version 2.1.22\nother diagnostic output');
    if (command === 'gcloud' && args[0] === 'config') return ok(`${project}\n`);
    if (command === 'gcloud' && args[0] === 'auth') return ok(auth ? 'hidden-principal@example.com\n' : '');
    if (command === 'gcloud' && args[0] === 'services') return ok(services ?? '');
    return failed('ENOENT');
  };
  return {calls, runCommand};
}

const fixedNow = () => new Date('2026-10-25T09:00:00.000Z');

test('默认检查只读本地 CLI/config/auth，不发起服务查询并推荐模拟体验', () => {
  const {calls, runCommand} = fixture({project: '(unset)', auth: ''});
  const report = collectEnvironment({argv: [], runCommand, env: {}, home: '/fake-home', fileExists: () => false, now: fixedNow});
  assert.equal(report.checkedAt, '2026-10-25T09:00:00.000Z');
  assert.equal(report.cli.gcloud.version, '552.0.0');
  assert.equal(report.cli.bq.version, '2.1.22');
  assert.equal(report.target.projectId, null);
  assert.equal(report.target.discovery, 'not-configured');
  assert.equal(report.services.checked, false);
  assert.equal(report.recommendedExecution.model, 'simulated');
  assert.equal(report.recommendedExecution.data, 'local');
  assert.match(report.recommendedExecution.reason, /不证明账号没有其他 Project/);
  assert.deepEqual(calls.map(call => commandKey(call.command, call.args)), [
    'gcloud --version',
    'bq version',
    'gcloud config get-value project',
    'gcloud auth list --filter=status:ACTIVE --format=value(account)',
  ]);
  assert.equal(JSON.stringify(report).includes('private-error@example.com'), false);
  assert.equal(JSON.stringify(report).includes('do-not-print'), false);
  assert.equal(JSON.stringify(report).includes('secret output'), false);
});

test('没有 gcloud/bq 时仍成功返回可本地模拟的报告，不把缺失 CLI 当成没有云项目', () => {
  const calls = [];
  const runCommand = (command, args) => {
    calls.push({command, args});
    return failed('ENOENT');
  };
  const report = collectEnvironment({argv: [], runCommand, env: {}, home: '/fake-home', fileExists: () => false, now: fixedNow});
  assert.equal(report.cli.gcloud.status, 'absent');
  assert.equal(report.cli.bq.status, 'absent');
  assert.equal(report.target.discovery, 'unknown');
  assert.equal(report.auth.status, 'unknown');
  assert.equal(report.adc.status, 'unknown');
  assert.equal(report.recommendedExecution.model, 'simulated');
  assert.equal(report.recommendedExecution.data, 'local');
  assert.equal(calls.length, 2);
});

test('显式项目优先，服务检查须显式开启，服务启用只成为候选且不提升为验证通过', () => {
  const {calls, runCommand} = fixture({
    project: 'active-project-1',
    services: 'aiplatform.googleapis.com\nbigquery.googleapis.com\n',
  });
  const report = collectEnvironment({
    argv: ['--project', 'chosen-project-2', '--check-services'],
    runCommand,
    env: {GOOGLE_APPLICATION_CREDENTIALS: '/private/path/key.json'},
    home: '/fake-home',
    fileExists: () => false,
    now: fixedNow,
  });
  assert.equal(report.target.projectId, 'chosen-project-2');
  assert.equal(report.target.source, 'explicit');
  assert.equal(report.requiresConfirmation, true);
  assert.match(report.recommendedExecution.reason, /Project 候选/);
  assert.equal(report.adc.status, 'configured-unverified');
  assert.equal(report.adc.verified, false);
  assert.equal(report.services.gemini.status, 'enabled-unverified');
  assert.equal(report.services.bigquery.status, 'enabled-unverified');
  assert.equal(report.capabilities.gemini, 'candidate-unverified');
  assert.equal(report.capabilities.bigquery, 'candidate-unverified');
  assert.equal(calls.some(call => call.command === 'gcloud' && call.args[0] === 'config'), false);
  assert.equal(calls.some(call => call.command === 'gcloud' && call.args[0] === 'services'), true);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('/private/path/key.json'), false);
  assert.equal(serialized.includes('active-project-1'), false);
});

test('未指定项目时采用 gcloud 活动配置候选，CLI 活动账号只输出状态', () => {
  const {runCommand} = fixture({project: 'configured-project-7', auth: 'ACTIVE'});
  const report = collectEnvironment({argv: [], runCommand, env: {}, home: '/fake-home', fileExists: () => false, now: fixedNow});
  assert.equal(report.target.projectId, 'configured-project-7');
  assert.equal(report.target.source, 'gcloud-active-configuration');
  assert.equal(report.auth.status, 'active');
  assert.equal(JSON.stringify(report).includes('hidden-principal@example.com'), false);
  assert.equal(JSON.stringify(report).includes('private-error@example.com'), false);
});

test('未能读取服务状态时标为 unknown 而非 not-enabled，且只检查显式目标', () => {
  const {calls, runCommand} = fixture({commands: {
    'gcloud services list --enabled --project=target-project-3 --format=value(config.name)': failed('EACCES'),
  }});
  const report = collectEnvironment({argv: ['--project=target-project-3', '--check-services'], runCommand, env: {}, home: '/fake-home', fileExists: () => false, now: fixedNow});
  assert.equal(report.services.gemini.status, 'unknown');
  assert.equal(report.services.bigquery.status, 'unknown');
  assert.equal(report.services.gemini.diagnosticCode, 'SERVICE_STATUS_UNAVAILABLE');
  assert.deepEqual(calls.find(call => call.command === 'gcloud' && call.args[0] === 'services').args, [
    'services', 'list', '--enabled', '--project=target-project-3', '--format=value(config.name)',
  ]);
});

test('没有目标项目时不查询 enabled services，ADC 本地文件只报告存在而不读取内容', () => {
  const {calls, runCommand} = fixture({project: '(unset)'});
  const checkedPaths = [];
  const report = collectEnvironment({
    argv: ['--check-services'],
    runCommand,
    env: {},
    home: '/fake-home',
    fileExists: path => { checkedPaths.push(path); return true; },
    now: fixedNow,
  });
  assert.equal(report.adc.status, 'present-unverified');
  assert.equal(report.adc.source, 'local-default-file');
  assert.equal(JSON.stringify(report).includes('/fake-home'), false);
  assert.equal(checkedPaths.length, 1);
  assert.equal(calls.some(call => call.command === 'gcloud' && call.args[0] === 'services'), false);
  assert.equal(report.services.gemini.status, 'unknown');
});

test('ADC 环境变量仅表示已配置；本地文件检查故障保持 unknown', () => {
  const {runCommand} = fixture({project: '(unset)'});
  let fileCheckCount = 0;
  const configured = collectEnvironment({
    argv: [], runCommand, env: {GOOGLE_APPLICATION_CREDENTIALS: '/private/not-checked.json'}, home: '/fake-home',
    fileExists: () => { fileCheckCount += 1; return false; }, now: fixedNow,
  });
  assert.equal(configured.adc.status, 'configured-unverified');
  assert.equal(fileCheckCount, 0);
  assert.equal(JSON.stringify(configured).includes('/private/not-checked.json'), false);

  const failedLocalCheck = collectEnvironment({
    argv: [], runCommand, env: {}, home: '/fake-home',
    fileExists: () => { throw new Error('do-not-surface'); }, now: fixedNow,
  });
  assert.equal(failedLocalCheck.adc.status, 'unknown');
  assert.equal(failedLocalCheck.adc.source, 'local-check-unavailable');
  assert.equal(JSON.stringify(failedLocalCheck).includes('do-not-surface'), false);
});

test('显式项目无效时不回退活动项目，也不访问服务', () => {
  const {calls, runCommand} = fixture({project: 'active-project-1'});
  const report = collectEnvironment({argv: ['--project=../../other'], runCommand, env: {}, home: '/fake-home', fileExists: () => false, now: fixedNow});
  assert.equal(report.target.projectId, null);
  assert.equal(report.target.source, 'invalid-explicit');
  assert.equal(report.target.diagnosticCode, 'PROJECT_ID_INVALID');
  assert.equal(calls.some(call => call.command === 'gcloud' && call.args[0] === 'config'), false);
  assert.equal(calls.some(call => call.command === 'gcloud' && call.args[0] === 'services'), false);
});

test('未知 auth 输出、配置 stdout 与诊断均不泄漏用户账号或原始 stderr', () => {
  const {runCommand} = fixture({commands: {
    'gcloud auth list --filter=status:ACTIVE --format=value(account)': failed('EACCES'),
    'gcloud config get-value project': ok('not-a-valid-project\nuser@example.com'),
  }});
  const report = collectEnvironment({argv: [], runCommand, env: {}, home: '/fake-home', fileExists: () => false, now: fixedNow});
  assert.equal(report.auth.status, 'unknown');
  assert.equal(report.target.discovery, 'unknown');
  assert.equal(JSON.stringify(report).includes('user@example.com'), false);
  assert.equal(JSON.stringify(report).includes('hidden-principal@example.com'), false);
  assert.equal(JSON.stringify(report).includes('private-error@example.com'), false);
});
