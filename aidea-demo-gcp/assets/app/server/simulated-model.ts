import { formatMetricValue } from "../shared/metric-format.ts";
import { BaseLlm } from '@google/adk';
import type { BaseLlmConnection, LlmRequest, LlmResponse } from '@google/adk';
import { setTimeout as delay } from 'node:timers/promises';
import type { AnalysisQuery } from '../shared/workspace.ts';
import type { Scenario } from '../shared/spec.ts';

const UNKNOWN_TEST_ANSWER = '当前合成场景未覆盖这个问题，无法据此确认。可以选择页面建议的问题继续体验。';
const MAX_CONTEXT_QUESTIONS = 8;
const MAX_QUESTION_CHARS = 1200;

export interface SimulatedModelOptions {
  /** test preserves the historical deterministic test-double contract. */
  profile?: 'test' | 'simulated';
  dataSource?: 'local' | 'bigquery';
  analysisQuery?: AnalysisQuery;
  selectedRecord?: { dataset: string; id: string; scope?: 'snapshot' | 'current' };
}

/**
 * Deterministic, no-provider conversation engine used by both the legacy test
 * model and the user-facing simulated mode. It emits calls to the ADK tools
 * already registered for this turn; it never executes tools itself.
 */
export class SimulatedModel extends BaseLlm {
  private readonly options: Required<Pick<SimulatedModelOptions, 'profile' | 'dataSource'>> & SimulatedModelOptions;
  private callNumber = 0;
  private readonly scenario: Scenario;

  constructor(scenario: Scenario, options: SimulatedModelOptions = {}) {
    super({ model: options.profile === 'test' ? 'me-local-test-model' : 'me-local-simulated-model' });
    this.scenario = scenario;
    this.options = { profile: 'simulated', dataSource: 'local', ...options };
  }

  async *generateContentAsync(request: LlmRequest, stream = false, signal?: AbortSignal): AsyncGenerator<LlmResponse> {
    signal?.throwIfAborted();
    const lastResponse = request.contents.at(-1)?.parts?.find(part => part.functionResponse)?.functionResponse;
    if (lastResponse) {
      const text = formatToolResponse(lastResponse.name ?? '', lastResponse.response, this.options.profile, this.options.selectedRecord);
      yield* this.textResponse(text, stream, signal);
      return;
    }

    const questions = recentQuestions(request);
    const question = questions.at(-1) ?? '';
    const available = new Set(Object.keys(request.toolsDict ?? {}));
    if (request.allowedTools) {
      const allowed = new Set(request.allowedTools);
      for (const name of available) if (!allowed.has(name)) available.delete(name);
    }
    // BigQuery is an explicit authority boundary; local fixture lookup must not
    // become a fallback even if a caller accidentally advertises that tool.
    if (this.options.dataSource === 'bigquery') available.delete('lookup_scenario');

    if (this.options.profile === 'test') {
      const topic = findScenarioTopic(this.scenario, questions);
      if (topic && available.has('lookup_scenario')) {
        yield this.toolCall('lookup_scenario', { topicId: topic.id });
        return;
      }
      yield* this.textResponse(UNKNOWN_TEST_ANSWER, stream, signal);
      return;
    }

    const previousQuestions = questions.slice(0, -1);
    const impliedRecordFollowUp = isFollowUpQuestion(question) && previousQuestions.slice(-3).some(isRecordQuestion);
    const impliedAnalysisFollowUp = isFollowUpQuestion(question) && previousQuestions.slice(-3).some(isAnalysisQuestion);

    if (isRecordQuestion(question) || impliedRecordFollowUp) {
      if (this.options.selectedRecord && available.has('get_workspace_record')) {
        yield this.toolCall('get_workspace_record', {
          dataset: this.options.selectedRecord.dataset,
          id: this.options.selectedRecord.id,
        });
        return;
      }
      yield* this.textResponse(this.options.selectedRecord
        ? '当前业务记录查询工具未连接，无法读取这条记录；我不会改查其他来源。'
        : '请先在右侧业务页面选择一条记录，再询问它的详情或状态；当前不会猜测数据集或记录编号。', stream, signal);
      return;
    }

    if (isAnalysisQuestion(question) || impliedAnalysisFollowUp) {
      if (available.has('analyze_workspace')) {
        yield this.toolCall('analyze_workspace', { ...(this.options.analysisQuery ?? {}) });
        return;
      }
      const missing = this.options.dataSource === 'bigquery'
        ? '当前方案的数据源为 BigQuery，但本轮没有注册权威只读分析工具，因此无法查询指标；不会改用本地合成数据。'
        : '当前方案未提供可用的只读分析工具，因此无法核对指标。';
      yield* this.textResponse(missing, stream, signal);
      return;
    }

    const topic = findScenarioTopic(this.scenario, questions);
    if (topic && available.has('lookup_scenario')) {
      yield this.toolCall('lookup_scenario', { topicId: topic.id });
      return;
    }
    if (this.options.dataSource === 'bigquery') {
      yield* this.textResponse('当前方案指定 BigQuery；本轮没有可用的权威只读工具结果，因此无法回答该数据问题。我不会使用本地场景内容替代 BigQuery。', stream, signal);
      return;
    }
    yield* this.textResponse(outOfScopeAnswer(this.scenario), stream, signal);
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('本地模拟模型不支持音视频 Live');
  }

  private toolCall(name: string, args: Record<string, unknown>): LlmResponse {
    this.callNumber += 1;
    return { content: { role: 'model', parts: [{ functionCall: {
      id: this.options.profile === 'test' ? 'lookup' : `me-sim-${this.callNumber}`,
      name,
      args,
    } }] } };
  }

  private async *textResponse(text: string, stream: boolean, signal?: AbortSignal): AsyncGenerator<LlmResponse> {
    if (stream) {
      for (const chunk of text.match(/.{1,12}/gs) ?? []) {
        signal?.throwIfAborted();
        await delay(5, undefined, { signal });
        yield { content: { role: 'model', parts: [{ text: chunk }] }, partial: true };
      }
    }
    signal?.throwIfAborted();
    yield { content: { role: 'model', parts: [{ text }] }, partial: false, turnComplete: true };
  }
}

/** Shared legacy topic matching, including bounded pronoun follow-ups. */
export function findScenarioTopic(scenario: Scenario, questions: readonly string[]) {
  const recent = questions.slice(-MAX_CONTEXT_QUESTIONS).map(value => value.slice(0, MAX_QUESTION_CHARS));
  const match = (question: string) => scenario.topics.find(topic =>
    topic.keywords.some(keyword => question.toLowerCase().includes(keyword.toLowerCase())));
  const current = recent.at(-1) ?? '';
  return match(current) ?? (/^(那|它|这个|继续|为什么)/.test(current)
    ? recent.slice(0, -1).reverse().map(match).find(Boolean)
    : undefined);
}

function recentQuestions(request: LlmRequest): string[] {
  const questions = request.contents.flatMap(content => {
    if (content.role !== 'user') return [];
    // ADK appends function results as user content too; those are not user questions.
    if (content.parts?.some(part => part.functionResponse)) return [];
    const text = content.parts?.map(part => part.text ?? '').join('').trim();
    return text ? [text] : [];
  });
  return questions.slice(-MAX_CONTEXT_QUESTIONS).map(question => question.slice(0, MAX_QUESTION_CHARS));
}

function isAnalysisQuestion(question: string): boolean {
  return /分析|看板|指标|數據|数据|趋势|趨勢|统计|統計|对比|比較|比较|转化率|轉化率|營收|营收|收入|流量|roi|kpi|metric|dashboard|trend|compare|analytics|conversion/i.test(question);
}

function isFollowUpQuestion(question: string): boolean {
  return /^(那|它|这个|继续|为什么|还有|所以|then\b|what about\b|why\b|and\b)/i.test(question.trim());
}

function isRecordQuestion(question: string): boolean {
  return /这条|這條|当前记录|當前記錄|选中记录|選中記錄|记录详情|記錄詳情|查看明细|查看明細|具体案例|具體案例|记录编号|記錄編號|订单号|訂單號|订单详情|訂單詳情|订单明细|訂單明細|案例详情|案例詳情|record details?|record id|case details?|order details?/i.test(question);
}

function outOfScopeAnswer(scenario: Scenario): string {
  const topics = scenario.topics.slice(0, 4).map(topic => topic.title).filter(Boolean);
  const examples = scenario.topics.flatMap(topic => topic.followups).slice(0, 3);
  const coverage = topics.length ? `当前本地模拟覆盖：${topics.join('、')}。` : '当前没有配置可查询的场景主题。';
  const suggestions = examples.length ? `可以试试：${examples.join('；')}。` : '请在右侧查看本方案支持的数据与操作范围。';
  return `${coverage}${suggestions}此模拟模式不会调用 Gemini；未配置的数据不会被补写或猜测。`;
}

function formatToolResponse(
  name: string,
  response: unknown,
  profile: 'test' | 'simulated',
  selectedRecord?: SimulatedModelOptions['selectedRecord'],
): string {
  const result = asRecord(response);
  if (!result) return toolFailure(profile);
  if (Object.hasOwn(result, 'error') || result.success === false || result.ok === false || result.status === 'error') return toolFailure(profile);

  if (name === 'lookup_scenario') {
    return typeof result.answer === 'string' ? result.answer : toolFailure(profile);
  }
  if (name === 'analyze_workspace') return formatAnalysis(result, profile);
  if (name === 'get_workspace_record') return formatRecord(result, profile, selectedRecord);
  return '只读工具已返回结果，但当前模拟对话无法安全解释该结果；请在对应业务 Tab 查看原始信息。';
}

function formatAnalysis(result: Record<string, unknown>, profile: 'test' | 'simulated'): string {
  if (!Array.isArray(result.metrics)) return toolFailure(profile);
  const metrics = result.metrics.flatMap(raw => {
    const metric = asRecord(raw);
    if (!metric || !('value' in metric) || !(typeof metric.value === 'number' || metric.value === null)) return [];
    const label = typeof metric.label === 'string' ? safeText(metric.label) : typeof metric.id === 'string' ? safeText(metric.id) : '未命名指标';
    const unit = typeof metric.unit === 'string' ? safeText(metric.unit) : '';
    const value = Array.isArray(metric.partitions) && metric.partitions.length ? "按原币分项（不合计）" : formatMetricValue(metric.value as number | null, unit);
    const details = [
      typeof metric.sampleSize === 'number' ? `样本 ${metric.sampleSize}` : '',
      typeof metric.origin === 'string' ? `来源类型 ${safeText(metric.origin)}` : '',
      typeof metric.source === 'string' && metric.source ? `来源 ${safeText(metric.source)}` : '',
      typeof metric.notice === 'string' && metric.notice ? `说明 ${safeText(metric.notice)}` : '',
    ].filter(Boolean);
    const partitions = Array.isArray(metric.partitions)
      ? metric.partitions.flatMap(partition => {
        const item = asRecord(partition);
        if (!item || !(typeof item.value === 'number' || item.value === null)) return [];
        const partitionName = typeof item.currency === 'string' ? safeText(item.currency) : typeof item.label === 'string' ? safeText(item.label) : '分组';
        const partitionUnit = typeof item.unit === 'string' ? safeText(item.unit) : '';
        return [`${partitionName} ${formatMetricValue(item.value as number | null, partitionUnit)}`];
      })
      : [];
    const groups = formatGroups(metric.groups);
    const trends = formatGroups(metric.trendGroups);
    return [`- ${label}：${value}${details.length ? `（${details.join('；')}）` : ''}${partitions.length ? `；分项：${partitions.join('、')}` : ''}${groups ? `；分组：${groups}` : ''}${trends ? `；趋势分组：${trends}` : ''}`];
  });
  if (!metrics.length) return toolFailure(profile);
  const revision = typeof result.revision === 'number' ? `；演示状态版本 ${result.revision}` : '';
  const metadata = formatQueryMetadata(result);
  return `已按当前页面范围读取只读分析结果${metadata ? `（${metadata}）` : ''}${revision}：\n${metrics.join('\n')}\n以上数值来自本轮分析工具返回；缺失值保持为空，不代表未来效果。`;
}

function formatRecord(
  result: Record<string, unknown>,
  profile: 'test' | 'simulated',
  selectedRecord?: SimulatedModelOptions['selectedRecord'],
): string {
  if (Array.isArray(result.rows)) return formatRecordRows(result.rows, result, profile, selectedRecord);
  if (!Object.hasOwn(result, 'record')) return toolFailure(profile);
  if (result.record === null || result.record === undefined) {
    const metadata = formatQueryMetadata(result);
    return `当前所选范围内没有找到这条记录；没有读取其他数据集。${metadata ? ` ${metadata}` : ''}`;
  }
  const record = asRecord(result.record);
  if (!record) return toolFailure(profile);
  const fields = formatRecordFields(record);
  if (!fields.length) return '记录工具没有返回可展示的字段；无法据此确认记录内容。';
  const source = typeof result.source === 'string' && result.source ? `；来源 ${safeText(result.source)}` : '';
  const dataset = typeof result.dataset === 'string' ? safeText(result.dataset) : '';
  const job = formatQueryMetadata(result);
  return `已读取当前选中的业务记录${dataset ? `（${dataset}）` : ''}${source}${job ? `；${job}` : ''}：\n${fields.join('\n')}`;
}

function formatRecordRows(
  rows: unknown[],
  result: Record<string, unknown>,
  profile: 'test' | 'simulated',
  selectedRecord?: SimulatedModelOptions['selectedRecord'],
): string {
  const metadata = formatQueryMetadata(result);
  if (!rows.length) {
    const target = selectedRecord ? `（${safeText(selectedRecord.dataset)} / ${safeText(selectedRecord.id)}）` : '';
    return `只读记录查询已完成${target}，本次返回 0 行；没有找到符合当前范围的记录。${metadata ? ` ${metadata}` : ''}`;
  }
  const records = rows.map(asRecord);
  if (records.some(record => !record)) return toolFailure(profile);
  const expectedDataset = selectedRecord?.dataset;
  const resultDataset = typeof result.dataset === 'string' ? result.dataset : undefined;
  if (expectedDataset && resultDataset && expectedDataset !== resultDataset) return toolFailure(profile);
  const dataset = resultDataset ?? expectedDataset;
  const visible = records.slice(0, 10).flatMap((record, index) => {
    const fields = formatRecordFields(record!);
    return [`- 第 ${index + 1} 条：${fields.length ? fields.join('；') : '没有可展示的字段值'}`];
  });
  const omitted = rows.length > visible.length ? `\n另有 ${rows.length - visible.length} 行未展示。` : '';
  const source = typeof result.source === 'string' && result.source ? `；来源 ${safeText(result.source)}` : '';
  return `本轮只读记录查询返回 ${rows.length} 行${dataset ? `（数据集 ${safeText(dataset)}）` : ''}${source}${metadata ? `；${metadata}` : ''}：\n${visible.join('\n')}${omitted}`;
}

function formatRecordFields(record: Record<string, unknown>): string[] {
  return Object.entries(record).flatMap(([key, value]) => {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      const text = value === null ? '空值' : safeValue(value);
      return [`${safeText(key)}：${text}`];
    }
    return [];
  });
}

function formatQueryMetadata(result: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof result.jobId === 'string' && result.jobId.trim()) parts.push(`BigQuery job ${safeText(result.jobId)}`);
  if (typeof result.queriedAt === 'string' && result.queriedAt.trim()) parts.push(`查询时间 ${safeText(result.queriedAt)}`);
  const filters = formatFilters(result.filters);
  if (filters) parts.push(`筛选 ${filters}`);
  return parts.join('；');
}

function formatFilters(raw: unknown): string {
  const filters = asRecord(raw);
  if (!filters) return '';
  return Object.entries(filters).flatMap(([key, value]) => {
    if (value === undefined || value === null || value === '') return [];
    if (Array.isArray(value)) {
      const conditions = value.flatMap(item => {
        const condition = asRecord(item);
        if (!condition || typeof condition.field !== 'string' || typeof condition.op !== 'string' || !('value' in condition)) return [];
        return [`${condition.field} ${condition.op} ${safeValue(condition.value)}`];
      });
      return conditions.length ? [`${key}: ${conditions.join('、')}`] : [];
    }
    if (typeof value === 'object') return [];
    return [`${key}=${safeValue(value)}`];
  }).join('，');
}

function formatGroups(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  const groups = raw.slice(0, 8).flatMap(value => {
    const group = asRecord(value);
    if (!group || !(typeof group.value === 'number' || group.value === null)) return [];
    const label = typeof group.label === 'string' ? safeText(group.label) : '未命名分组';
    const count = typeof group.sampleSize === 'number' ? `，样本 ${group.sampleSize}` : '';
    return [`${label}=${group.value === null ? '暂无数据' : String(group.value)}${count}`];
  });
  const omitted = raw.length > 8 ? `，另有 ${raw.length - 8} 组未展开` : '';
  return `${groups.join('、')}${omitted}`;
}

function safeValue(value: unknown): string {
  if (typeof value !== 'string') return String(value);
  return JSON.stringify(safeText(value).slice(0, 160));
}

function safeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function toolFailure(profile: 'test' | 'simulated'): string {
  return profile === 'test'
    ? UNKNOWN_TEST_ANSWER
    : '只读查询未成功返回可核对的数据，因此我无法确认指标或记录；请检查当前数据连接后重试。';
}
