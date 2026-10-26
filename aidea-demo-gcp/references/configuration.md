# 配置与生成

运行时与生成器共用 `assets/app/shared/spec.ts`、`shared/solution.ts` 和 `shared/workspace.ts` 中的校验逻辑。V1–V3 保持兼容；新的 Demo 使用 V4，复用 V3 完整方案与领域合同。配置未知字段或跨页面引用无效时必须报错，不能静默丢弃。

## 版本

- **V1**：合成问答演示，字段为 `version:1`、`confirmed:true`、客户/助手展示信息、`goal`、`solution`、`prompts`、`steps[{question,expected}]`、`acceptance` 和 `model`。
- **V2**：在共同字段上增加 `workspace` 与 `design`；继续使用现有 overview/records/workflow/assistant 工作区表现。旧样例只用于兼容和相近场景参考。
- **V3**：完整方案、多 Tab；要求 `workspace`、`design`、`blueprint` 和 `pages`。
- **V4**：沿用 V3，新增严格校验的 `capabilities` 和可选 `presentation`；Scenario 仍为 `version:2`，不增加第三份业务配置。能力见[能力目录](capabilities.md)。

V3/V4 的 `design.coverage` 每条使用稳定 `id`、`claim`、`status` 和 `evidence`。`status` 为 `unverified`、`simulated`、`verified` 或 `planned`；只有执行后有证据，才可更新为 verified。

V3/V4 `blueprint` 表达客户方案：

- `objectives`: id、title、measure。
- `sources`: id、title、kind、finding、status，可选 URL、检查时间、地区与证据。`kind=website` 要求有效公开 HTTP(S) URL 和 `checkedAt`；网页结论不能升级成业务效果实证。
- `journey`: id、title、role、description，可选 domainId 与 next；角色、领域和后续引用必须存在。
- `systems`: id、name、responsibility、status。只有真实接通并核实后才可用 connected。
- `dataNotes`、`phases`: 方案中的数据说明和实施阶段。

## 执行模式与环境

推荐方案前按[环境检查](environment.md)识别条件，再确认本次验证范围。V4可选 `execution: {model:"simulated"|"vertex", data:"local"|"bigquery"}`；新方案明确填写，省略仅作旧配置兼容，不自动猜测真实能力。四种组合均可表达：无GCP默认simulated/local；模型可用但无BQ用vertex/local；仅BQ可用用simulated/bigquery；两者可用且获授权用vertex/bigquery。模型与数据来源分别标识，真实BQ不等于真实客户数据。

正式模拟模式不需要Google项目或凭据，保留assistant-ui、ADK Runner与工具卡片。经营回答通过同一确定性分析/记录工具获取当前结果，模拟场景问答不等于真实模型自由推理；未覆盖问题明确提示范围。test仅内部兼容测试，不作为客户的模拟模式名称。BigQuery配置需已注册的数据扩展与有效范围，缺失或失败不回退本地数字。

私有 `DEMO_MODEL_MODE=simulated|vertex` 必须与execution.model一致；test仅内部测试可显式使用。新增访问配置默认simulated，可用 `--mode vertex` 明确选择云模式。旧客户端不认识execution时更新明确拒绝，需新目录升级；新manifest声明execution-modes-v1。模拟能力在方案对照中标simulated，真实能力有证据后才标verified；完整GCP目标方案保留planned接入条件。

## AI 智能对话、方案总览与领域页

新生成且启用AI的V4显式设置 `presentation.workspaceLayout:"split"`：左侧常驻AI对话，右侧从 `solution` 方案总览开始，有经营看板／分析总览时默认在确认的 `pages` 配置中排首个业务领域。之后按已确认顺序呈现其他领域。旧配置省略布局或显式 `tabs` 时保留独立 `chat` 首Tab、`solution` 第二Tab的兼容行为。未启用 AI 时不强制显示 chat Tab，solution 成为首个可见 Tab，之后仍保留按需启用 AI 的能力。`chat` 是应用导航入口，不作为业务领域写入 `pages`；`solution` 由完整方案和 `blueprint` 自动呈现，也不写入 `pages`。两者 ID 均保留为系统路由，不可复用作业务页 ID。

标题与Tab栏固定，内容区域独立滚动。split收起／展开为分栏边界顶部的纯图标按钮，保留可读名称和提示；能力表单复用统一控件和响应式样式。split布局中问答按右侧已启用assistant领域读取允许的筛选、记录与模拟状态；其他领域明确回落到全方案只读范围，清除旧领域记录与筛选。tabs兼容布局中聊天读取方案级上下文。当前后端 `domainId=solution` 仅用于选择只读上下文，不表示权限，也不是业务动作入口；状态变化只能由相应业务领域页面的动作处理器校验执行。AI 智能对话不在各领域页重复渲染。`pages` 按已确认顺序声明领域 `id/title/goal`、`datasets/metrics/actions`、`components`、`claimIds` 与 `links`。`components` 仅允许 `metrics`、`records`、`workflow`、`assistant`；禁止声明不支持的组件。保留 `assistant` 声明的配置兼容性与领域知识归属，不能据此自动在每个业务页添加聊天面板。

模板说明界面、AI 智能对话与方案总览默认中文。客户网站扩展按调研来源和已确认方案选择语言与品牌，V4 使用 `presentation: {shellLocale:"zh-CN", experienceLocale:"en", workspaceLayout:"split", brand:{primaryColor:"#7750A0", logoUrl:"/assets/logo.svg"}}`（brand 可省略）。当前外壳只支持 zh-CN，其他外壳语言明确拒绝；体验语言为合法 BCP47。客户扩展用 `CustomerExperience` 局部设置 lang，不给整页中文外壳错误标为英文；语言标记不自动翻译内容。Logo 只允许 /assets/ 或 HTTPS，颜色只接受六位十六进制。V3 可在 `blueprint.dataNotes` 记录语言与素材依据。网站扩展沿用已有状态和分析边界，不把某一客户的电商组件作为所有场景的必选项。

当前固定模板使用一条共享工作流演示跨领域交接；多个独立业务工作流需在确认方案中明确范围并增加必要客户扩展。

每个领域只能引用已有数据集、指标、动作与方案主张。`records` 要有数据集；`metrics` 要有指标；`workflow` 要有已配置工作流及该领域允许的动作。`pages[].actions` 只列普通 workflow transitions；V4 的 review/create 命令由 capability.pages 授权并显示，不重复放入 actions。跨域 link 目标必须是系统路由 `solution`、启用时的 `chat` 或已配置业务 Tab；目标数据集必须属于目标领域；recordId 必须能在 scenario 中找到对应记录。ID 不得重复，`chat` 与 `solution` 不能作为普通领域页 ID。

步骤保留 `question/expected`，并加稳定 `id`、`role`、`pageId`、`preconditions`、`inputs`、`observation` 和 `claimIds`。角色、Tab 和主张引用必须有效。首页内容、领域 Tab、Playbook 与验收使用相同 ID，避免复制出多套口径。

## Scenario 与数据

V3 的 `scenario.instruction` 仅写所有领域通用的回答规则和边界；业务事实及领域知识放入有显式 `domainIds` 的 topics，不通过全局指令绕过领域归属。

Scenario V2 声明 `version:2`、`synthetic`、`instruction`、`topics` 和 `workspace.datasets`。各数据集用内联 `rows` 或相对 `file` 加可选 `mapping`。文件路径相对 scenario 文件，CSV/JSON、主键、类型、字段、关联和来源按[数据分析](data-analysis.md)校验。V3 中每个 topic 必须提供非空 `domainIds`，并引用 `demo-spec.json.pages[].id`；允许多个领域共享，但必须显式列出每个适用领域，不隐式视为全局主题。

`scenario.synthetic` 必须等于所有 workspace 数据集均为 synthetic。客户文件需经授权并在生成阶段导入；不得混淆客户数据和合成样本，也不得把私密原文件塞进公开证据目录。每份 V3 示例只有一组 spec/data 且自包含所引用文件。

## 示例

- `examples/v4/service-spec.json` / `service-data.json`：设备服务受理、工作项创建与履约跟进。
- `examples/v4/subscription-spec.json` / `subscription-data.json`：多地区订阅经营、原币分析、方案映射核实与运营动作。两者均为固定种子合成数据，非真实客户经营记录。

- `examples/v3/geo-spec.json` 与 `geo-data.json`：品牌洞察 → 行动运营，体现分析指标、关联来源、跨领域记录跳转和回执。数据为合成样例。
- `examples/v3/service-spec.json` 与 `service-data.json`：设备服务受理 → 履约跟进，体现服务案例与活动的跨领域关联。属于独立合成业务，不继承特定客户的商品或区域规则。
- `examples/v2/`：保留作旧配置兼容参考；其中器材案例为虚构品牌与合成数据，不代表真实客户或商品。

只读最接近的一组样例；调整业务实体、Tab、指标和系统边界，不能只替换标题或照抄数据规则。

```sh
node --experimental-strip-types /abs/aidea-demo-gcp/scripts/generate.mjs \
  --spec /abs/demo-spec.json --data /abs/scenario.json --check
node --experimental-strip-types /abs/aidea-demo-gcp/scripts/generate.mjs \
  --spec /abs/demo-spec.json --data /abs/scenario.json --out /abs/new-demo
```

`--check` 导入并校验但不写产物。生成拒绝已有输出目录，避免覆盖客户内容。生成初始 `VALIDATION.md` 与待执行的 `validation-record.json`；生成成功不代表方案或 Demo 验收通过。

独立客户或独立演示实例使用不同的 `id`，避免同主机访问 Cookie 的名称冲突；生成后的更新保持原 ID。

`--update` 只允许同 id、兼容模板能力的更新，只更新配置、manifest 和结构化 `validation-record.json`；不覆盖源码或人工维护的 SOLUTION/PLAYBOOK/VALIDATION 文档。旧模板不支持所需 V3/V4 时需要按明确目标新目录升级，不静默删除 V3 字段。

新模板 manifest 的 `templateFeatures` 包含 `chat-tab`。更新配置若显式引用 `chat` 导航，目标运行时必须声明该能力；旧模板会明确拒绝，需在新目录升级，不能只写入旧运行时无法解析的配置。V4 同样要求 templateCapabilityVersion>=4；旧运行时更新会明确拒绝，不覆盖客户源码。

`generation-manifest.json` 记录模板文件快照、模板复制代码文件数/行数、`demo-spec.json` 与 `scenario.json` 的摘要、验证记录摘要和机械生成耗时；不会自动统计客户新增或修改的代码量。若需报告扩展代码量，必须另行实际测量并说明口径。`generationMs` 不含调研、方案确认、安装、构建、手工验证或模型时间，不得称完整交付时长或 Token 节省。

## 工作区布局

V4 `presentation.workspaceLayout` 可选 `tabs` 或 `split`。省略维持旧聊天首Tab；新生成启用AI的Demo明确使用split。split将AI常驻左侧，右侧从solution开始，不重复chat Tab；旧chat链接展开左侧并显示solution。未启用AI时仍显示方案与业务页面。详情见[分栏工作区](split-workspace.md)。`--update`到未声明split-workspace-v1的运行时必须拒绝并提示新目录升级，不覆盖源码。

技能改名为 `aidea-demo-gcp` 后，新生成清单的 `generator` 使用新标识；配置更新与验证流水线仍接受历史 `me-demo-generator` 清单，保留其原始标识，不自动重写旧客户源码。
