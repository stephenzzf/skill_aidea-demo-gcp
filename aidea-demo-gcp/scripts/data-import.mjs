import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseWorkspaceData } from '../assets/app/shared/workspace.ts';

function parseCsvDocument(text, filename) {
  const input = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let afterQuote = false;
  let touched = false;

  const finishCell = () => { row.push(cell); cell = ''; afterQuote = false; };
  const finishRow = () => {
    finishCell();
    if (!(row.length === 1 && row[0] === '' && !touched)) rows.push(row);
    row = [];
    touched = false;
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else cell += char;
      touched = true;
      continue;
    }
    if (afterQuote && char !== ',' && char !== '\r' && char !== '\n' && char !== ' ' && char !== '\t') {
      throw new Error(`${filename} CSV 第 ${rows.length + 1} 行的引号后包含无效字符`);
    }
    if (char === '"') {
      if (cell.length !== 0 || afterQuote) throw new Error(`${filename} CSV 第 ${rows.length + 1} 行包含未转义的引号`);
      quoted = true;
      touched = true;
    } else if (char === ',') {
      finishCell();
      touched = true;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      finishRow();
    } else if (afterQuote) {
      // RFC 4180 permits whitespace between the closing quote and delimiter.
      continue;
    } else {
      cell += char;
      if (char !== ' ' && char !== '\t') touched = true;
    }
  }
  if (quoted) throw new Error(`${filename} CSV 存在未闭合的引号`);
  if (cell.length > 0 || row.length > 0 || touched || afterQuote) finishRow();
  if (rows.length === 0) throw new Error(`${filename} CSV 为空，至少需要一行表头`);

  const headers = rows.shift().map(header => header.trim());
  if (headers.some(header => !header)) throw new Error(`${filename} CSV 表头不能为空`);
  if (new Set(headers).size !== headers.length) throw new Error(`${filename} CSV 表头存在重复列`);
  const records = rows.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`${filename} CSV 第 ${index + 2} 行列数与表头不一致`);
    return Object.fromEntries(headers.map((header, column) => [header, values[column]]));
  });
  return { headers, rows: records };
}

function parseCsv(text, filename) { return parseCsvDocument(text, filename).rows; }

function asSourceRows(value, filename) {
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error(`${filename} JSON 必须是对象数组`);
  }
  return value;
}

function convert(value, field, datasetId, rowIndex) {
  const label = `${datasetId} 第 ${rowIndex + 1} 行 ${field.id}`;
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  if (field.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${label} 必须是文本`);
    return value;
  }
  if (field.type === 'number') {
    const raw = typeof value === 'string' ? value.trim() : value;
    if (typeof raw === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) throw new Error(`${label} 不是有效数值`);
    const number = typeof raw === 'number' ? raw : typeof raw === 'string' && raw ? Number(raw) : Number.NaN;
    if (!Number.isFinite(number)) throw new Error(`${label} 不是有效数值`);
    return number;
  }
  if (field.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true';
    throw new Error(`${label} 必须是 true 或 false`);
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:?\d{2}))?$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} 必须是 YYYY-MM-DD 或 ISO 日期时间`);
  }
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    throw new Error(`${label} 不是有效日历日期`);
  }
  return value;
}

function mapRows(sourceRows, sourceColumns, rawDataset, schema) {
  const fields = new Map(schema.fields.map(field => [field.id, field]));
  const explicitMapping = rawDataset.mapping !== undefined;
  const mapping = rawDataset.mapping ?? Object.fromEntries(schema.fields.map(field => [field.id, field.id]));
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error(`${schema.id}.mapping 必须是字段映射对象`);
  for (const [target, source] of Object.entries(mapping)) {
    if (!fields.has(target)) throw new Error(`${schema.id}.mapping 目标字段 ${target} 未在方案中定义`);
    if (typeof source !== 'string' || !source.trim()) throw new Error(`${schema.id}.mapping.${target} 必须指定来源列`);
  }
  for (const [target, source] of Object.entries(mapping)) {
    if (explicitMapping && !sourceColumns.has(source)) throw new Error(`${schema.id}.mapping 来源列 ${source} 不存在`);
  }
  return sourceRows.map((sourceRow, index) => Object.fromEntries(schema.fields.map(field => {
    const source = mapping[field.id];
    const value = source === undefined ? null : sourceRow[source];
    return [field.id, convert(value, field, schema.id, index)];
  })));
}

async function readRows(rawDataset, baseDirectory) {
  const filename = rawDataset.file;
  if (typeof filename !== 'string' || !filename.trim()) throw new Error(`${rawDataset.id}.file 必须是相对路径`);
  if (isAbsolute(filename) || /^[a-z]:[\\/]/i.test(filename) || filename.startsWith('\\\\') || filename.split(/[\\/]/).includes('..')) {
    throw new Error(`${rawDataset.id}.file 必须是相对路径且不能包含 ..`);
  }
  const lexical = resolve(baseDirectory, filename);
  const lexicalRelative = relative(baseDirectory, lexical);
  if (!lexicalRelative || lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
    throw new Error(`${rawDataset.id}.file 不能离开 scenario 文件所在目录`);
  }
  let canonical;
  try { canonical = await realpath(lexical); }
  catch { throw new Error(`${rawDataset.id}.file 未找到：${filename}`); }
  const canonicalRelative = relative(baseDirectory, canonical);
  if (!canonicalRelative || canonicalRelative === '..' || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative)) {
    throw new Error(`${rawDataset.id}.file 的符号链接不能指向 scenario 目录之外`);
  }
  if (!(await stat(canonical)).isFile()) throw new Error(`${rawDataset.id}.file 必须是普通文件`);
  const extension = extname(canonical).toLowerCase();
  if (extension !== '.csv' && extension !== '.json') throw new Error(`${rawDataset.id}.file 仅支持 CSV 或 JSON`);
  const content = (await readFile(canonical, 'utf8')).replace(/^\uFEFF/, '');
  if (extension === '.csv') {
    const document = parseCsvDocument(content, filename);
    return { rows: document.rows, columns: new Set(document.headers) };
  }
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new Error(`${filename} 不是有效 JSON`); }
  const rows = asSourceRows(parsed, filename);
  return { rows, columns: new Set(rows.flatMap(row => Object.keys(row))) };
}

/** Resolve customer data references beside the scenario JSON, then normalize and validate them. */
export async function importScenarioWorkspace(scenario, scenarioPath, definition) {
  if (!scenario?.workspace || !Array.isArray(scenario.workspace.datasets)) return scenario;
  if (scenario.version !== 2 || typeof scenario.synthetic !== 'boolean') throw new Error('V2 场景必须声明 version=2 和 synthetic 来源标识');
  if (scenario.synthetic !== definition.datasets.every(dataset => dataset.origin === 'synthetic')) {
    throw new Error('scenario.synthetic 必须与方案中声明的数据来源一致');
  }
  const configured = new Map(definition.datasets.map(dataset => [dataset.id, dataset]));
  const rawDatasets = scenario.workspace.datasets;
  if (new Set(rawDatasets.map(dataset => dataset?.id)).size !== rawDatasets.length) throw new Error('scenario.workspace.datasets.id 不得重复');
  if (rawDatasets.length !== definition.datasets.length || rawDatasets.some(dataset => !configured.has(dataset?.id))) {
    throw new Error('scenario.workspace.datasets 必须与 demo-spec.workspace.datasets 一一对应');
  }
  const baseDirectory = dirname(await realpath(resolve(scenarioPath)));
  const normalized = [];
  for (const raw of rawDatasets) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['id', 'rows', 'file', 'mapping'].includes(key))) {
      throw new Error('scenario.workspace.datasets 只允许 id、rows、file 和 mapping 字段');
    }
    if ((raw.rows === undefined) === (raw.file === undefined)) throw new Error(`${raw.id}.rows 与 ${raw.id}.file 必须且只能提供一个`);
    const schema = configured.get(raw.id);
    const source = raw.rows !== undefined
      ? { rows: asSourceRows(raw.rows, `${raw.id}.rows`), columns: new Set(raw.rows.flatMap(row => Object.keys(row))) }
      : await readRows(raw, baseDirectory);
    normalized.push({ id: raw.id, rows: mapRows(source.rows, source.columns, raw, schema) });
  }
  const validated = parseWorkspaceData({ datasets: normalized }, definition);
  return { ...scenario, workspace: validated };
}

export { parseCsv };
