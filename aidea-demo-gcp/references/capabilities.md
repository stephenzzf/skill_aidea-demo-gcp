# V4 复用能力

先运行 inspect，再只读涉及的能力；不把某客户实体或国家/币种规则固定到模板。V4 保留同一 workspace 分析与一条工作流，不构建任意流程平台。基础指标卡、趋势、分类、明细、筛选、记录详情、跨 Tab 链接、确认与活动记录已经可复用；无需额外图表或表格依赖。

## 绑定合同

每项 `{id, kind, version:1, label, pages:[领域ID]}`，pages 只能是存在的业务领域，不能包含 chat/solution。后续接入的领域不可执行动作。

- `partitioned-analysis`: `{dataset,currencyField}`。同数据集金额指标按原币分别计算，跨币种总值为 null；保留每区来源记录和筛选。缺币种记录有说明，不转换汇率。solution 汇总继承已启用领域能力，不能重新混算。不同计量单位的业务应分指标建模，不假装已支持任意单位转换。
- `mapping-review`: `{role,dataset,targetField,targetDataset,evidenceField,statusField?,resolvedStatus?}`。targetField 必须有声明关系，目标存在且类型一致，依据必填。复核后不可覆盖已确认映射；相关工作项通过已有 staleField 标记待重评。不是自动全量实体融合或生产 MDM。
- `work-items`: `{role,dataset,inputFields,defaults}`。复用已配置 workflow.dataset，表单只允许声明输入，必填字段与初始状态完整。创建后普通迁移、校验、requireFresh/clearsStale 和回执仍由同一工作流实现。默认浏览器创建使用字符串主键；若需非字符串主键应显式扩展输入，而非静默转换。

映射/创建命令授权由绑定 pages/role 决定，不写入 pages.actions。事件仍使用既有 WorkspaceState；服务端每次重放校验，拒绝未知或非法事件。幂等仅在客户端带回已有事件时回读；本架构无数据库，网络丢失而响应未知不能假称服务端可恢复审计，更不能自动重试。

## AI 与 UI

新模板使用锁定的 assistant-ui 0.15.18 与 react-google-adk 0.0.40。官方 useAdkRuntime 维护消息和工具状态，薄适配层提供受保护的 ADK SSE、显式完成信号与本地完整轮次快照。App只协调配置和业务上下文；不增加云端会话或第二模型链。保留卡片/来源/追问；不启用编辑、重试、分支、多会话、附件或语音。详见[聊天运行时](chat-runtime.md)。

V4 看板和 AI 共用 analyzeDomain/analyzeCapabilities。默认注入指标、分区、口径与来源计数，移除整批 rows；analyze_workspace 按声明字段计算，get_workspace_record 按允许领域读取单条当前记录。未引入调用/Token 配额，ADK maxLlmCalls=0 不变。已有 SSE 和临时会话合同不变。

## 选择与扩展

将方案主张对应到已配置的字段/指标/角色/动作/页面；支持的直接绑定，不复制样例业务代码。能力之外的明确行为先记录缺口和验收，再新增最小内聚扩展，通过公共分析/状态边界接入。页面、客户数据与业务名称来自确认方案，不是任一客户样例的替换标题。

访问 Cookie 按稳定 Demo ID 隔离，同一主机多个端口可并存；每份服务仍独立校验签名、到期与配置版本。旧客户源码不自动更新，升级后的新运行时需重新登录一次。

能力表单复用CapabilityPanel的mw-capability-*样式：标签上置、统一控件高度和圆角、按可用容器宽度双列／单列；依据等长文本跨列，主操作保持紧凑宽度。不要只写inline grid而让input/select退回原生样式；样式限于业务能力边界，不影响客户官网体验和聊天。
