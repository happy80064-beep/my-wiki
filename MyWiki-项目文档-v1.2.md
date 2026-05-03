# MyWiki —— 个人 AI 知识中枢项目文档

> 本文档面向 AI 编程协作工具（Cursor / v0 / Bolt.new / Lovable / Claude Code 等），同时也是产品负责人的设计参考。
> 文档约定：中文用于产品语义描述，英文用于代码标识符、类型定义、文件名。

---

## 1. 产品愿景

### 1.1 一句话定义

MyWiki 是一个面向个人的 AI 知识中枢，用 wiki 的图结构存储工作和生活中的人、事、互动、主题，通过 AI 让信息可被自然语言精确召回。

### 1.2 解决的核心痛点

职场人士每天接触大量信息（飞书、邮件、会议、微信、文档、聊天），现有工具的问题：
- 信息分散在多个平台，"想得起来但找不到"
- 笔记工具是被动存储，需要主动整理才能用
- 普通 AI 助手没有用户的上下文，回答泛泛
- 工作工具和生活工具割裂，同一个人在两套系统里

### 1.3 核心价值主张

1. **统一记忆层**：工作和社交信息进入同一个知识库，靠"场景标签"区分而非分裂
2. **图结构存储**：信息之间的关系是一等公民，可精确查询归属和关联
3. **AI 增强检索**：自然语言问问题，系统先按结构精确过滤再由 AI 自然表达
4. **零摩擦捕获**：文字、语音、文件、链接，AI 自动识别和结构化
5. **时间感知**：每条信息有时间锚点，过去可回溯、未来可提醒、关系可看变化
6. **图谱可视化**：所有实体和关系可视化探索，发现孤岛、热点和意外关联
7. **AI 主动维护**：捕获时编译进知识库（不是仅检索），周期性体检发现问题

### 1.4 目标用户

非技术背景的职场人士，主要场景包括：
- 项目管理（多项目并行、跨团队协作）
- 客户/同事/朋友/家人关系维护
- 个人成长与学习沉淀

### 1.5 非目标（明确不做的）

- 不做团队协作功能（这是个人工具，不是 Notion）
- 不做内容编辑器的复杂排版（重点是结构化和检索，不是排版美感）
- 不做实时通讯或社交功能
- MVP 阶段不做平台集成（先验证核心体验）
- MVP 阶段不依赖云端主数据库，数据以本地为权威源
- 不做无差别消息全量监听；任何平台采集必须由用户主动触发或显式标记

---

## 2. 核心设计原则

### 2.1 类型收敛、标签扩展

页面类型只有四种（人、事项、互动、主题），不再细分。差异通过"场景标签"（工作/生活/社交/个人）和"标签"系统表达，避免类型爆炸。

例：一个人可以同时是同事和朋友 → 一张档案，打两个场景标签，关系类型字段记录"同事·朋友"。

### 2.2 关系是一等公民

实体之间的关系（owner、participant、attendee、mentions 等）是独立对象，有自己的 ID、类型、证据来源。**这是 wiki 架构和扁平笔记的本质区别**。

### 2.3 AI 是表达层，不是判断层

AI 负责：自然语言理解（捕获时提取结构）、自然语言生成（查询时表达答案）。
AI 不负责：精确归属判断、复杂逻辑推理。

归属和过滤必须由代码按数据结构精确执行，AI 只对已过滤好的结果做表达。这样可以避免"AI 把不属于某人的任务错误关联到他名下"这类幻觉问题。

### 2.4 捕获摩擦最小化

- 文字、语音、文件三种入口
- AI 自动识别类型、生成标题、提取标签、识别承诺
- 用户可编辑修正，但默认结果应该 80% 可用

### 2.5 可验证、可追溯

每条结构化信息都关联到原始 entry。用户可以追溯"AI 为什么这么说"，提升信任度。

### 2.6 AI 是建议，用户是决定

AI 处理后产生的所有结构化结果（实体类型、标题、摘要、场景、标签、关系、任务、owner 归属）都是"建议"。用户在保存前后的任何时刻都可以编辑、删除、重新生成任意字段。系统永远不假设 AI 的判断是最终答案。

### 2.7 编译，而不是仅检索

借鉴 Karpathy 的 LLM Wiki 思路：传统 RAG 在每次查询时重新发现知识，知识不累积。MyWiki 在**捕获时**就把信息编译进知识库——更新相关实体、刷新主题摘要、关联到现有项目。查询时直接读编译好的结果，而不是临时检索原文。这让知识随每次输入持续生长。

### 2.8 时间是核心维度，不是字段

时间不是某个字段的属性，而是横贯所有实体的轴。每个 entry、event、task、决策、观点都带有时间戳，系统据此提供四种能力：过去回溯、现在感知、未来提醒、演变追踪。详见第 5.5 节。

### 2.9 数据由用户拥有，可随时离开

所有数据归用户所有，可随时导出为标准 markdown 仓库（见第 7.4 节）。用户可以用 Obsidian 等工具浏览，可以用 git 备份和版本控制，可以无成本迁移到其他系统。MyWiki 不锁定数据。

### 2.10 本地优先（Local-First）

MyWiki 的长期架构应采用 local-first 思路：**本地数据副本是权威源，云端（如未来启用）只是同步通道，不是主数据库**。

具体含义：
- 当前 Web MVP 先用 IndexedDB / Dexie 验证核心闭环；桌面阶段优先迁移为 Tauri 壳，并评估 SQLite 作为主存储。
- 所有读写优先发生在本地，断网时除 LLM API 调用外，知识库浏览、查询已编译数据、图谱、编辑和导出应可继续使用。
- 数据模型从现在开始预留 `clientId` 和 `updatedAt`，为未来多端同步、冲突解决和本地导出做准备。
- 数据访问层要保持抽象，未来加 sync 模块时不应重写 UI 和业务逻辑。

这个原则需要在 MVP 阶段确立：如果一开始按“云端优先 + 本地缓存”设计，后期再补完整本地能力会非常昂贵；反过来，从 local-first 演进到多端，只需要增加同步层。

---

## 3. 数据模型（核心）

MyWiki 的数据模型由四张表构成。这是整个系统的地基，必须严格按此实现。

### 3.1 `entries` —— 原始捕获

每次用户扔进系统的内容都先以原始形态存储。它是所有结构化信息的"出处"。

```typescript
type Entry = {
  id: string;                    // uuid
  content: string;               // 原始文字内容（如来源是图片或文件，此处存 OCR 或解析后的文本）
  source: 'text' | 'voice' | 'image' | 'file' | 'paste';
  fileMetadata?: {               // 来源是 image 或 file 时使用
    filename: string;
    mimeType: string;            // image/png, image/jpeg, application/pdf 等
    url: string;                 // 本地或云端存储路径
    thumbnailUrl?: string;       // 图片缩略图（可选）
  };
  capturedAt: number;            // unix ms
  processed: boolean;            // 是否已 AI 处理
  derivedEntities: string[];     // 从此条提取出的 entity ids
  derivedTasks: string[];        // 从此条提取出的 task ids
  derivedRelationships: string[];// 从此条提取出的 relationship ids
  updatedAt: number;             // 最后修改时间；未来同步和冲突解决使用
  clientId?: string;             // 创建/修改此记录的客户端 ID；桌面阶段启用
  syncStatus?: 'local' | 'synced' | 'conflict'; // V2 同步状态，MVP 可不落库
};
```

### 3.2 `entities` —— 实体节点

人、事项、互动、主题都是节点。

```typescript
type EntityType = 'person' | 'project' | 'event' | 'topic';
type Scene = 'work' | 'life' | 'social' | 'personal';

type Entity = {
  id: string;
  type: EntityType;
  title: string;                 // 显示名，最长 30 字
  summary: string;               // 2-3 句摘要
  tags: string[];                // 自由标签
  scenes: Scene[];               // 场景标签（可多选）
  properties: PersonProps | ProjectProps | EventProps | TopicProps;
  sourceEntries: string[];       // 哪些 entry 提到/构成了它
  createdAt: number;
  updatedAt: number;
};

type PersonProps = {
  knownSince?: string;           // 认识时间或场合
  communicationStyle?: string;   // 沟通偏好
  focusAreas?: string[];         // 关注重点
  // work 场景下额外
  company?: string;
  role?: string;
  // social 场景下额外
  lastContactAt?: number;        // 上次互动时间戳，每次新 event 后自动更新
  contactReminderInterval?: number; // 维护提醒间隔（毫秒），如 90 天
  importantDates?: { label: string; date: string }[];
};

type ProjectProps = {
  status: 'active' | 'paused' | 'done' | 'archived';
  goal?: string;                 // 1-2 句目标
  startDate?: string;
  endDate?: string;
  myRole?: 'owner' | 'participant' | 'observer';
  retrospective?: {              // 复盘板块
    didWell?: string;
    toImprove?: string;
    reusableLessons?: string;
    completedAt?: number;
  };
};

type EventProps = {
  occurredAt: number;            // 发生时间（过去）或 预定时间（未来）
  isFuture: boolean;             // 是否是未来计划
  location?: string;             // 物理或线上位置
  aiSummary?: string;            // AI 提炼的会议要点
  rawTranscript?: string;        // 原始记录（可选）
  decisions?: { content: string; decidedBy?: string; decidedAt: number }[];
};

type TopicProps = {
  isPersonal: boolean;           // false=外部知识；true=个人成长/内省
  myView?: string;               // 用户主动写的核心观点
  viewHistory?: {                // 观点演变日志
    view: string;
    updatedAt: number;
    triggeredBy?: string;        // 由哪个 entry 引发的更新
  }[];
  autoCollectedSnippets: string[];     // 自动汇集的素材 entry ids
  aiCompiledSummary?: string;          // AI 基于素材编译的最新综述
  lastCompiledAt?: number;             // 上次 AI 编译时间
};
```

### 3.3 `relationships` —— 关系边

实体之间的连接，是一等公民。

```typescript
type RelationshipType =
  // person → project
  | 'owner'           // 负责人
  | 'participant'     // 参与者
  | 'stakeholder'     // 干系人
  | 'decision-maker'  // 决策人
  // person → event
  | 'attendee'        // 参会者
  | 'organizer'       // 组织者
  | 'mentioned-in'    // 被提及
  // person ↔ person
  | 'colleague'
  | 'friend'
  | 'family'
  | 'mentor'
  | 'reports-to'
  // project ↔ project
  | 'parent-of'
  | 'depends-on'
  | 'related-to'
  // event → project
  | 'about'           // 关于某事项
  | 'kicked-off'      // 启动事项
  // project/event → topic
  | 'relevant-to'
  // entity → entity 通用
  | 'mentions';       // 提及

type Relationship = {
  id: string;
  from: string;                  // entity id
  to: string;                    // entity id
  type: RelationshipType;
  properties?: Record<string, any>;
  evidence: string[];            // 支持此关系的 entry ids
  createdAt: number;
};
```

**关键约束**：删除一个 entity 时，必须级联清理涉及它的所有 relationships。

### 3.4 `tasks` —— 任务承诺

任务是特殊节点，因为它有强烈的归属语义。**这是 MVP 必须做对的部分**。

```typescript
type Task = {
  id: string;
  description: string;           // 任务内容
  owner: string;                 // 负责人 entity id（必填，通常指向某个 person）
  assignedBy?: string;           // 委托人 entity id（如"是张总让我做的"）
  linkedTo: string[];            // 关联的事项/互动 entity ids
  dueDate?: string;              // ISO date
  reminderTime?: number;         // 提醒时间戳，可独立于 dueDate（如截止前一天）
  status: 'pending' | 'done' | 'overdue' | 'cancelled';
  completedAt?: number;
  source: string;                // 哪条 entry 创建了这个任务
  createdAt: number;
};
```

**为什么 owner 必填**：这是解决"虾总的任务包含了不属于他的项目任务"这类幻觉的核心。查询永远按 `owner` 字段精确过滤，不依赖 AI 推断。

**同步预留字段（Local-First 路线）**：四张核心表（`entries / entities / relationships / tasks`）后续都应包含 `updatedAt` 和 `clientId`。当前 Web MVP 可先保持已有字段，桌面化或 schema 迁移时补齐：
- `clientId` 在应用首次启动时生成并持久化，如 `desktop-{uuid}`。
- `updatedAt` 在每次修改记录时更新，用于增量导出、多端同步和冲突解决。
- `syncStatus` 暂不作为 MVP 必需字段，等真正加入同步模块再启用。

### 3.5 数据存储

**当前 Web MVP 阶段**：浏览器 IndexedDB（Dexie.js 包装），所有业务数据本地存储，用于验证捕获、查询、图谱和待编译闭环。

**桌面化阶段**：推荐 Tauri + SQLite 或继续 Dexie/IndexedDB。SQLite 更适合复杂查询、文件附件管理和长期桌面存储；Dexie 更适合快速迭代和 Web 兼容。

**同步演进阶段**：不把 Supabase / Pocketbase 作为默认主数据库，而是在 local-first 基础上增加可选 sync 模块。优先考虑：
1. 云盘加密 blob 同步（iCloud / 坚果云 / Dropbox / WebDAV）
2. 自托管同步服务（NAS / Pocketbase / Supabase）
3. 局域网 P2P 直连

不使用 localStorage（容量限制和性能问题）。

### 3.6 图遍历 API（关系网络的核心查询能力）

数据访问层除了基础 CRUD，必须实现以下图遍历方法。这些是关系图谱可视化、AI 查询过滤、Lint 检查的共同底层能力。

```typescript
type GraphAPI = {
  // 取某节点的直接邻居（1 跳）
  getNeighbors(entityId: string, opts?: {
    relationshipTypes?: RelationshipType[];  // 只看某些关系类型
    direction?: 'in' | 'out' | 'both';      // 方向
  }): Entity[];

  // 取某节点的 N 跳子图（用于局部图谱视图）
  getSubgraph(entityId: string, depth: number, opts?: {
    sceneFilter?: Scene[];
    timeRange?: { start: number; end: number };
    excludeTypes?: EntityType[];
  }): { nodes: Entity[]; edges: Relationship[] };

  // 找两个节点之间的路径（用于回答"我和某人有什么共同事项"）
  findPaths(fromId: string, toId: string, maxDepth?: number): Relationship[][];

  // 取全局图（用于全局图谱视图，可分页或抽样）
  getFullGraph(opts?: {
    sceneFilter?: Scene[];
    timeRange?: { start: number; end: number };
    minDegree?: number;  // 只看至少有 N 个连接的节点（过滤孤岛）
  }): { nodes: Entity[]; edges: Relationship[] };

  // 找孤儿节点（没有入边或出边的实体）
  findOrphans(): Entity[];

  // 找 hub 节点（连接数最多的前 N 个节点）
  findHubs(n: number): { entity: Entity; degree: number }[];
};
```

**关键约束**：删除一个 entity 时，必须级联清理涉及它的所有 relationships。

### 3.7 数据模型示例

> 真实场景：用户输入 "今天和虾总约了股票监控项目的进度同步会，他确认这周内调通飞书推送，下周开始验证手动检测结果"

正确的数据生成结果：

```javascript
// entries
{ id: 'e1', content: '今天和虾总约了…', source: 'text', capturedAt: ... }

// entities
{ id: 'p1', type: 'person', title: '虾总', scenes: ['work'], ... }
{ id: 'pr1', type: 'project', title: '股票监控', scenes: ['work'], ... }
{ id: 'ev1', type: 'event', title: '股票监控进度同步', scenes: ['work'], ... }

// relationships
{ from: 'p1', to: 'pr1', type: 'owner' }
{ from: 'p1', to: 'ev1', type: 'attendee' }
{ from: 'ev1', to: 'pr1', type: 'about' }

// tasks
{ description: '调通飞书推送', owner: 'p1', linkedTo: ['pr1'], dueDate: '本周内', status: 'pending' }
{ description: '验证手动检测结果', owner: 'p1', linkedTo: ['pr1'], dueDate: '下周', status: 'pending' }
```

---

## 4. 核心功能与流程

### 4.1 捕获流程（最高优先级）

**v1.2 补充：Raw Inbox 异步采集原则**

借鉴 Karpathy LLM Wiki 的“用户捕获”和“LLM 编译”解耦思路，MyWiki 的文件采集不应强制实时入库。用户把材料拖入捕获页或批量选择文件后，系统先把原始文件保存为 `RawAsset`，进入本地 Raw Inbox；解析、两步摄入、AI 编译和写入 Wiki 可以稍后批量执行。这样用户的捕获动作保持在秒级，LLM 的处理耗时不会阻塞继续收集材料。

Raw Inbox 要求：
- 支持 Markdown、纯文本、Word、PDF、图片等格式先原样收件，并立即生成一条 `processed=false` 的原始 Entry。
- 同一原始文件按内容 hash 去重，重复导入不重复编译。
- 文件状态独立记录为 `raw / extracting / compiling / compiled / skipped / failed`。
- 用户点击“编译新材料”后，队列异步处理 raw 文件，并显示进度条、百分比和当前文件名。
- 编译成功后复用同一条原始 Entry，将 `processed` 更新为 `true`，并补充实体、关系、任务和待编译建议；编译失败不影响“已采集”状态，可后续重试或手动整理。
- 长文本（尤其 PDF/Word 转出的长文本）不直接要求 LLM 输出严格 JSON。先按块生成 Markdown 阅读摘要，再基于摘要生成 WikiPatch / JSON；超长材料只把代表性分块交给模型，完整原文保留在原始 Entry 中。
- 未来桌面版可映射到真实 `raw/` 目录：用户直接把文件丢进目录，MyWiki 监听新增/修改文件，再触发异步编译。

**用户操作**：
1. 进入捕获页，看到一个大文本框（默认聚焦）
2. 三种输入入口：
   - 粘贴文字（直接在文本框输入或粘贴）
   - 点击麦克风录音（实时转写并填入文本框）
   - 拖入文件或批量选择文件（支持图片 jpg/png/webp、PDF、Word、纯文本），先进入 Raw Inbox
3. 点击"AI 整理"按钮
4. AI 处理完毕，展示结构化结果：主实体、关联实体、关系、任务全部列出
5. **用户全程可编辑修改**任何字段（详见 4.1.1）
6. 点"保存到知识库"，所有数据写入存储

**图片处理特别说明**：
- 拖入或上传图片后，调用支持视觉的 LLM（可插拔 provider）直接解析图片内容
- 图片用于：聊天截图（提取对话）、白板照片（识别手写笔记）、名片（识别人员信息）、文档扫描（OCR）等
- 原始图片保留在 `entries.fileMetadata.url`，可随时回查
- AI 把视觉内容转为文字后，存入 `entries.content`，作为后续提取的依据

**AI 处理逻辑**：
- 调用支持视觉的 LLM（provider 可插拔，按实际接入模型选择）
- 一次调用提取：1 条主实体 + N 条关联实体 + N 条关系 + N 条任务
- 防御性 JSON 解析：去除 markdown 代码块、提取最外层 `{}`、容忍尾部逗号、降级到字段级正则提取

#### 4.1.1 全程可编辑原则（重要）

AI 处理结果是"建议"，不是"决定"。用户必须能在保存前的每一个字段上做二次编辑，并且保存后仍可回到任意页面继续修改。具体要求：

**保存前的编辑能力**：
- 主实体的类型（person/project/event/topic 选择器）
- 标题（可改）
- 摘要（多行文本框可改）
- 场景标签（可勾选/取消）
- 标签（可增、可删、可改）
- 关联实体（可删、可新增、可改类型）
- 关系（可删、可改类型、可改方向）
- 任务（每条任务的描述、owner、关联事项、截止日都可改）
- 任务也可整条丢弃或新增

**保存后的编辑能力**：
- 任何已保存的实体、关系、任务都可在 wiki 浏览界面继续编辑
- 修改后会更新 `updatedAt`，原始 entry 不变（保留 AI 第一次处理的痕迹）
- 提供"重新让 AI 处理"按钮，基于原始 entry 再次提取，覆盖当前结构化结果

**编辑交互的设计要求**：
- 所见即所得，点击字段直接进入编辑态，不要弹出对话框
- 字段之间用 Tab 键快速切换
- 删除操作要二次确认（避免误删）
- 改动有未保存提示，离开页面前提醒

### 4.2 查询流程（核心体验）

**v1.2 补充：查询加速原则**

查询是同步体验，不能像采集一样让用户长时间等待。MyWiki 查询加速采用 Karpathy LLM Wiki 的核心思路：昂贵的理解和综合尽量前移到摄入/后台编译阶段，查询时优先读取已经整理好的 Wiki。

已落地的 MVP 机制：
- **实体预编译资料 `compiledProfile`**：实体保存、摄入写回、待编译建议写回、查询洞察保存后，会刷新实体的概述、关键事实、未完成任务、关系摘要和来源摘要。
- **轻量 Wiki Index**：查询前先读取极简实体索引，包含 id、类型、标题、别名、短摘要、来源数、关系数和重要度，帮助 Query Agent 先选页面。
- **查询优先读预编译资料**：实体文档回答会优先使用 `compiledProfile`，减少每次查询重新扫描原始材料和临时综合的成本。
- **查询缓存**：同一问题在知识库没有变化时，可直接返回缓存答案，跳过重复检索和模型表达。
- **查询洞察命中**：用户保存过的高价值答案会作为 `query-insight` 主题页沉淀；再次问同一问题时优先命中该洞察页。
- **两段式快答体验**：前端先显示本地结构化快速答案，再后台调用 Query Agent 和 LLM 优化表达，降低主观等待时间。

**用户操作**：
- 在任意位置打开查询入口（顶栏搜索 / 知识库底部对话框）
- 输入自然语言问题
- 看到答案 + 来源链接 + 追问建议

**系统处理逻辑（关键，不要省略）**：

```
Step 1: 解析问题意图
  调用 LLM 把用户问题分类到六种查询类型之一：
  - 人际召回：关于某人的信息
  - 项目状态：关于某事项的进展
  - 承诺追踪：未完成的任务/承诺
  - 模糊记忆：用户记不清细节的搜索
  - 知识提炼：从主题或经验中归纳
  - 时间检索：按时间范围查询
  同时识别问题中的关键实体（人名、项目名等）。

Step 2: 图遍历过滤（在 JS 中执行，不用 LLM）
  根据查询类型和实体，从数据存储中精确过滤：
  - "虾总的未完成任务" → 先在 entities 找虾总 → 在 tasks 中 WHERE owner=虾总.id AND status!='done'
  - "品牌项目的最近决策" → 找项目 → 找 about 关系的 events → 取它们的 decisions 字段
  - "我答应了谁还没兑现" → tasks WHERE owner=用户 AND status='pending'

Step 3: 把过滤好的结果交给 LLM 表达
  传入：原始问题 + 过滤后的精确数据 + 表达要求
  LLM 任务：把数据组织成自然中文回答，标注来源，发现潜在风险（逾期等）主动提醒，
  不确定时列候选并追问一个问题，绝不编造。

Step 4: 渲染答案
  - 主答案
  - 可点击的来源芯片（链接到对应 entity 或 entry）
  - 2-3 个追问建议
```

**绝对禁止**：把所有数据平铺为字符串扔给 LLM 让它自己过滤。这是旧设计的核心错误。

#### 4.2.1 渐进式 Wiki 阅读式查询（Karpathy LLM Wiki 启发）

查询层的核心目标不是"在原文里临时捞片段"，而是像一个 wiki 阅读器一样，优先读取已经被系统编译好的知识成果。原始 entry 是证据层，不是第一查询层。

**推荐查询链路**：

```
用户问题
→ Query Agent 理解问题
→ Query Agent 读取知识目录（实体索引 / 别名 / 摘要 / 类型 / 更新时间）
→ Query Agent 判断相关页面、属性和证据关键词
→ 代码按查询计划命中候选实体或主题
→ 读取实体文档（summary、properties、tasks、sourceEntries）
→ 展开 1-2 跳关系子图（getSubgraph / findPaths）
→ 必要时调用工具搜索补充（相关 sourceEntries、全库 entries、后续可扩展 web/local search）
→ 由 LLM 基于已召回的结构化材料生成回答
→ 记录本次查询日志，必要时沉淀为新的 wiki 洞察
```

**Query Agent 规划层（LLM 理解问题，但不直接判答案）**：

Karpathy LLM Wiki 的关键不是硬关键词匹配，而是让 LLM agent 先读 `index.md`，判断问题可能对应哪些页面，再深入页面和来源。MyWiki 对应实现为 Query Agent：

```
LLM 理解问题
→ 读取知识目录 EntityIndex
→ 判断相关页面 / 实体候选
→ 生成工具搜索词
→ 代码读取页面和原文
→ LLM 只基于召回证据综合回答
→ 好答案写回 Wiki
```

Query Agent 输出结构化计划，而不是自然语言答案。计划至少包含：

```json
{
  "intent": "attribute_lookup | entity_profile | task_lookup | relationship_lookup | time_lookup | evidence_search",
  "selectedEntityIds": ["entity id"],
  "entityCandidates": ["数字生命体", "桌面数字生命体", "桌面生命体"],
  "attribute": "runtimeEnvironment",
  "evidenceTerms": ["Windows", "Windows 桌面", "运行在 Windows", "运行环境"],
  "needsRawEvidence": true,
  "needsGlobalSearch": false,
  "answerType": "yes_no_with_evidence"
}
```

注意：Query Agent 只负责"理解问题和规划查哪里"，不负责最终事实判断。归属、过滤、关系遍历、来源读取仍由代码执行。这样既避免关键词覆盖不足，也避免把整库数据丢给 LLM 造成幻觉。

**知识目录层（EntityIndex）**：

系统应维护一个轻量的目录层，作用类似 Karpathy 提到的 `index.md`。它不替代数据库，而是帮助查询先快速定位"可能相关的页面"。

每条目录记录至少包含：
- entityId
- title
- aliases（如"桌面生命体" → "桌面数字生命体"）
- type
- summary
- tags / scenes
- sourceCount
- relationshipCount
- updatedAt

查询时先读目录，再进入实体详情。这样用户问"桌面生命体叫什么"，系统应先命中"桌面数字生命体"，再读取它的实体文档，回答它的正式名称、别名、角色名和来源，而不是只返回"找到一个相关实体"。

**实体文档层（Entity Profile）**：

每个 entity 不只是一个数据库节点，也应被视为一篇持续更新的 wiki 页面。查询命中实体后，必须继续读取：
- 实体摘要和关键属性
- 与它相关的未完成任务和历史任务
- 直接关系和重要二跳关系
- 支持这些结论的 sourceEntries
- 关联 topic 的 aiCompiledSummary（如有）

**来源证据层（Entry Evidence）**：

只有当实体文档不足以回答，或用户追问"原文怎么说"时，才回到 entry 内容中做全文检索。查询答案必须保留来源芯片，用户能点回原始捕获。

**原始材料兜底扫描（Raw Evidence Fallback）**：

把 MyWiki 想象成一个资料室：实体页是整理好的档案柜，sourceEntries 是这份档案背后的原始资料夹，entries 全表是整个资料室。查询时必须按这个顺序找：

```
先查整理好的实体档案
→ 档案答不出，就翻这份档案背后的原始资料夹
→ 还答不出，再翻整个资料室
→ 找到证据后，标注"来自原始材料兜底扫描"
→ 后续提示或自动把信息补回实体档案
```

典型场景：用户问"桌面生命体的唤醒词是什么"，实体页里没有 `wakeWord` 字段，但原始捕获里写过"主唤醒词是小林"。系统不应直接说没找到，而应在该实体关联的 `sourceEntries` 中围绕"唤醒词"定位片段；如果关联来源没命中，再扫描全库 entries。

实现要求：
- 先由 Query Agent 从问题中抽取属性关键词和同义词，如"唤醒词 / 叫醒词 / KWS"、"终止词 / 停止词 / 打断词"、"API key"、"模型"、"路径"、"负责人"、"Windows / 运行环境 / 平台支持"。
- 命中实体后，优先扫描该实体相关的 sourceEntries、任务来源、关系 evidence。
- 对长 entry 截取命中词前后 100-200 字，交给 LLM 表达，而不是只截取原文开头。
- 如果相关来源没命中，再全库扫描 entries，但必须在扫描轨迹和答案中标注"来自全库原始材料兜底，还未编译进实体页"。
- 找到答案后，应产生一个"待编译回 Wiki"的建议，例如把 `桌面数字生命体.properties.wakeWord = 小林`，或创建"唤醒词"主题并建立关系。MVP 需要提供可触发的待编译项：用户点击后进入确认面板，确认后写回实体属性或创建 topic/relationship。
- 待编译确认项必须产品化展示，不能暴露 `entity.propertyKey = value` 这种调试格式。应展示为：
  - 实体：桌面数字生命体
  - 字段：运行环境 / 唤醒词 / 来源或基于项目
  - 建议值：Windows / 小林 / OpenMaic 开源项目
  - 证据：命中的原始材料片段
  - 置信度：高 / 中 / 低
  - 来源：关联原始材料 / 全库兜底
  - 动作：确认写回
- 属性值提取不能只拿命中词本身。例如原文是"基于 OpenMaic 开源项目二次开发"，写回值应是 `OpenMaic 开源项目`，而不是泛化的 `开源`。
- 待编译确认项必须经过"两道闸 + 一个队列"：
  1. **硬规则校验**：代码校验证据片段是否支持建议值。比如 `derivedFrom = OpenMaic 开源项目` 必须同时出现 `OpenMaic` 和 `基于 / 来源于 / 源自 / 二次开发 / fork / derived from` 等关系触发信号；不满足则不生成确认项。
  2. **LLM 语义校验（后续增强）**：当表达不是标准关键词但语义上支持关系时，再由 Agent 判断 `supported / confidence / reason`。MVP 阶段先实现规则校验。
  3. **待确认队列去重**：按 `entityId + propertyKey + normalizedPropertyValue` 合并重复建议。同一建议只显示一次，优先保留证据最强、来源最可靠的那条。

注意：原始材料兜底扫描不是退回普通 RAG。它只在 Wiki 编译层不足时使用，并且目标是把漏掉的信息补回 Wiki，让下次查询优先从实体档案直接回答。

**查询日志层（Query Log）**：

每次查询都应记录：
- 用户问题
- 命中的目录项
- 读取过的实体、关系、任务、entry
- 最终答案
- 是否有低置信度或歧义

这让系统能解释"为什么这么答 / 为什么没查到"，也能让高质量问答反向沉淀为新的 wiki 洞察页。

**好答案可沉淀**：

如果一次查询生成了有长期价值的综合结果，例如"桌面数字生命体下一阶段路线分析"、"我和虾总的共同事项总结"，系统应允许用户一键保存为 wiki 洞察，后续查询优先复用它。知识不应只停留在聊天历史里。

### 4.3 主题页的双层机制（编译 + 总结）

主题页有三层内容（在 Karpathy LLM Wiki 思路启发下增强）：

- **底层（自动积累）**：每次捕获处理时，AI 识别出涉及的主题（如"竞品分析""育儿""谈判技巧"），自动把这条 entry 挂进对应主题的 `autoCollectedSnippets`。无需用户操作。
- **中层（AI 编译）**：每当 autoCollectedSnippets 增加 N 条（默认 5 条）或距上次编译超过 7 天，系统自动调用 LLM 把素材编译成一份"AI 综述"，存入 `aiCompiledSummary`。这份综述持续生长，用户能看到这个主题的最新累积认知，而不是每次自己翻素材。
- **上层（用户观点）**：用户偶尔打开主题页，可点"我来写"或基于 aiCompiledSummary 修改，确认后存入 `myView`，并在 `viewHistory` 留下版本记录。

主题页默认展示三层并列：素材流（时间倒序）+ AI 综述 + 我的观点，用户能清楚区分哪些是事实积累、哪些是 AI 推断、哪些是自己的判断。

### 4.4 事项页的复盘板块

事项页底部有一个折叠的"复盘"区块（`retrospective` 字段）：
- 做得好的
- 下次改进
- 可复用的方法

填写后，AI 会把这些经验同步关联进相关主题页（创建 `relevant-to` 关系到对应 topic）。

### 4.5 不确定时的查询行为

LLM 在执行 Step 3 时，遇到无法精确匹配的问题（如"上次开会决定的那个事"），不直接说"没找到"，而是：
- 列出最多 3 个最可能匹配的候选
- 每个候选简述匹配理由
- 提一个最小化的追问（"是这三个之一吗？还记得大概时间或参与人吗？"）

### 4.6 捕获时的关联编译（核心）

每次新 entry 经 AI 处理后，系统不仅创建本次提取的实体和关系，还要**评估对已有知识库的影响**——这是"编译而不是仅检索"的核心实现：

1. **关联已有实体**：AI 提取出的"虾总"如果已存在于 entities 表，应链接到现有 ID 而非创建新实体。匹配方法：精确同名 + LLM 辅助歧义判断（同名时给用户选）。
2. **更新主题的素材流**：识别出新 entry 涉及的 topic，自动 push 到对应 topic.autoCollectedSnippets。
3. **触发主题编译**：如某 topic 的 snippets 数量到达阈值或时间间隔到达，触发 AI 重新编译 aiCompiledSummary。
4. **更新人员关系热度**：本次 entry 涉及的所有 person，自动更新 lastContactAt。
5. **检查矛盾**：如新 entry 的内容与某 topic 现有 myView 存在显著冲突（LLM 判断），在该 topic 上加一个"待审查"标记，下次 lint 时提示用户。

这一切都在保存的瞬间完成，对用户透明（最多看到一个简短的"已更新 3 个相关主题"的 toast）。

### 4.7 采集层架构：让信息入库摩擦最小

MyWiki 的成败很大程度取决于“信息从产生到入库”的摩擦。采集层应分阶段建设，但所有阶段都遵守两个底线：**用户主动触发**、**不做无差别全量监听**。

#### 4.7.1 采集原则

- 不要求用户频繁切换到 MyWiki 主界面。
- 采集动作应出现在用户已经工作的地方：桌面、浏览器、分享菜单、快捷键。
- 所有平台采集必须是用户主动触发或显式标记；不监听整个群、整个账号或整个聊天数据库。
- 采集后先进入本地数据库，再决定是否调用 LLM、是否同步或是否导出。
- 任何经过第三方平台服务器的采集，必须在 UI 上明确告知用户。

#### 4.7.2 七层采集路线

1. **全局快捷键 + 系统托盘浮窗**（桌面阶段优先）：任意应用中按快捷键弹出轻量捕获窗口，支持文字粘贴、录音、拖入文件或截图。
2. **浏览器扩展**（桌面阶段优先）：整页收录、选中文字收录、截图收录，并通过本地 native messaging 与桌面应用通信。
3. **手机分享菜单 + Widget**（多端阶段）：手机端只先做“快速入库”，不急于做完整编辑器。
4. **剪贴板智能提示**（可选）：用户复制长文本或图片时提示是否保存，必须默认关闭，由用户主动开启。
5. **平台机器人接入**（按需）：飞书、钉钉等只做 @ 机器人、星标、转发等“标记触发”采集；微信个人号不接入 API。
6. **邮件中继 / Webhook**（后端阶段）：转发邮件或第三方工具推送数据入库。
7. **本地通用数据接入端点**（给高级用户）：本地 HTTP、监听文件夹或 CLI 接收符合 MyWiki schema 的 JSON。该端点只监听 localhost，不暴露外网，只校验并接收数据，不内置第三方应用读取能力。

#### 4.7.3 阶段 1 推荐组合

当前 Web MVP 已先验证“捕获页 + AI 结构化 + 查询闭环”。桌面化后的第一个采集组合建议是：**全局快捷键浮窗 + 浏览器扩展**。这能覆盖大部分桌面工作场景，又不需要冒险接入第三方聊天数据库。

---

## 5. 页面类型详细设计

### 5.1 人员页（Person）

**Header**：头像（首字母）、姓名、关系类型（"客户·朋友"）、场景标签
**核心字段**：认识时间、沟通偏好、关注重点、共同事项
**承诺追踪区块**：双向显示 — 我对他的承诺（pending/done）、他对我的承诺
**互动时间线**：所有 type=event 且通过 attendee 关系连到此人的事件，按时间倒序
**关系图谱**：可视化此人参与的所有事项和事件（V2 功能）

### 5.2 事项页（Project）

**Header**：标题、状态、时间范围、我的角色
**统计**：会议数、参与人数、待办数、已完成数
**关键决策**：从相关 events 聚合，含拍板人和时间
**待办事项**：linkedTo 包含此项目的 tasks，按状态分组
**参与人员**：通过 owner/participant 等关系连接的所有 person
**最近会议**：通过 about 关系连接的 events
**复盘**：完成后填写

### 5.3 互动页（Event）

**Header**：标题、时间地点、关联事项
**参与人**：通过 attendee 关系连接的所有 person，可点击跳转
**AI 摘要**：自动生成的会议要点
**决策**：本次会议的明确决定
**行动项**：本次会议产生的 tasks
**原始记录**：可选的语音转录或手写笔记

### 5.4 主题页（Topic）

**Header**：主题名、是否个人成长类、场景标签
**我的核心观点**：用户主动写的内容（可空）
**观点演变日志**：我的看法随时间变化的版本历史
**自动积累的素材**：所有自动归类到此主题的 entries，按时间倒序
**相关人**：在这个领域给我启发的 person
**相关事项/经验**：通过 relevant-to 关系连接的 projects（特别是有复盘的）

### 5.5 时间感知机制（横贯全局的能力）

时间不属于某个页面，是横贯所有实体的轴。系统提供四种时间能力：

#### 5.5.1 过去回溯：按时间段查询

用户可问 "上周和市场部聊了什么"、"3 月份关于品牌的所有决定"、"去年这个时候我在忙什么"。系统在 entries 和 events 上按 capturedAt / occurredAt 做精确时间范围过滤，返回该时段的所有相关实体。

实现要点：
- 数据访问层提供 `findInTimeRange(start: number, end: number, types?: EntityType[])` 方法
- 查询入口支持自然语言时间表达（"上周"、"上个月"、"Q3"）的解析

#### 5.5.2 未来提醒：到期与预定事项

任务和未来事件统一进入提醒队列。系统每日定时扫描，把以下类型主动推到首页"需要关注"区：

- tasks 中 `dueDate` 已到达或临近（reminderTime 已到）
- tasks 中 status='pending' 且 dueDate 已过（标记为 overdue）
- events 中 `isFuture=true` 且 occurredAt 在未来 24 小时内
- person 中 `lastContactAt` 距今超过 `contactReminderInterval`（社交场景下，提醒维护重要关系）

实现要点：
- 浏览器端：用户每次打开应用时执行扫描（cheap），结果缓存当日
- V2 阶段：可选用 service worker + push API 做后台提醒

#### 5.5.3 演变追踪：认知如何变化

主题页的 `viewHistory[]` 记录每次"我的核心观点"修订；项目的 `retrospective` 与时间锚定。系统能回答："我对这件事最初是怎么想的，现在又怎么看？"

- 每次用户更新 topic.myView 时，旧版本自动 push 到 viewHistory
- 时间轴 UI 渲染观点演变，可看到每次变化的时间点和触发来源

#### 5.5.4 关系热度：维护社交关系

person 的 `lastContactAt` 在每次和此人相关的 event 创建时自动更新。社交场景下系统会提示"和某朋友 3 个月没联系了"，避免重要关系自然衰减。

- 用户可为重要的人单独设置 `contactReminderInterval`（如 30/60/90 天）
- 不强制提醒，但在每日简报或人员页提示状态

### 5.6 关系图谱可视化（第四种交互模式）

除了"创建、浏览、查询"，关系图谱提供了"探索"。在二维空间里看见所有节点和连接，用户能发现自己都没意识到的关联。

#### 5.6.1 全局图谱（独立页面）

入口：左侧导航的"图谱"。展示整个知识库的所有实体和关系。

- 节点颜色按类型区分：人=紫，事项=蓝，互动=绿，主题=琥珀
- 节点大小与连接度成正比（hub 节点更大）
- 默认采用 force-directed layout（推荐 d3-force）
- 顶部过滤栏：场景（工作/生活/社交/全部）、时间范围、实体类型
- 节点可拖动、滚轮缩放、点击聚焦
- 鼠标悬停显示详情 tooltip，点击跳转到对应实体页

#### 5.6.2 局部图谱（嵌入每个实体页）

每个实体页顶部有"关系网络"区块，显示以当前实体为中心的 1-2 跳子图。这是最常用的图视图——比如打开"虾总"，能看到他相关的所有项目、互动、任务。

- 默认 1 跳，用户可切换到 2 跳
- 中心节点固定在中心，其他节点环绕
- 与全局图共享视觉语言

#### 5.6.3 搜索结果可视化（高级能力）

AI 查询时，相关节点和路径在图中点亮，其他节点淡化——把搜索结果转换为视觉的"关系链"。

- 例如查询"虾总和我的共同事项"，从"虾总"和"我"两个节点高亮，所有连接它们的路径变粗变亮
- 适合复杂的多跳查询，让用户直观看到答案的逻辑

#### 5.6.4 实现技术

- 推荐 d3-force 库（轻量、灵活、无 DOM 依赖）
- 备选 vis-network（开箱更全但更重）
- 渲染用 SVG 或 Canvas：节点数 < 200 用 SVG（可交互更友好），> 200 用 Canvas
- 全局图谱节点过多时，提供"按场景切片"或"只看 hub 节点"等抽样策略

### 5.7 知识库健康检查（Lint，借鉴 Karpathy）

系统提供"健康检查"功能，用户可手动触发或设为每周自动扫描。这是把 MyWiki 从"被动笔记"升级为"主动伴侣"的关键机制。

#### 5.7.1 检查项

- **孤儿实体**：没有任何入边或出边的实体（可能值得删除或关联）
- **停滞任务**：status='pending' 超过 30 天且无关联活动的任务
- **失联关系**：person 中 lastContactAt 超过 reminderInterval 但用户未处理
- **冷藏项目**：status='active' 但近 60 天无新增 event 的项目（应转为 paused 或重启）
- **频繁提及但缺页**：在多条 entry 文本中出现但未建立独立 entity 的人或概念
- **未关联的 entry**：保存后未生成任何 entity/relationship/task 的原始捕获（可能 AI 处理失败）
- **观点矛盾**：topic 的 myView 与最新 autoCollectedSnippets 内容存在显著冲突（用 LLM 判断）

#### 5.7.2 输出形式

健康检查结果以一份"周报"展示：每项问题列出涉及的实体，提供一键操作按钮（删除孤儿、转为暂停、安排互动等）。用户可逐项处理或全部忽略，但保留记录便于后续回顾。

#### 5.7.3 实现要点

- 每项检查都是数据访问层上的简单查询，不需要 LLM
- 仅"观点矛盾"一项需要 LLM 辅助判断
- 检查结果缓存为 `lintReport` 实体，可历史回溯（看到自己上周清理过哪些孤儿）

---

## 6. UI/UX 设计原则

### 6.1 整体风格

- 干净、克制、专业感
- 浅色为主，深色为辅，单一蓝色为强调色
- 不用渐变、阴影特效、装饰性元素
- 字体统一系统字体（中文苹方/PingFang，英文 -apple-system）
- 圆角 12-14px（卡片）、20px（pill 按钮）
- 边框 1px，颜色淡（rgb(229, 229, 228) 之类）

### 6.2 信息密度

- 列表项保持紧凑，但有呼吸感（padding 11-13px）
- 字号梯度：13px 正文、12px 元信息、11px 标签、10px 大写小标
- 不堆砌元素，每屏一个核心动作

### 6.3 关键交互

- 捕获文本框默认聚焦
- 整理结果可所见即所得编辑（点击字段直接改）
- 所有跳转用蓝色文字（不用下划线）
- 实体之间通过链接互通，不出现"点击查看详情"按钮
- 移动端友好，输入区不被键盘遮挡

### 6.4 反馈

- 操作成功用顶部 toast，2.5 秒消失
- 操作失败用红色横条 + 具体错误信息（不要泛泛"操作失败"）
- AI 处理时用 spinner + 文字"AI 正在理解内容…"，不超过 8 秒应有回应

---

## 7. 技术选型

### 7.1 推荐技术栈

**当前 Web MVP**：
- Vite + React + TypeScript（当前代码基线）
- Dexie.js / IndexedDB（当前本地数据库）
- Tailwind CSS（保持设计可控）

**桌面壳（下一阶段重点）**：
- Tauri 2.0（推荐）：复用 Web UI，同时获得全局快捷键、系统托盘、本地文件、本地数据库和 native messaging 能力
- Electron 作为备选：生态成熟，但体积和资源占用更大

**前端**：
- Vite + React（继续沿用当前 MVP）或 Next.js 静态导出
- TypeScript 严格模式
- Tailwind CSS（不用 UI 框架，保持设计可控）
- 状态管理：Zustand（轻量）或原生 useReducer

**数据存储（本地优先）**：
- 当前：Dexie.js / IndexedDB
- 桌面阶段优先评估：SQLite（Tauri sql 插件）+ 本地文件系统附件目录
- 同步阶段：可选云盘加密 blob、自托管服务或局域网 P2P；不把云端数据库作为默认权威源

**AI 调用**：
- LLM Provider 可插拔：当前优先 MiniMax / DeepSeek，后续可扩展 Claude、Gemini、本地模型等
- 桌面应用中 API key 应存放在系统 keychain / credential vault，不写入前端明文
- 流式响应（提升感知速度）

**语音输入**：
- 当前 Web MVP：可先用浏览器能力或文件/文本输入验证闭环
- 桌面阶段：优先评估本地 Whisper.cpp / SenseVoice 等本地 ASR，减少隐私和网络依赖

**采集能力**：
- 全局快捷键、系统托盘、剪贴板、本地文件：Tauri 插件
- 浏览器扩展：Manifest V3 + native messaging 与桌面应用通信
- 本地通用接入：localhost HTTP / 文件夹监听 / CLI

**部署**：
- 当前：本地开发和验证
- 桌面阶段：Tauri 打包为 Windows / macOS / Linux 应用
- 同步或中继能力只有在用户需求明确后再引入后端

### 7.2 项目结构建议

```
/src
  /pages                # 当前 Vite + React 页面
    CapturePage.tsx     # 捕获页
    WikiPage.tsx        # 知识库浏览
    EntityPage.tsx      # 实体详情
    GraphPage.tsx       # 关系图谱
    QueryPage.tsx       # AI 查询
  /components           # UI 组件
    /capture
    /wiki
    /shared
  /lib
    /db                 # Dexie 数据访问层
      schema.ts
      entries.ts
      entities.ts
      relationships.ts
      tasks.ts
    /ai                 # LLM 集成
      capture.ts        # 捕获时的提取提示词
      query.ts          # 查询时的处理流程
      utils.ts          # JSON 防御性解析
    /graph              # 图遍历查询逻辑
      filter.ts         # 按关系过滤
      traverse.ts       # 多跳查询
  /types                # TypeScript 类型
/src-tauri              # 桌面阶段新增：Tauri 壳、系统能力、SQLite/文件 API
```

### 7.3 关键依赖

```json
{
  "dependencies": {
    "react": "^19",
    "react-dom": "^19",
    "vite": "^8",
    "dexie": "^4",
    "dexie-react-hooks": "^4",
    "zustand": "^5",
    "tailwindcss": "^4",
    "lucide-react": "^1",
    "gray-matter": "^4",
    "js-yaml": "^4"
  }
}
```

- 图谱当前采用轻量 SVG + 自实现力导布局；如果后续需要更复杂的物理模拟，再评估 `d3-force`
- `gray-matter` + `js-yaml`：markdown 导出时处理 YAML frontmatter

### 7.4 双轨存储与 Markdown 导出

借鉴 Karpathy LLM Wiki 的核心思路——把数据所有权交还给用户。MyWiki 提供"导出为 markdown 仓库"能力：

**导出结构**：

```
mywiki-export/
├── README.md                # 导出说明 + 数据统计
├── log.md                   # 时间线（所有 entries 按时间倒序）
├── index.md                 # 全部实体的目录
├── people/
│   ├── 虾总.md
│   └── 张晓燕.md
├── projects/
│   ├── 股票监控.md
│   └── 品牌焕新.md
├── events/
│   └── 2025-04-25-周例会.md
├── topics/
│   ├── 竞品分析.md
│   └── AI产品.md
├── tasks/
│   └── pending-tasks.md     # 所有 pending 任务汇总
└── raw/
    └── entries/             # 原始捕获，按日期分目录
```

**每个 markdown 文件的格式**：

```markdown
---
type: person
title: 虾总
scenes: [work]
created: 2025-04-10
updated: 2025-04-28
relations:
  - { type: owner, target: projects/股票监控.md }
  - { type: attendee, target: events/2025-04-25-周例会.md }
sources:
  - raw/entries/2025-04-10-001.md
---

# 虾总

## 基本信息
认识时间：2024 年 9 月

## 待办
- 调通飞书推送（pending, due 本周内）
- 验证手动检测（pending, due 下周）

## 互动记录
...
```

**好处**：
- 用户可以用 Obsidian 直接打开浏览，享受其图谱视图、双向链接等成熟功能
- 用户可以用 git 备份和版本控制
- 用户可以无成本迁出到任何 markdown 工具
- 便于团队场景下的协作（V2）

**实现要点**：
- IndexedDB 是实时数据库（性能好、查询快），markdown 是离线归档（人可读、可迁移）
- 提供"全量导出"按钮，下载为 zip
- V2 阶段可做"实时双向同步"——用户改 markdown 文件，系统识别并更新数据库

---

## 8. 分阶段实施路线

### 阶段 1 — Web MVP 核心闭环（当前阶段）

目标：能完整跑通"捕获 → 结构化 → 查询召回"，产生可用的私人知识库。

必做：
- 数据模型四张表完整实现（含时间戳字段，后续补 `clientId` 同步预留）
- 图遍历 API 基础方法（getNeighbors, getSubgraph, findPaths）
- 捕获页（当前先以文本/粘贴为主，文件/图片继续补齐）
- AI 处理流（实体 + 关系 + 任务一次提取，逐步支持视觉模型读图）
- 捕获时的关联编译（关联已有实体、更新 topic 素材流、后续更新 lastContactAt）
- 全程可编辑界面（保存前 / 保存后皆可改）
- 四种页面类型的基础展示（含每个实体页的局部图谱）
- AI 查询（Query Agent 规划：理解问题 → 读取目录 → 选择页面 → 工具搜索补充 → 实体文档/原文读取 → LLM 表达）
- 待编译回 Wiki 队列（新事实可确认写回，支持去重和状态）
- 全局图谱页与基础图谱洞察
- 时间轴基础（首页"需要关注"区，扫描 overdue tasks 和未来 24h events，后续补强）
- 数据持久化到 IndexedDB（图片文件本地存储或 base64）

不做：
- 平台集成
- 移动端 App
- 多用户和云同步
- 第三方聊天数据库读取
- 云端主数据库
- Markdown 导出（先保留为路线）

验收标准：
- 用户可以一周内每天捕获 5+ 条信息无障碍
- 查询"某人的未完成任务"能精确返回（不再出现归属错误）
- 查询"某事项叫什么/是什么/现在怎么样"能先命中实体，再读取实体文档、任务、关系和来源证据回答
- 查询"某事项的唤醒词/终止词/API key/模型/路径是什么"这类属性问题时，如实体页未编译该字段，能回扫相关 sourceEntries 并返回命中片段
- 查询"数字生命体能否在 Windows 环境运行"这类问法和实体标题不完全一致的问题时，Query Agent 能把问题拆成实体候选 + 运行环境属性 + Windows 证据词
- 原始材料兜底命中后，页面能生成"待编译回 Wiki"确认项，用户确认后写回实体属性或创建关联主题
- 待编译确认项显示中文字段名和准确建议值，例如"来源/基于项目 = OpenMaic 开源项目"，不显示 `derivedFrom = 开源` 这类内部调试表达
- 待编译确认项必须过滤证据和建议值不一致的低质量项，并合并重复项
- 查询"上周做了什么"能按时间精确过滤
- AI 处理时间不超过 8 秒
- 每个实体页的局部图谱能渲染 1 跳邻居
- 应用断网时，除 LLM API 调用外，已编译知识浏览、编辑和图谱可继续使用

### 阶段 2 — 桌面化与低摩擦采集（下一阶段）

目标：从 Web MVP 迁移到本地优先桌面应用，让采集发生在用户真正工作的地方。

- Tauri 桌面壳：主窗口、系统托盘、全局快捷键、轻量捕获浮窗
- 评估 SQLite 作为桌面主存储，或继续 Dexie/IndexedDB 作为过渡
- API key 进入系统 keychain / credential vault
- 全局快捷键浮窗：文字粘贴、录音、拖入文件或截图
- 浏览器扩展：整页收录、片段收录、截图收录，通过 native messaging 与桌面应用通信
- 本地通用数据接入端点：localhost HTTP / 文件夹监听 / CLI，严格 schema 校验，只接收用户主动推送的数据
- 本地 ASR 评估：Whisper.cpp / SenseVoice 等

验收标准：
- 桌面浮窗启动时间 < 200ms
- 通过快捷键和浏览器扩展完成日常采集，不需要频繁切回 MyWiki 主界面
- 所有数据默认留在本地，除 LLM API 外不依赖云端服务

### 阶段 3 — 探索、维护与导出

目标：从结构化存储升级为可探索、自维护的知识库。

- 全局关系图谱页继续补强：缩放、筛选、悬停高亮一跳关系、图谱洞察 dismiss 状态
- 主题页 AI 编译机制（按阈值/时间间隔自动刷新 aiCompiledSummary）
- 知识库健康检查（Lint）+ 周报输出
- Markdown 仓库导出（全量或增量）
- 关系热度提醒（社交场景下的 lastContactAt 检查）
- Schema 用户可定制（高级设置页）

### 阶段 4 — 多端同步（按需触发）

目标：在不破坏 local-first 架构的前提下，让桌面和手机共享同一份个人知识库。只有当桌面核心体验稳定、用户明确需要多端时再启动。

- 每条记录使用 `clientId + updatedAt` 做同步对账
- 可选云盘加密 blob 同步（iCloud / 坚果云 / Dropbox / WebDAV）
- 可选自托管服务或局域网 P2P
- 手机端先做“采集 + 查询 + 只读浏览”，复杂编辑后置
- 冲突解决先用 last-write-wins + 冲突历史，复杂冲突交给用户

### 阶段 5 — 平台集成（按需）

目标：减少手动输入，但所有平台采集都必须遵循“标记触发”原则。

- 飞书自建应用 + 消息回调：@ 机器人或星标触发，需企业授权
- 钉钉自定义机器人 + 群消息 webhook：同样只采集被标记消息
- 邮件中继：用户主动转发邮件到专属地址
- 会议录音转文字：优先本地 ASR，必要时云端
- 微信：保持分享 / 复制粘贴 / 截图路径，不接入个人号 API，不做第三方协议

### 阶段 6 — 智能化与主动性（持续）

目标：从被动工具变成主动伙伴。

- 每日智能简报（昨天发生了什么 / 今天该关注什么）
- 跨项目关联发现（基于图遍历的"你可能错过的连接"）
- 搜索结果在图谱中的可视化高亮
- 观点演变可视化（topic 的 viewHistory 时间线）
- 知识导出（PPT / 报告 / 复盘）
- Markdown 双向同步（用户改 markdown 文件，系统识别并更新数据库）

### 8.5 从单端到多端的演进原则

不要在没有真实需求前提前做多端。阶段 1 和阶段 2 的目标是把“本地桌面知识中枢”打磨稳定。只有当用户明确需要手机采集、跨设备查询或多设备备份时，再启动同步层。

低成本演进的前提：
- 数据已经以本地为权威源，不依赖云端数据库才能工作。
- 每条记录具备 `clientId` 和 `updatedAt`，可以做增量对账。
- UI 通过数据访问层读取数据，不直接绑定某个存储实现。
- LLM 处理结果只是结构化数据，和同步实现解耦。

建议步骤：
1. 先在本地记录 `pendingChanges` 队列。
2. 再实现云盘加密 blob 或自托管同步。
3. 手机端先做采集和只读查询，不急于做完整编辑。
4. 复杂冲突保留历史并交给用户确认，避免模型自动覆盖用户数据。

---

## 9. 隐私与安全

### 9.1 数据归属

MyWiki 是个人工具，所有数据归用户所有：
- MVP 阶段全部本地存储，不使用云端主数据库
- 阶段 4 如启用多端同步，必须端到端加密，云服务商不应能读取内容
- 永不用于任何形式的训练数据

### 9.2 LLM 调用

- 用户内容发送到 MiniMax / DeepSeek / Claude / Gemini 等任何 LLM Provider 时，必须明确告知用户
- API key 不写入前端明文；桌面阶段应存放在系统 keychain / credential vault
- LLM Provider 可插拔，避免产品与单一模型强绑定
- 提供"批量导出全部数据"功能，用户可随时迁出

### 9.3 敏感信息

- 不主动收集敏感字段（身份证号、银行卡号等）
- AI 提取时遇到疑似敏感信息，提示用户确认是否保留

### 9.4 平台集成隐私边界

任何平台集成（飞书、钉钉、邮件等）都必须遵守：
- **标记触发**：只采集用户主动 @ 机器人、星标、转发或点击保存的内容。
- **不做全量监听**：不监听整个群、整个账号、整个收件箱或全部聊天记录。
- **告知数据流**：如果消息会经过飞书、钉钉、邮件服务商或 LLM API，必须在 UI 中说明。
- **他人内容谨慎处理**：群聊或多人对话中包含他人发言时，应提示用户注意 consent 和隐私边界。
- **可关闭可撤销**：所有平台集成都应可关闭；关闭后不影响本地已有数据。

### 9.5 网络访问最小化

- MVP 阶段除 LLM API 外，不发起主动网络请求。
- 不做用户行为埋点，不上传使用统计。
- 错误日志只在用户主动报告问题时询问是否上传。
- 浏览器扩展与桌面应用之间优先走本地 native messaging / IPC，不经云端中转。

### 9.6 第三方聊天记录的明确红线

MyWiki 自身不实现以下能力：
- 不读取微信、QQ、钉钉、飞书等第三方聊天应用的本地数据库。
- 不通过逆向工程、内存读取、第三方协议等方式获取聊天内容。
- 不内置、不分发、不推荐 chatlog / WeChatMsg / PyWxDump 等灰色工具。
- 不在文档或营销中暗示“自动同步聊天记录”是 MyWiki 官方能力。

如用户确有技术能力并愿意自行承担风险，可以通过“本地通用数据接入端点”把自己处理后的结构化 JSON 推入 MyWiki。MyWiki 只做 schema 校验和本地入库，不背书、不推荐、不识别来源是否合法。

官方推荐的合规路径是：飞书/钉钉走平台授权的自建应用或机器人，并且只采集被用户标记的消息；微信保持分享、复制粘贴、截图等用户主动路径。

---

## 10. AI 提示词模板（关键参考）

### 10.1 捕获处理提示词

**纯文本输入**（适用于 source = text/voice/paste）：

```
你是 MyWiki 个人知识库助手。分析下面这段内容，输出 JSON。
不要输出任何 markdown 代码块或额外解释，只输出 JSON 对象本身。

JSON schema：
{
  "primaryEntity": {
    "type": "person | project | event | topic",
    "title": "标题，不超过20字",
    "summary": "2-3句核心摘要",
    "tags": ["2-4个标签"],
    "scenes": ["work | life | social | personal，可多选"]
  },
  "relatedEntities": [
    { "type": "...", "title": "...", "tentative": true }
  ],
  "relationships": [
    { "fromTitle": "实体A名", "toTitle": "实体B名", "type": "owner | participant | attendee | mentions | ..." }
  ],
  "tasks": [
    {
      "description": "任务内容",
      "ownerTitle": "负责人姓名（必须精确）",
      "linkedToTitles": ["关联的事项或互动名"],
      "dueDate": "ISO date 或 描述（如本周内）"
    }
  ]
}

判断要点：
- type 选择：person=关于某人；project=有目标推进的事项；event=会议或具体一次互动；topic=知识或主题积累
- task 的 owner 必须明确，无法判断时填 "uncertain"，让用户来选
- 关系类型严格使用 schema 中的枚举值
- relatedEntities 仅当内容明确提到时才返回，不要推测

内容：
{{user_content}}
```

**图片输入**（适用于 source = image，使用支持视觉的模型）：

API 调用时把图片作为 image content block 传入，然后追加文本 prompt：

```
你看到的是用户上传的图片。请：
1. 先描述图片包含什么（聊天截图 / 白板手写 / 名片 / 文档扫描 / 其他）
2. 提取图片中所有可读的文字内容
3. 基于提取的内容，按下面的 JSON schema 输出结构化结果（同纯文本模板）
4. 在 primaryEntity.summary 开头注明"图片来源：[简短描述]"

不要输出 markdown 代码块，只输出 JSON 对象本身。

[同纯文本 schema...]
```

**文件输入**（PDF、Word 等）：先在前端用相应库（pdf.js、mammoth 等）提取文字，然后走纯文本流程。

### 10.2 查询表达提示词

```
你是 MyWiki 助手。下面是经过精确过滤的数据，用户问了一个问题。
你的任务：把这些数据组织成自然的中文回答。

要求：
1. 直接给结论，不要"根据知识库..."这种废话开头
2. 如果数据中有逾期或风险（如承诺过期），主动提醒
3. 数据为空时不要编造，告知用户没有相关记录
4. 如果有多个可能匹配，列候选并追问一个问题
5. 结尾给 2 个相关追问建议（用方括号包裹，前端会渲染为按钮）

用户问题：{{question}}

精确过滤后的数据（不要再过滤，直接表达）：
{{filtered_data_json}}

回答：
```

---

## 11. Schema 文件 —— 系统的"可定制宪法"

借鉴 Karpathy LLM Wiki 的 CLAUDE.md/AGENTS.md 思路。MyWiki 内置一份 schema 文件，规定 AI 处理捕获和查询时的行为准则。这份 schema 对用户**部分可见、部分可定制**。

### 11.1 默认 schema（系统内置）

包含：
- 四种实体类型的定义和 frontmatter 字段
- 关系类型的完整枚举
- 场景标签的语义说明
- AI 处理时的判断规则（如"task 的 owner 必填，无法判断时填 uncertain"）
- Lint 检查的具体项

### 11.2 用户可定制部分

提供"高级设置"页让用户在不写代码的前提下定制：

- **新增子实体类型**：如把 person 细分出"客户"、"供应商"等子类
- **新增关系类型**：如行业特定的"投资人"、"导师"等关系
- **修改场景标签**：如增加"健康"、"财务"等场景
- **调整提醒间隔**：默认任务提醒、关系维护周期等
- **调整 lint 周期**：每周/每月/手动

### 11.3 开发者可定制部分（V2）

为有技术能力的用户提供：
- 直接编辑 schema.yaml 文件（导入导出）
- 自定义 AI 提示词模板
- 注册自定义 lint 规则

### 11.4 实现建议

- schema 存为单独的配置文件 `/src/lib/config/schema.ts`
- 用户定制部分存到 IndexedDB 的 settings 表，运行时合并默认 schema
- AI 调用时把当前生效的 schema 拼入 system prompt

---

## 12. 给 AI 编程工具的执行建议

如果你正在用这份文档驱动 AI 编程工具开发：

1. **先建立完整的类型系统**（`/src/types`），所有后续代码都基于此
2. **先实现数据访问层**（`/src/lib/db`），CRUD 操作单测覆盖
3. **再实现图遍历层**（`/src/lib/graph`），单测验证过滤准确
4. **最后实现 UI**，UI 只调用前两层的接口，不直接操作数据
5. **先把捕获流闭环跑通**，再做 wiki 浏览，最后做 AI 查询
6. **AI 调用部分独立**（`/src/lib/ai`），便于切换模型或加 mock

每个阶段做完一个验证用例：
- 捕获：扔进一段会议记录，能正确生成 person + project + event + 2-3 个 tasks
- 浏览：能从虾总的人员页跳到他参与的项目页，再跳回来
- 查询：问"虾总有什么没完成的"，只返回 owner=虾总的任务，不污染其他项目
- 时间：当前时间是 2025-04-28，问"上周做了什么"返回 4/21-4/27 的事
- 图谱：打开关系图谱，能看到所有节点并用力导向布局展开
- Lint：手动触发健康检查，能识别孤儿实体和停滞任务

---

## 13. 项目开发原则

在正式进入开发前，MyWiki 项目遵循以下执行原则：

1. **结构简单高效**：结构设计在优先保证功能正确性、性能和可维护性的基础上，尽量保持简单、直接、高效，避免过度抽象、重复封装和冗杂层级。
2. **任务按复杂度分流**：简单、确定性强的任务可直接使用成熟工具或 AI 模型处理；复杂、跨模块、需要审核结果质量的任务，应按职责拆解，尽量交给不同熟悉领域的 agent 或独立工作单元解耦处理。
3. **模块化开发与回滚点**：产品整体设计、功能模块化推进。每个模块完成后必须先通过对应测试和验收，再设置清晰回滚点，然后进入下一个模块开发。

---

## 14. v1.3 待优化技术路线

本路线来自对 Karpathy LLM Wiki 思路、旧版 `D:\llm-wiki\llm_wiki-0.4.4` 项目机制、以及产品负责人复盘的综合讨论。MyWiki 不直接照搬旧项目的文件系统形态，而是把其中成熟机制翻译成当前“实体图谱 + 捕获材料 + 查询 Agent + 待编译队列”的产品结构。

### 14.1 第一优先级：可靠写回 Wiki 的人机协作机制

目标：让“待编译回 Wiki”从临时查询提示升级为长期可维护的 Review / Compile Queue。

必须实现：

1. **持久化待编译队列**：待编译项必须独立存储，包含 `pending / applied / dismissed / superseded` 状态，不依赖查询页面的临时状态。
2. **稳定去重指纹**：同一实体、同一字段、同一建议值只能有一个有效确认项。用户确认过后，同类问题再次查询时不得重复弹出相同建议。
3. **确认后写回实体**：用户点击确认后，系统按白名单字段写回实体属性，同时标记待编译项为 `applied`。
4. **Sweep 自动消解**：查询或摄入后，如果实体属性已经包含某个建议值，应自动把对应 pending 项标记为 `superseded`，避免队列膨胀。
5. **写入白名单**：LLM 或 Query Agent 只能建议写入允许字段，例如 `runtimeEnvironment / wakeWord / stopWord / localPath / models / ownerNote / derivedFrom / openSourceStatus`。未知字段不得直接写回。
6. **证据强绑定**：待编译项必须包含证据 entry、证据片段、证据范围和置信度；证据片段必须能支撑建议值，否则不能生成确认项。
7. **语义字段纠偏**：例如“OpenMaic 是开源的吗？”应写入 `openSourceStatus`，不是 `derivedFrom`；“基于什么开源项目？”才写入 `derivedFrom`。

### 14.2 第二优先级：两步式 AI 摄入

目标：把一次性“读材料并直接生成实体”的提取方式升级为更稳定的两步流程。

推荐流程：

```text
Step 1 Analyze
  - 识别关键实体、概念、关系、任务、事实属性
  - 判断哪些实体可能已存在于 Wiki
  - 标记证据强度、矛盾、不确定项
  - 给出建议创建/更新清单

Step 2 Generate WikiPatch
  - 基于 Step 1 的分析生成结构化补丁
  - 只允许输出白名单 patch 类型
  - 不确定项进入 Review / Compile Queue
```

MyWiki 不使用旧项目的 `FILE blocks` 作为主要写入单元，而使用更贴合当前数据模型的 `WikiPatch blocks`：

```text
CREATE_ENTITY
UPDATE_ENTITY_PROPERTY
CREATE_RELATIONSHIP
CREATE_TASK
REVIEW_REQUIRED
```

所有 patch 都必须经过类型校验、字段白名单校验和证据校验。AI 负责提出建议，代码负责能否落库。

### 14.3 第三优先级：多阶段 Query Agent 检索

目标：查询不再依赖单次关键词抽取，而是让 Query Agent 参与“读目录、选页面、选证据范围”的过程，同时由代码执行确定性过滤。

推荐流水线：

```text
用户问题
→ Query Agent 理解意图
→ 读取知识目录 EntityIndex
→ 选择候选实体页面
→ 精确实体召回
→ CJK bigram / 同义词 / 属性关键词召回
→ 关系图谱 1-2 跳扩展
→ 实体 sourceEntries 扫描
→ 全库原始材料兜底扫描
→ LLM 组织回答
→ 新事实进入待编译回 Wiki 队列
```

其中：

- 中文查询应引入 CJK bigram 和短语保留，减少“数字生命体能否在 Windows 环境运行”这类问题被当成一个长关键词的情况。
- 混合检索时优先使用 RRF（Reciprocal Rank Fusion）按排名融合，而不是直接把不同分数体系加权相加。
- 图谱扩展可参考四信号关联度：直接关系、共同来源、共同邻居、类型亲和度。
- 原始材料兜底不是普通 RAG，而是在 Wiki 编译层不足时临时救场；命中结果应回流为待编译建议。

本轮检索升级执行项：

1. **多种子候选检索**：先用 Query Agent 选择页、短语保留、CJK bigram、同义词和属性关键词得到多个 seed，而不是只锁定一个主实体。
2. **2 跳图谱扩展带衰减**：从 seed 出发扩展 1 跳和 2 跳邻居；1 跳贡献按 0.5 计入，2 跳贡献按 0.25 计入，避免远距离节点稀释结果。扩展排序继续使用四信号关联度。
3. **证据范围合并**：最终读取主实体、Query Agent 选中页面、多种子扩展页面、任务来源、关系 evidence 和 sourceEntries，避免关键事实落在相邻页面时被遗漏。
4. **上下文预算控制**：查询组装材料时不再只用固定数量 `slice`，而按字符预算控制：预留 15% 给回答、5% 给目录/索引、50% 给页面和原始证据，单条证据不超过 pageBudget 的 30%。
5. **结构化事实优先**：对于运行环境、唤醒词、终止词、路径、开源状态等可抽取属性，代码先从完整原始 entry 中抽取硬结论；LLM 只负责表达，不得覆盖为“未找到/无法确认”。
6. **RRF 暂缓**：当前尚未引入向量检索，暂无多个异质排名列表需要融合。RRF 在后续加入向量/embedding 检索时再实现。

### 14.3.1 两步 Prompt 强化细则

旧项目的两步 Prompt 不直接照搬 `FILE blocks`，但应吸收其成熟约束，翻译为 MyWiki 的结构化 `WikiPatch` 输出：

1. **Step 1 Analyze 更完整**：分析阶段必须覆盖关键实体、关键概念、主要论点/发现、证据强度、与现有 Wiki 的连接、矛盾与张力、建议创建/更新项。
2. **显式对照现有目录**：每个关键实体和概念都要判断是否可能已存在，减少重复实体。
3. **强制证据原文片段**：claims、relationships、tasks、property updates 都必须携带可回溯证据。
4. **Step 2 WikiPatch 严格白名单**：只允许 `CREATE_ENTITY / UPDATE_ENTITY_PROPERTY / CREATE_RELATIONSHIP / CREATE_TASK / REVIEW_REQUIRED`，未知动作丢弃。
5. **REVIEW_REQUIRED 白名单选项**：MVP 阶段先统一使用 `Create Page / Update Existing / Skip`，后续可收敛为更少操作；不得让模型发明自定义操作。
6. **深度研究预留字段**：Review 项后续应包含 `searchQueries`，用于一键深度研究；本轮先在 Prompt 中要求模型生成，数据结构后续扩展。
7. **安全边界**：MyWiki 当前不写任意文件路径；后续若导出或导入 markdown，需要加入路径白名单，禁止绝对路径、`..`、控制字符和非 wiki 根目录写入。

### 14.4 第四优先级：图谱洞察、Lint 与导出

目标：让关系图谱从“能看见关系”升级为“主动发现问题和机会”。

后续能力：

1. **关系网络动效**：采用 force-directed 图谱，节点可拖动、悬停高亮一跳关系，支持按实体类型、场景和时间筛选。
2. **图谱洞察**：识别孤立实体、稀疏社区、桥接节点、跨主题意外连接。
3. **Lint 健康检查**：识别孤儿实体、无来源实体、断裂关系、重复实体、停滞任务、待编译堆积。
4. **Save-to-Wiki 闭环**：查询中的好答案可以保存回 Wiki，并再次触发编译。
5. **Markdown / Obsidian 导出**：结构化数据可导出为标准 markdown 仓库，但 MVP 内部仍以 IndexedDB 结构化存储为主。

本轮第四优先级落地状态（2026-05-02）：

1. **全局图谱页**：已新增 `/graph` 入口，使用离线 force-directed 布局展示全库实体和关系，保留实体类型颜色、节点大小和重排操作，暂不引入重依赖。
2. **图谱交互补强**：已支持轻量 3D 旋转、节点拖拽、缩放、按实体类型筛选、按场景筛选、按更新时间筛选、悬停高亮一跳关系。
3. **图谱洞察纯函数**：已新增 `buildGraphOverview`，基于实体和关系识别桥接节点、知识空白、高密节点和跨类型连接；规则层可测试、可解释。
4. **图谱洞察处理状态**：已新增 `graphInsightDismissals`，用户可隐藏已处理洞察，避免同一条洞察反复干扰。
5. **Lint 健康检查扩展**：已覆盖孤儿实体、无来源实体、断裂关系、长期任务、待编译项、待编译堆积、疑似重复实体和简单属性矛盾。
6. **Save-to-Wiki 闭环**：查询答案可保存为 `query-insight` topic，并用 `about` 关系连回命中的实体；相同问题复用原有查询洞察主题。保存后会自动加入摄入队列再次编译，队列用内容 hash 防止 active 重复排队。
7. **Markdown / Obsidian 导出**：知识库页已提供全量 Markdown zip 导出，包含 `README.md`、`index.md`、实体页、任务页和原始捕获页；导出路径经过白名单安全校验。

图谱视觉修订：

- 关系图谱采用浅色系、Obsidian 风格的知识工作区表达：浅背景、细网格、低干扰灰色连线、按类型着色的清晰节点。
- 取消无意义的光影、扫描线、粒子流、脉冲闪烁等装饰动效；只保留必要的悬停反馈、重排和后续真实交互动效。
- 图谱交互采用轻量 3D 投影视角：拖动画布可自由旋转观察关系结构，节点可直接拖拽调整位置。
- 节点动效使用类似“小气泡在水中轻微漂浮”的低幅随机运动，增强灵动感，但不得影响阅读和定位。
- 图谱视觉优先服务“可读、可探索、可判断关系”，而不是仪表盘式炫技。

仍保留到后续阶段的边界：

- RRF 暂缓，等引入向量/embedding 检索后再实现。
- LLM 语义级 Lint 暂缓，目前只做规则级健康检查，避免把整个 Wiki 一次性塞给模型。
- Markdown 导入、增量导出和 zip 内部更完整的 Obsidian 元数据后续再做。
- 图谱洞察可继续接入 LLM 表达和“深度研究”按钮，但当前先保持规则层稳定。

### 14.5 不盲抄旧项目的部分

旧项目的机制值得借鉴，但以下部分不应直接照搬：

1. `.llm-wiki/` 状态目录不应污染用户资料目录；后续桌面版应用状态应优先放系统 app data。
2. 单文件巨型 ingest 模块需要按 prompt、parser、validator、orchestrator 拆分。
3. Lint 的语义检查不应一次性把整个 wiki 塞给 LLM；大库需要分批和 map-reduce。
4. Real LLM 测试只用于关键路径或发布前，日常测试优先 mock。
5. 摄入队列 MVP 先串行保证稳定，有真实速度压力后再考虑有界并发。

---

## 15. 反模式（明确不要这样做）

❌ 把所有 entries 平铺成一段字符串扔给 LLM 让它自己过滤
❌ 查询命中实体后只返回候选列表，不继续读取实体文档、关系子图和来源证据
❌ 实体页答不出具体属性时直接说没找到，而不回扫该实体关联的原始材料
❌ 只靠手写关键词正则理解用户问题，不让 Query Agent 读取目录和选择相关页面
❌ "待编译回 Wiki"只有一句提示文案，没有可触发、可确认、可写回的功能
❌ 待编译回 Wiki 只存在于页面 state，刷新或重复查询后无法知道哪些已确认
❌ 用户确认过的同一实体、同一字段、同一值再次重复弹出确认项
❌ 把“是否开源”误写成“来源/基于项目”，混淆事实属性和来源关系
❌ LLM 直接决定任意字段写回，不经过字段白名单和证据校验
❌ 待编译确认项直接暴露内部字段名，或把"开源"这类泛词当成完整属性值
❌ 证据片段不包含建议值或关系触发信号，仍允许用户确认写回
❌ 同一个实体同一个字段同一个值重复生成多张待编译卡片
❌ 用 localStorage 存数据（容量小、性能差）
❌ 任务的 owner 用字符串而不是 entity id（无法稳定关联）
❌ 关系信息只存在实体的 summary 文字里（无法图遍历）
❌ 把工作和生活做成两个独立系统（违反"统一记忆层"原则）
❌ AI 处理后立即保存，不给用户编辑机会（错误率会累积）
❌ AI 处理结果只允许保存前编辑、保存后不可改（违反"AI 是建议"原则）
❌ 编辑必须通过弹窗或专门的"编辑模式"（必须所见即所得）
❌ 用复杂的 UI 库（MUI / Antd）覆盖整个界面（设计可控性差）
❌ 在前端直接暴露任何 LLM API key（桌面阶段应进系统凭据库，Web 生产环境应走安全代理）
❌ 时间字段用字符串而不是时间戳（无法做时间范围查询）
❌ 关系图谱用静态布局（必须 force-directed 才有探索价值）
❌ 重复人员实体（同一个人因为名字略不同建多张档案，违反去重原则）
❌ AI 仅在捕获时提取，不更新已有 topic 的 summary（违反"编译"原则）
❌ 捕获后所有数据只能在系统里看，不能导出（违反"数据由用户拥有"原则）
❌ 数据只能通过云端读写，断网后应用不可用（违反 local-first）
❌ MVP 阶段默认上云端主数据库（应先本地验证，再按需加同步层）
❌ 数据记录长期不带 `clientId` 和 `updatedAt`（未来同步和增量导出会很痛）
❌ 期望用户每次采集都切回 MyWiki 主界面（违反采集摩擦最小）
❌ 飞书、钉钉、邮件等平台集成做成全量监听，而不是标记触发
❌ 接入微信个人号 API 或第三方协议（个人号无开放 API，且有封号和合规风险）
❌ 平台采集时不告知用户内容会经过对应平台服务器或 LLM API
❌ MyWiki 自身实现读取微信、钉钉、飞书等第三方应用本地数据库
❌ 通过逆向工程、内存读取等方式获取第三方应用数据
❌ 内置或推荐 chatlog / WeChatMsg / PyWxDump 等灰色工具
❌ 把本地通用数据接入端点暴露到外网（必须只监听 localhost）
❌ 通用数据接入端点不做 schema 校验，任由脏数据污染知识库

---

## 文档版本

v1.2 · 2025-04-28
基于产品负责人与 AI 共创讨论，并参考 Karpathy LLM Wiki 模式。

变更记录：
- v1.2 补充：新增查询加速 MVP，包括实体 compiledProfile、轻量 Wiki Index、查询缓存、查询洞察命中，以及查询页先快答再后台优化的两段式体验
- v1.2 补充：新增层级结构建模路线，实体可选 `categories` 保存“父实体 -> 业态/版块 -> 项目/服务/机构”结构；摄入层提取 categories，查询层优先用确定性 `drillDown(parent, category)` 下钻，缺失时才原文扫描并进入待编译回 Wiki，避免把上一级业态列表或历史查询洞察误当具体项目清单
- v1.2 补充：Raw Inbox 升级为 Raw Entry First，文件导入后立即生成未编译原始 Entry；长文本摄入改为分块 Markdown 摘要再 WikiPatch，避免长 PDF 一次性严格 JSON 崩溃
- v1.2 补充：新增 Raw Inbox 异步采集/批量编译机制，明确文件先原样收件、hash 去重、状态队列、进度展示和稍后编译，避免用户捕获时间与 LLM 处理时间耦合
- v1.2 补充：除第三优先级 RRF 外，按优先级补齐 Review 队列、摄入队列与缓存、DeepSeek 两步摄入兜底、图谱筛选/缩放/一跳高亮/dismiss、Lint 扩展、Save-to-Wiki 再编译队列和 Markdown/Obsidian zip 导出
- v1.2 补充：吸收 v1.3 新思考，新增 Local-First 原则、同步预留字段、七层采集路线、Tauri 桌面化方向、分阶段路线重组、平台集成隐私边界、第三方聊天记录红线和网络访问最小化原则
- v1.2 补充：第四优先级开始落地全局动态图谱页、图谱洞察纯函数和 Save-to-Wiki 最小闭环；明确已完成项与后续拖动、缩放、筛选、Markdown 导出边界
- v1.2 补充：新增 v1.3 待优化技术路线，明确持久化待编译队列、两步式 AI 摄入、多阶段 Query Agent、图谱洞察/Lint/导出，以及不盲抄旧项目的边界
- v1.2 补充：新增待编译回 Wiki 的规则校验、语义校验规划和去重队列规范，防止证据错配和重复写回建议
- v1.2 补充：优化待编译回 Wiki 确认项规范，要求中文字段名、准确建议值、证据片段和确认写回动作，避免暴露内部字段表达
- v1.2 补充：新增 Query Agent 查询规划层，明确 LLM 负责读目录和生成结构化查询计划，代码负责实际过滤、遍历和证据读取；要求待编译回 Wiki 从提示升级为可确认写回功能
- v1.2 补充：新增 Raw Evidence Fallback 原始材料兜底扫描机制，明确实体文档不足时先扫相关 sourceEntries，再必要时扫全库 entries，并将命中信息提示编译回 Wiki
- v1.2 补充：新增"渐进式 Wiki 阅读式查询"方向，明确查询优先读取知识目录、实体文档、关系子图和来源证据；补充查询日志与好答案沉淀机制；更新 MVP 查询验收标准
- v1.2：补充时间维度（5.5 节）、关系图谱可视化（5.6 节）、知识库 Lint 健康检查（5.7 节）；强化主题页 AI 编译机制（4.3、4.6 节）；新增 Schema 文件可定制能力（第 11 章）；新增 Markdown 导出与双轨存储（7.4 节）；新增图遍历 API（3.6 节）
- v1.1：项目名调整为 MyWiki；明确文件输入支持图片（含视觉模型处理流程）；强化"AI 结果全程可编辑"原则
- v1.0：初版
