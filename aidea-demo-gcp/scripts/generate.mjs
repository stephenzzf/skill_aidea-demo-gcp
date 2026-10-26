#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseSpec, parseScenario } from '../assets/app/shared/spec.ts';
import { importScenarioWorkspace } from './data-import.mjs';
import { writeDeliverables } from './deliverables.mjs';
import { refreshValidation } from './validation.mjs';
import { readReuse, applyReuse } from './reuse.mjs';

const skill = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = resolve(skill, 'assets/app');
const excluded = new Set(['node_modules', 'dist', '.git', 'evidence', 'demo-spec.json', 'scenario.json']);
const sha = value => createHash('sha256').update(value).digest('hex');
const json = path => readFile(path, 'utf8').then(JSON.parse);
async function files(root, prefix = '') {
  const found = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    if (excluded.has(entry.name) || (entry.name.startsWith('.env') && entry.name !== '.env.example')) continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`模板含符号链接：${name}`);
    if (entry.isDirectory()) found.push(...await files(root, name));
    else found.push(name);
  }
  return found.sort();
}
function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--check' || key === '--update') result[key.slice(2)] = true;
    else if (['--spec', '--data', '--out', '--reuse'].includes(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) result[key.slice(2)] = argv[++i];
    else throw new Error(`未知或缺值参数：${key}`);
  }
  if (!result.spec || !result.data || (!result.check && !result.out)) throw new Error('用法：generate.mjs --spec /abs/demo-spec.json --data /abs/scenario.json --out /abs/new-directory [--update | --check]');
  return result;
}
async function main() {
  const started = performance.now();
  const options = args(process.argv.slice(2));
  if(options.reuse && options.update) throw new Error('--reuse仅支持新目录生成，不覆盖已有源码');
  const reuse=options.reuse ? await readReuse(options.reuse) : undefined;
  const spec = parseSpec(await json(options.spec));
  if(reuse && spec.version<3) throw new Error('静态领域扩展要求V3/V4方案配置');
  if(reuse && sha(await readFile(resolve(template,'package-lock.json')))!==reuse.manifest.dependencyDigest) throw new Error('目标模板与扩展依赖锁不一致；先核实依赖，不创建部分输出');
  const rawScenario = await json(options.data);
  const importedScenario = spec.version >= 2
    ? await importScenarioWorkspace(rawScenario, options.data, spec.workspace)
    : rawScenario;
  const scenario = parseScenario(importedScenario, spec.workspace, spec);
  if (options.check) {
    console.log(JSON.stringify({ valid: true, id: spec.id, version: spec.version, topics: scenario.topics.length, datasets: scenario.workspace?.datasets.length ?? 0, ...(reuse ? {reuse:{id:reuse.manifest.id,files:reuse.manifest.files.length}} : {}) }));
    return;
  }
  if (!isAbsolute(options.out)) throw new Error('--out 必须是绝对路径');
  const output = resolve(options.out);
  const fromSkill = relative(skill, output);
  if (!fromSkill.startsWith(`..${sep}`) || skill.startsWith(output + sep)) throw new Error('输出目录必须在 Skill 外部');
  let exists = false;
  try { exists = Boolean(await lstat(output)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let manifest;
  if (options.update) {
    if (!exists || !(await lstat(output)).isDirectory()) throw new Error('更新目标必须是已有应用目录');
    manifest = await json(resolve(output, 'generation-manifest.json'));
    if (!['aidea-demo-gcp', 'me-demo-generator'].includes(manifest.generator) || manifest.demoId !== spec.id) throw new Error('更新目标不属于此 Demo；不得更换 id');
    const supportedVersions = manifest.supportedSpecVersions ?? [1];
    if (!supportedVersions.includes(spec.version) || (spec.version >= 2 && (manifest.templateCapabilityVersion ?? 1) < spec.version)) {
      throw new Error(`现有 Demo 模板不支持配置 V${spec.version}；请先在新目录生成对应版本应用并迁移明确的客户扩展，原目录不会被覆盖。`);
    }
    if (spec.execution && !manifest.templateFeatures?.includes('execution-modes-v1')) throw new Error('现有运行时不支持execution与正式模拟模式；请在新目录升级，不覆盖客户源码');
    if (spec.presentation?.workspaceLayout === 'split' && !manifest.templateFeatures?.includes('split-workspace-v1')) {
      throw new Error('现有模板不支持split工作区；请在新目录升级运行时，不覆盖客户源码。');
    }
    const linksToChat = spec.version >= 3 && (spec.steps.some(step => step.pageId === 'chat')
      || spec.blueprint.journey.some(step => step.domainId === 'chat')
      || spec.pages.some(page => page.links.some(link => link.pageId === 'chat')));
    if (linksToChat && !manifest.templateFeatures?.includes('chat-tab')) {
      throw new Error('现有模板不支持独立 chat Tab 引用；请在新目录升级运行时，不覆盖客户源码。');
    }
    for (const name of ['demo-spec.json', 'scenario.json', 'generation-manifest.json']) {
      if (!(await lstat(resolve(output, name))).isFile()) throw new Error(`更新目标必须是普通文件：${name}`);
    }
  } else {
    if (exists) throw new Error('输出目录已存在；不覆盖。更新配置请显式使用 --update');
    const names = await files(template);
    await mkdir(output, { recursive: true });
    for (const name of names) {
      await mkdir(dirname(resolve(output, name)), { recursive: true });
      await cp(resolve(template, name), resolve(output, name));
    }
    const hashes = await Promise.all(names.map(async name => ({ path: name, sha256: sha(await readFile(resolve(output, name))) })));
    const codeNames = names.filter(n => /\.(ts|tsx|mjs)$/.test(n) && !n.startsWith('tests/'));
    const codeLines = (await Promise.all(codeNames.map(n => readFile(resolve(output, n), 'utf8')))).reduce((n, s) => n + s.split('\n').length - 1, 0);
    manifest = { generator: 'aidea-demo-gcp', version: 4, templateCapabilityVersion: 4, templateFeatures: ['chat-tab','assistant-ui','capabilities-v1','extension-api-v1','chat-state-v1','adk-native-v1','chat-ui-v2','chat-ui-v3','chat-process-v1','split-workspace-v1','execution-modes-v1'], supportedSpecVersions: [1, 2, 3, 4], demoId: spec.id, createdAt: new Date().toISOString(), templateFiles: hashes, copiedCodeFiles: codeNames.length, copiedCodeLines: codeLines, generatedApplicationCodeLines: 0 };
  }
  if(reuse) manifest.extension=await applyReuse(reuse,output);
  await writeFile(resolve(output, 'demo-spec.json'), JSON.stringify(spec, null, 2) + '\n');
  await writeFile(resolve(output, 'scenario.json'), JSON.stringify(scenario, null, 2) + '\n');
  if (!options.update) {
    await writeDeliverables(output, spec, scenario);
    manifest.generatedDocuments = ['SOLUTION.md', 'PLAYBOOK.md', 'VALIDATION.md', ...(spec.blueprint?.sources.some(source => source.kind === 'website') ? ['SITE-REVIEW.md'] : [])];
  }
  manifest.configFiles = await Promise.all(['demo-spec.json', 'scenario.json'].map(async name => ({ path: name, sha256: sha(await readFile(resolve(output, name))) })));
  manifest.capabilities = spec.capabilities?.map(({id,kind,version,pages})=>({id,kind,version,pages})) ?? [];
  manifest.presentation = spec.presentation;
  manifest.lastOperation = options.update ? 'config-update' : 'generate';
  manifest.lastUpdatedAt = new Date().toISOString();
  manifest.validation = await refreshValidation(output);
  manifest.generationMs = Math.round((performance.now() - started) * 100) / 100;
  await writeFile(resolve(output, 'generation-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ output, operation: manifest.lastOperation, version: spec.version, topics: scenario.topics.length, datasets: scenario.workspace?.datasets.length ?? 0, generationMs: manifest.generationMs, configFiles: 2, generatedDocuments: manifest.generatedDocuments ?? [], generatedApplicationCodeLines: 0, ...(options.update ? { note: '方案/Playbook/验证文档未覆盖；需复核是否仍与更新配置一致。' } : {}), next: `node --experimental-strip-types ${resolve(skill, 'scripts/pipeline.mjs')} --app ${output} --report /absolute/evidence/pipeline.json` }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
