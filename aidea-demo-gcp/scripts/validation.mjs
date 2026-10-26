import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const ignored = new Set(['node_modules', 'dist', '.git', 'evidence']);
async function runtimeFiles(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.name.startsWith('.env')) continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`验收依据不能包含符号链接：${name}`);
    if (entry.isDirectory()) result.push(...await runtimeFiles(root, name));
    else if (name.startsWith('public/') || /\.(ts|tsx|mjs|css)$/.test(name) || ['package.json', 'package-lock.json', 'Dockerfile', 'index.html', 'tsconfig.json', 'vite.config.ts'].includes(name)) result.push(name);
  }
  return result.sort();
}

/** Real source/configuration hashes, independent of generator declarations or prior reports. */
export async function validationBasis(root) {
  const names = await runtimeFiles(root);
  const sources = await Promise.all(names.map(async path => ({ path, sha256: hash(await readFile(resolve(root, path))) })));
  const configs = await Promise.all(['demo-spec.json', 'scenario.json'].map(async path => ({ path, sha256: hash(await readFile(resolve(root, path))) })));
  return { digest: hash(JSON.stringify({ sources, configs })), sources, configs };
}

export async function refreshValidation(root) {
  const path = resolve(root, 'validation-record.json');
  const basis = await validationBasis(root);
  let previous;
  try {
    if (!(await lstat(path)).isFile()) throw new Error('validation-record.json 必须为普通文件');
    previous = JSON.parse(await readFile(path, 'utf8'));
    if (previous.version !== 1 || !Array.isArray(previous.entries) || !Array.isArray(previous.history) || !previous.basis?.digest) throw new Error('validation-record.json 格式无效，请保留原记录并检查');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const changed = previous && previous.basis.digest !== basis.digest;
  const record = previous ? {
    ...previous, basis,
    status: changed ? 'needs-revalidation' : previous.status,
    history: changed ? [...previous.history, { basis: previous.basis, entries: previous.entries, archivedAt: new Date().toISOString() }] : previous.history,
    entries: changed ? previous.entries.map(entry => ({ ...entry, stale: true })) : previous.entries,
  } : { version: 1, status: 'pending', basis, entries: [], history: [] };
  await writeFile(path, JSON.stringify(record, null, 2) + '\n');
  return { status: record.status, basisDigest: basis.digest, stale: Boolean(changed), entries: record.entries.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--app') throw new Error('用法：validation.mjs --app /absolute/demo');
  console.log(JSON.stringify({ app: relative(process.cwd(), resolve(args[1])) || '.', ...await refreshValidation(resolve(args[1])) }, null, 2));
}
