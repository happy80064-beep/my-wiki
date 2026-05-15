import type { Entity } from '@/types';
import type { WikiPageType } from './scanner';

export type WikiSchemaPageTypeRule = {
  type: WikiPageType;
  directory: string;
  purpose: string;
};

export type WikiTargetOptions = {
  schema?: string;
  preferredType?: string;
  sourceFilename?: string;
};

export type WikiTargetSpec = {
  type: WikiPageType;
  path: string;
};

const allowedWikiPageTypes = [
  'overview',
  'project',
  'entity',
  'concept',
  'source',
  'query',
  'synthesis',
  'purpose',
  'schema',
  'comparison',
  'decision',
  'meeting',
  'stakeholder',
  'methodology',
  'finding',
  'thesis',
  'book',
  'character',
  'theme',
  'plot-thread',
  'chapter',
  'goal',
  'habit',
  'reflection',
  'journal',
] as const satisfies readonly WikiPageType[];

const defaultRules: WikiSchemaPageTypeRule[] = [
  { type: 'entity', directory: 'wiki/entities/', purpose: 'Named things: people, organizations, products, tools, datasets.' },
  { type: 'concept', directory: 'wiki/concepts/', purpose: 'Ideas, techniques, mechanisms, models, frameworks, phenomena.' },
  { type: 'project', directory: 'wiki/projects/', purpose: 'Projects, business cases, long-running initiatives, structured dossiers.' },
  { type: 'source', directory: 'wiki/sources/', purpose: 'Source summaries for papers, documents, webpages, interviews, files.' },
  { type: 'query', directory: 'wiki/queries/', purpose: 'Open questions, saved chat answers, active investigations.' },
  { type: 'comparison', directory: 'wiki/comparisons/', purpose: 'Side-by-side analysis of related entities, options, or concepts.' },
  { type: 'synthesis', directory: 'wiki/synthesis/', purpose: 'Cross-source and cross-topic conclusions or phase judgments.' },
  { type: 'overview', directory: 'wiki/overview.md', purpose: 'High-level wiki overview.' },
  { type: 'decision', directory: 'wiki/decisions/', purpose: 'Important choices, rationale, status, and consequences.' },
  { type: 'meeting', directory: 'wiki/meetings/', purpose: 'Meeting notes, agendas, and action items.' },
  { type: 'stakeholder', directory: 'wiki/stakeholders/', purpose: 'People, teams, organizations, responsibilities, and needs.' },
];

const fallbackDirectoryByType: Record<WikiPageType, string> = {
  overview: 'wiki/overview.md',
  project: 'wiki/projects/',
  entity: 'wiki/entities/',
  concept: 'wiki/concepts/',
  source: 'wiki/sources/',
  query: 'wiki/queries/',
  synthesis: 'wiki/synthesis/',
  purpose: 'purpose.md',
  schema: 'schema.md',
  comparison: 'wiki/comparisons/',
  decision: 'wiki/decisions/',
  meeting: 'wiki/meetings/',
  stakeholder: 'wiki/stakeholders/',
  methodology: 'wiki/methodology/',
  finding: 'wiki/findings/',
  thesis: 'wiki/thesis/',
  book: 'wiki/books/',
  character: 'wiki/characters/',
  theme: 'wiki/themes/',
  'plot-thread': 'wiki/plot-threads/',
  chapter: 'wiki/chapters/',
  goal: 'wiki/goals/',
  habit: 'wiki/habits/',
  reflection: 'wiki/reflections/',
  journal: 'wiki/journal/',
};

const chineseTypeAliases: Record<string, WikiPageType> = {
  实体: 'entity',
  人物: 'entity',
  机构: 'entity',
  公司: 'entity',
  概念: 'concept',
  方法: 'concept',
  机制: 'concept',
  模型: 'concept',
  框架: 'concept',
  项目: 'project',
  课题: 'project',
  业务: 'project',
  来源: 'source',
  源文件: 'source',
  资料: 'source',
  查询: 'query',
  问题: 'query',
  洞察: 'query',
  对比: 'comparison',
  比较: 'comparison',
  综合: 'synthesis',
  综述: 'synthesis',
  总结: 'synthesis',
  决策: 'decision',
  决定: 'decision',
  会议: 'meeting',
  纪要: 'meeting',
  干系人: 'stakeholder',
  利益相关者: 'stakeholder',
  目标: 'goal',
  习惯: 'habit',
  反思: 'reflection',
  复盘: 'reflection',
  日志: 'journal',
  日记: 'journal',
};

export function normalizeWikiPageType(value: string | undefined | null): WikiPageType | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if ((allowedWikiPageTypes as readonly string[]).includes(normalized)) return normalized as WikiPageType;
  return chineseTypeAliases[raw];
}

export function getDefaultWikiSchemaRules(): WikiSchemaPageTypeRule[] {
  return [...defaultRules];
}

export function parseWikiSchemaPageTypes(schemaMarkdown?: string): WikiSchemaPageTypeRule[] {
  if (!schemaMarkdown?.trim()) return getDefaultWikiSchemaRules();

  const rules: WikiSchemaPageTypeRule[] = [];
  for (const rawLine of schemaMarkdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('|') || /---/.test(line) || /type\s*\|\s*directory/i.test(line)) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim().replace(/^`|`$/g, ''));
    if (cells.length < 2) continue;
    const type = normalizeWikiPageType(cells[0]);
    if (!type) continue;
    const directory = normalizeDirectory(cells[1]);
    const purpose = cells.slice(2).join(' | ').trim();
    if (!directory) continue;
    rules.push({ type, directory, purpose });
  }

  return mergeRules(getDefaultWikiSchemaRules(), rules);
}

export function buildWikiSchemaRulesTable(schemaMarkdown?: string) {
  const rules = parseWikiSchemaPageTypes(schemaMarkdown);
  return [
    '| Type | Directory | Purpose |',
    '|---|---|---|',
    ...rules.map((rule) => `| ${rule.type} | ${rule.directory} | ${rule.purpose || '-'} |`),
  ].join('\n');
}

export function inferWikiTargetSpecFromSchema(
  entity: Pick<Entity, 'id' | 'type' | 'title' | 'tags'>,
  options: WikiTargetOptions = {},
): WikiTargetSpec {
  const rules = parseWikiSchemaPageTypes(options.schema);
  const available = new Set(rules.map((rule) => rule.type));
  const title = entity.title.trim();
  const selectedType =
    firstAvailableType(
      [
        normalizeWikiPageType(options.preferredType),
        explicitTypeFromTags(entity.tags),
        inferByTitleAndEntityType(entity, available),
        entity.type === 'topic' ? 'concept' : 'entity',
      ],
      available,
    ) ?? 'entity';

  return {
    type: selectedType,
    path: buildWikiTargetPath(selectedType, title || entity.id, rules, options.sourceFilename),
  };
}

export function buildWikiTargetPath(
  type: WikiPageType,
  title: string,
  rules: WikiSchemaPageTypeRule[] = getDefaultWikiSchemaRules(),
  sourceFilename?: string,
) {
  const directory = findDirectoryForType(type, rules);
  if (directory.endsWith('.md')) return directory;

  const baseName = type === 'source' && sourceFilename ? sourceFilename.replace(/\.[^.]+$/, '') : title;
  return `${directory}${slugifyWikiPath(baseName)}.md`;
}

export function findDirectoryForType(type: WikiPageType, rules: WikiSchemaPageTypeRule[] = getDefaultWikiSchemaRules()) {
  const directory = rules.find((rule) => rule.type === type)?.directory ?? fallbackDirectoryByType[type] ?? 'wiki/entities/';
  const normalized = normalizeDirectory(directory);
  if (normalized.endsWith('.md')) return normalized;
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

export function slugifyWikiPath(value: string) {
  const slug = value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|#{}[\]^`]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 96);
  return slug || 'untitled';
}

function inferByTitleAndEntityType(
  entity: Pick<Entity, 'type' | 'title' | 'tags'>,
  available: Set<WikiPageType>,
): WikiPageType {
  const title = entity.title.trim();
  const lowerTitle = title.toLowerCase();
  const tagText = entity.tags.join(' ');
  const text = `${title} ${tagText}`;

  if (available.has('query') && (entity.tags.some((tag) => tag.toLowerCase() === 'query-insight') || lowerTitle.startsWith('查询洞察：') || lowerTitle.startsWith('query insight:') || /[?？]$/.test(title))) {
    return 'query';
  }

  if (available.has('comparison') && /(对比|比较|\bvs\b| versus )/i.test(title)) return 'comparison';

  if (
    available.has('synthesis') &&
    /(总结|综述|汇总|复盘|路线图|计划|月报|周报|回顾|纪要总览|观察总览|脉络|全景|图谱|综合分析)/.test(title)
  ) {
    return 'synthesis';
  }

  if (entity.type === 'project' && available.has('project')) return 'project';

  if (entity.type === 'event') {
    if (available.has('decision') && /(决策|决定|拍板|取舍|ADR|decision)/i.test(text)) return 'decision';
    if (available.has('meeting') && /(会议|纪要|同步|沟通|访谈|meeting|minutes)/i.test(text)) return 'meeting';
  }

  if (entity.type === 'person' && available.has('stakeholder') && /(干系人|利益相关者|负责人|客户|团队|stakeholder)/i.test(text)) {
    return 'stakeholder';
  }

  if (entity.type === 'topic') {
    if (available.has('methodology') && /(方法论|研究方法|实验协议|评估设计|methodology)/i.test(text)) return 'methodology';
    if (available.has('finding') && /(发现|证据|观察|结论|finding)/i.test(text)) return 'finding';
    if (available.has('thesis') && /(假设|论点|命题|thesis)/i.test(text)) return 'thesis';
    if (available.has('goal') && /(目标|OKR|里程碑|goal)/i.test(text)) return 'goal';
    if (available.has('habit') && /(习惯|打卡|streak|habit)/i.test(text)) return 'habit';
    if (available.has('reflection') && /(复盘|反思|回顾|reflection)/i.test(text)) return 'reflection';
    if (available.has('journal') && /(日志|日记|journal)/i.test(text)) return 'journal';
    if (
      available.has('concept') &&
      /(方案|框架|方法|方法论|模式|机制|协议|规范|架构|系统|原则|公式|存储|部署|设计|策略|流程|范式|模型)/.test(text)
    ) {
      return 'concept';
    }
    if (available.has('concept')) return 'concept';
  }

  return available.has('entity') ? 'entity' : [...available][0] ?? 'entity';
}

function explicitTypeFromTags(tags: string[]): WikiPageType | undefined {
  for (const tag of tags) {
    const type = normalizeWikiPageType(tag);
    if (type && type !== 'schema' && type !== 'purpose' && type !== 'overview') return type;
  }
  return undefined;
}

function firstAvailableType(candidates: Array<WikiPageType | undefined>, available: Set<WikiPageType>) {
  return candidates.find((type) => type && available.has(type));
}

function normalizeDirectory(value: string) {
  const normalized = value
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/');
  if (!normalized) return '';
  if (normalized.endsWith('.md')) return normalized;
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function mergeRules(baseRules: WikiSchemaPageTypeRule[], schemaRules: WikiSchemaPageTypeRule[]) {
  const merged = new Map<WikiPageType, WikiSchemaPageTypeRule>();
  for (const rule of baseRules) merged.set(rule.type, rule);
  for (const rule of schemaRules) merged.set(rule.type, rule);
  return [...merged.values()];
}
