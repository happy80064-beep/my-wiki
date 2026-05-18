# MyWiki

MyWiki 是一个本地优先的个人 AI 知识中枢。它把 PDF、Word、Excel、PPT、图片、网页、压缩包和文本等原始材料放入统一工作区，经过结构化入库和 Wiki 编译后，生成可阅读、可检索、可追溯、可持续编辑的 Markdown Wiki。

当前仓库版本：`v0.1.4`

最新安装包：<https://github.com/happy80064-beep/my-wiki/releases/latest>

## 当前状态

`v0.1.4` 是内测 MVP 版本，重点修复和验证原始材料导入、网页 URL 抓取、知识库切换和跨平台安装包发布链路。

本版本相对 `v0.1.3` 的主要更新：

1. 桌面 Frog 和应用内捕获页粘贴网页 URL 时，会先提取网页正文，再保存到 Raw Inbox，不再把 URL 当成一行普通 Markdown 文本。
2. 网页提取优先使用随安装包分发的 MarkItDown；当 MarkItDown 抓到验证页或空内容时，会改走网页 fetch 提取。遇到站点登录、验证或反爬拦截时会明确失败，不再生成“内容待补充”类假 wiki。
3. 导入链路补齐 MarkItDown README 中常见格式的本地验证：HTML、CSV、JSON、XML、ZIP 均有可运行链路；ZIP 现在可作为 Raw Inbox 原始材料导入。
4. 总览页“切换知识库”修复空输入时“打开”按钮循环箭头误转的问题，并增加“浏览”按钮，可从资源管理器选择本地知识库文件夹。
5. 保留 v0.1.3 已有的 Frog 小尺寸透明悬浮窗、Raw Inbox 队列、Wiki 批量生成、巡检、查询、图谱和多模型配置能力。

当前发布安装包：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows | `MyWiki_0.1.4_x64-setup.exe` | 推荐给普通 Windows 用户的安装包 |
| Windows | `MyWiki_0.1.4_x64_en-US.msi` | Windows MSI 安装包 |
| macOS | `MyWiki_0.1.4_aarch64.dmg` | Apple Silicon Mac 推荐安装包 |
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
3. 创建并推送 tag，例如 `v0.1.4`。
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
