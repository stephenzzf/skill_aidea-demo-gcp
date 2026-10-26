# 聊天组件与运行时

默认复制已验证的官方 `useAdkRuntime` 接线，不逐客户 init、安装 latest 或重写聊天状态机。锁定 `@assistant-ui/react@0.15.18`、`@assistant-ui/react-google-adk@0.0.40` 与 `@google/adk@2.3.0`。官方 ADK Runtime 内部基于 ExternalStore；本模板复用其 ADK 消息、工具和流式处理，替换原先由 App 手写的状态协调。

## 职责与合同

- `NativeChat` 是 UI 消息权威，使用官方 Thread/Composer/Message/ActionBar primitives；App只协调登录、配置、业务上下文和重置。稳定消息ID，原生运行/完成/中断状态；工具结果只读展开，不执行模型HTML、SQL或脚本。
- `adk-transport` 包装官方 `createAdkStream`；`/api/chat/adk` 复用原有业务上下文、领域、角色及扩展校验，再交给同一个 ADK Runner。旧 `/api/chat` 兼容入口保留，不另建模型链。
- **显式终态**：只有服务端 runDemo 完整结束才发送 `meDemoTerminal:{version:1,status:'complete'}`。提前EOF、错误或非法终态产生原生失败状态，不保存该轮、不自动重试。官方默认parser不抛出 partial-only EOF，因此不能删除此薄守卫。
- 只透传服务端允许的文本、工具调用与结果；仅增加模型实际返回的公开 thought 文本摘要，过滤 thoughtSignature、鉴权、任意状态与私有元数据。浏览器不得传 system、工具定义、凭据、checkpoint 或 runConfig；`maxLlmCalls=0` 始终由服务端决定。
- `adk-history` 保存完成的本地快照和卡片，兼容旧完整消息对；每轮只在终态保存一次。发送给模型的历史仅含合法的完整文本消息对。每次请求重建内存ADK会话并清理，不依赖实例黏性、会话REST后台或数据库。
- sessionStorage 被禁用时仍保留本页内存历史并显示提示；刷新恢复仅在存储可用时成立。重置先同步取消，再清理当前会话与业务临时状态，防止迟到写回。
- 当前锁定版本的取消需 `unstable_allowCancellation:true`；AbortSignal 传到服务端 Runner。取消只证明应用停止接收与传播中断，不能承诺 Provider 零消耗或零计费。未知结果不得自动重试。
- 消息区独立滚动，Composer 占实际布局空间；Header和导航固定。用户上滚不强制回底，使用官方回到最新；输入自动增高且设高度边界。复制不调用模型。不启用自动标题、编辑、重新生成、分支或云端多线程。

## 生成与升级

新应用直接复制模板，客户只改配置、数据或已核对的扩展。旧客户应用不自动迁移；新增 `adk-native-v1`、`chat-ui-v2`、`chat-ui-v3`、`chat-process-v1` 生成标记。扩展API未变，但锁文件已变，旧复用清单的lock摘要会被拒绝：一次性核对依赖和扩展合同后，从兼容源码重新导出清单；不能静默改写摘要或绕过校验。

2026-10-25 已完成：原生Runtime浏览器工具展示、多轮历史、刷新、错误、停止和重置；partial-only EOF与存储不可用本地合同测试；自有Google Project上的两轮真实只读Gemini分析与一次真实取消。业务数字依据合成服务样例核对，不等同于客户生产效果。后续配置生成复用模板证据，仅在AI合同或依赖改变时重验必要真实场景。

上游：[ADK Runtime](https://www.assistant-ui.com/docs/runtimes/google-adk/overview)、[API与会话边界](https://www.assistant-ui.com/docs/runtimes/google-adk/api)。仅按需阅读，不加载全仓。官方支持更多能力不代表本模板已开放；保留ME自己的鉴权、业务校验与完成合同。

## 对话UI适配

工具分组、Markdown、引用与反馈默认复用[对话UI](chat-ui.md)。引用必须经过统一发送边界转成用户文本；只拦截表单submit无法覆盖官方Send/Input直接发送。草稿保留至显式终态，不能以同步append返回作为完成。反馈采用本地侧边车，不加入模型历史。
