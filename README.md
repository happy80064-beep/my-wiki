# MyWiki

MyWiki 是一个本地优先的个人 AI 知识中枢。它把 PDF、Word、Excel、PPT、图片、网页、压缩包和文本等原始材料放入统一工作区，经过结构化入库和 Wiki 编译后，生成可阅读、可检索、可追溯、可持续编辑的 Markdown Wiki。

当前仓库版本：`v0.1.5`

最新安装包：<https://github.com/happy80064-beep/my-wiki/releases/latest>

## 当前状态

`v0.1.5` 是内测 MVP 的稳定性与验收版本，重点提升长 PDF 入库、结构化编译、Wiki 批量生成、图谱筛选和人工审核流程。

本版本相对 `v0.1.4` 的主要更新：

1. PDF 提取优先使用随桌面安装包分发的 PDFium，并通过全局锁串行 PDF 解析，降低长 PDF 和多文件并发解析时的崩溃、卡死和相互影响风险。
2. 长文档结构化入库改为完整原文分块摘要和 SHA-256 digest 缓存，再进入结构化抽取，避免在进入模型前过早截断 149 页 PDF 这类长材料。
3. LLM 请求增加同 provider/model 串行调度和失败冷却；Raw Inbox 队列在网络、限流、超时失败后会短暂停顿再处理下一个任务，减少长 PDF 失败拖累后续任务。
4. Source Wiki 批量编译增加可重试请求，遇到缺失 FILE block、超时或限流时会按明确失败类型重试，不再把异常结果当成可用 Wiki。
5. 知识树栏“批量生成/更新wiki页”会优先只处理状态为“未生成”的来源词条；当所有来源词条都已生成 Wiki 后，才进入全量更新并提示会覆盖旧 Markdown。
6. Wiki 人工编辑保护增强：AI 重编译遇到人工修改会进入审核队列，采纳新版本时保留被替换内容的 superseded 记录，降低误覆盖风险。
7. 查询保存回 Wiki 和 Wiki 检索继续收敛到页面优先、来源可追溯的结果，减少“问题描述”或污染 frontmatter 对页面内容的影响。
8. 巡检页补充孤立页面、frontmatter 和引用问题处理能力，图谱页筛选项进一步对齐当前 Wiki page types 和社区视图，隐藏不匹配的旧标签入口。
9. Wiki 页头部 description/摘要展示改为句子感知压缩，避免长 frontmatter 或正文摘要被截断在“2026年开”“1993年2月”这类半句话上。
10. 保留 v0.1.4 已有的网页 URL 正文抓取、MarkItDown sidecar、项目工作区、Raw Inbox、图谱、查询、巡检、多模型角色配置和客户端更新检测能力。

本地打包版验收记录：

- Windows 打包版已用 149 页真实 PDF 做干净工作区端到端测试：PDFium 提取文本 100,378 字符，包含 `1/149` 与 `149/149` 页标记；结构化生成 37 个实体、40 条关系；Wiki 生成 37/37；未检测到 fallback/兜底/降级文本；队列最终清空，原文件状态为 `compiled`。
- 本机环境为 Windows，无法在本机安装运行 macOS `.dmg`。macOS 包通过 GitHub Actions 的 `macos-latest` runner 执行 `pnpm test` 与 `pnpm desktop:build:macos` 后生成。

当前发布安装包：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows | `MyWiki_0.1.5_x64-setup.exe` | 推荐给普通 Windows 用户的安装包 |
| Windows | `MyWiki_0.1.5_x64_en-US.msi` | Windows MSI 安装包 |
| macOS | `MyWiki_0.1.5_aarch64.dmg` | Apple Silicon Mac 推荐安装包 |
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
- Wiki 检索与查询：基于已生成 Wiki 页面回答问题，支持把查询洞察保存回 Wiki。
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
3. 创建并推送 tag，例如 `v0.1.5`。
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
