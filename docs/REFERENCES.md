# 来源与 Skill 实践

核对日期：2026-10-26。以下区分规范、官方产品说明与本项目采用的方法，不代表上游为本项目背书。

| 来源 | 本项目采用方式 |
|---|---|
| [Agent Skills 格式规范](https://agentskills.io/specification) | 独立 `aidea-demo-gcp` 目录与同名 frontmatter，脚本、参考资料、模板分工；避免绝对个人路径 |
| [Agent Skills 最佳实践](https://agentskills.io/skill-creation/best-practices) | 从真实工作流提炼，保持职责明确，按需加载细节，用实际验证迭代 |
| [Codex / ChatGPT Skills 官方说明](https://learn.chatgpt.com/docs/build-skills) | 显式/隐式调用、安装目录、UI元数据和发现边界；安装仓库子目录，不产生同名重复安装 |
| [GitHub Secret scanning](https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning) | 提交前、暂存区与历史分别扫描；泄露后先轮换，不能只删除文件 |
| [Gitleaks](https://github.com/gitleaks/gitleaks) | 使用成熟扫描器补充本仓库的个人路径/产物检查；测试结果不等于绝对无泄露保证 |

流程研究参考 [Google Cloud ge-demo-generator / ge-demo-video Skills](https://github.com/GoogleCloudPlatform/generative-ai/tree/9bffb4d802d9e6c6af353d15f162c90504d27c17/search/gemini-enterprise/ge-demo-generator/skills)，固定分析基线 `9bffb4d802d9e6c6af353d15f162c90504d27c17`。借鉴需求澄清、方案确认、数据关联和 Playbook 思路；不复制 Gemini Enterprise、Python 或多资源部署链路，不包含视频能力。

主要运行时上游：[Google ADK TypeScript](https://github.com/google/adk-js)、[assistant-ui](https://github.com/assistant-ui/assistant-ui)、[react-resizable-panels](https://github.com/bvaughn/react-resizable-panels)、[Cloud Run 服务身份](https://docs.cloud.google.com/run/docs/securing/service-identity)。使用锁文件中的版本，各依赖保留自己的许可证。项目不捆绑这些依赖的源码目录。

本项目具体选择：保留一个 Skill、一套应用模板与两个核心配置；脚本负责机械生成和依据校验；业务方案先确认；真实模型仅运行必要且获授权的场景。没有公开承诺生成时长、Token节省比例、经营提升或生产SLA。
