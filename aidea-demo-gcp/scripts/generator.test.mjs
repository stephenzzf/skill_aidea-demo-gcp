import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const skill = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(skill, 'scripts/generate.mjs');
const run = args => execFileSync(process.execPath, ['--experimental-strip-types', script, ...args], { encoding: 'utf8' });

test('generate both domains, reject overwrite/unconfirmed configs, update configs while preserving customized source', async t => {
  const temp = await mkdtemp(resolve(tmpdir(), 'me-generator-test-'));
  // Only this test's temporary files are disposable; no app or user data is touched.
  t.after(() => rm(temp, { recursive: true, force: true }));
  for (const domain of ['geo', 'whatsapp']) {
    const spec = resolve(skill, `references/examples/${domain}-spec.json`);
    const data = resolve(skill, `references/examples/${domain}-data.json`);
    const out = resolve(temp, domain);
    const args = ['--spec', spec, '--data', data, '--out', out];
    const result = JSON.parse(run(args));
    assert.equal(result.generatedApplicationCodeLines, 0);
    assert.equal(result.configFiles, 2);
    assert((await lstat(resolve(out, 'server/agent.ts'))).isFile());
    const manifest = JSON.parse(await readFile(resolve(out, 'generation-manifest.json'), 'utf8'));
    assert.equal(manifest.generator, 'aidea-demo-gcp');
    assert.equal(manifest.templateCapabilityVersion, 4);
    assert.deepEqual(manifest.supportedSpecVersions, [1, 2, 3, 4]);
    await assert.rejects(lstat(resolve(out, 'node_modules')));
    assert.equal(spawnSync(process.execPath, ['--experimental-strip-types', script, ...args]).status, 1);
    const custom = '// customer-specific extension\n';
    await writeFile(resolve(out, 'server/extension.ts'), custom);
    const updated = JSON.parse(await readFile(spec, 'utf8'));
    updated.title = '更新后的客户演示';
    const input = resolve(temp, `${domain}-updated.json`);
    await writeFile(input, JSON.stringify(updated));
    // Existing customer manifests retain their provenance after the Skill rename.
    if (domain === 'geo') {
      manifest.generator = 'me-demo-generator';
      await writeFile(resolve(out, 'generation-manifest.json'), JSON.stringify(manifest));
    }
    run(['--spec', input, '--data', data, '--out', out, '--update']);
    assert.equal(JSON.parse(await readFile(resolve(out, 'generation-manifest.json'), 'utf8')).generator, manifest.generator);
    assert.equal(await readFile(resolve(out, 'server/extension.ts'), 'utf8'), custom);
    assert.equal(JSON.parse(await readFile(resolve(out, 'demo-spec.json'), 'utf8')).title, updated.title);
    updated.confirmed = false;
    await writeFile(input, JSON.stringify(updated));
    assert.equal(spawnSync(process.execPath, ['--experimental-strip-types', script, '--spec', input, '--data', data, '--check']).status, 1);
  }
});

test('V2 generation imports customer CSV into validated config and legacy manifest refuses V2 update without overwriting', async t => {
  const temp = await mkdtemp(resolve(tmpdir(), 'me-generator-v2-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const scenarioDir = resolve(temp, 'scenario');
  await (await import('node:fs/promises')).mkdir(scenarioDir);
  const customerCsv = resolve(scenarioDir, 'records.csv');
  const spec = JSON.parse(await readFile(resolve(skill, 'references/examples/geo-spec.json'), 'utf8'));
  spec.version = 2;
  spec.design = {
    facts: ['方案已确认'], assumptions: ['样例数据仅用于演示'], implementation: ['本地模拟'],
    coverage: [{ claim: '可下钻查看记录', status: 'simulated', evidence: '记录列表' }],
  };
  spec.workspace = {
    views: ['overview', 'records'], roles: [{ id: 'analyst', label: '分析人员' }], stages: [{ id: 'open', label: '待处理' }],
    datasets: [{ id: 'records', label: '业务记录', key: 'record_id', origin: 'customer', source: '客户授权 CSV', fields: [
      { id: 'record_id', label: '记录编号', type: 'string', required: true },
      { id: 'value', label: '数值', type: 'number', required: true },
    ] }], metrics: [],
  };
  const data = {
    version: 2, synthetic: false, instruction: '只基于配置来源回答。', topics: [],
    workspace: { datasets: [{ id: 'records', file: 'records.csv', mapping: { record_id: 'ID', value: 'Value' } }] },
  };
  await writeFile(customerCsv, 'ID,Value\nr-1,3.5\nr-2,4\n');
  const specPath = resolve(scenarioDir, 'demo-spec.json');
  const dataPath = resolve(scenarioDir, 'scenario.json');
  await writeFile(specPath, JSON.stringify(spec));
  await writeFile(dataPath, JSON.stringify(data));
  const output = resolve(temp, 'v2');
  const result = JSON.parse(run(['--spec', specPath, '--data', dataPath, '--out', output]));
  assert.equal(result.version, 2);
  assert.equal(result.datasets, 1);
  assert.deepEqual(result.generatedDocuments, ['SOLUTION.md', 'PLAYBOOK.md', 'VALIDATION.md']);
  for (const file of result.generatedDocuments) assert((await lstat(resolve(output, file))).isFile());
  const materialized = JSON.parse(await readFile(resolve(output, 'scenario.json'), 'utf8'));
  assert.deepEqual(materialized.workspace.datasets[0].rows, [
    { record_id: 'r-1', value: 3.5 }, { record_id: 'r-2', value: 4 },
  ]);
  assert(!('file' in materialized.workspace.datasets[0]));

  const legacy = resolve(temp, 'legacy');
  run(['--spec', resolve(skill, 'references/examples/geo-spec.json'), '--data', resolve(skill, 'references/examples/geo-data.json'), '--out', legacy]);
  const legacyManifestPath = resolve(legacy, 'generation-manifest.json');
  const legacyManifest = JSON.parse(await readFile(legacyManifestPath, 'utf8'));
  delete legacyManifest.templateCapabilityVersion;
  delete legacyManifest.supportedSpecVersions;
  await writeFile(legacyManifestPath, JSON.stringify(legacyManifest));
  const before = await readFile(resolve(legacy, 'demo-spec.json'), 'utf8');
  const rejected = spawnSync(process.execPath, ['--experimental-strip-types', script, '--spec', specPath, '--data', dataPath, '--out', legacy, '--update'], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /不支持配置 V2/);
  assert.equal(await readFile(resolve(legacy, 'demo-spec.json'), 'utf8'), before);
});

test('access helper creates private, nonoverwriting credentials; deployment is a validated dry preview', async t => {
  const temp = await mkdtemp(resolve(tmpdir(), 'me-access-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const access = resolve(skill, 'assets/app/scripts/access.mjs');
  const file = resolve(temp, 'local.env');
  const printed = execFileSync(process.execPath, [access, file], { encoding: 'utf8' });
  const env = parseEnv(await readFile(file, 'utf8'));
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.equal(env.DEMO_ACCESS_CODE_HASH, createHash('sha256').update(env.DEMO_OPERATOR_ACCESS_CODE).digest('hex'));
  assert(!printed.includes(env.DEMO_OPERATOR_ACCESS_CODE));
  assert(Date.parse(env.DEMO_ACCESS_EXPIRES_AT) > Date.now() + 86300000);
  assert.equal(spawnSync(process.execPath, [access, file]).status, 1);
  const generatedApp = resolve(temp, 'deploy-app');
  run(['--spec', resolve(skill, 'references/examples/geo-spec.json'), '--data', resolve(skill, 'references/examples/geo-data.json'), '--out', generatedApp]);
  const deploy = resolve(generatedApp, 'scripts/deploy.mjs');
  const deployEnv = { ...env, DEMO_MODEL_MODE: 'vertex', GOOGLE_CLOUD_PROJECT: 'local-test-project', GOOGLE_CLOUD_LOCATION: 'us-central1', DEMO_MODEL: 'configured-model' };
  delete deployEnv.DEMO_OPERATOR_ACCESS_CODE;
  const deployFile = resolve(temp, 'deploy.json');
  await writeFile(deployFile, JSON.stringify(deployEnv), { mode: 0o600 });
  const args = [deploy, '--project', 'local-test-project', '--region', 'asia-southeast1', '--service', 'local-test-demo', '--service-account', 'demo@local-test-project.iam.gserviceaccount.com', '--env-file', deployFile];
  const options = { encoding: 'utf8', cwd: generatedApp };
  const previewText = execFileSync(process.execPath, args, options);
  const preview = JSON.parse(previewText);
  assert.equal(preview.program, 'gcloud');
  assert(preview.args.includes('--project=local-test-project'));
  assert(!previewText.includes(env.DEMO_COOKIE_SECRET));
  assert.equal(spawnSync(process.execPath, [...args.slice(0, 2), 'different-project', ...args.slice(3)], options).status, 1);
  for (const change of [
    { DEMO_ACCESS_CODE_HASH: 'x' }, { DEMO_COOKIE_SECRET: 'x' },
    { DEMO_ACCESS_EXPIRES_AT: '2020-01-01T00:00:00Z' }, { DEMO_REQUEST_TIMEOUT_MS: 'abc' },
  ]) {
    await writeFile(deployFile, JSON.stringify({ ...deployEnv, ...change }));
    assert.equal(spawnSync(process.execPath, args, options).status, 1);
  }
  deployEnv.DEMO_OPERATOR_ACCESS_CODE = env.DEMO_OPERATOR_ACCESS_CODE;
  await writeFile(deployFile, JSON.stringify(deployEnv));
  assert.equal(spawnSync(process.execPath, args, options).status, 1);
  // A file inside the app is rejected even if it has no secrets and valid permissions.
  const buildFile = resolve(skill, 'assets/app/package.json');
  assert.equal(spawnSync(process.execPath, [...args.slice(0, -1), buildFile], options).status, 1);
});

test('V3 generates different business domains, rejects unconfirmed or unsupported inputs and invalidates old evidence without overwriting source', async t => {
  const temp = await mkdtemp(resolve(tmpdir(), 'me-generator-v3-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const pageNames = [];
  for (const domain of ['geo', 'service']) {
    const specPath = resolve(skill, `references/examples/v3/${domain}-spec.json`);
    const dataPath = resolve(skill, `references/examples/v3/${domain}-data.json`);
    const output = resolve(temp, domain);
    const result = JSON.parse(run(['--spec', specPath, '--data', dataPath, '--out', output]));
    assert.equal(result.version, 3);
    const spec = JSON.parse(await readFile(resolve(output, 'demo-spec.json'), 'utf8'));
    pageNames.push(spec.pages.map(page => page.title));
    const solution = await readFile(resolve(output, 'SOLUTION.md'), 'utf8');
    assert(solution.includes(spec.blueprint.objectives[0].measure));
    assert(solution.includes(spec.pages[0].title));
    assert((await readFile(resolve(output, 'PLAYBOOK.md'), 'utf8')).includes(spec.steps[0].observation));
    let record = JSON.parse(await readFile(resolve(output, 'validation-record.json'), 'utf8'));
    assert.equal(record.status, 'pending');
    record.entries.push({ id: spec.steps[0].id, status: 'passed', evidence: 'manual-check', basisDigest: record.basis.digest });
    record.status = 'recorded';
    await writeFile(resolve(output, 'validation-record.json'), JSON.stringify(record));
    await writeFile(resolve(output, 'server/customer.ts'), '// customer extension retained\n');
    await writeFile(resolve(output, 'SOLUTION.md'), 'human-reviewed solution');
    run(['--spec', specPath, '--data', dataPath, '--out', output, '--update']);
    record = JSON.parse(await readFile(resolve(output, 'validation-record.json'), 'utf8'));
    assert.equal(record.status, 'needs-revalidation');
    assert.equal(record.entries[0].stale, true);
    assert.equal(record.history.length, 1);
    assert.equal(record.history[0].entries[0].evidence, 'manual-check');
    assert.equal(await readFile(resolve(output, 'server/customer.ts'), 'utf8'), '// customer extension retained\n');
    assert.equal(await readFile(resolve(output, 'SOLUTION.md'), 'utf8'), 'human-reviewed solution');
    spec.confirmed = false;
    const invalid = resolve(temp, `${domain}-invalid.json`);
    await writeFile(invalid, JSON.stringify(spec));
    assert.equal(spawnSync(process.execPath, ['--experimental-strip-types', script, '--spec', invalid, '--data', dataPath, '--check']).status, 1);
    spec.confirmed = true;
    spec.pages[0].components.push('arbitrary-script');
    await writeFile(invalid, JSON.stringify(spec));
    assert.equal(spawnSync(process.execPath, ['--experimental-strip-types', script, '--spec', invalid, '--data', dataPath, '--check']).status, 1);
  }
  assert.notDeepEqual(pageNames[0], pageNames[1]);
});

test('chat references require a runtime that declares the built-in chat tab', async t => {
  const temp = await mkdtemp(resolve(tmpdir(), 'me-generator-chat-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const originalSpec = resolve(skill, 'references/examples/v3/service-spec.json');
  const data = resolve(skill, 'references/examples/v3/service-data.json');
  const output = resolve(temp, 'app');
  run(['--spec', originalSpec, '--data', data, '--out', output]);
  const manifestPath = resolve(output, 'generation-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert(manifest.templateFeatures.includes('chat-tab'));
  delete manifest.templateFeatures;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const spec = JSON.parse(await readFile(originalSpec, 'utf8'));
  spec.pages[0].links.push({ label: 'AI 智能对话', pageId: 'chat' });
  const input = resolve(temp, 'spec.json');
  await writeFile(input, JSON.stringify(spec));
  const before = await readFile(resolve(output, 'demo-spec.json'), 'utf8');
  const rejected = spawnSync(process.execPath, ['--experimental-strip-types', script, '--spec', input, '--data', data, '--out', output, '--update'], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /不支持独立 chat Tab/);
  assert.equal(await readFile(resolve(output, 'demo-spec.json'), 'utf8'), before);
  manifest.templateFeatures = ['chat-tab'];
  await writeFile(manifestPath, JSON.stringify(manifest));
  run(['--spec', input, '--data', data, '--out', output, '--update']);
  assert.equal(JSON.parse(await readFile(resolve(output, 'demo-spec.json'), 'utf8')).pages[0].links.at(-1).pageId, 'chat');
});

test('website evidence produces a scoped site-review artifact without performing a crawl', async t => {
  const temp = await mkdtemp(resolve(tmpdir(), 'me-site-review-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const raw = JSON.parse(await readFile(resolve(skill, 'references/examples/v3/geo-spec.json'), 'utf8'));
  raw.blueprint.sources.push({ id: 'website-fixture', title: '未联网的检查报告测试夹具', kind: 'website', status: 'unavailable',
    url: 'https://example.invalid/catalog', checkedAt: '2026-10-24T08:00:00Z', region: 'fixture-only', finding: '测试夹具：没有实际访问，不代表站点现状。' });
  const input = resolve(temp, 'spec.json');
  await writeFile(input, JSON.stringify(raw));
  const result = JSON.parse(run(['--spec', input, '--data', resolve(skill, 'references/examples/v3/geo-data.json'), '--out', resolve(temp, 'app')]));
  assert(result.generatedDocuments.includes('SITE-REVIEW.md'));
  const report = await readFile(resolve(temp, 'app/SITE-REVIEW.md'), 'utf8');
  assert(report.includes('https://example.invalid/catalog'));
  assert(report.includes('unavailable'));
  assert(report.includes('没有实际访问'));
});
