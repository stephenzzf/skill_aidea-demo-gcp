import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, cp, symlink } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const project = 'fixture-cloud-project';
const accessHash = 'a'.repeat(64);
const cookieSecret = 'fixture-cookie-secret-that-is-not-real';

function validEnv(): Record<string, string> {
  return {
    DEMO_MODEL_MODE: 'vertex',
    DEMO_ACCESS_CODE_HASH: accessHash,
    DEMO_COOKIE_SECRET: cookieSecret,
    DEMO_ACCESS_EXPIRES_AT: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    GOOGLE_CLOUD_PROJECT: project,
    GOOGLE_CLOUD_LOCATION: 'us-central1',
    DEMO_MODEL: 'gemini-fixture-model',
    BQ_PROJECT: 'fixture-bq-project',
    BQ_LOCATION: 'US',
    BQ_DATASET: 'fixture_dataset',
  };
}

async function runDeploy(env: Record<string, string>, extraArgs: string[] = []) {
  const scratch = await mkdtemp(join(tmpdir(), 'me-demo-deploy-test-'));
  try {
    const envFile = join(scratch, 'deploy.json');
    const binDir = join(scratch, 'bin');
    const capturePath = join(scratch, 'gcloud-args.txt');
    await mkdir(binDir);
    // Test the deployment contract independently of the customer's selected execution mode.
    const fixtureApp = join(scratch, 'app');
    await mkdir(join(fixtureApp, 'scripts'), { recursive: true });
    for (const name of ['deploy.mjs', 'private-path.mjs']) await cp(join(appRoot, 'scripts', name), join(fixtureApp, 'scripts', name));
    for (const name of ['server', 'shared']) await cp(join(appRoot, name), join(fixtureApp, name), { recursive: true });
    await symlink(join(appRoot, 'node_modules'), join(fixtureApp, 'node_modules'), 'dir');
    const spec = JSON.parse(await readFile(join(appRoot, 'demo-spec.json'), 'utf8'));
    if (spec.version >= 4) spec.execution = { model: 'vertex', data: 'bigquery' };
    await writeFile(join(fixtureApp, 'demo-spec.json'), JSON.stringify(spec));
    const deployScript = join(fixtureApp, 'scripts', 'deploy.mjs');
    await writeFile(envFile, JSON.stringify(env), { mode: 0o600 });
    await writeFile(
      join(binDir, 'gcloud'),
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$DEPLOY_TEST_CAPTURE"\n',
      { mode: 0o700 },
    );

    const child = spawnSync(process.execPath, [
      deployScript,
      '--project', project,
      '--region', 'asia-southeast1',
      '--service', 'fixture-demo',
      '--service-account', `fixture-runtime@${project}.iam.gserviceaccount.com`,
      '--env-file', envFile,
      ...extraArgs,
    ], {
      cwd: fixtureApp,
      encoding: 'utf8',
      env: {
        PATH: [binDir, '/usr/bin', '/bin'].join(delimiter),
        TMPDIR: scratch,
        DEPLOY_TEST_CAPTURE: capturePath,
      },
    });
    let gcloudArgs: string[] | undefined;
    try {
      const captured = await readFile(capturePath, 'utf8');
      gcloudArgs = captured.trimEnd().split('\n');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { child, gcloudArgs };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test('dry-run prints request-based, zero-minimum deploy settings and does not invoke gcloud', async () => {
  const { child, gcloudArgs } = await runDeploy(validEnv());
  assert.equal(child.status, 0, child.stderr);
  assert.equal(gcloudArgs, undefined);

  const output = JSON.parse(child.stdout) as { program: string; args: string[]; note: string };
  assert.equal(output.program, 'gcloud');
  assert.deepEqual(output.args.slice(0, 2), ['run', 'deploy']);
  assert.ok(output.args.includes('--allow-unauthenticated'));
  assert.ok(output.args.includes('--cpu-throttling'));
  assert.ok(output.args.includes('--min=0'));
  assert.ok(output.args.includes('--min-instances=0'));
  assert.ok(output.args.includes('--timeout=300'));
  assert.equal(output.args.some(arg => arg === '--max' || arg.startsWith('--max=') || arg === '--max-instances' || arg.startsWith('--max-instances=')), false);
  assert.match(output.note, /服务级 IAM/u);
  assert.doesNotMatch(child.stdout, new RegExp(accessHash));
  assert.doesNotMatch(child.stdout, new RegExp(cookieSecret));
});

test('BigQuery mode rejects each missing required deployment setting', async t => {
  for (const name of ['BQ_PROJECT', 'BQ_LOCATION', 'BQ_DATASET']) {
    await t.test(name, async () => {
      const env = validEnv();
      delete env[name];
      const { child, gcloudArgs } = await runDeploy(env);
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, new RegExp(`${name}`));
      assert.equal(gcloudArgs, undefined);
    });
  }
});

test('raw/mart dataset pair works without BQ_DATASET and --execute calls only fake gcloud', async () => {
  const env = validEnv();
  delete env.BQ_DATASET;
  env.BQ_RAW_DATASET = 'fixture_raw';
  env.BQ_MART_DATASET = 'fixture_mart';
  const { child, gcloudArgs } = await runDeploy(env, ['--execute']);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(gcloudArgs?.slice(0, 2), ['run', 'deploy']);
  assert.ok(gcloudArgs?.includes('--allow-unauthenticated'));
  assert.ok(gcloudArgs?.includes('--cpu-throttling'));
  assert.ok(gcloudArgs?.includes('--min=0'));
  assert.ok(gcloudArgs?.includes('--min-instances=0'));
  assert.equal(gcloudArgs?.some(arg => arg.includes('add-iam-policy-binding') || arg.includes('projects add-iam')), false);
  assert.doesNotMatch(child.stdout + child.stderr, new RegExp(accessHash));
  assert.doesNotMatch(child.stdout + child.stderr, new RegExp(cookieSecret));
});

test('rejects incomplete or mixed BigQuery dataset forms', async t => {
  const rawOnly: Record<string, string> = { ...validEnv(), BQ_RAW_DATASET: 'fixture_raw' };
  delete rawOnly.BQ_DATASET;
  const mixed = { ...validEnv(), BQ_RAW_DATASET: 'fixture_raw', BQ_MART_DATASET: 'fixture_mart' };
  for (const [name, env] of [['raw dataset without mart', rawOnly], ['single dataset and raw/mart pair', mixed]] as const) {
    await t.test(name, async () => {
      const { child, gcloudArgs } = await runDeploy(env);
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, /BQ_RAW_DATASET|BQ_DATASET/u);
      assert.equal(gcloudArgs, undefined);
    });
  }
});

test('rejects malformed BigQuery identifiers', async t => {
  for (const [name, value] of [['BQ_LOCATION', 'asia/east'], ['BQ_DATASET', 'fixture.dataset']] as const) {
    await t.test(name, async () => {
      const { child, gcloudArgs } = await runDeploy({ ...validEnv(), [name]: value });
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, new RegExp(name));
      assert.equal(gcloudArgs, undefined);
    });
  }
});

test('rejects original access codes and local ADC paths without echoing their values', async t => {
  for (const [name, value] of [
    ['DEMO_OPERATOR_ACCESS_CODE', 'fixture-original-access-code-do-not-log'],
    ['GOOGLE_APPLICATION_CREDENTIALS', '/fixture/private/local-adc.json'],
  ] as const) {
    await t.test(name, async () => {
      const { child, gcloudArgs } = await runDeploy({ ...validEnv(), [name]: value });
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, /不需要的变量/u);
      assert.doesNotMatch(child.stdout + child.stderr, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(gcloudArgs, undefined);
    });
  }
});
