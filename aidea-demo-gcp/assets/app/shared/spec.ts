import { parseCapabilities } from './capabilities.ts';
import type { CapabilityBinding } from './capabilities.ts';
import { parseWorkspace, parseWorkspaceData } from './workspace.ts';
import type { WorkspaceDefinition, WorkspaceData } from './workspace.ts';
import { parseDomainPages, parseSolutionBlueprint, validateSolutionReferences } from './solution.ts';
import type { DomainPage, SolutionBlueprint } from './solution.ts';

export type { DomainPage, SolutionBlueprint } from './solution.ts';
// Dependency-free: generator and server share the same strict config validator.
export interface DemoStep {
  question: string;
  expected: string;
  id?: string;
  role?: string;
  pageId?: string;
  preconditions?: string[];
  inputs?: string[];
  observation?: string;
  claimIds?: string[];
}

export interface DemoSpec {
  version: 1 | 2 | 3 | 4;
  id: string;
  customer: string;
  assistantName: string;
  title: string;
  subtitle: string;
  audience: string;
  goal: string;
  solution: string;
  confirmed: true;
  prompts: string[];
  steps: DemoStep[];
  acceptance: string[];
  capabilities?: CapabilityBinding[];
  presentation?: Presentation;
  execution?: { model: 'simulated' | 'vertex'; data: 'local' | 'bigquery' };
  workspace?: WorkspaceDefinition;
  design?: SolutionDesign;
  blueprint?: SolutionBlueprint;
  pages?: DomainPage[];
  model: { project: string; location: string; model: string };
}

export interface SolutionDesign {
  facts: string[];
  assumptions: string[];
  implementation: string[];
  coverage: { id?: string; claim: string; status: 'unverified' | 'simulated' | 'verified' | 'planned'; evidence: string }[];
}

export interface Topic {
  id: string;
  title: string;
  keywords: string[];
  answer: string;
  rows: [string, string][];
  source: string;
  followups: string[];
  domainIds?: string[];
}

export interface Scenario {
  synthetic: boolean;
  version?: 2;
  workspace?: WorkspaceData;
  instruction: string;
  topics: Topic[];
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须是对象`);
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key));
  if (unexpected) throw new Error(`${name}.${unexpected} 不受支持，请核对配置版本`);
}
function string(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${name} 必须是${allowEmpty ? '' : '非空'}字符串`);
  return value;
}
function list<T>(value: unknown, name: string, parse: (item: unknown, name: string) => T, allowEmpty = false): T[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length)) throw new Error(`${name} 必须是${allowEmpty ? '' : '非空'}数组`);
  return value.map((item, i) => parse(item, `${name}[${i}]`));
}
const strings = (value: unknown, name: string, allowEmpty = false) => list(value, name, string, allowEmpty);
function unique(values: string[], name: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${name} 不得重复`);
}

export function parseSpec(value: unknown): DemoSpec {
  const v = object(value, 'demo-spec');
  if (![1, 2, 3, 4].includes(v.version as number) || v.confirmed !== true) throw new Error('需要受支持的 version=1/2/3/4 且 confirmed=true 的已确认方案');
  const version = v.version as 1 | 2 | 3 | 4;
  const commonKeys = ['version', 'id', 'customer', 'assistantName', 'title', 'subtitle', 'audience', 'goal', 'solution', 'confirmed', 'prompts', 'steps', 'acceptance', 'workspace', 'design', 'model'];
  onlyKeys(v, version === 4 ? [...commonKeys, 'blueprint', 'pages', 'capabilities', 'presentation', 'execution'] : version >= 3 ? [...commonKeys, 'blueprint', 'pages'] : commonKeys, 'demo-spec');
  if (version === 1 && (v.workspace !== undefined || v.design !== undefined || v.pages !== undefined || v.blueprint !== undefined)) throw new Error('V1 不支持业务工作区或V3方案字段');
  if (version === 2 && (v.pages !== undefined || v.blueprint !== undefined)) throw new Error('V2 不支持V3页面与方案字段');
  if (version >= 3 && (v.workspace === undefined || v.design === undefined || v.blueprint === undefined || v.pages === undefined)) {
    throw new Error('V3 必须提供 workspace、design、blueprint 与 pages');
  }
  const workspace = version >= 2 ? parseWorkspace(v.workspace) : undefined;
  const design = version >= 2 ? parseDesign(v.design, version >= 3) : undefined;
  const blueprint = version >= 3 ? parseSolutionBlueprint(v.blueprint) : undefined;
  const pages = version >= 3 ? parseDomainPages(v.pages) : undefined;
  const id = string(v.id, 'id');
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('id 必须为小写字母开头的字母、数字或连字符');
  const model = object(v.model, 'model');
  onlyKeys(model, ['project', 'location', 'model'], 'demo-spec.model');
  const spec: DemoSpec = {
    version, confirmed: true, id,
    ...(workspace ? { workspace, design } : {}),
    ...(blueprint ? { blueprint, pages } : {}),
    customer: string(v.customer, 'customer'), assistantName: string(v.assistantName, 'assistantName'),
    title: string(v.title, 'title'), subtitle: string(v.subtitle, 'subtitle'),
    audience: string(v.audience, 'audience'), goal: string(v.goal, 'goal'), solution: string(v.solution, 'solution'),
    prompts: strings(v.prompts, 'prompts', Boolean(workspace)), acceptance: strings(v.acceptance, 'acceptance'),
    steps: list(v.steps, 'steps', (item, name) => {
      const step = object(item, name);
      if (version >= 3) {
        onlyKeys(step, ['id', 'question', 'expected', 'role', 'pageId', 'preconditions', 'inputs', 'observation', 'claimIds'], name);
        return { id: string(step.id, `${name}.id`), question: string(step.question, `${name}.question`), expected: string(step.expected, `${name}.expected`),
          role: string(step.role, `${name}.role`), pageId: string(step.pageId, `${name}.pageId`),
          preconditions: strings(step.preconditions, `${name}.preconditions`, true), inputs: strings(step.inputs, `${name}.inputs`, true),
          observation: string(step.observation, `${name}.observation`), claimIds: strings(step.claimIds, `${name}.claimIds`, true) };
      }
      onlyKeys(step, ['question', 'expected'], name);
      return { question: string(step.question, `${name}.question`), expected: string(step.expected, `${name}.expected`) };
    }),
    model: { project: string(model.project, 'model.project', true), location: string(model.location, 'model.location', true), model: string(model.model, 'model.model', true) },
  };
  if (version === 4) {
    spec.capabilities = parseCapabilities(v.capabilities, workspace!, pages!);
    spec.presentation = parsePresentation(v.presentation);
    if (v.execution !== undefined) {
      const execution = object(v.execution, 'execution');
      onlyKeys(execution, ['model', 'data'], 'execution');
      if (!['simulated', 'vertex'].includes(execution.model as string) || !['local', 'bigquery'].includes(execution.data as string)) throw new Error('execution 必须指定 model: simulated|vertex 和 data: local|bigquery');
      spec.execution = { model: execution.model as 'simulated' | 'vertex', data: execution.data as 'local' | 'bigquery' };
    }
  }
  if (version >= 3) validateSolutionReferences(spec);
  return spec;
}

export function parseScenario(value: unknown, workspace?: WorkspaceDefinition, spec?: DemoSpec): Scenario {
  const v = object(value, 'scenario');
  onlyKeys(v, ['version', 'synthetic', 'instruction', 'topics', 'workspace'], 'scenario');
  if (workspace ? typeof v.synthetic !== 'boolean' || v.version !== 2 : v.synthetic !== true || v.version !== undefined) throw new Error('V1 仅支持合成数据；V2/V3 需要 version=2 和明确 synthetic 标识');
  const topics = list(v.topics, 'topics', (item, name): Topic => {
    const topic = object(item, name);
    const allowsDomainIds = spec === undefined || spec.version >= 3;
    onlyKeys(topic, allowsDomainIds ? ['id', 'title', 'keywords', 'answer', 'rows', 'source', 'followups', 'domainIds'] : ['id', 'title', 'keywords', 'answer', 'rows', 'source', 'followups'], name);
    const domainIds = topic.domainIds === undefined ? undefined : strings(topic.domainIds, `${name}.domainIds`);
    if (domainIds) unique(domainIds, `${name}.domainIds`);
    if (spec && spec.version >= 3) {
      if (!domainIds?.length) throw new Error(`${name}.domainIds 在 V3 中必填且至少指定一个领域`);
      const pageIds = new Set(spec.pages?.map(page => page.id) ?? []);
      const unknown = domainIds.find(domainId => !pageIds.has(domainId));
      if (unknown) throw new Error(`${name}.domainIds 引用了不存在的领域：${unknown}`);
    }
    return {
      id: string(topic.id, `${name}.id`), title: string(topic.title, `${name}.title`),
      keywords: strings(topic.keywords, `${name}.keywords`), answer: string(topic.answer, `${name}.answer`),
      rows: list(topic.rows, `${name}.rows`, (row, key): [string, string] => {
        if (!Array.isArray(row) || row.length !== 2) throw new Error(`${key} 必须是两列字符串`);
        return [string(row[0], key), string(row[1], key)];
      }),
      source: string(topic.source, `${name}.source`), followups: strings(topic.followups, `${name}.followups`, true),
      ...(domainIds ? { domainIds } : {}),
    };
  }, Boolean(workspace));
  if (new Set(topics.map(t => t.id)).size !== topics.length) throw new Error('topic.id 不得重复');
  const data = workspace ? parseWorkspaceData(v.workspace, workspace) : undefined;
  if (workspace && v.synthetic !== workspace.datasets.every(d => d.origin === 'synthetic')) throw new Error('synthetic 必须与数据来源一致');
  const result: Scenario = { synthetic: v.synthetic as boolean, instruction: string(v.instruction, 'instruction'), topics, ...(data ? { version: 2, workspace: data } : {}) };
  if (spec && spec.version >= 3) validateSolutionReferences(spec, data);
  return result;
}

function parseDesign(value: unknown, requireClaimIds: boolean): SolutionDesign {
  const v = object(value, 'demo-spec.design');
  onlyKeys(v, ['facts', 'assumptions', 'implementation', 'coverage'], 'demo-spec.design');
  const coverage = list(v.coverage, 'design.coverage', (raw, name) => {
    const item = object(raw, name);
    onlyKeys(item, ['id', 'claim', 'status', 'evidence'], name);
    if (!['unverified', 'simulated', 'verified', 'planned'].includes(item.status as string)) throw new Error(`${name}.status 不受支持`);
    if (requireClaimIds && item.id === undefined) throw new Error(`${name}.id 是 V3 必填项`);
    return { ...(item.id !== undefined ? { id: string(item.id, `${name}.id`) } : {}),
      claim: string(item.claim, `${name}.claim`), status: item.status as SolutionDesign['coverage'][number]['status'], evidence: string(item.evidence, `${name}.evidence`) };
  });
  const ids = coverage.map(item => item.id).filter((item): item is string => Boolean(item));
  if (ids.length) unique(ids, 'design.coverage.id');
  return { facts: strings(v.facts, 'design.facts', true), assumptions: strings(v.assumptions, 'design.assumptions', true),
    implementation: strings(v.implementation, 'design.implementation'), coverage };
}

export interface Presentation {
  shellLocale: 'zh-CN';
  experienceLocale: string;
  workspaceLayout?: 'tabs' | 'split';
  brand?: { primaryColor?: string; logoUrl?: string };
}
function parsePresentation(value: unknown): Presentation {
  const raw = value === undefined ? {shellLocale:'zh-CN',experienceLocale:'zh-CN'} : object(value,'presentation');
  onlyKeys(raw,['shellLocale','experienceLocale','workspaceLayout','brand'],'presentation');
  if(raw.workspaceLayout!==undefined && raw.workspaceLayout!=='tabs' && raw.workspaceLayout!=='split') throw new Error('presentation.workspaceLayout仅支持tabs或split');
  if(raw.shellLocale!=='zh-CN') throw new Error('当前说明外壳仅支持zh-CN，客户体验语言通过experienceLocale配置');
  const locale=string(raw.experienceLocale,'presentation.experienceLocale');
  try { new Intl.Locale(locale); } catch { throw new Error('experienceLocale必须为合法语言标签'); }
  let brand: Presentation['brand'];
  if(raw.brand!==undefined){
    const b=object(raw.brand,'presentation.brand');onlyKeys(b,['primaryColor','logoUrl'],'presentation.brand');brand={};
    if(b.primaryColor!==undefined){const color=string(b.primaryColor,'primaryColor');if(!/^#[0-9a-fA-F]{6}$/.test(color))throw new Error('primaryColor必须为6位hex颜色');brand.primaryColor=color;}
    if(b.logoUrl!==undefined){const url=string(b.logoUrl,'logoUrl');if(!url.startsWith('/assets/')&&!/^https:\/\//.test(url))throw new Error('logoUrl仅支持/assets/或HTTPS');brand.logoUrl=url;}
  }
  return {shellLocale:'zh-CN',experienceLocale:locale,...(raw.workspaceLayout ? {workspaceLayout:raw.workspaceLayout as 'tabs' | 'split'} : {}),...(brand?{brand}:{})};
}
