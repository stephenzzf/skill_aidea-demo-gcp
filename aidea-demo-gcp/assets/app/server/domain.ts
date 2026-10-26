import { analyzeCapabilities, materializeCapabilities } from './capabilities.ts';
import type { DemoSpec, Scenario } from '../shared/spec.ts';
import type { WorkspaceChatContext } from '../shared/contracts.ts';
import type { AnalysisQuery, WorkspaceState } from '../shared/workspace.ts';
import { isPlannedDomain, resolveDomainContext, resolveDomainPage } from '../shared/solution.ts';
import { analyze, materialize } from './workspace.ts';

/** Domain selection is server-validated; the browser never supplies calculated facts. */
export function domainContext(spec: DemoSpec, context?: WorkspaceChatContext, assistant = false) {
  if (spec.version < 3) return context;
  if (!context?.domainId) throw new Error('请选择当前业务领域');
  const resolved = resolveDomainContext(spec, context);
  const page = resolveDomainPage(spec, context.domainId)!;
  if (page.id !== 'solution' && isPlannedDomain(page, spec.design?.coverage ?? [])) throw new Error('该领域为后续接入，当前仅展示方案说明');
  if (assistant && !page.components.includes('assistant')) throw new Error('该业务领域未启用问答');
  return { ...context, ...resolved };
}

export function analyzeDomain(spec: DemoSpec, scenario: Scenario, query: AnalysisQuery, state: WorkspaceState, domainId?: string) {
  if (!spec.workspace || !scenario.workspace) throw new Error('工作区未启用');
  const context = domainContext(spec, { query, state, ...(domainId ? { domainId } : {}) });
  if(spec.version===4) return analyzeCapabilities(spec,scenario,context?.query ?? query,state,domainId);
  const page = spec.version >= 3 ? resolveDomainPage(spec, domainId) : undefined;
  return analyze(spec.workspace, scenario.workspace, context?.query ?? query, state,
    page ? { datasets: page.datasets, metrics: page.metrics } : undefined);
}

export function selectedDomainRecord(spec: DemoSpec, scenario: Scenario, context?: WorkspaceChatContext) {
  const selected = context?.selectedRecord;
  if (!selected || !spec.workspace || !scenario.workspace) return undefined;
  const definition = spec.workspace.datasets.find(dataset => dataset.id === selected.dataset);
  const data = selected.scope === 'snapshot' ? scenario.workspace : spec.version===4 ? materializeCapabilities(spec,scenario.workspace,context.state) : materialize(spec.workspace, scenario.workspace, context.state);
  const row = data.datasets.find(dataset => dataset.id === selected.dataset)?.rows.find(row => String(row[definition?.key ?? '']) === selected.id);
  if (!definition || !row) throw new Error('选中记录不存在');
  return row;
}
