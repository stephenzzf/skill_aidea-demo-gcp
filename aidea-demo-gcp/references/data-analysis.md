# 数据分析与看板

V2 数据/计算合同与 V3 领域页合同在 `assets/app/shared/workspace.ts`、`shared/solution.ts`；确定性引擎在 `server/workspace.ts`。生成器和运行时应共用校验器。普通生成优先读一份相近样例，不载入整套模板。

V3 的 `pages` 定义首页以外的业务领域 Tabs。每个领域声明可读数据集、指标、动作、允许的组件、方案主张及跨域链接。引用须存在；分析、动作和 AI 上下文均限制到当前领域声明的范围。领域链接只传递配置中允许的页面与数据记录，不接受来自 URL 的任意字段或操作。

## 数据

每个数据集声明 id、label、key、origin（synthetic/customer）、source、fields；字段类型 string/number/boolean/date，可声明required和unit；relations明确字段、目标dataset与target。单行粒度和口径写进source/方案。主键唯一、字段类型与日期有效、关联记录存在。

scenario.workspace.datasets每项使用rows，或file加可选mapping（目标字段→文件列）。CSV/JSON路径相对scenario文件，必须在同目录树内，不能使用绝对路径、父目录或逃逸符号链接。JSON是记录数组；CSV支持引号、换行、BOM与CRLF，重复表头和列数不一致报错。导入先显式映射再转类型；不自动猜币种、日期格式、缺失值或合并重复记录。客户授权文件在Codex生成阶段处理，不增加Web上传后台。产物scenario保存规范化记录，原始文件不自动复制。

origin由数据集定义决定；没有客户文件时不要用customer标识合成样例。scenario.synthetic只有全部数据集为synthetic时才为true。不同来源默认分别分析，混合需要明确选择combined。私有资料不可进入公开目录或无保护链接；API访问保护适用于数据。

## 指标与查询

metrics支持count、distinct、sum、avg、ratio；dataset绑定数据集，field用于聚合，filters用于固定口径，numerator/denominator用于比例。groupBy用于分类，timeField用于日期范围和趋势。scope=snapshot使用初始数据，current使用重放后的演示状态。

过滤只允许eq、contains、gte、lte；可通过已定义relation引用直接关联数据集的字段，不能运行任意SQL/代码。查询时间范围应与timeField一致，图表/汇总/明细共用筛选。空值不参与数值聚合；没有数值时显示暂无数据；ratio分母0为null，不显示0%。比例以0–1返回，百分比由UI格式化。

看板展示口径、时间范围、样本数、来源及来源类型，可下钻到领域允许的关联记录。无数据明确显示空状态。查询、指标、明细和对话使用相同领域及筛选范围；切换领域后不能带入另一个领域的记录或操作。模型解释服务端计算结果；改变分析范围后说明与页面当前范围的差异。观察、推测和建议分别表达，不把相关性当因果。

## 模拟业务状态

workflow绑定业务数据集与statusField，transitions声明允许角色、前后状态、输入和必需字段。状态只保存事件，服务端对可信初始记录重放。inputFields是业务输入，requiredFields是动作前必备信息；invalidates标记旧建议待重评，clearsStale解除，requireFresh阻断未重评操作。

浏览器state不是生产权限或审计证据。服务端验证状态与允许动作，不接受客户端直接改写原始记录。已存在事件的requestId可幂等回读；没有共享存储时，响应未知且客户端仍持旧状态不能保证跨请求去重，因此UI防重复点击且不自动重试。动作不产生外部副作用。

历史分析与当前运营指标要区分：模拟处理能改变待办/完成数量，不能自动改写历史收入、市场可见度、转化或实测效果。

V3 领域查询会返回该领域声明的参考数据集，供记录关系导航使用；所选表决定当前明细视图。直接日期范围作用于选定事实表，字典/参考表按自身关联键读取，不据此冒充相同时间范围的经营样本。跨领域记录只能通过配置的链接跳转。
