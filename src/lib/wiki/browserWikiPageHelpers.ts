import { getLlmProviderPreset } from '@/lib/llm/providers';
import { getProviderConfigForRole, type LlmProviderSettings } from '@/lib/llm/providerSettings';
import { defaultEntityProperties } from '@/lib/db';
import type { CompiledEntityProfile, Entity, Entry, EntityType } from '@/types';
import { parseMarkdownFrontmatter, stringifyMarkdownFrontmatter } from './frontmatter';
import { extractMarkdownSummary, inferWikiTargetSpec, sanitizeWikiMarkdownOutput } from './markdownCompiler';
import { buildWikiPageMetadata, repairWikiMarkdownDescription } from './pageMetadata';
import { typeLabel } from './pageTree';
import type { WikiPageMetadata } from './pageMetadata';
import { normalizeWikiPageType } from './schemaRules';
import type { WikiPageType } from './scanner';
import { buildHumanEditedWikiPatch } from './humanEditGuard';
import { stripSupersededMarkdown } from './superseded';

export function getWikiCompileProviderSummary(settings: LlmProviderSettings) {
  const config = getProviderConfigForRole(settings, 'wiki-compile');
  if (!config) return null;
  const preset = getLlmProviderPreset(config.providerId);
  return {
    providerId: config.providerId,
    label: preset?.label ?? config.providerId,
    model: config.model,
  };
}

export function buildBrowserEntityMarkdownPatch(entity: Entity, markdown: string, updatedAt = Date.now()) {
  const cleaned = sanitizeWikiMarkdownOutput(markdown).trim();
  const metadata = buildWikiPageMetadata(cleaned, entity);
  const pageType = resolveEditedWikiPageType(metadata, entity);
  const normalizedMarkdown = normalizeEditedWikiMarkdownType(cleaned, pageType);
  const normalizedMetadata = buildWikiPageMetadata(normalizedMarkdown, entity);
  const nextEntityType = wikiPageTypeToEntityType(pageType, entity.type);
  const patch: Partial<Entity> = {
    title: normalizedMetadata.title,
    summary: extractMarkdownSummary(normalizedMarkdown) || normalizedMetadata.description || entity.summary,
    tags: normalizedMetadata.tags,
    wikiMarkdown: normalizedMarkdown,
    ...buildHumanEditedWikiPatch(normalizedMarkdown, updatedAt),
    updatedAt,
  };
  if (nextEntityType !== entity.type) {
    patch.type = nextEntityType;
    patch.properties = defaultEntityProperties(nextEntityType);
  }
  return patch;
}

export function buildInitialBrowserEntityMarkdown(entity: Entity, schema?: string) {
  if (entity.wikiMarkdown?.trim()) return sanitizeWikiMarkdownOutput(entity.wikiMarkdown).trim();

  const inferredTarget = inferWikiTargetSpec(entity, { schema });
  const metadata = buildWikiPageMetadata('', entity);
  const created = Number.isFinite(entity.createdAt) ? new Date(entity.createdAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const updated = Number.isFinite(entity.updatedAt) ? new Date(entity.updatedAt).toISOString().slice(0, 10) : created;
  const sources = metadata.sources.length ? metadata.sources : entity.sourceEntries;
  const lines = [
    '---',
    `type: ${inferredTarget.type}`,
    `title: ${JSON.stringify(metadata.title)}`,
    `created: ${created}`,
    `updated: ${metadata.updated || updated}`,
    `tags: [${metadata.tags.map((tag) => JSON.stringify(tag)).join(', ')}]`,
    `sources: [${sources.map((source) => JSON.stringify(source)).join(', ')}]`,
    `related: [${metadata.related.map((item) => JSON.stringify(item)).join(', ')}]`,
  ];

  lines.push('---', '', `# ${metadata.title}`, '');

  if (entity.summary?.trim()) {
    lines.push('## 摘要', entity.summary.trim(), '');
  }

  if (entity.indicators?.length) {
    lines.push('## 指标', '');
    for (const indicator of entity.indicators) {
      const value = indicator.value === null ? '未找到明确值' : `${indicator.rawValue ?? indicator.value}${indicator.unit ?? ''}`;
      lines.push(`- **${indicator.name}**：${value}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

export function buildBrowserEntityWikiRepairPatch(entity: Entity) {
  if (!entity.wikiMarkdown?.trim()) return null;

  const normalizedQueryMarkdown = repairQueryInsightMarkdownStructure(entity);
  const repaired = repairWikiMarkdownDescription(normalizedQueryMarkdown ?? entity.wikiMarkdown, entity);
  const nextMarkdown = repaired?.markdown ?? normalizedQueryMarkdown;
  if (!nextMarkdown) return null;
  if (nextMarkdown.trim() === entity.wikiMarkdown.trim()) return null;

  return {
    wikiMarkdown: nextMarkdown,
    summary: extractMarkdownSummary(nextMarkdown) || repaired?.description || entity.summary,
  };
}

export function selectBrowserWikiRecompileCandidates(entities: Entity[]) {
  return [...entities]
    .filter((entity) => entity.sourceEntries.length > 0)
    .filter((entity) => !(entity.type === 'topic' && entity.tags.includes('query-insight')))
    .sort((left, right) => {
      const sourceDelta = right.sourceEntries.length - left.sourceEntries.length;
      if (sourceDelta !== 0) return sourceDelta;
      return right.updatedAt - left.updatedAt;
    });
}

export function buildCompiledProfileFromWikiMarkdown(input: {
  entity: Entity;
  markdown: string;
  entries: Entry[];
  relatedTitles?: string[];
  updatedAt?: number;
}): CompiledEntityProfile {
  const cleaned = stripSupersededMarkdown(sanitizeWikiMarkdownOutput(input.markdown)).trim();
  const summary = extractMarkdownSummary(cleaned) || input.entity.summary || `${input.entity.title} 相关 Wiki 页面。`;
  const lines = cleaned.replace(/\r\n/g, '\n').split('\n');
  const keyFacts = collectListItems(lines, ['关键事实', '关键指标', '指标', '要点', 'Facts', 'Metrics']).slice(0, 8);
  const openTasks = collectListItems(lines, ['未确认与待补充', '待补充', 'Open Questions', 'Unknowns']).slice(0, 6);
  const relationshipSummary = (input.relatedTitles ?? []).slice(0, 8).map((title) => `相关：${title}`);
  const sourceSummary =
    input.entries.length > 0
      ? `${input.entries.length} 条来源已用于 v2 Wiki 页面重编译：${input.entries
          .slice(0, 3)
          .map((entry) => entry.fileMetadata?.filename ?? entry.id)
          .join('、')}`
      : '暂无来源原文。';

  return {
    overview: summary,
    keyFacts,
    openTasks,
    relationshipSummary,
    sourceSummary,
    updatedAt: input.updatedAt ?? Date.now(),
  };
}

function collectListItems(lines: string[], sectionNames: string[]) {
  const normalizedTargets = sectionNames.map((name) => name.toLowerCase());
  const items: string[] = [];
  let inside = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^#{1,6}\s+/.test(line)) {
      const heading = line.replace(/^#{1,6}\s+/, '').trim().toLowerCase();
      inside = normalizedTargets.some((target) => heading.includes(target));
      continue;
    }

    if (!inside) continue;
    if (!line) continue;
    if (/^#{1,6}\s+/.test(line)) break;
    if (/^[-*+]\s+/.test(line)) {
      items.push(line.replace(/^[-*+]\s+/, '').trim());
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      items.push(line.replace(/^\d+\.\s+/, '').trim());
      continue;
    }
  }

  return items;
}

function repairQueryInsightMarkdownStructure(entity: Entity) {
  if (!(entity.type === 'topic' && entity.tags.includes('query-insight'))) return null;
  const markdown = sanitizeWikiMarkdownOutput(entity.wikiMarkdown ?? '').trim();
  if (!markdown.includes('## 问题') || !markdown.includes('## 结论') || markdown.includes('## 摘要')) return null;

  const frontmatterMatch = markdown.match(/^(---\n[\s\S]*?\n---)\n*/);
  const frontmatter = frontmatterMatch?.[1];
  const body = frontmatter ? markdown.slice(frontmatterMatch[0].length).trim() : markdown;
  const lines = body.split('\n');
  const questionIndex = lines.findIndex((line) => line.trim() === '## 问题');
  const conclusionIndex = lines.findIndex((line) => line.trim() === '## 结论');
  if (questionIndex < 0 || conclusionIndex <= questionIndex) return null;

  const nextHeadingIndex = lines.findIndex((line, index) => index > conclusionIndex && /^##\s+/.test(line.trim()));
  const answerLines = lines.slice(conclusionIndex + 1, nextHeadingIndex >= 0 ? nextHeadingIndex : lines.length);
  const remainderLines = nextHeadingIndex >= 0 ? lines.slice(nextHeadingIndex) : [];
  const prefixLines = lines.slice(0, questionIndex);
  const rebuiltBody = compactMarkdownBlocks([
    prefixLines.join('\n').trim(),
    ['## 摘要', answerLines.join('\n').trim()].filter(Boolean).join('\n'),
    remainderLines.join('\n').trim(),
  ]);
  const repaired = [frontmatter, rebuiltBody].filter(Boolean).join('\n\n').trim();
  return repaired === markdown ? null : repaired;
}

function compactMarkdownBlocks(blocks: string[]) {
  return blocks
    .map((block) => block.trim())
    .filter(Boolean)
    .join('\n\n');
}

function resolveEditedWikiPageType(metadata: WikiPageMetadata, entity: Entity): WikiPageType {
  const metadataType = normalizeWikiPageType(metadata.type);
  const tagType = metadata.tags
    .map((tag) => normalizeWikiPageType(tag))
    .find((type): type is WikiPageType => Boolean(type && !['schema', 'purpose', 'overview'].includes(type)));
  const currentType = entityTypeToWikiPageType(entity.type);

  if (metadataType && metadataType !== currentType) return metadataType;
  if (tagType && tagType !== metadataType) return tagType;
  return metadataType ?? tagType ?? currentType;
}

export function normalizeEditedWikiMarkdownType(markdown: string, pageType: WikiPageType) {
  const parsed = parseMarkdownFrontmatter(markdown);
  if (!parsed.raw) return markdown;
  const currentType = normalizeWikiPageType(typeof parsed.data.type === 'string' ? parsed.data.type : undefined);
  const currentTags = Array.isArray(parsed.data.tags) ? parsed.data.tags.map(String) : [];
  const nextTags = normalizeWikiPageTypeTags(currentTags, pageType);
  const tagsChanged = JSON.stringify(currentTags) !== JSON.stringify(nextTags);
  if (currentType === pageType && parsed.data.type === pageType && !tagsChanged) return markdown;

  const nextData = {
    ...parsed.data,
    type: pageType,
    tags: nextTags,
  };
  return `${stringifyMarkdownFrontmatter(nextData)}\n\n${parsed.body.trimStart()}`.trim();
}

export function normalizeWikiPageTypeTags(tags: string[], pageType: WikiPageType) {
  if (['schema', 'purpose', 'overview'].includes(pageType)) return dedupeTags(tags);

  let sawTypeTag = false;
  let hasTargetTypeTag = false;
  const next: string[] = [];

  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed) continue;

    const normalized = normalizeWikiPageType(trimmed);
    if (normalized && !['schema', 'purpose', 'overview'].includes(normalized)) {
      sawTypeTag = true;
      if (normalized === pageType && !hasTargetTypeTag) {
        next.push(trimmed);
        hasTargetTypeTag = true;
      }
      continue;
    }

    next.push(trimmed);
  }

  if (sawTypeTag && !hasTargetTypeTag) {
    next.unshift(typeLabel(pageType));
  }

  return dedupeTags(next);
}

function dedupeTags(tags: string[]) {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    next.push(trimmed);
  }
  return next;
}

function entityTypeToWikiPageType(type: EntityType): WikiPageType {
  if (type === 'project') return 'project';
  if (type === 'topic') return 'concept';
  return 'entity';
}

function wikiPageTypeToEntityType(type: WikiPageType, fallback: EntityType): EntityType {
  if (type === 'project') return 'project';
  if (
    [
      'concept',
      'query',
      'synthesis',
      'comparison',
      'methodology',
      'finding',
      'thesis',
      'theme',
      'plot-thread',
      'chapter',
      'goal',
      'habit',
      'reflection',
      'journal',
    ].includes(type)
  ) {
    return 'topic';
  }
  return fallback;
}
