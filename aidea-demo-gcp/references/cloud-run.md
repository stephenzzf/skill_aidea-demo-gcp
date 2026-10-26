# Cloud Run 交付

一个 Node 22 容器在同一个 Cloud Run 服务中提供 React 页面和 Express/ADK API。使用客户自己的 Google Project；模型区域、BigQuery 区域与 Cloud Run 区域分别显式配置。

真实部署与模型调用需要当前任务对目标项目的授权；拥有凭据或历史部署记录不增加授权。准备工作可先完成。不要复制上游全栈脚本、自动启用额外业务资源、添加项目级 IAM 绑定或切换 gcloud 默认账号/项目；公开入口按第 4 步作为部署配置处理。

1. 本地先通过 README 中的测试与构建。使用已有服务账号，确认 Cloud Run/构建所需权限与模型访问权限；缺失时报告具体阻塞。
2. 在仓库外创建权限 600 的 JSON 环境文件，值均为字符串。必要字段：`DEMO_MODEL_MODE:"vertex"`、`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`、`DEMO_MODEL`、`DEMO_ACCESS_CODE_HASH`、`DEMO_COOKIE_SECRET`、`DEMO_ACCESS_EXPIRES_AT`。只复制访问配置的摘要、签名密钥和有效期，不复制 `DEMO_OPERATOR_ACCESS_CODE`。当 `demo-spec.json` 的 `execution.data` 为 `bigquery` 时，必须配置 `BQ_PROJECT`、`BQ_LOCATION`，并在 `BQ_DATASET` 与 `BQ_RAW_DATASET` + `BQ_MART_DATASET` 两种数据集形式中选择一种。BigQuery 项目可以与 Cloud Run 部署项目不同。ADC 使用部署命令指定的 Cloud Run 服务身份，不复制本机 ADC 文件或设置 `GOOGLE_APPLICATION_CREDENTIALS`。
3. 从应用目录运行以下命令，仅输出待执行参数，不部署：

```sh
node scripts/deploy.mjs --project PROJECT --region REGION --service SERVICE \
  --service-account ACCOUNT@PROJECT.iam.gserviceaccount.com --env-file /private/deploy.json
```

4. 授权覆盖该目标后加 `--execute`。脚本调用 `gcloud run deploy --source=.`，不会修改 gcloud 默认项目。默认 dry-run 只打印命令，不调用云端；执行时显式请求请求计费（`--cpu-throttling`）、服务级和 revision 级最小实例均为 0（`--min=0 --min-instances=0`），保留 `--allow-unauthenticated` 和按应用请求超时计算的 Cloud Run timeout，不设置模型配额或 max instances 上限。`--allow-unauthenticated` 会配置公开入口并影响服务级 Invoker IAM（例如为 `allUsers` 开放调用），这属于部署动作；业务 API 仍由应用访问码保护。脚本不自动授予项目级 IAM 权限，服务身份所需权限必须预先由项目管理员配置。`--source=.` 按 `.gcloudignore` 生成源码归档并交给 Cloud Build；应用源码、配置和锁文件保留，依赖目录、构建产物、证据、本机环境文件、运行日志和压缩包排除。Cloud Build 构建和 Cloud Run 运行都会使用目标 Google Cloud 项目资源。
5. 回读服务 URL、revision、镜像与服务身份，验证 HTTPS 页面、访问码、未授权 API 与一次经授权的真实问答。健康检查与本地测试不证明真实模型质量或云端验收。

默认访问码从生成时起 24 小时有效，应用重启不延长；过期前后以服务器时间校验。撤销/轮换通过更新访问摘要/签名密钥/有效期并部署新 revision 完成。旧 revision 若仍有流量或独立 URL，须在原授权内确认其停止可达，不能宣称更新配置后旧 revision 瞬间撤销。

应用请求超时默认 240 秒，Cloud Run 部署超时 300 秒。超时是网络/资源生命周期，不是模型调用配额；可按演示需求调整请求超时并同步服务超时。断线不自动重新调用模型。

官方依据：[TypeScript ADK](https://github.com/google/adk-js)、[Cloud Run 部署](https://adk.dev/deploy/cloud-run/)、[请求计费](https://cloud.google.com/run/docs/configuring/billing-settings)、[最小实例](https://cloud.google.com/run/docs/configuring/min-instances)、[公开访问与 Invoker IAM](https://cloud.google.com/run/docs/authenticating/public)。版本锁定以产物 package-lock.json 为准。
