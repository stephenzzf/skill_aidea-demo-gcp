# Aidea Demo GCP

从客户需求到已确认方案，再到可交互、可验证的业务 Demo。面向 ME / Meet Experience 的 Google Cloud、AI 与数据解决方案演示。

**先设计并确认方案，后生成应用；优先复用固定模板，减少重复读写、接线和模型调用。** 本项目用于售前和方案验证，不是生产运营平台。

## 能做什么

- 目标不明确时，提出有依据的业务方向选项；网站任务先确认官方 URL 并检查代表性路径。
- 形成涵盖业务目标、角色、流程、数据、系统、实施阶段与验收的完整方案。
- 左侧常驻 AI 对话，右侧方案总览、经营看板和业务领域 Tabs；拖拽分栏、图标收起、固定导航及移动端切换。
- 确定性指标分析、来源下钻、业务记录与模拟操作回执；问答解释同一份数据与状态。
- 无 Google Project 时使用正式模拟 AI 与合成数据；具备授权环境时选择真实 Gemini 和场景 BigQuery 扩展。
- 前后端同一 TypeScript 项目、锁文件和 Cloud Run 服务，交付固定访问 URL。

演示外壳和方案默认中文；客户官网体验使用经核实的原站语言与品牌。样例均为合成数据，不代表真实客户效果。

## 安装

要求：可加载本地 Skills 的 Codex、Node.js **22.18+**（CI 使用 Node 24）、npm；打包源码需要 Python 3。真实云模式另外需要自己的 Google Project、计费、权限、模型可用性与 ADC。

克隆后将独立技能目录安装到个人 Skills 目录；目标已存在时先人工比较，不覆盖：

```sh
git clone https://github.com/stephenzzf/skill_aidea-demo-gcp.git
cd skill_aidea-demo-gcp
mkdir -p "$HOME/.agents/skills"
test ! -e "$HOME/.agents/skills/aidea-demo-gcp" && cp -R aidea-demo-gcp "$HOME/.agents/skills/aidea-demo-gcp"
```

也可通过 Codex 的 `$skill-installer` 指定本仓库及 `aidea-demo-gcp` 子目录安装。避免同时在多个发现目录安装同名 Skill。宿主发现方式见 [Codex 官方说明](https://learn.chatgpt.com/docs/build-skills)。

## 对话使用

```text
使用 $aidea-demo-gcp，检查 https://example.com，
规划与 Google Cloud、AI 和数据相关的业务方案。
先给出方向选项，确认完整方案后再生成 Demo。
```

确认方案后再要求生成到新目录。需要真实云调用、数据集创建或部署时，明确项目、区域和允许的资源范围；凭据存在不构成操作授权。Skill 不会自动创建项目、授权 IAM、真实触达用户或发布客户官网。

## 无云快速体验

从仓库根目录运行以下命令，使用已经确认的合成服务样例。生成目录和私有访问配置均位于仓库外，不调用真实模型或 Google Cloud：

```sh
SKILL="$PWD/aidea-demo-gcp"
WORK="$(mktemp -d)"
node --experimental-strip-types "$SKILL/scripts/pipeline.mjs" \
  --spec "$SKILL/references/examples/v4/service-spec.json" \
  --data "$SKILL/references/examples/v4/service-data.json" \
  --out "$WORK/demo" --report "$WORK/pipeline.json"
cd "$WORK/demo"
npm run access -- "$WORK/private/access.env"
node --env-file="$WORK/private/access.env" --experimental-strip-types server/index.ts
```

打开 `http://localhost:8080`，从私有文件读取 `DEMO_OPERATOR_ACCESS_CODE`。每次生成随机访问码，默认有效 24 小时；仓库没有通用默认密码。不要提交或分享整个环境文件。

固定模板在生成后才具备 `demo-spec.json` 和 `scenario.json`；不要把 `assets/app` 当成已生成客户应用直接启动。

## 真实 Gemini、BigQuery 与 Cloud Run

| 模式 | 对话 | 数据与边界 |
|---|---|---|
| simulated + local | 确定性模拟，经真实 ADK Runner | 合成/授权本地数据；不伪造真实推理或云 Job |
| vertex + local | 自有 Project 的真实 Gemini | 本地授权数据；发送给模型的内容受 Google Cloud 条款约束 |
| vertex + bigquery | 真实 Gemini | 需要实现并验证固定只读 BigQuery 场景适配；不是任意 SQL 或通用连接器 |

模板提供扩展边界及部署变量校验，**不包含任何客户专用 BigQuery 数据集、读取器或云资源**。不要把配置字段支持当成连接已经实现。

真实模式先核对 CLI、项目、ADC、区域和所选模型，参见 [环境检测](aidea-demo-gcp/references/environment.md)。CLI 登录和本机 ADC 是不同凭据用途。不要上传本机 ADC、服务账号 JSON 或个人令牌。

在生成应用根目录，先做可审阅 dry-run：

```sh
node scripts/deploy.mjs --project YOUR_PROJECT --region YOUR_REGION \
  --service YOUR_SERVICE --service-account RUNTIME_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com \
  --env-file /absolute/private/deploy.json
```

确认目标及授权后加 `--execute`。部署采用 `gcloud run deploy --source=.`，一个服务同时提供前端与 API；公开登录页，业务 API 保持访问码保护。部署身份可为个人账号，运行身份必须为服务账号，推荐最小权限。脚本不会自动授予项目级 IAM。

请求计费、最小实例为 0，不等于整体免费：Cloud Build、镜像存储、BigQuery、Gemini 等可能计费。不设置应用层模型次数或 Token 配额，平台限制仍然适用。完整步骤见 [Cloud Run 交付](aidea-demo-gcp/references/cloud-run.md)。

## 项目结构

```text
aidea-demo-gcp/           可安装的 Skill，目录名与 frontmatter.name 一致
  SKILL.md               短入口、确认流程及参考资料路由
  agents/openai.yaml     展示名称、调用提示和自动匹配策略
  scripts/               生成、导入、复用、验证及打包脚本
  references/            按需加载的合同、方法与合成样例
  assets/app/            固定 React/Vite/Express/ADK 模板
docs/                    面向仓库使用者的架构、隐私检查和来源说明
scripts/                 仓库发布隐私检查，不是客户业务运行时
.github/workflows/       无云、无模型凭据的自动检查
```

完整方案与 Demo 能力必须对应，分别标记已验证、模拟验证、待验证及后续接入。默认交付方案、Demo、Playbook、验证报告和生成记录；视频不在范围内。PPT 仅在用户需要且已安装兼容的 ME 品牌 PPT Skill 时调用，本仓库不捆绑该技能。

## 维护与验证

```sh
npm --prefix aidea-demo-gcp/assets/app ci --ignore-scripts --no-audit --no-fund
node --experimental-strip-types --test scripts/*.test.mjs aidea-demo-gcp/scripts/*.test.mjs
node scripts/privacy-check.mjs
# 可选：安装 detect-secrets==1.5.0 后检查新增秘密候选
# git ls-files -z | xargs -0 detect-secrets-hook --baseline .secrets.baseline
# 提交前再检查暂存区的实际 blob；不输出疑似秘密原文
node scripts/privacy-check.mjs --staged
```

生成样例后运行其类型检查、测试和构建。修改配置优先 `generate.mjs --update`，不覆盖客户源码；历史 `me-demo-generator` 清单继续兼容。Token 缺少实际计量时记 unknown，不推算节省比例。

- [安全与数据边界](SECURITY.md)
- [发布隐私审计](docs/PRIVACY-REVIEW.md)
- [架构与实现边界](docs/ARCHITECTURE.md)
- [最佳实践与上游来源](docs/REFERENCES.md)
- [贡献说明](CONTRIBUTING.md)

## 许可与品牌

通用代码和文档采用 [MIT License](LICENSE)。依赖包各自的许可证继续适用。Aideaon / ME 品牌名称与标识不授予商标使用权；第三方品牌如有出现，仅用于说明或合成样例。参见模板 [来源说明](aidea-demo-gcp/assets/app/NOTICE.md)。
