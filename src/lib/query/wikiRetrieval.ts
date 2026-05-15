import { db } from '@/lib/db';
import { buildWikiIndex, type WikiIndexEntry } from '@/lib/wikiIndex';
import { buildInitialBrowserEntityMarkdown } from '@/lib/wiki/browserWikiPageHelpers';
import { inferWikiTargetSpec, sanitizeWikiMarkdownOutput } from '@/lib/wiki/markdownCompiler';
import { buildWikiPageMetadata } from '@/lib/wiki/pageMetadata';
import { normalizeWikiPageType } from '@/lib/wiki/schemaRules';
import type { Entity, Relationship } from '@/types';
import type { QueryAnswerPageContext } from './queryAnswer';

export type RetrievedWikiPage = QueryAnswerPageContext & {
  aliases: string[];
  relatedEntityIds: string[];
  matchedTerms: string[];
};

export type RetrievedQueryContext = {
  tokens: string[];
  indexSummary: string;
  pages: RetrievedWikiPage[];
  trace: string[];
};

type SearchableWikiPage = {
  entity: Entity;
  title: string;
  type: string;
  path: string;
  href: string;
  aliases: string[];
  summary: string;
  markdown: string;
  body: string;
  tags: string[];
  sources: string[];
  related: string[];
  updated?: string;
  score: number;
  matchedTerms: string[];
};

const FILENAME_EXACT_BONUS = 200;
const PHRASE_IN_TITLE_BONUS = 50;
const PHRASE_IN_CONTENT_PER_OCC = 20;
const MAX_PHRASE_OCC_COUNTED = 10;
const TITLE_TOKEN_WEIGHT = 5;
const CONTENT_TOKEN_WEIGHT = 1;
const ALIAS_TOKEN_WEIGHT = 4;
const DEFAULT_PAGE_LIMIT = 10;
const PRIMARY_CANDIDATE_LIMIT = 14;

const STOP_WORDS = new Set([
  '的',
  '是',
  '了',
  '在',
  '有',
  '和',
  '与',
  '或',
  '及',
  '把',
  '被',
  '并',
  '并且',
  '一个',
  '这个',
  '那个',
  '哪些',
  '什么',
  '怎么',
  '如何',
  '为什么',
  '是否',
  '多少',
  '认为',
  '未来',
  '一下',
  '一下子',
  '项目',
  '这个项目',
  'the',
  'is',
  'a',
  'an',
  'what',
  'how',
  'why',
  'are',
  'was',
  'were',
  'do',
  'does',
  'did',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'it',
  'its',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'this',
  'that',
  'these',
  'those',
]);

export async function retrieveQueryContext(
  question: string,
  options: {
    limit?: number;
    maxContextChars?: number;
  } = {},
): Promise<RetrievedQueryContext> {
  const [entities, relationships, wikiIndex] = await Promise.all([
    db.entities.toArray(),
    db.relationships.toArray(),
    buildWikiIndex(300),
  ]);

  return retrieveQueryContextFromEntities(question, entities, relationships, wikiIndex, options);
}

export function retrieveQueryContextFromEntities(
  question: string,
  entities: Entity[],
  relationships: Relationship[],
  wikiIndex: WikiIndexEntry[],
  options: {
    limit?: number;
    maxContextChars?: number;
  } = {},
): RetrievedQueryContext {
  const tokens = tokenizeQuery(question);
  const normalizedQuestion = normalizeText(question);
  const budget = computeContextBudget(options.maxContextChars);
  const searchablePages = entities
    .filter((entity) => !(entity.type === 'topic' && entity.tags.includes('query-insight')))
    .map((entity) => buildSearchableWikiPage(entity));

  const scoredPages = searchablePages
    .map((page) => {
      const { score, matchedTerms } = scoreWikiPage(page, tokens, normalizedQuestion);
      return { ...page, score, matchedTerms };
    })
    .filter((page) => page.score > 0)
    .sort((left, right) => right.score - left.score || right.entity.updatedAt - left.entity.updatedAt);

  const pageLimit = options.limit ?? DEFAULT_PAGE_LIMIT;
  const primary = scoredPages.slice(0, Math.max(PRIMARY_CANDIDATE_LIMIT, pageLimit + 4));
  const relationshipMap = buildRelationshipMap(relationships);
  const expanded = expandRetrievedPages(primary, searchablePages, relationshipMap);
  const merged = mergeRetrievedPages(primary, expanded);

  const selectedPages: RetrievedWikiPage[] = [];
  let usedChars = 0;
  for (const page of merged) {
    const truncatedContent =
      page.body.length > budget.maxPageSize
        ? `${page.body.slice(0, budget.maxPageSize - 18).trim()}\n\n[...truncated...]`
        : page.body;
    if (usedChars + truncatedContent.length > budget.pageBudget && selectedPages.length > 0) {
      continue;
    }

    usedChars += truncatedContent.length;
    selectedPages.push({
      index: selectedPages.length + 1,
      entityId: page.entity.id,
      title: page.title,
      type: page.type,
      path: page.path,
      href: page.href,
      summary: page.summary,
      content: truncatedContent,
      score: page.score,
      tags: page.tags,
      sources: page.sources,
      related: page.related,
      updated: page.updated,
      aliases: page.aliases,
      relatedEntityIds: relationshipMap.get(page.entity.id) ?? [],
      matchedTerms: page.matchedTerms,
    });

    if (selectedPages.length >= pageLimit) break;
  }

  return {
    tokens,
    indexSummary: buildIndexSummary(question, wikiIndex, budget.indexBudget),
    pages: selectedPages,
    trace: [
      `问题分词：${tokens.join('、') || '（无）'}`,
      `Wiki 候选页：${scoredPages.length} 个，实际选入上下文 ${selectedPages.length} 个。`,
      selectedPages.length > 0
        ? `上下文页面：${selectedPages.map((page) => `[${page.index}] ${page.title}`).join('；')}`
        : '没有选中可用的 Wiki 页面。',
    ],
  };
}

function buildSearchableWikiPage(entity: Entity): SearchableWikiPage {
  const markdown = (entity.wikiMarkdown?.trim() ? sanitizeWikiMarkdownOutput(entity.wikiMarkdown) : buildInitialBrowserEntityMarkdown(entity)).trim();
  const metadata = buildWikiPageMetadata(markdown, entity);
  const fallbackTarget = inferWikiTargetSpec(entity);
  const type = normalizePageType(metadata.type) ?? fallbackTarget.type;
  const target = inferWikiTargetSpec(entity, { preferredType: type });
  const summary = metadata.description || entity.compiledProfile?.overview || entity.summary || extractLead(metadata.body);
  const body = [metadata.body.trim() || markdown, buildStructuredFactBlock(entity)].filter(Boolean).join('\n\n');
  const aliases = Array.from(
    new Set(
      [
        entity.title,
        ...entity.tags,
        ...metadata.tags,
        ...metadata.related,
        ...(entity.categories ?? []).flatMap((category) => [category.name, ...(category.aliases ?? []), ...category.items.map((item) => item.title)]),
        ...(entity.indicators ?? []).flatMap((indicator) => [
          indicator.name,
          indicator.businessLine ?? '',
          indicator.categoryName ?? '',
          indicator.rawValue ?? '',
        ]),
      ]
        .map((item) => item.trim())
        .filter((item) => item.length >= 2),
    ),
  );

  return {
    entity,
    title: metadata.title || entity.title,
    type,
    path: target.path,
    href: `/wiki/${entity.type}/${entity.id}`,
    aliases,
    summary,
    markdown,
    body,
    tags: metadata.tags,
    sources: metadata.sources,
    related: metadata.related,
    updated: metadata.updated,
    score: 0,
    matchedTerms: [],
  };
}

function buildStructuredFactBlock(entity: Entity) {
  const sections: string[] = [];

  const profile = entity.compiledProfile;
  if (profile) {
    const facts = [
      profile.overview ? `- 概览：${profile.overview}` : '',
      ...profile.keyFacts.slice(0, 10).map((fact) => `- ${fact}`),
      ...profile.relationshipSummary.slice(0, 8).map((item) => `- 关系：${item}`),
      profile.sourceSummary ? `- 来源：${profile.sourceSummary}` : '',
    ].filter(Boolean);
    if (facts.length > 0) sections.push(['## MyWiki Structured Facts', ...facts].join('\n'));
  }

  const categories = entity.categories ?? [];
  if (categories.length > 0) {
    const lines = categories.slice(0, 12).map((category) => {
      const items = category.items
        .slice(0, 12)
        .map((item) => (item.summary ? `${item.title}：${item.summary}` : item.title))
        .join('；');
      return `- ${category.name}：${items || category.evidence || '未列出明细'}`;
    });
    sections.push(['## Structured Categories', ...lines].join('\n'));
  }

  const indicators = entity.indicators ?? [];
  if (indicators.length > 0) {
    const rows = indicators.slice(0, 24).map((indicator) =>
      [
        indicator.businessLine || indicator.categoryName || '整体',
        indicator.name,
        formatIndicatorValue(indicator),
        indicator.confidence,
        indicator.source?.excerpt ? compact(indicator.source.excerpt, 80) : indicator.note ?? '',
      ].join(' | '),
    );
    sections.push(['## Structured Indicators', '业态/范围 | 指标 | 数值 | 置信度 | 证据', '--- | --- | --- | --- | ---', ...rows].join('\n'));
  }

  return sections.join('\n\n');
}

function formatIndicatorValue(indicator: NonNullable<Entity['indicators']>[number]) {
  if (indicator.rawValue?.trim()) return indicator.rawValue.trim();
  if (indicator.value === null) return indicator.note?.trim() || '未提供明确数值';
  return `${indicator.value}${indicator.unit ?? ''}`;
}

function scoreWikiPage(page: SearchableWikiPage, tokens: string[], normalizedQuestion: string) {
  const title = normalizeText(page.title);
  const aliases = page.aliases.map((alias) => normalizeText(alias));
  const summary = normalizeText(page.summary);
  const body = normalizeText(page.body);
  const slug = slugifyTitle(page.title);
  let score = 0;
  const matchedTerms = new Set<string>();

  if (normalizedQuestion && (title === normalizedQuestion || aliases.includes(normalizedQuestion) || slug === normalizedQuestion)) {
    score += FILENAME_EXACT_BONUS;
  }

  if (normalizedQuestion && title.includes(normalizedQuestion)) {
    score += PHRASE_IN_TITLE_BONUS;
    matchedTerms.add(page.title);
  }

  const phraseOccurrences = normalizedQuestion ? countOccurrences(body, normalizedQuestion) : 0;
  if (phraseOccurrences > 0) {
    score += Math.min(phraseOccurrences, MAX_PHRASE_OCC_COUNTED) * PHRASE_IN_CONTENT_PER_OCC;
    matchedTerms.add(page.title);
  }

  for (const token of tokens) {
    if (!token) continue;
    if (title.includes(token)) {
      score += TITLE_TOKEN_WEIGHT;
      matchedTerms.add(token);
    }
    if (slug.includes(token)) {
      score += TITLE_TOKEN_WEIGHT + 2;
      matchedTerms.add(token);
    }
    if (aliases.some((alias) => alias.includes(token))) {
      score += ALIAS_TOKEN_WEIGHT;
      matchedTerms.add(token);
    }
    if (summary.includes(token)) {
      score += CONTENT_TOKEN_WEIGHT * 3;
      matchedTerms.add(token);
    }
    if (body.includes(token)) {
      score += CONTENT_TOKEN_WEIGHT;
      matchedTerms.add(token);
    }
  }

  score += Math.min(page.entity.sourceEntries.length, 8);
  score += Math.min(page.entity.tags.length, 5);
  score += Math.min(page.body.length / 1200, 10);

  return {
    score,
    matchedTerms: Array.from(matchedTerms),
  };
}

function expandRetrievedPages(
  primary: SearchableWikiPage[],
  allPages: SearchableWikiPage[],
  relationshipMap: Map<string, string[]>,
) {
  const pageById = new Map(allPages.map((page) => [page.entity.id, page]));
  const expansions: SearchableWikiPage[] = [];
  const seen = new Set(primary.map((page) => page.entity.id));

  primary.slice(0, 4).forEach((page, index) => {
    const relatedIds = relationshipMap.get(page.entity.id) ?? [];
    relatedIds.slice(0, 5).forEach((relatedId, relatedIndex) => {
      if (seen.has(relatedId)) return;
      const relatedPage = pageById.get(relatedId);
      if (!relatedPage) return;
      seen.add(relatedId);
      expansions.push({
        ...relatedPage,
        score: page.score * 0.35 - index * 3 - relatedIndex,
        matchedTerms: page.matchedTerms,
      });
    });
  });

  return expansions.sort((left, right) => right.score - left.score);
}

function mergeRetrievedPages(primary: SearchableWikiPage[], expanded: SearchableWikiPage[]) {
  const merged = new Map<string, SearchableWikiPage>();
  for (const page of [...primary, ...expanded]) {
    const existing = merged.get(page.entity.id);
    if (!existing || page.score > existing.score) {
      merged.set(page.entity.id, page);
    }
  }
  return [...merged.values()].sort((left, right) => right.score - left.score || right.entity.updatedAt - left.entity.updatedAt);
}

function buildRelationshipMap(relationships: Relationship[]) {
  const map = new Map<string, string[]>();
  for (const relationship of relationships) {
    const fromList = map.get(relationship.from) ?? [];
    if (!fromList.includes(relationship.to)) fromList.push(relationship.to);
    map.set(relationship.from, fromList);

    const toList = map.get(relationship.to) ?? [];
    if (!toList.includes(relationship.from)) toList.push(relationship.from);
    map.set(relationship.to, toList);
  }
  return map;
}

function buildIndexSummary(question: string, wikiIndex: WikiIndexEntry[], budget: number) {
  const tokens = tokenizeQuery(question);
  const selected = wikiIndex
    .map((entry) => ({
      entry,
      score:
        (tokens.some((token) => normalizeText(entry.title).includes(token)) ? 40 : 0) +
        entry.aliases.filter((alias) => tokens.some((token) => normalizeText(alias).includes(token))).length * 8 +
        tokens.filter((token) => normalizeText(entry.shortSummary).includes(token)).length * 4 +
        Math.min(entry.importance, 24),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.entry.importance - left.entry.importance)
    .slice(0, 16)
    .map(({ entry }) => `- ${entry.title}（${inferIndexPageLabel(entry)}）：${entry.shortSummary}`);

  if (selected.length === 0) return '';

  let used = 0;
  const kept: string[] = [];
  for (const line of selected) {
    if (used + line.length > Math.max(1200, budget)) break;
    kept.push(line);
    used += line.length;
  }
  return kept.join('\n');
}

function tokenizeQuery(query: string): string[] {
  const rawTokens = query
    .toLowerCase()
    .split(/[\s,，。！？、；;:：“”"'‘’（）()\[\]{}<>\-_/\\|]+/)
    .filter((token) => token.length > 1)
    .filter((token) => !STOP_WORDS.has(token));

  const tokens: string[] = [];
  for (const token of rawTokens) {
    const hasCjk = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token);
    if (hasCjk && token.length > 2) {
      const chars = [...token];
      for (let index = 0; index < chars.length - 1; index += 1) {
        tokens.push(chars[index] + chars[index + 1]);
      }
      for (const char of chars) {
        if (!STOP_WORDS.has(char)) tokens.push(char);
      }
      tokens.push(token);
    } else {
      tokens.push(token);
    }
  }

  const normalizedQuestion = normalizeText(query);
  if (normalizedQuestion) tokens.push(normalizedQuestion);

  return Array.from(new Set(tokens.filter((token) => token.length > 0)));
}

function computeContextBudget(maxContextChars = 200000) {
  const maxContext = typeof maxContextChars === 'number' && maxContextChars > 0 ? Math.min(Math.max(maxContextChars, 4000), 1_000_000) : 204_800;
  const responseReserve = Math.floor(maxContext * 0.15);
  const indexBudget = Math.floor(maxContext * 0.05);
  const pageBudget = Math.floor(maxContext * 0.5);
  const maxPageSize = Math.min(pageBudget, Math.max(5000, Math.floor(pageBudget * 0.3)));
  return {
    maxContext,
    responseReserve,
    indexBudget,
    pageBudget,
    maxPageSize,
  };
}

function countOccurrences(haystack: string, needle: string) {
  if (!needle) return 0;
  let count = 0;
  let position = 0;
  while (true) {
    const next = haystack.indexOf(needle, position);
    if (next < 0) break;
    count += 1;
    position = next + needle.length;
  }
  return count;
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[“”"'‘’`~!@#$%^&*()_+\-=\[\]{};:,.<>/?，。！？、；：（）《》【】]/g, '');
}

function slugifyTitle(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|#{}[\]^`]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function inferIndexPageLabel(entry: WikiIndexEntry) {
  if (entry.type === 'topic' && entry.title.startsWith('查询洞察：')) return 'query';
  if (entry.type === 'topic' && /(模式|机制|方法|框架|方案|协议|规范|架构|系统|原则|公式|设计)/.test(entry.title)) {
    return 'concept';
  }
  return entry.type;
}

function normalizePageType(value: string | undefined) {
  return normalizeWikiPageType(value);
}

function extractLead(body: string) {
  const text = body.replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 159)}...` : text;
}

function compact(value: string, maxLength: number) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}
