import type { Entity, Entry, Relationship } from '@/types';
import {
  buildWikiSchemaRulesTable,
  inferWikiTargetSpecFromSchema,
  type WikiTargetOptions,
  type WikiTargetSpec,
} from './schemaRules';
import { unwrapWikiReference } from './references';
import { compactWikiSummaryText } from './summaryText';

export type WikiMarkdownCompileInput = {
  entity: Entity;
  sourceEntries: Entry[];
  relatedEntities?: Entity[];
  relationships?: Relationship[];
  contextMap?: WikiCompileContextMap;
  today?: string;
};

export type WikiMarkdownBatchCompileInput = {
  sourceEntry: Entry;
  entities: Entity[];
  relatedEntities?: Entity[];
  relationships?: Relationship[];
  contextMap?: WikiCompileContextMap;
  today?: string;
};

export type WikiCompileContextMap = {
  purpose?: string;
  schema?: string;
  index?: string;
  overview?: string;
  log?: string;
};

export type WikiMarkdownCompileResult = {
  markdown: string;
  summary: string;
  tags: string[];
  path?: string;
  warnings?: string[];
};

export type WikiMarkdownBatchCompileResult = {
  results: Array<WikiMarkdownCompileResult & { entityId: string }>;
  missingEntityIds: string[];
  unmatchedPaths: string[];
  warnings: string[];
};

export type WikiMarkdownCompileNormalizeOptions = {
  requireFileBlock?: boolean;
};

export type ParsedWikiFileBlock = {
  path: string;
  content: string;
};

export type ParseWikiFileBlocksResult = {
  blocks: ParsedWikiFileBlock[];
  warnings: string[];
};

const OPENER_LINE = /^---\s*FILE:\s*(.+?)\s*---\s*$/i;
const CLOSER_LINE = /^---\s*END\s+FILE\s*---\s*$/i;
const FENCE_LINE = /^\s{0,3}(```+|~~~+)/;

export function inferWikiTargetSpec(
  entity: Pick<Entity, 'id' | 'type' | 'title' | 'tags'>,
  options: WikiTargetOptions = {},
): WikiTargetSpec {
  return inferWikiTargetSpecFromSchema(entity, options);
}

export function buildWikiMarkdownCompilePrompt(input: WikiMarkdownCompileInput) {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const target = inferWikiTargetSpec(input.entity, { schema: input.contextMap?.schema });
  const targetPath = target.path;
  const schemaRulesTable = buildWikiSchemaRulesTable(input.contextMap?.schema);
  const sourceBlocks = input.sourceEntries.length
    ? input.sourceEntries
        .slice(0, 8)
        .map((entry, index) =>
          [
            `## 来源 ${index + 1}: ${entry.fileMetadata?.filename ?? entry.id}`,
            `entryId: ${entry.id}`,
            '',
            truncateForPrompt(entry.content, 9000),
          ].join('\n'),
        )
        .join('\n\n---\n\n')
    : '（当前实体没有直接来源，请只基于实体已有摘要、指标、分类和关系生成。）';

  const related = (input.relatedEntities ?? [])
    .slice(0, 24)
    .map((entity) => `- ${entity.title}（${entity.type}）：${entity.summary}`)
    .join('\n');
  const allowedWikiLinks = buildAllowedWikiLinkTargets(input, targetPath);

  const relationshipText = (input.relationships ?? [])
    .slice(0, 40)
    .map((relationship) => `- ${relationship.from} --${relationship.type}--> ${relationship.to}`)
    .join('\n');

  return [
    '你是 MyWiki v2 的 Wiki 编译 Agent。你的任务不是提取一堆字段，而是把原始材料编译成一篇人类可读、Query Agent 也可直接读取的中文 Wiki Markdown 页面。',
    '',
    '请重度参考 LLM Wiki / Karpathy LLM Wiki 的知识页形态：顶部 YAML frontmatter，正文是结构化 Markdown，包含项目概述、关键事实、板块/层级、指标表、来源证据、未确认事项和相关链接。',
    '',
    '## Wiki Context Map',
    '',
    '下面这组上下文来自参考项目 LLM Wiki 的机制：purpose 决定方向，schema 决定页面类型和结构，index/overview 帮助避免重复建页和错分类型。',
    '',
    buildContextMapBlock(input.contextMap),
    '',
    '## Schema Page Types（本次编译必须遵守）',
    '',
    schemaRulesTable,
    '',
    '## 本次 Schema 推断结果',
    '',
    `- targetType: ${target.type}`,
    `- targetPath: ${targetPath}`,
    '- 这是根据 schema.md 的 Page Types、实体类型、标题、标签和来源上下文推断出的目标页面。除非原始证据明确说明这是别的 schema 类型，否则 frontmatter.type 必须与 targetType 保持一致。',
    '',
    '## 当前目标实体',
    JSON.stringify(
      {
        id: input.entity.id,
        type: input.entity.type,
        title: input.entity.title,
        summary: input.entity.summary,
        tags: input.entity.tags,
        categories: input.entity.categories ?? [],
        indicators: input.entity.indicators ?? [],
        properties: input.entity.properties,
      },
      null,
      2,
    ),
    '',
    '## 相关实体',
    related || '（暂无相关实体）',
    '',
    '## 已知关系',
    relationshipText || '（暂无关系）',
    '',
    '## Allowed Existing Wiki Links（正文 wikilink 只允许使用这些目标）',
    '',
    allowedWikiLinks || '（当前没有可安全链接的既有 Wiki 页面；正文不要生成 [[...]]，相关概念保持纯文本。）',
    '',
    '## 原始来源材料',
    sourceBlocks,
    '',
    '## 输出要求',
    '- 整个回复只能包含一个 FILE block，不能有任何 block 外文本。',
    '- 第一字符必须是 `-`，也就是 `---FILE:` 的开头。',
    `- FILE block 路径必须是：${targetPath}`,
    '- 严禁输出 `<think>`、`</think>`、思考过程、分析过程、推理说明、任务复述或任何 FILE block 外前言。',
    '- 如果你需要内部思考，请只在内部完成；最终答案只能是 FILE block。',
    '- FILE 内容第一行必须是 `---`，并包含合法 YAML frontmatter。',
    '- frontmatter 必须包含：type、title、created、updated、tags、sources、related。',
    `- frontmatter.type 必须是：${target.type}。`,
    `- updated 使用 ${today}。`,
    '- sources 使用来源文件名或 entryId；related 只能使用上方 Allowed Existing Wiki Links 中列出的 target（不含 [[ ]]），不确定就写 []；禁止在 related 数组里写 [[...]] 包裹。',
    '- 正文中的 [[wikilink]] 只能引用上方 Allowed Existing Wiki Links 中列出的 target，推荐写成 [[target|显示名称]]。',
    '- 禁止发明英文 slug、拼音 slug、翻译 slug 或未登记页面名；如果目标不在 Allowed Existing Wiki Links 中，就写纯文本，不要写 [[...]]。',
    '- 正文必须是中文。不要把 OCR 目录编号、页码、点线、残缺字符当成事实。',
    '- 如果原文没有明确数据，写“未在当前来源中确认”，不要猜。',
    '- 重要数字必须保留完整单位和证据语境。',
    '- 使用 Markdown 表格呈现关键指标；没有指标时写“当前来源未提供明确指标”。',
    '- 只有确认目标已存在于 Allowed Existing Wiki Links 时，才在正文里引用相关实体。',
    '',
    '建议正文结构：',
    '# 标题',
    '## 摘要',
    '## 项目概述 / 主题概述',
    '## 关键事实',
    '## 结构与板块',
    '## 关键指标',
    '## 来源与证据',
    '## 未确认与待补充',
    '## 相关页面',
    '',
    '## 输出格式（必须严格遵守）',
    '```',
    `---FILE: ${targetPath}---`,
    '---',
    `type: ${target.type}`,
    `title: "${escapeYamlString(input.entity.title)}"`,
    `created: ${today}`,
    `updated: ${today}`,
    'tags: [tag1, tag2]',
    'sources: [source-file-or-entry-id]',
    'related: [related-page-slug]',
    '---',
    '',
    `# ${input.entity.title}`,
    '',
    '## 摘要',
    '正文内容。',
    '',
    '---END FILE---',
    '```',
    '',
    '如果你输出任何 FILE block 外的解释、分析或前言，系统会丢弃那些内容。',
  ].join('\n');
}

export function buildWikiMarkdownBatchCompilePrompt(input: WikiMarkdownBatchCompileInput) {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const schemaRulesTable = buildWikiSchemaRulesTable(input.contextMap?.schema);
  const targetEntities = input.entities.slice(0, 8).map((entity) => {
    const target = inferWikiTargetSpec(entity, { schema: input.contextMap?.schema });
    return {
      id: entity.id,
      title: entity.title,
      entityType: entity.type,
      targetType: target.type,
      targetPath: target.path,
      summary: entity.summary,
      tags: entity.tags,
      categories: entity.categories ?? [],
      indicators: entity.indicators ?? [],
    };
  });
  const targetPaths = new Set(targetEntities.map((entity) => entity.targetPath));
  const related = (input.relatedEntities ?? [])
    .slice(0, 40)
    .map((entity) => {
      const target = inferWikiTargetSpec(entity, { schema: input.contextMap?.schema });
      return `- ${target.path}: ${entity.title}（${entity.type}）：${entity.summary}`;
    })
    .join('\n');
  const relationshipText = (input.relationships ?? [])
    .slice(0, 80)
    .map((relationship) => `- ${relationship.from} --${relationship.type}--> ${relationship.to}`)
    .join('\n');
  const allowedWikiLinks = buildBatchAllowedWikiLinkTargets(input, targetPaths);
  const sourceName = input.sourceEntry.fileMetadata?.filename ?? input.sourceEntry.id;

  return [
    '你是 MyWiki v2 的文件级 Wiki 编译 Agent。你的任务是参考 LLM Wiki 的 ingest 机制，围绕同一份原始材料，一次性生成或更新多篇高质量 Wiki Markdown 页面。',
    '',
    '这不是逐字段抽取，也不是简单摘要。每一篇 Wiki 页都必须是人类可读、Query Agent 可直接检索的知识页：有事实、有结构、有指标、有来源证据、有未确认事项。',
    '',
    '## Wiki Context Map',
    '',
    buildContextMapBlock(input.contextMap),
    '',
    '## Schema Page Types（必须遵守）',
    '',
    schemaRulesTable,
    '',
    '## 本次必须输出的目标页面',
    '',
    JSON.stringify(targetEntities, null, 2),
    '',
    '## 相关既有页面',
    '',
    related || '（暂无相关既有页面）',
    '',
    '## 已知关系',
    '',
    relationshipText || '（暂无关系）',
    '',
    '## Allowed Existing Wiki Links',
    '',
    allowedWikiLinks || '（没有可安全链接的既有页面；正文不要生成 [[...]]）',
    '',
    '## 原始材料',
    '',
    `sourceName: ${sourceName}`,
    `entryId: ${input.sourceEntry.id}`,
    '',
    truncateForPrompt(input.sourceEntry.content, 50000),
    '',
    '## 输出要求',
    '- 完整回复只能包含 FILE blocks，不能有任何 block 外文本。',
    '- 第一字符必须是 `-`，也就是第一个 `---FILE:` 的开头。',
    '- 必须为“本次必须输出的目标页面”中的每一个 targetPath 输出且只输出一个 FILE block。',
    '- FILE block 路径必须严格使用目标列表中的 targetPath，不要发明英文 slug、拼音 slug 或未登记路径。',
    '- 严禁输出 `<think>`、思考过程、分析过程、任务复述或任何 FILE block 外说明。',
    '- 每个 FILE 内容第一行必须是 `---`，并包含合法 YAML frontmatter。',
    '- frontmatter 必须包含：type、title、created、updated、tags、sources、related。',
    `- updated 使用 ${today}。`,
    '- sources 必须包含本次 sourceName 或 entryId。',
    '- 正文必须是中文。不要把 OCR 目录编号、页码、点线、乱码残缺字体当成事实。',
    '- 如果原文没有明确数据，写“未在当前来源中确认”，不要猜。',
    '- 重要数字必须保留完整单位和证据语境。',
    '- 使用 Markdown 表格呈现关键指标；没有指标时写“当前来源未提供明确指标”。',
    '- 每篇正文建议包含：摘要、项目/主题概述、关键事实、结构与板块、关键指标、来源与证据、未确认与待补充、相关页面。',
    '',
    '## 输出格式示例',
    '```',
    '---FILE: wiki/projects/example.md---',
    '---',
    'type: project',
    'title: "示例项目"',
    `created: ${today}`,
    `updated: ${today}`,
    'tags: [项目]',
    `sources: ["${escapeYamlString(sourceName)}"]`,
    'related: []',
    '---',
    '',
    '# 示例项目',
    '',
    '## 摘要',
    '正文内容。',
    '',
    '---END FILE---',
    '```',
  ].join('\n');
}

function buildAllowedWikiLinkTargets(input: WikiMarkdownCompileInput, currentTargetPath: string) {
  const currentTarget = normalizeWikiLinkTarget(currentTargetPath);
  const seen = new Set<string>();
  const lines: string[] = [];
  const add = (targetValue: string, labelValue: string) => {
    const target = normalizeWikiLinkTarget(targetValue);
    const label = labelValue.trim() || target;
    if (!target || target === currentTarget || seen.has(target)) return;
    seen.add(target);
    lines.push(`- target: ${target}; display: ${label}; use: [[${target}|${label}]]`);
  };

  for (const link of extractWikiLinkTargets(input.contextMap?.index ?? '')) {
    add(link.target, link.label);
  }

  for (const entity of input.relatedEntities ?? []) {
    const target = inferWikiTargetSpecFromSchema(entity, { schema: input.contextMap?.schema }).path;
    add(target, entity.title);
  }

  return lines.slice(0, 80).join('\n');
}

function buildBatchAllowedWikiLinkTargets(input: WikiMarkdownBatchCompileInput, targetPaths: Set<string>) {
  const seen = new Set<string>();
  const lines: string[] = [];
  const add = (targetValue: string, labelValue: string) => {
    const target = normalizeWikiLinkTarget(targetValue);
    const label = labelValue.trim() || target;
    if (!target || seen.has(target)) return;
    seen.add(target);
    lines.push(`- target: ${target}; display: ${label}; use: [[${target}|${label}]]`);
  };

  for (const link of extractWikiLinkTargets(input.contextMap?.index ?? '')) {
    add(link.target, link.label);
  }

  for (const entity of input.entities) {
    const target = inferWikiTargetSpecFromSchema(entity, { schema: input.contextMap?.schema }).path;
    if (targetPaths.has(target)) add(target, entity.title);
  }

  for (const entity of input.relatedEntities ?? []) {
    const target = inferWikiTargetSpecFromSchema(entity, { schema: input.contextMap?.schema }).path;
    add(target, entity.title);
  }

  return lines.slice(0, 120).join('\n');
}

function extractWikiLinkTargets(markdown: string) {
  const links: Array<{ target: string; label: string }> = [];
  for (const match of markdown.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const { target, label } = unwrapWikiReference(`[[${match[1]}]]`);
    if (target) links.push({ target, label });
  }
  return links;
}

function normalizeWikiLinkTarget(value: string) {
  const { target } = unwrapWikiReference(value);
  return target
    .replace(/\\/g, '/')
    .replace(/^wiki\//i, '')
    .replace(/\.md$/i, '')
    .normalize('NFKC')
    .trim();
}

export function normalizeWikiMarkdownCompileResult(
  rawText: string,
  fallback: Pick<Entity, 'title' | 'type' | 'tags' | 'summary'>,
  today = new Date().toISOString().slice(0, 10),
  options: WikiMarkdownCompileNormalizeOptions = {},
): WikiMarkdownCompileResult {
  const parsed = parseWikiFileBlocks(rawText);
  const block = parsed.blocks[0];

  if (options.requireFileBlock && !block) {
    const detail = parsed.warnings.length ? ` ${parsed.warnings.join(' ')}` : '';
    throw new Error(`Wiki compiler did not return a valid FILE block.${detail}`);
  }

  const cleaned = block ? block.content.trim() : sanitizeWikiMarkdownOutput(rawText);
  const markdown = ensureFrontmatter(cleaned, fallback, today);
  return {
    markdown,
    summary: extractMarkdownSummary(markdown) || fallback.summary || `${fallback.title} 相关 Wiki 页面。`,
    tags: extractFrontmatterTags(markdown, fallback.tags),
    path: block?.path,
    warnings: parsed.warnings,
  };
}

export function normalizeWikiMarkdownBatchCompileResult(
  rawText: string,
  input: WikiMarkdownBatchCompileInput,
): WikiMarkdownBatchCompileResult {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const parsed = parseWikiFileBlocks(rawText);
  const targetByPath = new Map(
    input.entities.map((entity) => [inferWikiTargetSpec(entity, { schema: input.contextMap?.schema }).path, entity] as const),
  );
  const results: WikiMarkdownBatchCompileResult['results'] = [];
  const seenEntityIds = new Set<string>();
  const unmatchedPaths: string[] = [];

  for (const block of parsed.blocks) {
    const entity = targetByPath.get(block.path);
    if (!entity) {
      unmatchedPaths.push(block.path);
      continue;
    }
    if (seenEntityIds.has(entity.id)) continue;

    const normalized = normalizeWikiMarkdownCompileResult(block.content, entity, today);
    results.push({
      ...normalized,
      entityId: entity.id,
      path: block.path,
      warnings: [...(normalized.warnings ?? []), ...parsed.warnings],
    });
    seenEntityIds.add(entity.id);
  }

  return {
    results,
    missingEntityIds: input.entities.map((entity) => entity.id).filter((entityId) => !seenEntityIds.has(entityId)),
    unmatchedPaths,
    warnings: parsed.warnings,
  };
}

export function parseWikiFileBlocks(text: string): ParseWikiFileBlocksResult {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ParsedWikiFileBlock[] = [];
  const warnings: string[] = [];

  let index = 0;
  while (index < lines.length) {
    const openerMatch = OPENER_LINE.exec(lines[index]);
    if (!openerMatch) {
      index += 1;
      continue;
    }

    const path = openerMatch[1].trim();
    index += 1;

    const contentLines: string[] = [];
    let fenceMarker: string | null = null;
    let fenceLength = 0;
    let closed = false;

    while (index < lines.length) {
      const line = lines[index];
      const fenceMatch = FENCE_LINE.exec(line);
      if (fenceMatch) {
        const run = fenceMatch[1];
        const marker = run[0];
        const length = run.length;
        if (fenceMarker === null) {
          fenceMarker = marker;
          fenceLength = length;
        } else if (marker === fenceMarker && length >= fenceLength) {
          fenceMarker = null;
          fenceLength = 0;
        }
        contentLines.push(line);
        index += 1;
        continue;
      }

      if (fenceMarker === null && CLOSER_LINE.test(line)) {
        closed = true;
        index += 1;
        break;
      }

      contentLines.push(line);
      index += 1;
    }

    if (!path) {
      warnings.push('FILE block with empty path skipped.');
      continue;
    }

    if (!isSafeWikiFilePath(path)) {
      warnings.push(`FILE block with unsafe path "${path}" rejected.`);
      continue;
    }

    if (!closed) {
      warnings.push(`FILE block "${path}" was implicitly closed at end of stream.`);
    }

    blocks.push({ path: path.replace(/\\/g, '/'), content: contentLines.join('\n') });
  }

  return { blocks, warnings };
}

export function isSafeWikiFilePath(path: string) {
  if (typeof path !== 'string' || path.trim().length === 0) return false;
  if (/[\x00-\x1f]/.test(path)) return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  const normalized = path.replace(/\\/g, '/');
  if (normalized.split('/').some((segment) => segment === '..')) return false;
  return normalized.startsWith('wiki/') && normalized.endsWith('.md');
}

export function sanitizeWikiMarkdownOutput(rawText: string) {
  let text = stripMarkdownFence(rawText).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  const unclosedThinkIndex = text.search(/<think>/i);
  if (unclosedThinkIndex >= 0) {
    const afterThink = text.slice(unclosedThinkIndex).replace(/^<think>/i, '');
    const contentStart = findFirstMarkdownContentIndex(afterThink);
    text = contentStart >= 0 ? afterThink.slice(contentStart).trim() : text.slice(0, unclosedThinkIndex).trim();
  }

  const frontmatterStart = text.search(/^---\s*$/m);
  if (frontmatterStart > 0) {
    text = text.slice(frontmatterStart).trim();
  } else if (frontmatterStart < 0) {
    const headingStart = text.search(/^#\s+/m);
    if (headingStart > 0 && looksLikePreamble(text.slice(0, headingStart))) {
      text = text.slice(headingStart).trim();
    }
  }

  return text
    .replace(/^\s*(?:思考过程|分析过程|推理过程|任务分析)[:：][\s\S]*?(?=^#\s+|^---\s*$)/im, '')
    .replace(/<\/?think>/gi, '')
    .trim();
}

export function extractMarkdownSummary(markdown: string) {
  const withoutFrontmatter = markdown.replace(/^---\n[\s\S]*?\n---\s*/, '').trim();
  const summarySection =
    extractSection(withoutFrontmatter, '摘要') ??
    extractSection(withoutFrontmatter, '项目概述') ??
    extractSection(withoutFrontmatter, '主题概述');
  const source = summarySection ?? withoutFrontmatter;
  const text = source
    .split(/\n+/)
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('|'))
    .join(' ')
    .trim();
  return compactWikiSummaryText(text, 220);
}

export function extractFrontmatterTags(markdown: string, fallback: string[] = []) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return fallback;
  const tagLine = match[1].match(/^tags:\s*(.+)$/m)?.[1]?.trim();
  if (!tagLine) return fallback;
  const inline = tagLine.match(/^\[(.*)\]$/)?.[1] ?? tagLine;
  return inline
    .split(',')
    .map((tag) => tag.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
    .slice(0, 12);
}

function ensureFrontmatter(markdown: string, fallback: Pick<Entity, 'title' | 'type' | 'tags'>, today: string) {
  if (markdown.startsWith('---')) {
    return markdown;
  }

  const target = inferWikiTargetSpec({ id: fallback.title, ...fallback });

  return [
    '---',
    `type: ${target.type}`,
    `title: "${escapeYamlString(fallback.title)}"`,
    `created: ${today}`,
    `updated: ${today}`,
    `tags: [${fallback.tags.map((tag) => escapeYamlBare(tag)).join(', ')}]`,
    'sources: []',
    'related: []',
    '---',
    '',
    markdown.startsWith('#') ? markdown : `# ${fallback.title}\n\n${markdown}`,
  ].join('\n');
}

function stripMarkdownFence(text: string) {
  return text
    .replace(/^```(?:markdown|md|yaml)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function findFirstMarkdownContentIndex(text: string) {
  const frontmatterStart = text.search(/^---\s*$/m);
  const headingStart = text.search(/^#\s+/m);
  const candidates = [frontmatterStart, headingStart].filter((index) => index >= 0);
  return candidates.length ? Math.min(...candidates) : -1;
}

function looksLikePreamble(text: string) {
  const compact = text.trim();
  if (!compact) return false;
  return /(?:让我|下面|以下|根据|分析|任务|用户|要求|编写|Wiki页面|wiki页面|页面内容)/i.test(compact);
}

function buildContextMapBlock(contextMap: WikiCompileContextMap | undefined) {
  if (!contextMap) return '（未提供工作区上下文，使用内置通用 schema 规则。）';

  const sections = [
    ['purpose.md', contextMap.purpose],
    ['schema.md', contextMap.schema],
    ['wiki/index.md', contextMap.index],
    ['wiki/overview.md', contextMap.overview],
    ['wiki/log.md', contextMap.log],
  ]
    .filter(([, content]) => content?.trim())
    .map(([label, content]) => [`### ${label}`, truncateForPrompt(content ?? '', 4000)].join('\n\n'));

  return sections.length ? sections.join('\n\n') : '（工作区上下文为空，使用内置通用 schema 规则。）';
}

function extractSection(markdown: string, heading: string) {
  const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'm');
  return markdown.match(pattern)?.[1]?.trim();
}

function truncateForPrompt(text: string, maxChars: number) {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const head = Math.round(maxChars * 0.55);
  const tail = maxChars - head;
  return `${trimmed.slice(0, head)}\n\n...（中间内容已截断，完整原文仍保存在来源记录中）...\n\n${trimmed.slice(-tail)}`;
}

function escapeYamlString(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeYamlBare(value: string) {
  return /[,\[\]{}:#\n]/.test(value) ? `"${escapeYamlString(value)}"` : value;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
