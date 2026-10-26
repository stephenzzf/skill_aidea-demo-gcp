# 配置与组件优先的快速路径

推荐云能力前先执行 `preflight.mjs`，将不含凭据的环境摘要用于方案确认；未具备GCP时默认simulated/local，继续保留模拟对话与合成数据看板。检测不是云资源授权，详见[环境与模式](environment.md)。

已有客户应用先 `inspect.mjs --app /abs/app`，只读输出摘要。不要先cat完整SOLUTION、schema、旧源码和上游文档。已有需求、方案、数据可复用时不重做调研；来源沿用原日期，不宣称重新验证。

```sh
node --experimental-strip-types "$SKILL/scripts/inspect.mjs" --app /abs/existing-app
node --experimental-strip-types "$SKILL/scripts/pipeline.mjs" --spec /abs/demo-spec.json --data /abs/scenario.json --reuse /abs/extension-source --out /abs/new-demo --report /abs/evidence/pipeline.json
```

未使用扩展时省略--reuse。有缺口才读[扩展合同](extensions.md)；不再逐客户接线核心六文件。需要合成数据时才运行seed-data.mjs，从确认结构固定种子生成，客户授权数据不覆盖、不猜测业务事实。V1–V3继续兼容；旧应用没有extension-api-v1/清单时需要一次明确迁移，不能把旧核心补丁整包复制进模板。

流水线依次生成、安装、类型检查、相关测试、Vite构建。已有应用用--app；--tests可选明确测试文件。安装按lock摘要复用，首次联网单请求30秒、不自动重试。只有已判断为本地确定性检查的流程才启用以下复用：

```sh
node --experimental-strip-types "$SKILL/scripts/pipeline.mjs" --app /abs/demo --report /abs/evidence/pipeline.json --reuse-checks
```

同应用、源码/配置、环境、测试选择、原始日志hash和构建产物均一致时，复用类型/测试/构建。仅client样式变化时可复用类型/测试证据并重新构建；客户端TS/TSX逻辑变化重做类型检查与所选测试，避免遗漏前端适配器回归。手工UI和请求合同仍待验证。服务端/shared/contracts/测试/配置/数据变化、失败、日志或依赖不符均失效。`--fresh`显式重验；它与--reuse-checks互斥。真实模型或外部系统状态不适用这种本地证据缓存。

不要重复npm run build内的typecheck；不要让每个worker与主代理重复同一有效检查。新缺陷、输入或依据变化才扩大测试。UI修改不自动增加真实模型问答。

本地预览沿用README及私有访问配置；先核端口/PID/cwd。手工验证后用同一basisDigest写cases[{id,status,evidence实际文件}]，再finalize：

```sh
node "$SKILL/scripts/finalize.mjs" --app /abs/demo --report /abs/evidence/pipeline.json --manual /abs/evidence/manual.json --out /abs/demo-source.zip
```

finalize拒绝过期依据、目录内归档和覆盖，不覆盖人工SOLUTION/PLAYBOOK。生成时间不是交付SLA。复用量按哈希核对，改动量与复制量分开；缓存输入不是免费，Provider total不重复加thoughts。长历史已经加载的输入不能由Skill指令自动移除；后续执行应以简短摘要和明确文件路径为依据，不再重复把所有历史内容读回模型。

默认聊天已沉淀为 `adk-native-v1`、`chat-ui-v3`、`chat-process-v1` 固定接线（官方 ChainOfThought 摘要、真实工具过程与业务卡片）；新客户不重复探针、抄写适配器或真实问答验收。扩展API保持v1但lock变更，旧扩展清单须按[运行时升级](chat-runtime.md)核对后重新导出，不能跳过摘要校验。

新生成启用AI的V4应用在已确认配置中明确设置presentation.workspaceLayout="split"，复用split-workspace-v1固定外壳，不逐客户编写分栏或重新接线聊天。依赖新增react-resizable-panels后，旧扩展仅在核对其依赖兼容后于新目录重新导出清单，保留原客户目录。布局与相关手工验收见[分栏工作区](split-workspace.md)。
