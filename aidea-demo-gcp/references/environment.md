# Google Cloud 环境预检

在方案发现早期先确定客户 Demo 的 AI 与数据验证路径，避免默认假设每位使用者都有 Google Cloud Project。执行：

```sh
node "${CODEX_HOME:-$HOME/.codex}/skills/aidea-demo-gcp/scripts/preflight.mjs"
```

若客户明确指定了候选 Project，可使用 `--project PROJECT_ID`。仅当方案需要只读查看项目已启用的 API 时，加 `--check-services`；该选项会对所选 Project 执行 `gcloud services list --enabled --project=PROJECT_ID`。没有 Project 时不调用该命令。

## 检查边界

默认模式只检查本机 `gcloud`、`bq` 版本、当前 gcloud 配置中的 Project 候选、CLI 活动认证状态，以及 ADC 是否在常见本地位置有配置迹象。它不会登录、切换项目、列举用户可访问的所有 Projects、启用 API、创建或修改云资源、运行 BigQuery 查询、调用 Gemini，也不打印账号、密钥、Token、凭据路径或 CLI 原始错误。

Project 候选按显式 `--project` 优先，其次使用当前 gcloud active configuration 的 `core/project`。二者都只是**候选目标**，不证明用户拥有使用权限。项目 ID 不作为 Skill 的客户默认值；方案确认前不可据此连接云资源。

`gcloud auth list` 只说明本机 CLI 是否显示活动账号；它不验证 ADC。若 `GOOGLE_APPLICATION_CREDENTIALS` 非空，只标 `configured-unverified`，不据此断言文件存在；标准 ADC 文件经本地存在性检查确认后标 `present-unverified`。两种状态都不读取凭据内容、不获取 Token，也不确认凭据有效。文件检查报错时为 `unknown`。ADC 还可能来自运行时附加身份，因此本地未发现 ADC 时也标为 `unknown`，不能据此断言不存在凭据。Google 官方文档说明 gcloud CLI 认证与 ADC 是分开的凭据来源，并列出 macOS/Linux 的标准 ADC 文件位置：[ADC 的工作方式](https://docs.cloud.google.com/docs/authentication/application-default-credentials)。

服务检查只报告指定 Project 中 `aiplatform.googleapis.com` 与 `bigquery.googleapis.com` 是否出现在 enabled service 列表。API 已启用、Project 已配置、gcloud 有活动账号或本地存在 ADC，都不证明模型/数据 API 权限、区域/模型可用性、配额或查询成功。请求拒绝、网络不可用、CLI 故障和权限不明一律记录为 `unknown`，不能误报为“服务未启用”或“没有 Project”。参考 [gcloud active configuration](https://docs.cloud.google.com/sdk/gcloud/reference/config/get)、[gcloud auth list](https://docs.cloud.google.com/sdk/gcloud/reference/auth/list) 与 [gcloud services list](https://docs.cloud.google.com/sdk/gcloud/reference/services/list)。

预检 JSON 的 `target.source`、`cli`、`auth`、`adc`、`services` 和 `capabilities` 是本机观察摘要；`enabled-unverified` 只代表 API 名称在目标 Project 的 enabled 列表中。`recommendedExecution` 使用 `model: "simulated"` 与 `data: "local"`，表示本地模拟对话和合成数据看板作为当前安全默认；若有 Project 候选，可将 Gemini/BigQuery 接入作为待确认方案选项。`requiresConfirmation` 标识存在候选 Project、尚需在方案中确认目标；它既不授权云调用，也不自动开始真实验证。

## 四种交付组合

AI 和数据服务分别决定，不能把两者捆绑为“必须全有”或“全无”。下表是方案组合；真实组合还需逐项满足授权与验证条件。

| 对话 | 看板/数据 | 适用条件 | Demo 标注 |
|---|---|---|---|
| 本地模拟对话 | 固定种子的合成数据与本地确定性分析 | 无可用 GCP Project，或用户选择纯本地演示 | “模拟 AI 对话”“合成演示数据”；仍可交付完整方案、问答体验和经营看板 |
| Gemini 实时对话 | 合成数据与本地确定性分析 | Vertex AI/Gemini 目标、身份、模型和一次必要的真实场景已确认并验证；BigQuery 不可用或不需要 | 区分 Gemini 回复与本地模拟分析结果 |
| 本地模拟对话 | BigQuery 只读数据与确定性分析 | 目标 Project、数据集、最小查询权限及查询证据已确认；Gemini 不可用或不需要 | 对话标为模拟，BigQuery 来源和时间范围可追溯 |
| Gemini 实时对话 | BigQuery 只读数据与确定性分析 | Gemini 与 BigQuery 各自完成目标确认、权限核实和必要验证 | 按来源分别标注模型解释与确定性数据结果 |

已发现服务 enabled 只能把服务标成候选，不能自动进入真实组合。需要真实 Gemini、BigQuery 或两者时，先在方案中分别写明 Project、区域/模型或数据集、身份/权限、查询范围、费用与验证步骤；已有的用户授权适用于其精确目标时继续沿用，缺少授权时不得自行补齐。方案涉及创建/修改资源、变更 IAM 或部署时，另按对应资源和副作用边界处理。

如果使用同一台机器、同一身份、同一 Project 候选且以上字段均未变化，可复用当前任务中保存的预检摘要；发生 Project、身份、ADC、API 状态或运行环境变化时重新执行。预检不是持久身份/权限证明，历史摘要不能替代目标绑定的真实验证。
