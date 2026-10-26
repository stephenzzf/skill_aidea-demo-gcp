import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isPlannedDomain } from '../assets/app/shared/solution.ts';

const lines = values => values.map(value => `- ${value}`).join('\n');
const cell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows].map(row => `| ${row.map(cell).join(' | ')} |`).join('\n');

/** Generates reviewable content, never inferred test results or completion claims. */
export async function writeDeliverables(output, spec, scenario) {
  const workspace = spec.workspace;
  const design = spec.design;
  const chatEnabled = spec.version >= 3 && spec.pages.some(page => page.components.includes('assistant') && !isPlannedDomain(page, design?.coverage ?? []));
  const execution = spec.execution ? `本期对话：${spec.execution.model === 'simulated' ? 'AI模拟对话（确定性场景引擎，非真实模型推理）' : '真实Gemini（需授权后验证）'}；数据后端：${spec.execution.data === 'bigquery' ? 'BigQuery（需授权后验证）' : '本地确定性分析'}；${scenario.synthetic ? '合成业务数据' : '数据按来源分别标识'}。云目标方案与本期验证范围分开，不因模拟演示宣称真实接入或效果。` : '沿用既有私有运行模式；未声明execution，不能据此确认云能力。';
  const solution = [
    `# ${spec.customer}：${spec.title}`, '', `目标：${spec.goal}`, '', spec.solution, '',
    '## 本期演示方式', '', execution, '', '## 业务依据与假设', '', '已知与已确认：', '', lines(design?.facts ?? ['本文件来自已确认的演示配置。']), '',
    '假设与待核实：', '', lines(design?.assumptions ?? ['业务资料为合成演示，真实系统和效果需单独验证。']), '',
    ...(spec.blueprint ? [
      '## 目标与衡量', '', table(['目标', '衡量方式'], spec.blueprint.objectives.map(item => [item.title, item.measure])), '',
      '## 依据与调研范围', '', table(['依据', '类型/状态', '发现', '来源与时间'], spec.blueprint.sources.map(item => [item.title, `${item.kind}/${item.status}`, item.finding, `${item.url ?? item.evidence ?? '客户对话/显式假设'} ${item.checkedAt ?? '未记录时间'} ${item.region ?? ''}`])), '',
    ] : []),
    '## 角色与业务流程', '',
    workspace ? table(['角色', '责任视角'], workspace.roles.map(role => [role.id, role.label])) : `演示对象：${spec.audience}`, '',
    table(['步骤/操作', '预期结果'], spec.steps.map(step => [step.question, step.expected])), '',
    ...(spec.blueprint ? [
      table(['旅程步骤', '角色', '业务描述', '领域/后续'], spec.blueprint.journey.map(item => [item.title, item.role, item.description, `${item.domainId ?? '方案阶段'} / ${(item.next ?? []).join('、')}`])), '',
      '## 首页与业务领域', '', chatEnabled && spec.presentation?.workspaceLayout === 'split' ? '桌面左侧为持续 AI 对话，右侧默认进入方案总览，随后为以下业务领域；可拖拽和收起对话。窄屏采用对话／Demo全屏切换。Header与右侧导航固定，两栏独立滚动。' : chatEnabled ? '默认进入独立“AI 智能对话”首 Tab，“方案总览”为第二 Tab，随后为以下业务领域。标题与 Tab 导航固定，内容独立滚动。' : '默认进入“方案总览”，随后为以下业务领域。标题与 Tab 导航固定，内容独立滚动。', '',
      table(['领域', '目标', '数据/指标', '动作', '方案主张'], spec.pages.map(page => [page.title, page.goal, `${page.datasets.join('、')} / ${page.metrics.join('、')}`, page.actions.join('、'), page.claimIds.join('、')])), '',
      '## 系统协作', '', table(['系统', '职责', '接入状态'], spec.blueprint.systems.map(item => [item.name, item.responsibility, item.status])), '',
    ] : []),
    '## 数据与指标', '',
    workspace ? table(['数据', '来源类型', '依据', '主键'], workspace.datasets.map(d => [d.label, d.origin, d.source, d.key])) : '合成主题知识与结果卡片。', '',
    workspace ? table(['指标', '口径', '范围'], workspace.metrics.map(m => [m.label, m.description, m.scope])) : '', '',
    ...(spec.blueprint ? [lines(spec.blueprint.dataNotes), '', table(['数据集', '关系'], workspace.datasets.map(dataset => [dataset.label, (dataset.relations ?? []).map(relation => `${dataset.id}.${relation.field} → ${relation.dataset}.${relation.target}`).join('；') || '无跨数据集关联'])), ''] : []),
    '## 实施路径与边界', '', lines(design?.implementation ?? ['本地演示验收后，按授权准备真实模型和 Cloud Run 部署。']), '',
    ...(spec.blueprint ? [table(['阶段', '实施内容'], spec.blueprint.phases.map(phase => [phase.title, phase.description])), ''] : []),
    '浏览器临时保存模拟事件；角色切换不代表真实身份权限。没有跨设备共享或真实业务写入。客户文件和合成数据分来源分析；历史快照不会因模拟行动而改写。', '',
    '## 方案—Demo 对照', '',
    table(['方案主张', '配置声明状态', '证据/待执行'], (design?.coverage ?? spec.acceptance.map(claim => ({ claim, status: 'unverified', evidence: '待实际执行' }))).map(c => [c.claim, c.status, c.evidence])), '',
    '状态来自方案配置，不是本次生成器执行验证的结果。实际证据见 VALIDATION.md 和后续验收记录。', '',
    '## 可选交付', '', 'PPT 使用同一方案、指标定义和验收状态，按需调用现有 ME 品牌 PPT Skill，并遵守其内容与配图确认流程。', '',
  ].join('\n');
  const playbook = [`# ${spec.customer} 演示 Playbook`, '', execution, '', '数据与动作边界：' + (scenario.synthetic ? '合成业务数据，操作仅改变当前标签页的模拟状态。' : '客户文件与合成数据按来源标识，操作只改变模拟状态。'), '',
    ...spec.steps.flatMap((step, index) => [`## ${index + 1}. ${step.question}`, '', ...(spec.version >= 3 ? [`步骤 ID：${step.id}；角色：${step.role}；页面：${step.pageId}；方案主张：${step.claimIds.join('、')}`, '', `前置条件：${step.preconditions.join('；') || '无'}`, '', `输入/操作：${step.inputs.join('；') || step.question}`, ''] : []), `预期结果：${step.expected}`, '', `观察点：${step.observation ?? '核对页面状态、来源记录、筛选范围和操作回执；聊天声称成功不能替代操作结果。'}`,  '实际结果：待执行。', '证据位置：待记录。', '']),
    '刷新应恢复当前标签页完整对话与模拟事件；“重新体验”清空这些临时状态。失败和取消不自动重试。', '',
  ].join('\n');
  const validation = [`# ${spec.customer} 验证记录`, '', '**状态：待执行。生成文件不等于验收通过。**', '', execution, '',
    table(['验收项', '当前结果', '证据'], spec.acceptance.map(item => [item, '待执行', '未执行'])), '',
    '结构化验收记录：validation-record.json。每条 entries 使用 id、status、evidence、basisDigest；实际验证后填写，不能把配置声明当验收结果。交付前运行 Skill 的 scripts/validation.mjs --app /absolute/demo 检查依据；源码、配置或数据变化会标记 needs-revalidation，保留旧证据。', '',
    '需分别记录配置/导入、确定性分析、业务闭环、UI、本地测试模型、真实模型和云端验收。模拟闭环不证明生产集成或商业效果。', '',
    '生成耗时仅覆盖配置校验、复制和机械文档生成；安装、构建、模型调用与人工工作另行计时。没有实际 Token/费用记录时写 unknown，不推算节省比例。', '',
  ].join('\n');
  const websiteSources = spec.blueprint?.sources.filter(source => source.kind === 'website') ?? [];
  const files = { 'SOLUTION.md': solution, 'PLAYBOOK.md': playbook, 'VALIDATION.md': validation, ...(websiteSources.length ? {
    'SITE-REVIEW.md': [`# ${spec.customer} 站点检查依据`, '', '本文件整理确认配置中的检查证据，生成器不进行站点抓取。来源未访问或只覆盖部分页面时按实际状态报告；公开页面不证明内部系统、真实流失原因或经营效果。', '',
      table(['页面/地区', 'URL', '检查时间', '状态', '观察/假设', '证据'], websiteSources.map(source => [source.title + (source.region ? ` / ${source.region}` : ''), source.url, source.checkedAt ?? '未检查', source.status, source.finding, source.evidence ?? '未提供截图；只支持已记录的内容观察'])), '',
      '建议与方案覆盖：见 SOLUTION.md；关键路径与结果验证：见 PLAYBOOK.md 和 VALIDATION.md。', ''].join('\n'),
  } : {}) };
  for (const [name, content] of Object.entries(files)) await writeFile(resolve(output, name), content);
  return Object.keys(files);
}
