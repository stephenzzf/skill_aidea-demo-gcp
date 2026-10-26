import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseWorkspace } from '../assets/app/shared/workspace.ts';
import { importScenarioWorkspace, parseCsv } from './data-import.mjs';

const definition = parseWorkspace({
  views: ['overview', 'records'],
  roles: [{ id: 'operator', label: '业务人员' }],
  stages: [{ id: 'open', label: '待处理' }],
  datasets: [
    { id: 'orders', label: '订单', key: 'order_id', origin: 'customer', source: '客户授权文件', fields: [
      { id: 'order_id', label: '订单编号', type: 'string', required: true },
      { id: 'amount', label: '金额', type: 'number', required: true, unit: 'CNY' },
      { id: 'active', label: '有效', type: 'boolean' },
      { id: 'created_at', label: '日期', type: 'date', required: true },
      { id: 'note', label: '备注', type: 'string' },
    ] },
    { id: 'products', label: '产品', key: 'product_id', origin: 'synthetic', source: '演示样例', fields: [
      { id: 'product_id', label: '产品编号', type: 'string', required: true },
    ] },
  ],
  metrics: [],
});

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'me-data-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'inputs'));
  const scenarioPath = resolve(root, 'scenario.json');
  await writeFile(scenarioPath, '{}');
  return { root, scenarioPath, input: resolve(root, 'inputs', 'orders.csv') };
}

test('CSV parser supports BOM, CRLF, quoted delimiters, escaped quotes, and embedded newlines', () => {
  assert.deepEqual(parseCsv('\uFEFFid,note\r\nA,"a,b"\r\nB,"say ""hi""\nand leave"\r\n', 'orders.csv'), [
    { id: 'A', note: 'a,b' },
    { id: 'B', note: 'say "hi"\nand leave' },
  ]);
});

test('CSV import applies explicit mapping, coerces supported primitives, and retains trusted origins', async t => {
  const paths = await fixture(t);
  await writeFile(paths.input, 'Order No,Amount,Live,Date,Comment\nA-1,12.5,true,2026-10-24,"light, quick"\nA-2,0,false,2026-10-25,\n');
  const result = await importScenarioWorkspace({ version: 2, synthetic: false, topics: [], workspace: { datasets: [
    { id: 'orders', file: 'inputs/orders.csv', mapping: { order_id: 'Order No', amount: 'Amount', active: 'Live', created_at: 'Date', note: 'Comment' } },
    { id: 'products', rows: [{ product_id: 'P-1' }] },
  ] } }, paths.scenarioPath, definition);
  assert.deepEqual(result.workspace.datasets[0].rows, [
    { order_id: 'A-1', amount: 12.5, active: true, created_at: '2026-10-24', note: 'light, quick' },
    { order_id: 'A-2', amount: 0, active: false, created_at: '2026-10-25', note: null },
  ]);
  assert.equal(definition.datasets[0].origin, 'customer');
  assert.equal(definition.datasets[1].origin, 'synthetic');
});

test('JSON import preserves typed customer records and applies field mapping', async t => {
  const paths = await fixture(t);
  const file = resolve(paths.root, 'inputs/orders.json');
  await writeFile(file, JSON.stringify([{ external: 'A-3', total: 18, date: '2026-10-24', live: false }]));
  const result = await importScenarioWorkspace({ version: 2, synthetic: false, workspace: { datasets: [
    { id: 'orders', file: 'inputs/orders.json', mapping: { order_id: 'external', amount: 'total', created_at: 'date', active: 'live' } },
    { id: 'products', rows: [{ product_id: 'P-1' }] },
  ] } }, paths.scenarioPath, definition);
  assert.deepEqual(result.workspace.datasets[0].rows[0], {
    order_id: 'A-3', amount: 18, active: false, created_at: '2026-10-24', note: null,
  });
});

test('import rejects duplicate or uneven CSV columns and malformed quotes', () => {
  assert.throws(() => parseCsv('id,id\na,b\n', 'bad.csv'), /重复列/);
  assert.throws(() => parseCsv('id,amount\na\n', 'bad.csv'), /列数/);
  assert.throws(() => parseCsv('id,note\na,"unfinished', 'bad.csv'), /未闭合/);
});

test('import rejects unmapped headers, invalid values, missing required fields, and bad references', async t => {
  const paths = await fixture(t);
  const scenario = rows => ({ version: 2, synthetic: false, workspace: { datasets: [
    { id: 'orders', rows }, { id: 'products', rows: [{ product_id: 'P-1' }] },
  ] } });
  await assert.rejects(importScenarioWorkspace(scenario([{ order_id: 'A', amount: 'nope', active: true, created_at: '2026-10-24', note: null }]), paths.scenarioPath, definition), /不是有效数值/);
  await assert.rejects(importScenarioWorkspace(scenario([{ order_id: 'A', amount: 1, active: true, created_at: 'not-a-date', note: null }]), paths.scenarioPath, definition), /ISO 日期时间/);
  await assert.rejects(importScenarioWorkspace(scenario([{ order_id: 'A', amount: 1, active: true, note: null }]), paths.scenarioPath, definition), /必填字段/);
  const withRelation = parseWorkspace({
    ...definition,
    datasets: [
      { ...definition.datasets[0], relations: [{ field: 'order_id', dataset: 'products', target: 'product_id' }] },
      definition.datasets[1],
    ],
  });
  await assert.rejects(importScenarioWorkspace({ version: 2, synthetic: false, workspace: { datasets: [
    { id: 'orders', rows: [{ order_id: 'missing-product', amount: 1, created_at: '2026-10-24' }] },
    { id: 'products', rows: [{ product_id: 'P-1' }] },
  ] } }, paths.scenarioPath, withRelation), /无法关联/);
});

test('file references must stay inside the scenario folder and point to regular CSV or JSON files', async t => {
  const paths = await fixture(t);
  const valid = 'Order No,Amount,Live,Date,Comment\nA,1,true,2026-10-24,ok\n';
  await writeFile(paths.input, valid);
  const request = file => ({ version: 2, synthetic: false, workspace: { datasets: [
    { id: 'orders', file, mapping: { order_id: 'Order No', amount: 'Amount', active: 'Live', created_at: 'Date', note: 'Comment' } },
    { id: 'products', rows: [{ product_id: 'P-1' }] },
  ] } });
  await assert.rejects(importScenarioWorkspace(request('../outside.csv'), paths.scenarioPath, definition), /不能包含 \.\./);
  await assert.rejects(importScenarioWorkspace(request(pathToFileURL(paths.input).pathname), paths.scenarioPath, definition), /必须是相对路径/);
  await assert.rejects(importScenarioWorkspace(request('C:\\private\\orders.csv'), paths.scenarioPath, definition), /必须是相对路径/);
  await assert.rejects(importScenarioWorkspace(request('inputs/missing.csv'), paths.scenarioPath, definition), /未找到/);
  const external = await mkdtemp(resolve(tmpdir(), 'me-data-outside-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const externalFile = resolve(external, 'outside.csv');
  await writeFile(externalFile, valid);
  await symlink(externalFile, resolve(paths.root, 'outside-link.csv'));
  await assert.rejects(importScenarioWorkspace(request('outside-link.csv'), paths.scenarioPath, definition), /符号链接不能指向/);
  const directory = resolve(paths.root, 'inputs', 'directory.csv');
  await mkdir(directory);
  await assert.rejects(importScenarioWorkspace(request('inputs/directory.csv'), paths.scenarioPath, definition), /普通文件/);
  await writeFile(resolve(paths.root, 'inputs/orders.txt'), valid);
  await assert.rejects(importScenarioWorkspace(request('inputs/orders.txt'), paths.scenarioPath, definition), /仅支持 CSV 或 JSON/);
  await assert.rejects(importScenarioWorkspace({ version: 2, synthetic: false, workspace: { datasets: [
    { id: 'orders', file: 'inputs/orders.csv', mapping: { unknown_field: 'Order No' } },
    { id: 'products', rows: [{ product_id: 'P-1' }] },
  ] } }, paths.scenarioPath, definition), /未在方案中定义/);
  await assert.rejects(importScenarioWorkspace({ version: 2, synthetic: false, workspace: { datasets: [
    { id: 'orders', file: 'inputs/orders.csv', rows: [] },
    { id: 'products', rows: [{ product_id: 'P-1' }] },
  ] } }, paths.scenarioPath, definition), /必须且只能提供一个/);
});
