import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseRuntimeConfig } from '../server/config.ts';

const empty = { project: '', location: '', model: '' };
const cloud = { project: 'fixture-project', location: 'global', model: 'fixture-model' };
const env = { DEMO_MODEL_MODE: 'simulated', DEMO_ACCESS_CODE_HASH: randomBytes(32).toString('hex'), DEMO_COOKIE_SECRET: randomBytes(32).toString('hex'), DEMO_ACCESS_EXPIRES_AT: new Date(Date.now() + 60000).toISOString() };
test('all four confirmed execution combinations keep model and data independent; simulation needs no Google settings', () => {
  for (const model of ['simulated', 'vertex'] as const) for (const data of ['local', 'bigquery'] as const) {
    const actual = parseRuntimeConfig(model === 'vertex' ? cloud : empty, { ...env, DEMO_MODEL_MODE: model }, { model, data });
    assert.equal(actual.mode, model);
    if (model === 'simulated') assert.equal(actual.project, '');
  }
  assert.throws(() => parseRuntimeConfig(empty, { ...env, DEMO_MODEL_MODE: 'vertex' }), /project、location 和 model/);
  assert.throws(() => parseRuntimeConfig(cloud, { ...env, DEMO_MODEL_MODE: 'vertex' }, { model: 'simulated', data: 'local' }), /不一致/);
  assert.throws(() => parseRuntimeConfig(cloud, env, { model: 'vertex', data: 'bigquery' }), /不一致/);
  assert.throws(() => parseRuntimeConfig(empty, { ...env, DEMO_MODEL_MODE: '' }), /显式设置/);
  assert.equal(parseRuntimeConfig(empty, { ...env, DEMO_MODEL_MODE: 'test' }).mode, 'test');
});
test('access setup defaults to formal simulation; explicit legacy test/Vertex are supported without overwriting files', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'me-execution-access-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const mode of ['simulated', 'vertex', 'test']) {
    const path = resolve(dir, `${mode}.env`);
    execFileSync(process.execPath, ['scripts/access.mjs', path, ...(mode === 'simulated' ? [] : ['--mode', mode])]);
    const text = await readFile(path, 'utf8');
    assert(text.includes(`DEMO_MODEL_MODE=${mode}`));
    assert(!text.includes('GOOGLE_CLOUD_PROJECT'));
    assert.throws(() => execFileSync(process.execPath, ['scripts/access.mjs', path], { stdio: 'pipe' }));
  }
});

test('explicit local profile refuses cloud/undeclared extensions; BigQuery requires a registered adapter', async () => {
  const { createApp } = await import('../server/app.ts');
  const { parseSpec, parseScenario } = await import('../shared/spec.ts');
  const spec = parseSpec(JSON.parse(await readFile('demo-spec.json','utf8')));
  const scenario = parseScenario(JSON.parse(await readFile('scenario.json','utf8')),spec.workspace,spec);
  const runtime = parseRuntimeConfig(empty,env);
  const local = {...spec,execution:{model:'simulated' as const,data:'local' as const}};
  const cloud = {...spec,execution:{model:'simulated' as const,data:'bigquery' as const}};
  const adapter = {id:'fixture',dataBackend:'bigquery' as const,parseContext:()=>({})};
  assert.throws(()=>createApp(local,scenario,runtime,undefined,adapter),/dataBackend/);
  assert.throws(()=>createApp(local,scenario,runtime,undefined,{id:'legacy',parseContext:()=>({})}),/dataBackend/);
  assert.throws(()=>createApp(cloud,scenario,runtime,undefined,undefined),/BigQuery/);
  assert.doesNotThrow(()=>createApp({...spec,execution:undefined},scenario,runtime,undefined,adapter));
});
