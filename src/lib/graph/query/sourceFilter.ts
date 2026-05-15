import type { QueryComposePayload } from '@/lib/ai/queryComposer';
import type { Entity } from '@/types';
import type { QuerySource } from '../types';
import { buildAttributeTerms, cjkBigrams, normalizeLanguageTerm } from './language';
import { buildMetricTerms, type EvidenceHit } from './metrics';

export function filterSourcesForComposedAnswer(
  sources: QuerySource[],
  answer: string,
  payload: QueryComposePayload,
  primaryEntityId?: string,
) {
  const entryContentById = new Map(payload.entries.map((entry) => [entry.id, entry.content]));
  const filtered = sources.filter((source) => {
    if (source.type === 'entity') {
      return source.id === primaryEntityId || sourceTitleMentioned(source.title, answer);
    }
    if (source.type === 'task') {
      return sourceTextSupportsAnswer(source.title, answer, payload.question);
    }
    const entryContent = entryContentById.get(source.id);
    return entryContent ? sourceTextSupportsAnswer(entryContent, answer, payload.question) : false;
  });

  return filtered.length > 0 ? filtered : sources.filter((source) => source.type === 'entity').slice(0, 1);
}

export function readableRelatedTitles(entities: Entity[]) {
  return uniqueStrings(
    entities
      .map((entity) => entity.title.trim())
      .filter((title) => title.length > 0 && title !== 'undefined' && title !== 'null'),
  );
}

export function formatEvidenceHitLines(
  hits: EvidenceHit[],
  options: { includeSnippet?: boolean; maxSnippets?: number } = {},
) {
  const scopeLabels = Array.from(
    new Set(hits.map((hit) => (hit.scope === 'global-fallback' ? '全库原始材料兜底' : '关联原始材料'))),
  );
  const matchedTerms = uniqueStrings(hits.flatMap((hit) => hit.matchedTerms)).slice(0, 6);
  const summary = `原始材料命中：已找到 ${hits.length} 条证据（${scopeLabels.join('、')}），命中词：${matchedTerms.join('、') || '未标注'}。`;

  if (!options.includeSnippet) {
    return `${summary}\n这些原文已放在来源区，避免把未编译的长文本直接混入快速答案。`;
  }

  const lines = hits.slice(0, options.maxSnippets ?? 2).map((hit, index) => {
    const scopeLabel = hit.scope === 'global-fallback' ? '全库原始材料兜底' : '关联原始材料';
    return `${index + 1}. ${cleanEvidenceSnippet(hit.snippet)}（${scopeLabel}）`;
  });

  return `${summary}\n证据摘录：\n${lines.join('\n')}\n建议：这些信息应后续编译回实体档案，下次就能直接从 Wiki 回答。`;
}

export function sourceTitleMentioned(title: string, answer: string) {
  const normalizedTitle = normalize(title);
  if (normalizedTitle.length < 2) return false;
  const normalizedAnswer = normalize(answer);
  return normalizedAnswer.includes(normalizedTitle) ||
    titleAliases(title).some((alias) => normalize(alias).length >= 2 && normalizedAnswer.includes(normalize(alias)));
}

function titleAliases(title: string) {
  return uniqueStrings([
    title,
    title.replace(/项目|主题|事项|公司|有限公司|股份/g, ''),
    ...title.split(/[、/，,；;\s-]+/),
  ].filter((alias) => alias.trim().length >= 2));
}

export function sourceTextSupportsAnswer(text: string, answer: string, question: string) {
  const normalizedText = normalize(text);
  if (!normalizedText) return false;

  const metricValues = extractComparableMetricValues(answer);
  if (metricValues.length > 0) {
    return metricValues.some((value) => normalizedText.includes(normalize(normalizeMetricComparable(value))));
  }

  const directValues = extractDirectAnswerValues(answer);
  if (directValues.some((value) => normalizedText.includes(normalize(value)))) {
    return true;
  }

  const anchors = extractAnswerSourceAnchors(answer, question);
  if (anchors.length === 0) return false;

  const matched = anchors.filter((anchor) => normalizedText.includes(normalize(anchor)));
  if (matched.some((anchor) => normalize(anchor).length >= 6)) return true;
  const hasStrongMatch = matched.some((anchor) => normalize(anchor).length >= 4);
  return hasStrongMatch && matched.length >= Math.min(2, anchors.length);
}

function extractComparableMetricValues(answer: string) {
  const values = [
    ...answer.matchAll(/[0-9][0-9,，]*(?:\.[0-9]+)?\s*(?:亿元|万元|元|%|平方米|㎡|人|家|个)/g),
    ...answer.matchAll(/[0-9][0-9,，]*(?:\.[0-9]+)?\s*(?:亿|万)(?![\u4e00-\u9fa5A-Za-z0-9])/g),
  ].map((match) => match[0]);
  return uniqueStrings(values);
}

function normalizeMetricComparable(value: string) {
  return value.replace(/，/g, ',').replace(/\s+/g, '');
}

function extractDirectAnswerValues(answer: string) {
  const values: string[] = [];
  for (const match of answer.matchAll(/(?:是|为|叫|设定为|设置为)\s*([^。\n；;]+)/g)) {
    values.push(...(match[1] ?? '').split(/[、/，,；;\s]+/));
  }
  for (const match of answer.matchAll(/「([^」]{1,40})」|“([^”]{1,40})”|\*\*([^*]{1,40})\*\*/g)) {
    values.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return uniqueStrings(
    values
      .map((value) => value.replace(/^(约|大约|预计|当前|目前)/, '').trim())
      .filter((value) => normalize(value).length >= 2 && !/^(提示|建议|来源材料|知识库)$/.test(value)),
  ).slice(0, 12);
}

function extractAnswerSourceAnchors(answer: string, question: string) {
  const questionTerms = new Set([
    ...buildMetricTerms(question),
    ...buildAttributeTerms(question),
    ...cjkBigrams(question),
  ].map(normalize));
  const ignored = new Set([
    '主要依据',
    '提示',
    '建议',
    '目前',
    '知识库',
    '来源材料',
    '可以确认',
    '无法确认',
    '相关信息',
    '直接作为结论',
  ].map(normalize));

  const quoted = [...answer.matchAll(/[「“]([^」”]{2,40})[」”]/g)].map((match) => match[1] ?? '');
  const phraseCandidates = answer
    .split(/[。\n；;：:，,、（）()\[\]【】\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3 && item.length <= 24);

  return uniqueStrings([...quoted, ...phraseCandidates])
    .filter((term) => {
      const normalized = normalize(term);
      if (normalized.length < 3 || ignored.has(normalized) || questionTerms.has(normalized)) return false;
      return !/^(第?[一二三四五六七八九十0-9]+|这些|其中|包括|分别|相关|具体|如下)$/.test(term);
    })
    .slice(0, 16);
}

export function cleanEvidenceSnippet(value: string) {
  return snippet(
    value
      .replace(/[`>#*_]+/g, ' ')
      .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim(),
    120,
  );
}

function snippet(value: string, maxLength = 80) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const trimmed = value.trim();
    const key = normalize(trimmed);
    if (!trimmed || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalize(value: string) {
  return normalizeLanguageTerm(value);
}
