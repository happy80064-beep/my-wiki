# MyWiki

MyWiki 是一个本地优先的个人 AI 知识中枢。它把 PDF、Word、Excel、PPT、图片、网页、压缩包和文本等原始材料放入统一工作区，经过结构化入库和 Wiki 编译后，生成可阅读、可检索、可追溯、可持续编辑的 Markdown Wiki。

当前仓库版本：`v0.1.6`

最新安装包：<https://github.com/happy80064-beep/my-wiki/releases/latest>

## 当前状态

`v0.1.6` 是内测 MVP 的查询、深度研究、巡检和捕获体验修订版本，重点提升检索可信度、来源分组、可解释耗时、Lint 可操作性和桌面捕获体验。本次重新发布仍沿用 `v0.1.6` 版本号，替换同版本 Release 里的安装包资产。

本版本相对 `v0.1.5` 的主要更新：

1. 查询页改为统一 Wiki RAG 查询链路：闲聊/问候先识别并直接走 Query 模型；知识库问题不再要求用户手动切换“简单/复杂查询”，统一执行 Wiki 页面检索、证据分层和一次 LLM 回答。
2. 移除用户侧“简单查询”开关，避免查询型问题和开放性问题由用户手动选错链路；查询型问题通过确定性意图理解约束回答风格，开放性问题通过同一 Wiki 证据边界综合回答。
3. Query trace 增加阶段耗时统计，可直接查看慢在本地 Wiki 扫描、Wiki 页面回答、网络搜索、合成、排队、冷却还是重试。
4. 查询回答 prompt 强化专业、严谨、精炼约束：先直接回答问题，避免寒暄、套话、空泛建议和重复背景；不得补编 Wiki 页面没有明示的信息，缺失内容必须明确标注“当前 Wiki 不能确认”。
5. 查询回答默认关闭显式 thinking/reasoning，减少推理内容挤占输出预算的问题；回答模型输出预算收敛到更适合查询场景的范围，降低长答案延迟。
6. 深度研究加强问题对象约束：网络结果按项目关键词区分为“项目事实来源”和“方法参考材料”，不含项目关键词的搜索结果只能作为弱相关参考，不能作为强相关项目事实写入最终答案。
7. 深度研究最终答案和 UI 参考列表增加来源分组；弱相关材料会单独折叠为“方法参考材料”，用于借鉴方法、打法或案例，不再和直接项目来源混在同一列表里。
8. 已用真实 Tavily 搜索和 MiniMax-M2.7 对“福瑞科技园三期医疗业态引流策划”场景做验证：12 条搜索结果中 3 条 direct、9 条 weak，未把济南/山东等弱相关案例当作福瑞项目事实。
9. Lint 巡检减少误报：改进同名页面、兼容实体和 Broken Link 识别规则，不能直接自动修复的问题从 Fix 改为 Guide。
10. 点击 Guide 会在右侧 Wiki 页面/编辑区域临时高亮可能需要处理的位置，便于人工补链接、改名、改引用或重编译后再次运行 Lint。
11. 捕获网页 HTML 和压缩包时，相关工具和终端命令改为后台/隐藏方式运行，减少桌面弹出黑色终端窗口对用户的打扰。
12. 桌面 Frog 拖拽捕获区增加有效区域背景色提示；拖入原始材料后会进入 Raw Inbox 并触发 Wiki 编译流程。
13. 兼容类型的同标题实体会复用/合并，降低项目、主题等页面重复生成后引发的查询、图谱和 Lint 噪声。
14. 保留 v0.1.5 已有的长 PDF 稳定入库、PDFium 解析、结构化编译、Wiki 批量生成、人工编辑保护、图谱、查询、巡检、多模型角色配置和客户端更新检测能力。

本地打包版验收记录：

- Query 真实用例已用本地 dev API 和 MiniMax-M2.7 验证 5 个代表问题，均未触发 fallback/兜底/降级：问候直达 LLM 约 6.1s；完工时间查询约 6.1s；医疗业态列表约 4.8s；终止词查询约 10.2s；商业模式与关键风险开放问题约 13.6s。
- Windows 打包版已用 149 页真实 PDF 做干净工作区端到端测试：PDFium 提取文本 100,378 字符，包含 `1/149` 与 `149/149` 页标记；结构化生成 37 个实体、40 条关系；Wiki 生成 37/37；未检测到 fallback/兜底/降级文本；队列最终清空，原文件状态为 `compiled`。
- 本机环境为 Windows，无法在本机安装运行 macOS `.dmg`。macOS 包通过 GitHub Actions 的 `macos-latest` runner 执行 `pnpm test` 与 `pnpm desktop:build:macos` 后生成。

当前发布安装包：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows | `MyWiki_0.1.6_x64-setup.exe` | 推荐给普通 Windows 用户的安装包 |
| Windows | `MyWiki_0.1.6_x64_en-US.msi` | Windows MSI 安装包 |
| macOS | `MyWiki_0.1.6_aarch64.dmg` | Apple Silicon Mac 推荐安装包 |
| macOS | `MyWiki_macos_ARM64.app.zip` | Apple Silicon Mac app 压缩包 |

> 说明：当前 macOS 包是 ARM64 / Apple Silicon 版本。iOS 分发不是普通桌面安装包链路，需要后续单独规划 TestFlight、App Store 或企业签名分发。

## 核心功能

- 本地工作区：按项目创建独立文件夹，集中保存 `raw/`、`wiki/`、索引和运行状态。
- Raw Inbox：支持拖拽、粘贴文件、粘贴网页 URL，原始材料先安全入库，再进入编译流程。
- 多格式导入：支持文本、Markdown、HTML、CSV、JSON、XML、ZIP、Word、PDF、Excel、PPT 和图片。
- MarkItDown 增强：安装包内置 MarkItDown sidecar，用于复杂 Office/PDF/HTML/ZIP 和 URL 转 Markdown。
- 多模态处理：图片 OCR 与视觉 caption，PDF/PPTX/DOCX 内嵌图片抽取，caption/OCR 写入 Markdown。
- Wiki 生成：批量生成/更新 Wiki 页面，输出结构化 Markdown、frontmatter、来源引用和相关页面。
- 知识库切换：总览页可新建、切换或浏览选择本地 MyWiki 工作区，知识库、图谱、审核、巡检、查询页随当前工作区动态适配。
- Wiki 检索与查询：闲聊直达 LLM，知识库问题统一走 Wiki RAG；回答基于已生成 Wiki 页面，保留证据分层、引用来源和保存回 Wiki 能力。
- 图谱：展示实体关系、社区结构和类型/社区着色，支持平面/空间视角、缩放、平移、重排和全屏。
- 巡检：检测 wiki 链接、内容质量和潜在冲突，支持保留巡检结果并查看问题页面。
- 模型配置：按 Provider 配置文本、视觉、embedding、OCR 等角色模型，并检查职责可用性。
- 版本更新：客户端通过 GitHub Releases 检测新版本并提示下载。

## 仓库结构

```text
.
├── src/                         # React 前端页面、组件和业务逻辑
├── src-tauri/                   # Tauri 桌面壳、权限和桌面命令
├── scripts/                     # 构建、OCR/MarkItDown 辅助脚本
├── docs/                        # 发布和维护文档
├── .github/workflows/           # GitHub Actions 发布流程
├── MyWiki-项目文档.md            # 早期产品/数据模型设计文档
├── MyWiki-项目文档-v1.2.md       # v1.2 阶段项目文档
├── MyWiki-项目文档-v2.0.md       # v2.0 重构目标和实施计划
├── package.json                 # 前端依赖、脚本和当前版本号
└── README.md                    # 仓库说明
```

## 本地开发

环境要求：

- Node.js 22+
- pnpm 10+
- Rust stable
- Windows 构建需要 Tauri Windows 打包环境
- macOS 构建需要 macOS runner 或本机 macOS 环境

常用命令：

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm desktop:dev
```

构建桌面安装包：

```bash
pnpm desktop:build:windows
pnpm desktop:build:macos
```

## 发布流程

正式发布由 GitHub Actions 处理：

1. 同步 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`src-tauri/tauri.macos.conf.json` 的版本号。
2. 合并并推送到 `main`。
3. 创建并推送 tag，例如 `v0.1.6`。
4. `Release Packages` workflow 构建 Windows/macOS 安装包。
5. workflow 创建 GitHub Release，客户端通过 `/releases/latest` 检查更新。

详见 [`docs/release.md`](./docs/release.md)。

## 数据与隐私

MyWiki 当前设计是本地优先：用户项目、原始材料、生成的 Wiki 和索引默认保存在用户选择的本地工作区中。API Key 存在本地配置中，不应提交到 Git 仓库或打进公开安装包。使用云端 LLM 时，上传给模型的内容取决于用户选择的导入、编译、OCR、视觉 caption 和查询流程。

## 当前已知边界

- MVP 仍在快速迭代，部分队列和编译能力还在持续优化。
- 部分网页会因为登录、验证码、环境验证或反爬策略无法抓取正文，本版本会明确提示失败。
- macOS 当前发布 Apple Silicon / ARM64 包。
- iOS 分发尚未接入，需要单独设计移动端构建和签名流程。
- 图谱页当前以现有实体关系数据为主，后续会继续和文件工作区 Wiki page types 深度对齐。
