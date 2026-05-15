import { joinWorkspacePath, type WorkspaceLayout } from './paths';

export type ProjectTemplateId = 'research' | 'reading' | 'personal-growth' | 'business' | 'general';
export type ProjectOutputLanguage = 'zh-CN' | 'en-US';

export type ProjectTemplate = {
  id: ProjectTemplateId;
  name: string;
  icon: string;
  description: string;
  wikiDirectories: string[];
  purpose: string;
  schema: string;
};

type SchemaTypeRow = {
  type: string;
  directory: string;
  purpose: string;
};

type SchemaOptions = {
  title: string;
  extraTypes?: SchemaTypeRow[];
  extraNaming?: string[];
  extraFrontmatter?: string;
  extraCrossReferences?: string[];
  conventionsTitle?: string;
  conventions?: string[];
};

const baseTypes: SchemaTypeRow[] = [
  { type: 'entity', directory: 'wiki/entities/', purpose: '人物、机构、产品、工具、数据集等具名对象' },
  { type: 'concept', directory: 'wiki/concepts/', purpose: '方法、机制、模型、框架、现象和核心概念' },
  { type: 'project', directory: 'wiki/projects/', purpose: '项目、业务、课题或长期事项的结构化档案' },
  { type: 'source', directory: 'wiki/sources/', purpose: '论文、文档、网页、访谈、文件等来源说明' },
  { type: 'query', directory: 'wiki/queries/', purpose: '仍在调查中的问题、假设和追问' },
  { type: 'comparison', directory: 'wiki/comparisons/', purpose: '多个对象、方案或概念的并列比较' },
  { type: 'synthesis', directory: 'wiki/synthesis/', purpose: '跨来源、跨主题的综合结论和阶段性判断' },
  { type: 'overview', directory: 'wiki/overview.md', purpose: '项目级总览，一般每个工作区一页' },
  { type: 'decision', directory: 'wiki/decisions/', purpose: '重要选择、原因、后果和状态' },
  { type: 'meeting', directory: 'wiki/meetings/', purpose: '会议纪要、议程、行动项和后续跟踪' },
  { type: 'stakeholder', directory: 'wiki/stakeholders/', purpose: '相关人员、团队、组织及其诉求/职责' },
];

const baseNaming = [
  'Files: 使用 kebab-case.md，例如 project-alpha.md。',
  'Entities: 尽量使用官方名称或通用名称，例如 openai.md、gpt-4.md。',
  'Concepts: 使用描述性名词短语，例如 retrieval-augmented-generation.md。',
  'Sources: 推荐 author-year-slug.md 或 source-title.md，例如 wei-2022-cot.md。',
  'Queries: 用问题或调查目标做 slug，例如 does-scale-improve-reasoning.md。',
  'Comparisons: 用 a-vs-b.md 或 topic-comparison.md。',
  'Synthesis: 用阶段性主题或结论做 slug，例如 q1-market-synthesis.md。',
];

function buildFrontmatter(pageTypes: SchemaTypeRow[]) {
  return `所有 wiki 页面必须包含 YAML frontmatter:

\`\`\`yaml
---
type: ${pageTypes.map((row) => row.type).join(' | ')}
title: Human-readable title
tags: []
related: []
sources: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
\`\`\`

Source pages also include:

\`\`\`yaml
authors: []
year: YYYY
url: ""
venue: ""
raw_path: "raw/sources/source-file.ext"
\`\`\`

Project pages also include:

\`\`\`yaml
status: planned | active | paused | completed | cancelled
owner: ""
start_date: YYYY-MM-DD
target_date: YYYY-MM-DD
\`\`\`

Decision pages also include:

\`\`\`yaml
status: proposed | accepted | deprecated | superseded
deciders: []
date: YYYY-MM-DD
supersedes: ""
\`\`\`

Meeting pages also include:

\`\`\`yaml
date: YYYY-MM-DD
attendees: []
action_items: []
\`\`\``;
}

const baseCrossReferences = [
  '使用 [[page-slug]] 或 [[page-slug|显示文本]] 在页面之间建立链接。',
  '每个 entity、concept、project、source 都应出现在 wiki/index.md 的对应分组里。',
  'query 页面要链接它依赖的 source、entity、concept 和 synthesis。',
  'synthesis 页面要通过 related: 或正文引用列出贡献来源，避免凭空综合。',
  'source 页面优先链接 raw/sources/ 下的原始文件，并在正文说明来源可靠性。',
];

const contradictionRules = [
  '在相关 entity/concept/project 页面明确记录冲突点和冲突来源。',
  '创建或更新 query 页面跟踪未决问题。',
  '把相互冲突的来源都放入 sources/related，不要只保留支持结论的一侧。',
  '证据足够时，用 synthesis 页面沉淀当前判断，并标注仍不确定的部分。',
];

export const projectTemplates: ProjectTemplate[] = [
  {
    id: 'research',
    name: '研究',
    icon: '🔬',
    description: '深度研究、论文、假设、方法与证据跟踪。',
    wikiDirectories: ['wiki/methodology', 'wiki/findings', 'wiki/thesis'],
    purpose: [
      '## 研究问题',
      '',
      '> 写清这个项目试图回答的核心问题，尽量具体、可验证。',
      '',
      '## 当前假设 / 工作论点',
      '',
      '> 记录当前最有可能成立的解释。随着证据积累持续更新。',
      '',
      '## 背景与动机',
      '',
      '- 为什么这个问题值得研究？',
      '- 已有资料覆盖到哪里，缺口在哪里？',
      '',
      '## 子问题',
      '',
      '1. ',
      '2. ',
      '3. ',
      '',
      '## 范围',
      '',
      '**In scope:**',
      '- ',
      '',
      '**Out of scope:**',
      '- ',
      '',
      '## 方法',
      '',
      '- ',
      '',
      '## 成功标准',
      '',
      '- ',
    ].join('\n'),
    schema: buildSchema({
      title: 'Research Deep-Dive',
      extraTypes: [
        { type: 'thesis', directory: 'wiki/thesis/', purpose: '工作假设、论点演进和证据状态' },
        { type: 'methodology', directory: 'wiki/methodology/', purpose: '研究方法、实验协议、评估设计' },
        { type: 'finding', directory: 'wiki/findings/', purpose: '单个经验发现、观察或证据片段' },
      ],
      extraNaming: [
        'Theses: 使用假设本身做 slug，例如 scaling-improves-reasoning.md。',
        'Methodologies: 使用方法名，例如 systematic-review.md、ablation-study.md。',
        'Findings: 使用发现描述，例如 larger-models-better-few-shot.md。',
      ],
      extraFrontmatter: `Thesis pages also include:

\`\`\`yaml
confidence: low | medium | high
status: speculative | supported | refuted | settled
\`\`\`

Finding pages also include:

\`\`\`yaml
source: "[[source-slug]]"
confidence: low | medium | high
replicated: true | false | null
\`\`\``,
      extraCrossReferences: [
        'finding 页面必须通过 source: 指回具体来源。',
        'thesis 页面使用 related: 连接支持和反驳它的 finding。',
        'methodology 页面被使用该方法的 finding 或 synthesis 引用。',
      ],
      conventionsTitle: 'Research-Specific Conventions',
      conventions: [
        'thesis 页面是活文档，证据变化时必须更新状态和置信度。',
        'finding 要区分直接证据、作者解释和你自己的推断。',
        'methodology 写清为什么这样研究，而不只是步骤。',
        '不要把单个来源的结论直接升级为 synthesis。',
      ],
    }),
  },
  {
    id: 'reading',
    name: '阅读',
    icon: '📚',
    description: '跟踪书籍、人物、主题、情节线和章节笔记。',
    wikiDirectories: ['wiki/books', 'wiki/characters', 'wiki/themes', 'wiki/plot-threads', 'wiki/chapters'],
    purpose: [
      '## 书籍信息',
      '',
      '**书名:**',
      '**作者:**',
      '**年份:**',
      '**类型:**',
      '',
      '## 阅读目标',
      '',
      '- ',
      '',
      '## 重点追踪主题',
      '',
      '1. ',
      '2. ',
      '3. ',
      '',
      '## 带着的问题',
      '',
      '1. ',
      '2. ',
      '',
      '## 阅读进度',
      '',
      '**开始日期:**',
      '**目标完成:**',
      '**当前章节:**',
      '',
      '## 最终收获',
      '',
      '> 完成后补充。',
    ].join('\n'),
    schema: buildSchema({
      title: 'Reading',
      extraTypes: [
        { type: 'book', directory: 'wiki/books/', purpose: '书籍或长文本的总档案' },
        { type: 'character', directory: 'wiki/characters/', purpose: '书中的人物、角色、叙述者或组织' },
        { type: 'theme', directory: 'wiki/themes/', purpose: '反复出现的主题、意象和论点' },
        { type: 'plot-thread', directory: 'wiki/plot-threads/', purpose: '故事线、论证线或叙事弧' },
        { type: 'chapter', directory: 'wiki/chapters/', purpose: '逐章笔记、摘要和页码线索' },
      ],
      extraNaming: [
        'Books: 使用书名 slug，例如 the-design-of-everyday-things.md。',
        'Characters: 使用角色名，例如 elizabeth-bennet.md。',
        'Themes: 使用主题短语，例如 social-class-mobility.md。',
        'Plot threads: 使用弧线描述，例如 darcys-redemption-arc.md。',
        'Chapters: 使用 ch-NN-slug.md，例如 ch-01-opening-scene.md。',
      ],
      extraFrontmatter: `Character pages also include:

\`\`\`yaml
first_appearance: "Ch. N"
role: protagonist | antagonist | supporting | minor
\`\`\`

Chapter pages also include:

\`\`\`yaml
chapter: N
pages: "1-24"
\`\`\``,
      extraCrossReferences: [
        'chapter 页面通过 related: 关联出现的人物、主题和情节线。',
        'theme 页面记录主题在不同章节中的发展，而不是只给定义。',
        'plot-thread 页面列出推进该线索的章节。',
      ],
      conventionsTitle: 'Reading-Specific Conventions',
      conventions: [
        '章节页尽量在阅读后立刻写，保留新鲜反应。',
        '区分剧情摘要、文本证据和个人解释。',
        '重要引用必须记录页码或章节位置。',
        '未解决的线索用 status: open 标注。',
      ],
    }),
  },
  {
    id: 'personal-growth',
    name: '个人成长',
    icon: '🌱',
    description: '记录目标、习惯、复盘、日记和长期成长线索。',
    wikiDirectories: ['wiki/goals', 'wiki/habits', 'wiki/reflections', 'wiki/journal'],
    purpose: [
      '## 关注领域',
      '',
      '1. ',
      '2. ',
      '3. ',
      '',
      '## 动机',
      '',
      '> 为什么现在开始维护这个 Wiki？',
      '',
      '## 当前目标',
      '',
      '- [ ] ',
      '- [ ] ',
      '- [ ] ',
      '',
      '## 活跃习惯',
      '',
      '- ',
      '- ',
      '',
      '## 复盘节奏',
      '',
      '**每日记录:**',
      '**每周复盘:**',
      '**每月复盘:**',
      '**季度复盘:**',
      '',
      '## 年度主题',
      '',
      '> ',
    ].join('\n'),
    schema: buildSchema({
      title: 'Personal Growth',
      extraTypes: [
        { type: 'goal', directory: 'wiki/goals/', purpose: '正在推进的具体结果' },
        { type: 'habit', directory: 'wiki/habits/', purpose: '可重复执行和跟踪的行为' },
        { type: 'reflection', directory: 'wiki/reflections/', purpose: '周期复盘、经验教训和模式识别' },
        { type: 'journal', directory: 'wiki/journal/', purpose: '自由日记、当天记录或会话记录' },
      ],
      extraNaming: [
        'Goals: 使用结果目标做 slug，例如 run-a-marathon.md。',
        'Habits: 使用行为名称，例如 daily-meditation.md。',
        'Reflections: 使用周期+日期，例如 weekly-2026-05.md。',
        'Journal: 使用日期，例如 2026-05-11.md。',
      ],
      extraFrontmatter: `Goal pages also include:

\`\`\`yaml
target_date: YYYY-MM-DD
status: active | paused | achieved | abandoned
progress: 0-100
\`\`\`

Habit pages also include:

\`\`\`yaml
frequency: daily | weekly | monthly
streak: N
status: active | paused | dropped
\`\`\`

Reflection pages also include:

\`\`\`yaml
period: weekly | monthly | quarterly | annual
\`\`\``,
      extraCrossReferences: [
        'reflection 页面引用本周期复盘的 goal 和 habit。',
        'goal 页面通过 related: 连接支撑它的 habit。',
        'journal 页面可以用 [[slug]] 直接引用目标、习惯和复盘。',
      ],
      conventionsTitle: 'Personal Growth Conventions',
      conventions: [
        '日记和复盘要诚实，这个 Wiki 首先服务自己。',
        '定期更新 goal 的 progress；过期状态比没有状态更误导。',
        '区分结果目标和过程目标。',
        '复盘习惯时写为什么成功或失败，不只写是否完成。',
      ],
    }),
  },
  {
    id: 'business',
    name: '业务',
    icon: '💼',
    description: '管理会议、项目、决策、客户和团队上下文。',
    wikiDirectories: ['wiki/projects', 'wiki/stakeholders', 'wiki/decisions', 'wiki/meetings'],
    purpose: [
      '## 业务上下文',
      '',
      '**组织 / 团队:**',
      '**业务领域:**',
      '**覆盖时间:**',
      '',
      '## 目标',
      '',
      '1. ',
      '2. ',
      '3. ',
      '',
      '## 关键项目',
      '',
      '- ',
      '- ',
      '',
      '## 关键干系人',
      '',
      '- ',
      '- ',
      '',
      '## 待决事项',
      '',
      '- ',
      '',
      '## 指标 / 成功标准',
      '',
      '- ',
      '',
      '## 约束和风险',
      '',
      '- ',
      '',
      '## 复盘节奏',
      '',
      '**周会:**',
      '**月度状态:**',
      '**季度复盘:**',
    ].join('\n'),
    schema: buildSchema({
      title: 'Business / Team',
      extraNaming: [
        'Meetings: 使用 YYYY-MM-DD-slug.md，例如 2026-05-11-weekly-sync.md。',
        'Decisions: 使用 NNN-slug.md，例如 001-adopt-new-pricing.md。',
        'Projects: 使用项目简称或业务名称，例如 health-park-phase-3.md。',
        'Stakeholders: 使用人名、团队名或组织名，例如 platform-team.md。',
      ],
      extraCrossReferences: [
        'meeting 页面必须通过 attendees: 和 [[stakeholder-slug]] 关联参会人。',
        'decision 页面链接产生该决策的会议、来源和项目。',
        'project 页面通过 related: 连接关键 decision、stakeholder、source。',
        'stakeholder 页面列出其参与的项目、诉求、风险和职责边界。',
      ],
      conventionsTitle: 'Business-Specific Conventions',
      conventions: [
        '会议纪要最好在 24 小时内写完。',
        '行动项必须有负责人、截止日期和可验收结果。',
        '决策页记录背景、选择、后果和替代方案，不只写结论。',
        '被废弃的决策必须链接到取代它的新决策。',
        '项目完成后补充复盘。',
      ],
    }),
  },
  {
    id: 'general',
    name: '通用',
    icon: '📄',
    description: '最小配置，适合任何个人知识库起步。',
    wikiDirectories: [],
    purpose: [
      '## 目标',
      '',
      '> 你想理解、沉淀或构建什么？',
      '',
      '## 关键问题',
      '',
      '1. ',
      '2. ',
      '3. ',
      '',
      '## 范围',
      '',
      '**In scope:**',
      '- ',
      '',
      '**Out of scope:**',
      '- ',
      '',
      '## 当前判断',
      '',
      '> TBD',
    ].join('\n'),
    schema: buildSchema({
      title: 'General',
      conventionsTitle: 'General Conventions',
      conventions: [
        '按需使用 entity、concept、source、query、comparison、synthesis 页面。',
        '在模式稳定前避免过度建模，先把事实、来源和问题记录清楚。',
        '回答质量依赖 sources 和 related 的准确链接；新增页面时优先补全这些字段。',
      ],
    }),
  },
];

export function getProjectTemplate(id: ProjectTemplateId) {
  const template = projectTemplates.find((item) => item.id === id);
  if (!template) throw new Error(`Unknown project template: ${id}`);
  return template;
}

export function sanitizeProjectDirectoryName(name: string) {
  const sanitized = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+|\.+$/g, '')
    .replace(/^-+|-+$/g, '');

  return sanitized || 'mywiki-project';
}

export function buildProjectRoot(parentDirectory: string, projectName: string) {
  return joinWorkspacePath(parentDirectory, sanitizeProjectDirectoryName(projectName));
}

export function buildTemplateWorkspaceFiles(
  layout: WorkspaceLayout,
  templateId: ProjectTemplateId,
  outputLanguage: ProjectOutputLanguage,
) {
  const template = getProjectTemplate(templateId);
  const languageLabel = outputLanguage === 'zh-CN' ? '简体中文' : 'English';

  return new Map<string, string>([
    [
      layout.purpose,
      [
        '---',
        'type: purpose',
        'title: 项目用途',
        `template: ${template.id}`,
        `outputLanguage: ${outputLanguage}`,
        '---',
        '',
        '# 项目用途',
        '',
        template.purpose,
        '',
        `AI 生成的 Wiki 页面、回答和研究输出默认使用${languageLabel}。`,
        '',
      ].join('\n'),
    ],
    [
      layout.schema,
      [
        '---',
        'type: schema',
        `title: "Wiki Schema — ${template.name}"`,
        `template: ${template.id}`,
        '---',
        '',
        template.schema,
        '',
      ].join('\n'),
    ],
  ]);
}

function buildSchema(options: SchemaOptions) {
  const pageTypes = [...baseTypes, ...(options.extraTypes ?? [])];
  const naming = [...baseNaming, ...(options.extraNaming ?? [])];
  const crossReferences = [...baseCrossReferences, ...(options.extraCrossReferences ?? [])];

  return [
    `# Wiki Schema — ${options.title}`,
    '',
    '## Page Types',
    '',
    '| Type | Directory | Purpose |',
    '|------|-----------|---------|',
    ...pageTypes.map((row) => `| ${row.type} | ${row.directory} | ${row.purpose} |`),
    '',
    '## Naming Conventions',
    '',
    ...naming.map((item) => `- ${item}`),
    '',
    '## Frontmatter',
    '',
    buildFrontmatter(pageTypes),
    options.extraFrontmatter ?? '',
    '',
    '## Index Format',
    '',
    '`wiki/index.md` lists all pages grouped by type. Each entry:',
    '',
    '```',
    '- [[page-slug]] — one-line description',
    '```',
    '',
    '## Log Format',
    '',
    '`wiki/log.md` records activity in reverse chronological order:',
    '',
    '```',
    '## YYYY-MM-DD',
    '',
    '- Action taken / finding noted',
    '```',
    '',
    '## Cross-referencing Rules',
    '',
    ...crossReferences.map((item) => `- ${item}`),
    '',
    '## Contradiction Handling',
    '',
    ...contradictionRules.map((item, index) => `${index + 1}. ${item}`),
    options.conventions?.length ? ['', `## ${options.conventionsTitle ?? 'Template Conventions'}`, ''].join('\n') : '',
    ...(options.conventions ?? []).map((item) => `- ${item}`),
  ].join('\n').replace(/\n{3,}/g, '\n\n');
}
