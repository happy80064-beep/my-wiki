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

### 3.5 数据存储

**MVP 阶段**：浏览器 IndexedDB（推荐 Dexie.js 库），所有数据本地存储。
**演进阶段**：可迁移到 Supabase / Pocketbase 等支持本地+云同步的方案。

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

**用户操作**：
1. 进入捕获页，看到一个大文本框（默认聚焦）
2. 三种输入入口：
   - 粘贴文字（直接在文本框输入或粘贴）
   - 点击麦克风录音（实时转写并填入文本框）
   - 拖入文件（支持图片 jpg/png/webp、PDF、Word、纯文本）
3. 点击"AI 整理"按钮
4. AI 处理完毕，展示结构化结果：主实体、关联实体、关系、任务全部列出
5. **用户全程可编辑修改**任何字段（详见 4.1.1）
6. 点"保存到知识库"，所有数据写入存储

**图片处理特别说明**：
- 拖入或上传图片后，调用支持视觉的 LLM（Claude Sonnet 4 等）直接解析图片内容
- 图片用于：聊天截图（提取对话）、白板照片（识别手写笔记）、名片（识别人员信息）、文档扫描（OCR）等
- 原始图片保留在 `entries.fileMetadata.url`，可随时回查
- AI 把视觉内容转为文字后，存入 `entries.content`，作为后续提取的依据

**AI 处理逻辑**：
- 调用 LLM（推荐 Claude Sonnet 4 及以上版本，支持视觉）
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

**前端**：
- Next.js 14+ (App Router) 或 Vite + React
- TypeScript 严格模式
- Tailwind CSS（不用 UI 框架，保持设计可控）
- 状态管理：Zustand（轻量）或原生 useReducer

**数据存储**：
- 本地：Dexie.js (IndexedDB 包装)
- 云端备份（V2）：Supabase

**AI 调用**：
- Claude API（推荐 claude-sonnet-4 或更新版本）
- 客户端直连（开发阶段）+ 后端代理（生产，保护 API key）
- 流式响应（提升感知速度）

**语音输入**：
- 浏览器 Web Speech API（中文支持 zh-CN）
- 备选 Whisper API（更准但需后端）

**部署**：
- Vercel（前端）
- Supabase（V2 后端）
- 域名 + Cloudflare（可选）

### 7.2 项目结构建议

```
/src
  /app                  # Next.js 路由
    /capture            # 捕获页
    /wiki               # 知识库浏览
      /[type]
        /[id]           # 实体详情
    /query              # AI 对话查询
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
```

### 7.3 关键依赖

```json
{
  "dependencies": {
    "next": "^14",
    "react": "^18",
    "dexie": "^4",
    "dexie-react-hooks": "^1",
    "@anthropic-ai/sdk": "^0.30",
    "zustand": "^4",
    "tailwindcss": "^3",
    "uuid": "^9",
    "date-fns": "^3",
    "d3-force": "^3",
    "gray-matter": "^4",
    "js-yaml": "^4"
  }
}
```

- `d3-force`：关系图谱的力导向布局
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

### 阶段 1 — MVP 核心闭环（4-6 周）

目标：能完整跑通"捕获 → 结构化 → 查询召回"，产生可用的私人知识库。

必做：
- 数据模型四张表完整实现（含时间戳字段）
- 图遍历 API 基础方法（getNeighbors, getSubgraph）
- 捕获页（文字 + 语音 + 文件/图片三种输入）
- AI 处理流（实体 + 关系 + 任务一次提取，支持视觉模型读图）
- 捕获时的关联编译（关联已有实体、更新 topic 素材流、更新 lastContactAt）
- 全程可编辑界面（保存前 / 保存后皆可改）
- 四种页面类型的基础展示（含每个实体页的局部图谱）
- AI 查询（六种查询类型 + 图遍历过滤 + LLM 表达）
- 时间轴基础（首页"需要关注"区，扫描 overdue tasks 和未来 24h events）
- 数据持久化到 IndexedDB（图片文件本地存储或 base64）

不做：
- 平台集成
- 移动端 App
- 多用户和云同步
- 全局图谱可视化（MVP 仅做局部图）
- Lint 健康检查
- Markdown 导出

验收标准：
- 用户可以一周内每天捕获 5+ 条信息无障碍
- 查询"某人的未完成任务"能精确返回（不再出现归属错误）
- 查询"上周做了什么"能按时间精确过滤
- AI 处理时间不超过 8 秒
- 每个实体页的局部图谱能渲染 1 跳邻居

### 阶段 2 — 探索与维护（4-8 周）

目标：从结构化存储升级为可探索、自维护的知识库。

- 全局关系图谱页（force-directed 布局，支持过滤和缩放）
- 主题页 AI 编译机制（按阈值/时间间隔自动刷新 aiCompiledSummary）
- 知识库健康检查（Lint）+ 周报输出
- Markdown 仓库导出（全量或增量）
- 关系热度提醒（社交场景下的 lastContactAt 检查）
- Schema 用户可定制（高级设置页）

### 阶段 3 — 自动化与减负（4-8 周）

目标：减少手动输入，让捕获发生在后台。

- Chrome 扩展：一键收录任意网页
- 邮件接入（Gmail / Outlook）：AI 摘要后入库
- 飞书 / 钉钉 webhook：标记的消息自动入库
- 会议录音转文字（Whisper）+ 自动提炼

### 阶段 4 — 智能化与主动性（持续）

目标：从被动工具变成主动伙伴。

- 每日智能简报（昨天发生了什么 / 今天该关注什么）
- 跨项目关联发现（基于图遍历的"你可能错过的连接"）
- 搜索结果在图谱中的可视化高亮
- 观点演变可视化（topic 的 viewHistory 时间线）
- 知识导出（PPT / 报告 / 复盘）
- 移动端 App
- Markdown 双向同步（用户改 markdown 文件，系统识别并更新数据库）

---

## 9. 隐私与安全

### 9.1 数据归属

MyWiki 是个人工具，所有数据归用户所有：
- MVP 阶段全部本地存储，不上云
- V2 阶段如启用云同步，端到端加密
- 永不用于任何形式的训练数据

### 9.2 LLM 调用

- 用户内容发送到 Claude API 时，明确告知用户
- 不在本地缓存 API key（生产用后端代理）
- 提供"批量导出全部数据"功能，用户可随时迁出

### 9.3 敏感信息

- 不主动收集敏感字段（身份证号、银行卡号等）
- AI 提取时遇到疑似敏感信息，提示用户确认是否保留

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

## 14. 反模式（明确不要这样做）

❌ 把所有 entries 平铺成一段字符串扔给 LLM 让它自己过滤
❌ 用 localStorage 存数据（容量小、性能差）
❌ 任务的 owner 用字符串而不是 entity id（无法稳定关联）
❌ 关系信息只存在实体的 summary 文字里（无法图遍历）
❌ 把工作和生活做成两个独立系统（违反"统一记忆层"原则）
❌ AI 处理后立即保存，不给用户编辑机会（错误率会累积）
❌ AI 处理结果只允许保存前编辑、保存后不可改（违反"AI 是建议"原则）
❌ 编辑必须通过弹窗或专门的"编辑模式"（必须所见即所得）
❌ 用复杂的 UI 库（MUI / Antd）覆盖整个界面（设计可控性差）
❌ 在前端直接暴露 Claude API key（生产必须后端代理）
❌ 时间字段用字符串而不是时间戳（无法做时间范围查询）
❌ 关系图谱用静态布局（必须 force-directed 才有探索价值）
❌ 重复人员实体（同一个人因为名字略不同建多张档案，违反去重原则）
❌ AI 仅在捕获时提取，不更新已有 topic 的 summary（违反"编译"原则）
❌ 捕获后所有数据只能在系统里看，不能导出（违反"数据由用户拥有"原则）

---

## 文档版本

v1.2 · 2025-04-28
基于产品负责人与 AI 共创讨论，并参考 Karpathy LLM Wiki 模式。

变更记录：
- v1.2：补充时间维度（5.5 节）、关系图谱可视化（5.6 节）、知识库 Lint 健康检查（5.7 节）；强化主题页 AI 编译机制（4.3、4.6 节）；新增 Schema 文件可定制能力（第 11 章）；新增 Markdown 导出与双轨存储（7.4 节）；新增图遍历 API（3.6 节）
- v1.1：项目名调整为 MyWiki；明确文件输入支持图片（含视觉模型处理流程）；强化"AI 结果全程可编辑"原则
- v1.0：初版
