# 静态扩展 API v1

只有已有能力无法表达确认需求时才扩展。通用模板提供Provider、领域renderer、额外聊天上下文、受保护路由与只读Agent工具的固定入口，避免逐客户修改核心App/导航/Agent/contracts。业务名称、角色、数据字段和规则保留在客户模块；不把特定客户或任何市场配置放入模板。

- `client/demo-extension.tsx` 导出静态demoClientExtension；默认undefined。Provider接收config/resetKey/onContext/children，renderer接收page/navigate，返回undefined时沿用基础领域页。启用assistant的自定义页面由外壳发布实际领域ID；可选describeContext(context)提供纯显示范围摘要，真实数据仍通过严格extension上下文提交。上下文为{id,version:1,data}；重置清理。
- `server/demo-extension.ts` 导出静态demoServerExtension；默认undefined。parseContext严格校验业务data。registerRoutes在已通过访问校验的Router上挂相对路径。新execution配置对应服务端扩展须声明dataBackend:"local"或"bigquery"并与execution.data匹配，旧配置无此字段保持兼容。createChatBinding提供只读工具和摘要；若声明authoritative分析，则内置快照/工具让位，避免两套当前数值。BigQuery正式模拟对话仍使用该权威只读工具；可选simulation.selectedRecord由服务端把已校验扩展记录映射为{dataset,id}，不直接解析自由文本猜测记录。工具可返回record或rows，并保留真实jobId/queriedAt；本地模式不得注入BigQuery扩展。BigQuery模式的经营看板使用扩展查询接口，内置/api/analysis默认拒绝以防本地替代；确需浏览器治理任务统计时，由服务端localWorkspaceDomains显式列出已确认领域，该结果标记dataBackend=local。未知ID/版本/数据在调用模型前拒绝。
- 不从JSON动态导入代码或选择文件，不允许模型生成任意执行代码。Agent没有业务写入工具；模拟动作仍由页面与服务端动作处理器确认执行。

业务模块放在client/extensions、server/extensions、shared/extensions；扩展测试为tests/extension*.test.ts。完成首次本地验证后声明明确文件清单：

```sh
node "$SKILL/scripts/reuse.mjs" --app /abs/source-app --id example --files client/demo-extension.tsx,server/demo-extension.ts,shared/extensions/example.ts
```

生成extension-manifest.json（不是第三份业务配置）记录API版本、依赖锁和文件哈希；清单不代表测试成功。--reuse只适用于新目录，拒绝过期hash、未知版本、路径越界/符号链接、依赖锁不兼容和核心源码覆盖。代码变化后保留原清单并重新核实，不自动掩盖漂移。

两个默认静态入口以外的核心文件不能在清单中覆盖。已有复杂客户扩展可以先一次性改为该边界，后续复用只复制模块和两份配置；不要为接口统一重写已验证业务引擎。

## 已授权的 Google Cloud 数据扩展

资源准备和回读优先复用已配置的gcloud／bq CLI，先核对project、location及资源归属，遇到已有数据不重复装载或覆盖。应用内使用已锁定google-auth-library与固定参数化只读API；不将CLI或凭据放入前端，不执行模型SQL。BigQuery仅在对应客户方案确认并授权后启用，不是所有Demo的默认依赖。模型与看板共用一个分析权威；失败不回退本地经营数字。客户字段、市场、币种、数据集和业务视图保留在客户扩展。
