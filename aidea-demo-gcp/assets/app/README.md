# ME 客户演示

React/Vite + TypeScript + Express + 官方 ADK，共用一个服务。客户内容在 `demo-spec.json` 与 `scenario.json` 中配置；Codex 对话负责调研、需求澄清与方案确认后生成。V4 新生成启用AI时明确配置`presentation.workspaceLayout:"split"`：左侧AI对话、右侧方案总览及业务领域Tabs；可拖拽、收起，窄屏切换对话／Demo。省略或tabs保持旧版AI首Tab行为。标题与导航固定，内容独立滚动；说明界面默认中文，客户网站体验按来源语言与品牌。V1–V3 保持兼容。支持合成数据与客户授权 CSV/JSON，来源分别标注。

## 本地运行

要求 Node.js ≥22.18。执行 `npm ci && npm run build && npm test`。创建应用目录外的私有访问配置：

```sh
npm run access -- /absolute/private/demo.env
node --env-file=/absolute/private/demo.env --experimental-strip-types server/index.ts
```

访问 `http://localhost:8080`。从私有文件读取 `DEMO_OPERATOR_ACCESS_CODE` 输入页面；该文件权限 600，不提交、不在日志输出。默认有效期为生成后 24 小时。需新访问码时生成一个新的私有文件，不覆盖旧文件。轮换服务器配置后旧 Cookie 不再有效。

开发时用 `node --env-file=/absolute/private/demo.env --experimental-strip-types --watch server/index.ts --dev`，仍是同一端口和同源 API。端口通过 `PORT` 环境变量配置；私有环境已导出时可用 `npm run dev` / `npm start`。

默认 `simulated` 是正式AI模拟对话模式：无需Google Project或凭据，经过实际ADK Runner、只读工具和SSE；场景匹配与确定性分析不等于真实模型自由推理。未覆盖问题明确提示范围。`test` 仅用于内部验证兼容。界面分别显示模型模式、数据后端和来源。真实模式设置 `DEMO_MODEL_MODE=vertex`，指定自己的 `GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`、`DEMO_MODEL` 并使用 ADC；不自动回退到模拟或测试模式，不在前端提供模型凭据。

## 会话和接口

- `POST /api/access {code}` 换取 HttpOnly Cookie；访问码到期后 API 拒绝访问。Cookie 名称按 Demo ID 隔离，不同演示可同主机并存。
- `GET /api/config` 返回受保护的客户展示配置。
- `POST /api/chat {message,history}` 返回 SSE `text/card/done/error` 事件。history 只接受完整的 user/assistant 文本对，不能注入系统/工具事件。
- `GET /api/workspace` 返回业务配置与初始临时状态。
- `POST /api/analysis {query,state,domainId?}` 确定性计算指标、分组、趋势和来源明细；V3/V4 必须提供领域 ID，结果限定该领域配置范围。
- `POST /api/actions` 接收允许的动作、角色、记录、输入、expectedRevision和state，返回模拟状态与回执。
- `/api/chat` 可选 context（query/state/selectedRecord定位），V3/V4 问答必须包含有效 `domainId`，且该领域启用了 assistant。服务器校验领域、筛选和记录，重新计算分析；模型不决定 KPI 或业务状态。V3/V4 动作也需 `domainId` 且动作在领域中启用。
- `GET /api/health` 只检查进程，不触发模型。

会话临时保存在当前浏览器标签页；每次请求建立独立 ADK 内存会话并重放文本上下文，不依赖实例连续存活。只保存完整轮次；关闭标签页、存储被禁用或清除时不保证恢复。没有跨设备历史、数据库或真实业务写入。重置在浏览器完成。V2 只保存模拟事件，服务器从原始记录重放并校验。角色切换只表示演示视角。客户端已有event可识别重复请求；响应未知且仍持旧状态时不能保证跨实例去重，因此不自动重试。

ADK `maxLlmCalls=0`；无轮次、用户、Demo、调用次数或 Token 配额。传输正文有 2 MiB 大小保护，请求默认超时 240 秒（`DEMO_REQUEST_TIMEOUT_MS`）；不自动截断历史、不自动重试中断。真实模型/平台仍有自身限制。前端停止会将取消信号传入 ADK/模型；Provider 已开始的请求不保证取消计费。

## 部署准备

Dockerfile 使用同一锁文件构建并以非 root 身份运行；`.env`、本地凭据、测试证据不进入镜像。`scripts/deploy.mjs` 默认仅输出参数，须显式目标项目、区域、服务、服务身份和私有 JSON 环境文件；`--execute` 才实际部署。完整流程见 Skill 的 `references/cloud-run.md`。本地通过不代表已部署或真实模型已验收。

`generation-manifest.json` 记录模板摘要与复制耗时。配置更新使用 Skill 的 `generate.mjs --update`，只更新两份配置及 manifest，不覆盖源代码。场景行为超出模板时再扩展对应工具/组件。

## 方案与业务体验

V3/V4 的方案首页与 SOLUTION.md 读取同一确认配置。业务 Tab 使用 `#tab=领域ID`，记录直达可附加 dataset 与 record 参数；首页为 `#tab=solution`。跨 Tab 共用模拟事件，各领域保留自己的筛选与选中记录；split 布局左侧聊天持续挂载，tabs 布局保留首位聊天 Tab。方案、数据或源码变化后，交付前运行 Skill 的 `scripts/validation.mjs --app /absolute/demo` 标记过期证据；`validation-record.json` 保存当前依据与历史记录。该检查不会自动宣称通过。

V2 的 SOLUTION.md、PLAYBOOK.md 和 VALIDATION.md 由配置生成，验证文档初始状态待执行；实际执行后填入证据，不因文件存在宣称通过。方案可覆盖更完整落地路径，Demo仅验证明确列出的关键场景。配置更新不覆盖人工文档，更新后应重新核对。

看板与AI使用同一确定性分析函数。指标显示口径、样本数、来源与范围，缺值不当零，比例分母为零显示暂无数据。snapshot指标来自初始数据，current指标来自模拟状态；模拟行动不会篡改历史业务结果。

业务操作需要确认，失败保留输入，取消不提交，条件改变可标记建议待重评。没有真实系统接口时只产生模拟回执，不能据此宣称已发消息、建真实工单、购买或改变经营表现。客户数据在生成阶段经CSV/JSON导入，页面不提供制作后台。

## V4 模板复用

聊天界面使用锁定的 assistant-ui Google ADK Runtime（react 0.15.18、react-google-adk 0.0.40）及官方 primitives。NativeChat 维护原生消息/工具状态，adk-transport 只适配受保护的 `/api/chat/adk` 和显式完成信号，adk-history 保存完整轮次并兼容旧历史。App只协调业务上下文和重置。取消、错误或提前EOF不保存、不自动重试；存储不可用时保留内存历史并显示提示。复制和回到最新使用官方组件；无需Assistant Cloud、数据库或第二后端。锁定版本的取消需要显式 `unstable_allowCancellation`；升级依赖前须重验取消和异常。

`capabilities` 可选择原币分析、映射核实与字符串主键工作项，复用既有确定性分析和状态流转；未知类型/版本/字段及无效引用明确拒绝。V4 默认给模型提供不带明细行的分析摘要，单条记录通过只读工具按需读取；不新增模型调用或 Token 配额。

用 Skill 的 inspect/seed-data/pipeline/finalize 脚本减少重复读文件、手工数据编写和验收打包。源码、配置与证据摘要分别记录，模板复制耗时不能当作完整交付时长。只修改兼容配置的更新不会覆盖客户源码；现有客户应用需显式新目录升级才获得新模板。


## 扩展与检查复用

客户行为通过 `client/demo-extension.tsx` 和 `server/demo-extension.ts` 两个静态入口接入；业务模块位于对应 `extensions/` 目录。Provider、领域页回退、聊天上下文校验和受保护路由由模板统一接线。声明权威扩展分析后，内置分析快照与工具让位；仅有摘要的只读分析也可运行。默认入口不启用扩展，不包含客户业务或品牌规则。

Skill 的 `reuse.mjs` 为明确模块记录文件、依赖锁与 API 摘要；生成时 `--reuse` 只适用于新目录，不覆盖核心文件。先用 `inspect.mjs --app` 读取紧凑摘要，按缺口读取资料。运行 `pipeline.mjs --app … --report … --reuse-checks` 可复用相同源码、配置、环境、测试选择及日志校验通过的本地检查；客户端变化仍需界面验证，后端或数据变化重新检查。它不复用或宣称新的真实模型、云端及业务验收。

### 对话UI

模板包含工具过程分组、Markdown/GFM与代码复制、回复复制/Markdown导出、整条与选区引用及本地赞踩反馈。引用转成用户提供的普通文本上下文，反馈只保存在当前浏览器会话；重置会清理。工具结果仅作只读展示，原始JSON位于折叠技术详情。原生HTML不执行。运行时版本保持锁定，新增react-markdown0.14.24和remark-gfm4.0.1；扩展清单须匹配新依赖锁。

## chat-ui-v3：Thread 视觉与受控业务卡片

界面按官方 Thread 层级组织：轻量查询过程、可见业务结果卡、最新回复操作栏、后续建议及紧凑输入区。保留锁定的 assistant-ui 原生 ADK Runtime，不复制最新版API、不新增后端或依赖。结构参考固定上游 [1fc83e9](https://github.com/assistant-ui/assistant-ui/tree/1fc83e9f51d43fca1f48f3c561e9075681285c15) 与官方 [Thread](https://www.assistant-ui.com/elements/thread)、[Approval Card](https://www.assistant-ui.com/elements/approval-card)；本模板使用兼容的primitives自有组合，没有声称直接安装最新整套Thread或ADK原生审批协议。

已知分析/记录工具用严格结构校验选择业务卡片，其他工具继续安全回退。字段与动作来自方案配置；聊天内的模拟动作沿用`/api/actions`，必须确认、版本匹配及收到有效回执后才更新V3Workspace单一状态。回执可随标签页刷新恢复，跨领域Tab读取相同事件；不是生产审计或跨设备持久化。历史查询卡保留当时数据范围，去领域页面查看时明确其筛选独立。

后续建议和动作选项来自当前配置和状态，无额外模型请求。附件、语音、编辑、再生成和分支不在本版范围。新版本在新目录生成；旧客户目录不自动覆盖。

公开摘要与工具过程：chat-process-v1 复用官方 ChainOfThoughtPrimitive，启用 Gemini includeThoughts；仅展示实际返回摘要，不公开签名。完整轮次可刷新恢复，后续模型历史仅发送普通正文。没有工具调用时不生成过程。

## 已确认执行配置

V4新配置明确 `execution: {model:"simulated",data:"local"}`。无云时保留左侧AI模拟对话、右侧方案/看板/业务页；合成数据仍通过确定性工具计算，模拟操作只改变本次体验。模型、数据可分别升级为vertex和bigquery，先在Codex中确认方案及对应云验证/资源授权。BigQuery需要客户数据扩展，不是基础模板的默认依赖。

运行前由Skill `scripts/preflight.mjs` 输出不含凭据的环境摘要；当前项目只是候选，检测结果不授予任何云写入或模型调用权限。访问文件默认simulated；显式Vertex可用 `npm run access -- /absolute/private/demo.env --mode vertex`，随后按已有私有机制填写项目、地域、模型和ADC。模拟模式与已确认execution不一致时拒绝启动，不静默改模式。
