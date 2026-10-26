---
name: aidea-demo-gcp
license: MIT
description: 通过需求调研和方案确认，使用 Codex 生成包含方案总览和业务领域 Tabs 的 ME 客户演示应用，启用 AI 时支持常驻对话与可拖拽的业务分栏；适用于完整业务方案、网站检查和交互验证，不用于长期生产系统。
---

# Aidea Demo GCP

Codex 负责需求、调研与方案确认；Web 演示已确认的完整方案及关键业务结果。默认复用固定 TypeScript 模板，客户内容以两份配置为主，不把任何客户案例变成通用业务默认值。

## 执行入口

1. **先复用已确认输入**。有旧应用时，先执行 `scripts/inspect.mjs --app /abs/app`；有配置时使用 `--spec /abs/demo-spec.json`。从摘要取得版本、Tab、能力、配置路径和复用状态，不先读取整套方案、schema、模板源码或历史工具输出。只有出现明确缺口才读相关文件。
2. **先检查环境，再确认方案**。在推荐Gemini/BigQuery实施前运行 `scripts/preflight.mjs`，分别识别项目候选、身份、应用凭据和服务状态；见[环境与演示模式](references/environment.md)。无可用GCP默认使用AI模拟对话＋合成数据看板，不阻塞完整业务方案；检测不代表资源或调用授权。已有环境摘要未变化时复用，未知不当作不可用。**未确认需求先设计**。网站任务核实官方 URL，按目标检查代表性页面，记录日期、地区和依据；见[网站检查](references/website-review.md)。方向模糊时给3–5个有依据的方案选项逐步收敛；见[需求发现](references/discovery.md)。完整方案应覆盖目标、角色、流程、数据、系统、实施与验收；见[方案设计](references/solution-design.md)。方案和 Demo 范围确认后才生成；已确认内容直接沿用，不重复访谈。
3. **匹配而非重写**。新应用使用V4，明确execution模型/数据模式，兼容V1–V3及旧V4。先匹配[已有能力](references/capabilities.md)，只读取相关[配置合同](references/configuration.md)。合成数据用固定种子脚本，客户数据用既有导入器。固定UI/问答/指标/流程代码直接复制。现有扩展已声明清单时用 `--reuse`，只复制已核对模块；新扩展只接[两个静态入口](references/extensions.md)，不逐客户修改App、路由、Agent或聊天合同。
4. **一次冻结，一次相关验证**。通过 `scripts/pipeline.mjs` 生成、安装、类型检查、测试和构建，见[快速生成](references/fast-generation.md)。单一负责人冻结后运行；已通过的同版本结果可复用，不让子任务与主任务反复运行同一检查。使用 `--reuse-checks` 复用有完整依据的本地证据；UI变化仍手工验证；仅样式变化可复用类型/测试，客户端逻辑或后端/配置/数据变化重验。真实模型仅做合同变化所需、已有授权覆盖的最小场景，不因重新生成就重复调用。
5. **交付有范围的证据**。按Playbook核对实际业务结果，之后 `scripts/finalize.mjs` 校验摘要并打包。交付完整方案、交互Demo、Playbook、验证报告和生成记录；网站任务增加站点报告。详见[验证](references/validation.md)。总墙钟、机械生成、安装、验证、真实推理分开；Token区分缓存/非缓存、主会话/子任务/Provider，缺失记unknown，不推算节省比例。

## 必须保持的体验与合同

- 新生成且启用AI的V4 Demo明确配置 `presentation.workspaceLayout:"split"`：左侧常驻AI对话，右侧从方案总览开始，有经营看板时默认紧随其后，再排列确认的业务领域Tabs；可拖拽、收起／展开使用边界顶部纯图标按钮，窄屏采用对话／Demo全屏切换。既有省略配置的应用仍保持聊天首Tab。布局见[分栏工作区](references/split-workspace.md)。Header与导航固定，内容独立滚动；直达链接、前进/后退、刷新与重置有效。方案总览展示完整方案和方案—Demo对照，不放需求表单或生成后台。
- 外壳、方案、分析和问答默认中文；客户官网/独立站体验按已核实来源的语言与品牌局部呈现，语言与国家/币种分开判断。客户案例仅作回归参考，不作为通用默认业务。
- assistant-ui使用锁定的官方Google ADK Runtime与模型实际返回的公开思考摘要、轻量工具过程、Markdown、复制/导出、引用追问、本地赞踩及受控业务卡片能力。消息区独立滚动，Composer占实际布局空间，不盖住正文；用户上滑时不强制拉回底部。NativeChat是消息权威，薄传输层校验显式完成信号，adk-history只保存完整轮次；App不再另写SSE或聊天状态机。不启用Cloud账户或第二后端。界面组合与接线见[对话UI](references/chat-ui.md)；稳定消息ID、异常EOF、取消、旧历史迁移及版本约束见[聊天运行时](references/chat-runtime.md)。
- 业务能力表单复用固定CapabilityPanel与样式：统一标签、输入控件和紧凑主按钮，宽卡双列、窄卡单列；不逐客户重写或让控件退回原生样式。详见[能力目录](references/capabilities.md)。
- 正式模拟模式保留左侧AI模拟对话与右侧业务Tabs，复用同一分析工具读取当前数据及状态；未知问题明确范围，不伪造自由推理、内部思考或云Job。真实Gemini与BigQuery分别选择，数据来源独立标识，运行失败不静默切模式。
- 确定性代码计算指标，AI理解、解释与起草；动作处理器校验、执行模拟迁移并给回执。只有一个当前分析权威，AI不能把回复当执行结果。来源、历史快照和当前模拟状态分别标识；verified需证据，simulated不是生产效果，unverified/planned如实呈现。
- React/Vite/TypeScript + Express + 官方ADK，一个服务/锁文件，用户自己的Google Project，`maxLlmCalls=0`；不加模型配额、数据库、任意代码执行或真实业务写入。取消/结果不明不自动重试。扩展ID、版本与上下文由服务端校验，扩展路由位于现有访问保护之后。
- 生成拒绝覆盖已有目录；`--update`只改兼容配置与manifest，不覆盖客户源码/人工文档。过期证据失效但保留历史；复用清单不等于验收通过。

Cloud Run按需见[部署](references/cloud-run.md)。PPT按需复用同一方案调用ME品牌PPT Skill，并遵守其内容和配图确认流程。本Skill不包含视频生成、录制或交接。
