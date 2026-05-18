# MyWiki

MyWiki 是一个本地优先的个人 AI 知识中枢。它把 PDF、Word、Excel、PPT、图片、网页和文本等原始材料放入统一工作区，经过结构化入库和 Wiki 编译后，生成可阅读、可检索、可追溯、可继续编辑的 Markdown Wiki。

当前仓库版本：`v0.1.3`

最新安装包：<https://github.com/happy80064-beep/my-wiki/releases/latest>

## 当前状态

`v0.1.3` 是内测 MVP 版本，重点验证三条主链路：

1. 原始材料进入本地工作区，并进入可观察的入库/编译队列。
2. 原始材料被编译为 Wiki 页面，支持知识树、全文搜索、编辑保存和查询引用。
3. 客户端可以通过 GitHub Releases 检测新版本，并提示用户下载更新。

当前已发布安装包：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows | `MyWiki_0.1.3_x64-setup.exe` | 推荐给普通 Windows 用户的安装包 |
| Windows | `MyWiki_0.1.3_x64_en-US.msi` | Windows MSI 安装包 |
| macOS | `MyWiki_0.1.3_aarch64.dmg` | Apple Silicon Mac 推荐安装包 |
| macOS | `MyWiki_macos_ARM64.app.zip` | Apple Silicon Mac app 压缩包 |

> 说明：当前 macOS 包是 ARM64 / Apple Silicon 版本。真正的 iOS 安装包不是普通桌面安装包链路，需要后续单独规划 TestFlight、App Store 或企业签名分发。

## 核心功能

- 本地工作区：按项目创建独立文件夹，集中保存 raw、wiki、索引和运行状态。
- Raw Inbox：支持拖拽/粘贴文件和文本，原始材料先安全入库，再进入编译流程。
- 多格式导入：支持文本、Markdown、Word、PDF、Excel、图片等常见材料；可选 MarkItDown 后端用于增强复杂 Office/PDF 解析。
- 多模态处理：图片 OCR 与视觉 caption、PDF/PPTX/DOCX 内嵌图片抽取、caption 缓存和 Markdown media/alt 写入。
- Wiki 生成：批量生成/更新 Wiki 页面，生成结构化 Markdown、frontmatter、来源引用和相关页面。
- Wiki 检索：知识库页提供全文关键词检索，返回相关 Wiki 页结果。
- 查询工作台：基于已生成 Wiki 页面回答问题，并支持把查询洞察保存回 Wiki。
- 关系图谱：展示实体关系、社区结构和类型/社区着色，支持平面/空间视角、缩放、平移、重排和全屏。
- 模型配置：按 Provider 配置模型，并按文本、视觉、embedding、OCR 等能力检查职责可用性。
- 版本更新：客户端启动后检查 GitHub Releases，发现新版本后在顶部和“关于”页提示。

## 仓库结构

```text
.
├─ src/                         # React 前端页面、组件和业务逻辑
├─ src-tauri/                   # Tauri 桌面壳、权限和桌面命令
├─ scripts/                     # 构建、迁移、OCR/MarkItDown 辅助脚本
├─ docs/                        # 发布和维护文档
├─ .github/workflows/           # GitHub Actions 发布流程
├─ MyWiki-项目文档.md            # 旧版产品/数据模型设计文档
├─ MyWiki-项目文档-v1.2.md       # v1.2 阶段项目文档
├─ MyWiki-项目文档-v2.0.md       # v2.0 重构目标和实施计划
├─ package.json                 # 前端依赖、脚本和当前版本号
└─ README.md                    # 仓库说明
```

## 版本文档

仓库目前保留了三份项目文档，用于记录不同阶段的产品判断和开发方向：

- [`MyWiki-项目文档.md`](./MyWiki-项目文档.md)：早期 MVP 设想，重点是个人 AI 知识中枢、四类实体、关系图谱和低摩擦捕获。
- [`MyWiki-项目文档-v1.2.md`](./MyWiki-项目文档-v1.2.md)：v1.2 阶段文档，记录当时的功能扩展和实现方案。
- [`MyWiki-项目文档-v2.0.md`](./MyWiki-项目文档-v2.0.md)：当前主要参考文档，明确从浏览器 IndexedDB 原型转向本地文件工作区、Raw Inbox、Markdown Wiki 和异步编译队列。
- [`docs/release.md`](./docs/release.md)：发布规范，说明版本号、Release 资产、Windows/macOS 包和更新检测机制。

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
pnpm exec tsc --noEmit --pretty false
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
2. 合并到 `main`。
3. 创建并推送 tag，例如 `v0.1.3`。
4. `Release Packages` workflow 构建 Windows/macOS 安装包。
5. workflow 创建 GitHub Release，客户端通过 `/releases/latest` 检查更新。

详见 [`docs/release.md`](./docs/release.md)。

## 数据与隐私

MyWiki 当前设计是本地优先：用户项目、原始材料、生成的 Wiki 和索引默认保存在用户选择的本地工作区中。模型调用所需的 API Key 存在本地配置中；使用云端 LLM 时，上传给模型的内容取决于用户选择的导入、编译、OCR、视觉 caption 和查询流程。

## 当前已知边界

- MVP 仍在快速迭代，部分队列和编译能力还在持续优化。
- macOS 目前发布 Apple Silicon / ARM64 包。
- iOS 分发尚未接入，需要单独设计移动端构建和签名流程。
- 图谱页当前以现有实体关系数据为主，后续会继续和文件工作区 Wiki page types 更深度对齐。
