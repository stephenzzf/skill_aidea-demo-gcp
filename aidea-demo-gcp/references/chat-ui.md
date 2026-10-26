# 通用对话UI（chat-ui-v3 + chat-process-v1）

新应用直接复制这些已接线组件，不逐客户重新安装或生成聊天代码。沿用assistant-ui react0.15.18、Google ADK适配0.0.40；新增锁定react-markdown0.14.24和remark-gfm4.0.1。无需新框架、Assistant Cloud或会话后台。

- `MessagePrimitive.Parts` 的 `ChainOfThought` 组合将相邻摘要与工具组成执行过程：显示真实运行/完成/失败/取消状态；包含业务卡片的过程默认展开，纯摘要可折叠；结果摘要先解析ADK的JSON字符串，再显示可读指标/字段。原始参数和结果仅在技术详情，不显示内部签名或虚构耗时。
- MarkdownTextPrimitive支持安全Markdown/GFM表格、引用与代码块；skipHtml，不添加raw HTML执行插件。代码块提供语言和复制反馈，长表格/代码局部滚动。
- ActionBar/More/ExportMarkdown、SelectionToolbar/Quote及Composer Quote组合提供复制勾选、导出、整条/选区引用和本地赞踩。复制与导出只取回复文本，不含工具JSON。
- 引用保存在官方composer quote状态，在提交前序列化为明确标记的用户上下文。官方ADK不会自动转发quote元数据；Send按钮、Enter及表单必须共用NativeChat.send，不能只拦截form submit。Shift+Enter换行，IME输入不误发。没有编辑、重新生成或自动重试。
- append返回不等于回复完成。保留原始草稿直至显式终态；错误/取消仅在composer仍空时恢复，避免覆盖用户编辑。reset/卸载先取消并丢弃pending草稿。鉴权过期时仅将草稿和引用保留在当前App内存，重新输入访问码后恢复；不自动重发。关闭/刷新登录页后不保证保留未发送草稿。
- 官方FeedbackAdapter写独立version1本地侧边车，按消息ID恢复选中视觉；不发送服务端、不进入模型上下文。sessionStorage不可用时保留页内内存状态；reset清除反馈和历史。
- tabs兼容布局保留AI对话第一、方案第二、领域Tab随后；split布局将同一NativeChat常驻左侧，右侧从方案总览开始，见[分栏工作区](split-workspace.md)。固定Header/导航，聊天页压缩重复标题；正文上限880px。Composer占真实空间，用户上滚不强拉底部，离开底部才显示回到最新。隐藏辅助文本需限制在消息/表单定位上下文，避免撑大外层页面。1280×720空输入消息区至少240px。
- 最新完成回复的操作栏常显；历史回复hover/focus显示操作，触屏保持可见；官方菜单处理键盘焦点。保留可读标签与减少动画样式；不宣称仅截图即可证明完整无障碍合规。

修改UI后只验证相关组件与交互；源码/依赖冻结后统一类型、测试、构建，避免重复。UI本地Runner测试与真实Provider证据分别报告；仅在AI合同变化时运行已授权的必要真实场景。客户名称、标签和业务数据来自配置，不写入通用默认值。

参考官方[工具分组](https://www.assistant-ui.com/elements/tool-group)、[消息操作](https://www.assistant-ui.com/elements/message-actions)、[Markdown](https://www.assistant-ui.com/elements/markdown-text)、[引用](https://www.assistant-ui.com/elements/quote)。本模板按既有品牌和安全边界组合官方primitives，不宣称支持官方目录全部能力。


## 官方Thread视觉与业务卡片

保持固定Header和语言分层；tabs使用AI对话首Tab，split使用左侧常驻对话与右侧业务Tabs；聊天区使用深灰正文、白/浅灰背景、轻量查询过程与紧凑Composer，ME紫色仅强调交互。工具过程与业务结果分层，不能把需要确认的动作藏进折叠过程。回复顺序为内容、操作栏、相关后续建议。

- 沿用锁定版本的官方primitives，不因官网最新示例使用新API就升级整套runtime或初始化项目。组件参考固定版本和适配说明见模板README；保留已验证的Send/Enter引用序列化、草稿、取消和显式终态接线。
- `ChatBusinessCards`通过已知工具注册与严格结构校验展示查询结果、记录和确认动作。未知结果走安全fallback；不把任意JSON渲染成可执行UI。标签、字段、角色、动作和来源来自当前配置，无客户名称分支。
- 受控动作卡复用V3Workspace现有状态与`/api/actions`。只有当前记录、允许领域和有效版本才提供动作；点击前展示字段与操作范围，确认后验证回执再更新共享状态。状态变化令旧建议失效，刷新从现有事件恢复；不新建聊天业务状态副本。
- 这是受控UI与已有模拟动作接口的连接，不是ADK原生暂停/续跑审批协议。没有真实业务写入工具。模型回复或卡片本地按钮状态都不能替代执行回执。
- 建议优先按当前配置和业务状态产生，不增加每轮模型调用。附件、语音、编辑、再生成和分支在有明确需求及完整合同前不显示空按钮。

## 公开摘要与工具过程（chat-process-v1）

复用锁定版本的官方 ChainOfThoughtPrimitive 与 MessagePrimitive.Parts 组合和原生 ADK 的 thought→reasoning 转换，展示模型实际返回的公开思考摘要。服务端通过 includeThoughts 请求摘要，但不保证每轮均有摘要；不暴露 thoughtSignature，不从工具调用或等待时间编造思考内容。只有真实发生的工具调用显示查询过程，业务工具的过程与默认可见结果卡片同时保留。

完整轮次的公开摘要可在本标签页刷新恢复，但 nativeHistory 仍只发送普通正文；复制、导出及引用整条回复不包含摘要或工具 JSON。用户主动选中摘要并引用时，该文字作为明确的用户引用发送。未知字段和签名不进入持久化合同。保持正常/失败/取消状态、显式完成标记和上滚阅读行为；更换模型时单独验证 includeThoughts 支持，不以本地 fixture 证明真实 Provider 能力。

参考官方 [Reasoning](https://www.assistant-ui.com/elements/reasoning) 与 [Gemini ThinkingConfig](https://ai.google.dev/api/generate-content#ThinkingConfig)。没有新增运行时、后端或依赖；生成直接复制已接线模板。
