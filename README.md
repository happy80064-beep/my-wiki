# MyWiki

MyWiki 是一个本地优先的个人 AI 知识中枢。它把 PDF、Word、Excel、PPT、图片、网页、压缩包和文本等原始材料放入统一工作区，经过结构化入库和 Wiki 编译后，生成可阅读、可检索、可追溯、可持续编辑的 Markdown Wiki。

当前仓库版本：`v0.1.8`

最新安装包：<https://github.com/happy80064-beep/my-wiki/releases/latest>

## 当前状态

`v0.1.8` 是内测 MVP 的 Query 工作台和图谱体验修订版本，基于 `v0.1.7` 的本地工作区、查询、图谱、Raw Inbox/Frog 编译链路，重点改善长对话回看、回答等待过程可见性、大图谱可视化稳定性，以及图谱洞察与 Deep Research 的可理解性。

本版本相对 `v0.1.7` 的主要更新：

1. 查询页进入或切换会话后会自动定位到最近一轮对话，长对话不再需要用户手动一直向下翻。
2. 查询回答卡片增加 `Thought for N lines` 折叠块：生成中展示处理过程，生成完成后默认折叠，正文回答仍保持原有输出内容和结构。
3. Thought 展示使用 MyWiki 已有查询轨迹（检索、模式、工作区上下文、证据分层、回答阶段），不把模型原始 chain-of-thought 写入回答正文、复制内容或保存到 Wiki。
4. 图谱平面视图迁移到 Sigma + Graphology ForceAtlas2 渲染：节点改用 WebGL 画布绘制，布局按 Louvain 社区和节点度数自动拉开，减少左右侧节点挤压、重叠和缩放卡顿。
5. 图谱交互保留社区/类型着色、缩放、重排、悬停高亮、节点拖拽、洞察联动和节点跳转；空间视图继续保留原有 3D 展示。

`v0.1.7` 的本地工作区和编译链路修订继续保留：

1. 运行记录切换为工作区文件优先：实体、关系、任务、审核项、Raw Inbox、查询缓存等记录写入当前知识库的 `.mywiki/records.json`，桌面安装版不再依赖浏览器 IndexedDB 作为主存储。
2. 移除 Dexie 和 fake-indexeddb 依赖，保留一层兼容现有业务调用的文件记录表 API；工作区记录读写失败会在界面和队列中显式报错，不再静默忽略。
3. Raw Inbox/Frog 编译队列增强失败判定：原文件解析后如果只生成来源页、没有生成项目/概念/指标/任务等实质 Wiki 页，会标记失败并保留重试入口，而不是显示编译成功。
4. 图片视觉模型失败不再用 OCR 碎片兜底生成 Wiki 页；旧版本产生的“视觉描述待重试”“模型限流”“访问量过大”等无效图片编译结果会恢复为失败状态。
5. 对旧的无效 Wiki 内容采用 `mywiki:superseded` 过期块保留，不删除旧内容；查询和主题聚合会忽略被整体标记过期或仅为来源页的内容。
6. AI 重编译时继续保护人工编辑内容：检测到 AI 新结果与人工编辑内容冲突时进入审核页，由用户决定是否应用；应用后旧内容保留为过期块。
7. 查询页改为流式回答体验，闲聊和 Wiki RAG 回答都会边生成边显示；安装版通过 Tauri HTTP 流式通道调用已配置模型。
8. 查询意图从“简单开关”升级为确定性模式分类：保留闲聊分流；事实/列表类查询保持更严格、更短的回答约束；分析类问题使用更充分的上下文和更高质量的回答 prompt。
9. 查询检索对象扩展：在 Wiki 页检索之外，按查询模式补充工作区上下文，包括原始 source markdown、结构化记录摘要和文件工作区线索，再由真实 Wiki 页面引用收口。
10. 图谱扩展参与查询召回：分析类问题可从一跳关系、共同来源、Wiki 链接、共同邻居和类型亲和补充候选；事实类查询默认收窄图谱扩展，减少无关内容漂移。
11. 图谱页跳转修正为当前 Wiki 浏览器路径，避免从图谱洞察或原文件标签跳到旧版知识库路由。
12. 图谱可视化优化节点稳定性和社区连线可见性，降低非核心节点在无任务运行时的小范围跳动和闪烁。
13. 查询页 UI 更新，把原“简单查询”文本开关改为更具象的模式开关样式，并配合新的查询模式展示。
14. Markdown 原文件标题识别增强，导入长标题方案/框架类文档时更容易生成正确项目页；来源页不会再被自动主题聚合当成知识主题。
15. 查询缓存一致性修复：当用户确认应用 Wiki 编译建议、审核项或其他知识记录写回后，非缓存表写入会立即清空旧查询缓存，避免在同一毫秒内复用旧答案导致“已确认的待审核建议”再次出现。
16. DeepSeek 结构化入库链路改为流式 JSON 输出，并限制结构化结果规模；当模型只返回 thinking/reasoning、空正文或服务端错误时会显式失败并保留错误原因，不再把空结果当作编译成功。
17. Wiki 知识树删除优化：删除单页或 type 分组会先弹出应用内二次确认；type 分组删除改为批量事务并锁定重复点击，降低“点了多次、等待很久才删除”的体验问题。
18. 音视频材料支持本次暂缓：MarkItDown 官方音频转写链路依赖 Google Speech Recognition，中文和长音频结果不可控；`v0.1.8` 不发布 ffmpeg 组件，也不把 MP3、MP4、M4A、WAV 列为支持导入格式，等待后续形成稳定 ASR 方案后再接入。
19. Raw Inbox/Frog 与主窗口共享工作区锁：`.mywiki/records.json`、`.mywiki/ingest-queue.json` 和入库运行队列改为跨窗口串行写入；旧/已有工作区里残留的中断任务、处理中任务或丢失 rawAsset 记录会显式恢复为可重试状态，或从 `raw/sources` 源文件重建后继续入库，避免切页、刷新或 Frog 独立窗口写入造成状态互相覆盖。
20. Raw Inbox/Frog 与图谱状态一致性修复：Wiki 重试成功后会清理旧错误文案；队列进入 Wiki 生成阶段时会同步 `.mywiki/ingest-queue.json` 阶段；结构化入库和图谱渲染会忽略自环关系，避免模型抽取出的“实体指向自身”关系导致图谱画布不可用。
21. 图谱洞察交互说明优化：将“桥接”“空白”等短标签改为“类型：桥接节点”“类型：资料缺口”等明确语义，并补充洞察原因文案；洞察卡片点击用于高亮相关节点，“用这条洞察发起研究”才会进入 Deep Research。
22. Deep Research 入口和状态反馈优化：图谱页右侧按钮改为“研究面板”，从洞察发起研究后会自动打开面板并显示“已开始研究”提示；确认弹窗说明默认研究主题、搜索关键词和任务执行位置，避免开始后用户误以为没有执行。
23. 图谱诊断列表稳定性修复：对重复 insight id 做去重，避免 React duplicate key 导致洞察卡片重复、消失或按钮状态不稳定。
24. 图谱平面视图再次优化：初始坐标改为社区分区撒点，ForceAtlas2 布局后继续拉开社区中心，默认只强制显示核心标签；Sigma 节点支持直接拖动，拖动后位置会保留到当前图谱会话，避免松手后弹回。
25. Wiki 页 Related/Sources 标签跳转修复：从图谱、查询或深链以 `?ref=` / `?source=` 打开页面后，点击相关标签会同步 URL 到目标 Wiki 页，并且后续工作区刷新不会把右侧详情拉回原页面。

本地与发布验收记录：

- Query 工作台自动定位最近消息和 Thought 折叠展示已通过本地 Vite + headless Edge 截图验证；测试样例确认 Thought 只叠加在正文上方，不改变回答正文内容。
- 图谱平面视图已使用真实知识库 `D:\MyWiki-MVP\工作-wiki-2026` 本地加载验证，当前真实样本为 104/115 个可展示实体、121/134 条可展示关系、9 个社区；Chrome headless 截图确认 Sigma/ForceAtlas2 社区布局正常展开，节点拖拽和滚轮缩放可执行，未再出现节点集中挤在画布中心的问题。
- 图谱新增前端懒加载 chunk 约 108 KB（gzip 约 30 KB），生产 `dist` 总体积约 58.24 MB；对安装包体积的影响处在几百 KB 到 1-2 MB 的预期范围内。
- Query、图谱、Lint、工作区记录、Raw Inbox 队列和人工编辑保护相关单元测试已覆盖本次修改的主要行为。
- 查询建议写回竞态已用固定 `Date.now()` 的真实同毫秒用例验证：先查询生成开源状态建议并写入缓存，再应用建议，随后再次查询必须重新读取实体属性，不允许命中旧缓存或重复返回待审核建议。
- Raw Inbox/Frog 真实模型回归用例已使用 DeepSeek 配置处理真实 Markdown 原文件：原文件状态为 `compiled`，生成了实质实体/Wiki 页，未触发 fallback、兜底或降级。
- DeepSeek 管理式医疗回归用例已验证结构化入库和 Wiki 生成能够产出实质项目页、概念页和相关实体，不再停留在来源文件入库状态。
- Raw Inbox/Frog 队列稳定性已使用真实工作区副本 `D:\MyWiki-MVP\工作-wiki-2026` 验证：直接打开旧/已有项目文件夹后，失败的 `管理式医疗.md` 可恢复并完成结构化与 Wiki 生成；新建工作区导入 Markdown 和网页捕获 Markdown 均完成入库，失败数为 0。测试过程中出现的默认 5 秒测试超时已定位为验证脚本超时阈值不足，重跑使用 30 秒阈值后真实链路通过，未把超时或降级当作通过。
- 2026-05-26 安装包实测回归中发现的 `管理式医疗.md` 成功后残留旧失败文案、网页捕获队列阶段显示滞后、图谱自环关系导致 Sigma 画布失败，已补充针对性单元测试和真实工作区数据检查；全量 `npm test` 通过 438 个测试。
- 图谱洞察和 Deep Research 交互修订已通过本地 Vite 浏览器验证：洞察卡片显示明确类型标签和研究入口，确认弹窗会说明默认主题/关键词，研究面板不会被洞察卡片挤到列表下方；修复后未再出现图谱诊断 duplicate key 控制台错误。对应单元测试覆盖从桥接洞察发起研究后必须显示研究面板和队列状态；全量 `npm test` 通过 440 个测试。
- 知识树删除回归用例已验证单页删除、type 分组删除、二次确认、重复点击锁定和关联关系/来源引用级联清理。
- Wiki 页 Related 标签跳转已使用真实知识库 `D:\MyWiki-MVP\工作-wiki-2026` 回归：从“内蒙古福瑞医疗科技股份有限公司”通过 `concepts/数字生命研发专项计划` 跳到目标 Wiki 后等待刷新仍停留在目标页；新增单元测试覆盖从 `?ref=` 打开 A、点击 related 到 B、再触发数据刷新时不得回跳 A；本机 Windows 桌面包 `.msi` / `.exe` 生成通过。
- 本机环境为 Windows，macOS `.dmg` 无法在本机安装运行。macOS 包通过 GitHub Actions 的 `macos-latest` runner 执行 `pnpm test` 与 `pnpm desktop:build:macos` 后生成。
- 音视频链路已按官方 MarkItDown 文档重新确认：ffmpeg 只能解决解码/抽轨，不能提供稳定中文 ASR；本版本已撤下音视频入口和组件发布，避免把不可控转写失败、超时或降级当作通过。

当前发布安装包：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows | `MyWiki_0.1.8_x64-setup.exe` | 推荐给普通 Windows 用户的安装包 |
| Windows | `MyWiki_0.1.8_x64_en-US.msi` | Windows MSI 安装包 |
| macOS | `MyWiki_0.1.8_aarch64.dmg` | Apple Silicon Mac 推荐安装包 |
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
3. 创建并推送 tag，例如 `v0.1.8`。
4. `Release Packages` workflow 构建 Windows/macOS 安装包并生成 SHA256 校验文件。
5. workflow 创建或更新 GitHub Release，客户端通过 `/releases/latest` 检查更新。

详见 [`docs/release.md`](./docs/release.md)。

## 数据与隐私

MyWiki 当前设计是本地优先：用户项目、原始材料、生成的 Wiki 和索引默认保存在用户选择的本地工作区中。API Key 存在本地配置中，不应提交到 Git 仓库或打进公开安装包。使用云端 LLM 时，上传给模型的内容取决于用户选择的导入、编译、OCR、视觉 caption 和查询流程。

## 当前已知边界

- MVP 仍在快速迭代，部分队列和编译能力还在持续优化。
- 部分网页会因为登录、验证码、环境验证或反爬策略无法抓取正文，本版本会明确提示失败。
- macOS 当前发布 Apple Silicon / ARM64 包。
- iOS 分发尚未接入，需要单独设计移动端构建和签名流程。
- 图谱页当前以现有实体关系数据为主，后续会继续和文件工作区 Wiki page types 深度对齐。
- 音视频材料解析和转写尚未接入稳定方案；本版本不把 MP3、MP4、M4A、WAV 作为支持导入格式。
