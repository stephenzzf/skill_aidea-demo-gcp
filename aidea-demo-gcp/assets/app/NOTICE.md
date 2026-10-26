# 来源与验证边界

UI 由 Aideaon / ME 客户演示体验演进而来。仅包含通用模板，不包含客户交付快照、私有仓库标识或业务证据。Aideaon 品牌名称与标识属于相应权利人，使用时遵守品牌授权。

流程参考 GoogleCloudPlatform/generative-ai 中 `search/gemini-enterprise/ge-demo-generator/skills` 的业务研究、需求澄清、方案确认、数据关系与 Playbook 思路，分析基线 `9bffb4d802d9e6c6af353d15f162c90504d27c17`。未复制其 Python、Gemini Enterprise、A2A、IAM 或多资源部署实现。

官方 `@google/adk` 作为依赖使用，Apache-2.0，详见该依赖与上游 https://github.com/google/adk-js 。其他依赖许可由各包提供。

测试模型是本地确定性替身，验证应用与 ADK 集成，不证明真实模型质量、真实业务效果或云端部署成功。

本项目通用代码与文档采用 MIT；Aideaon / ME 名称和品牌标识不因此授予商标或品牌素材使用许可，依赖包仍按各自许可证使用。
