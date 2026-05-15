import type { Entry } from '@/types';
import { inferMetricScope, isMetricQuestion, metricScopeTerms } from './language';

export type EvidenceHit = {
  entry: Entry;
  snippet: string;
  matchedTerms: string[];
  scope: 'entity-source' | 'global-fallback';
  score: number;
};

export type MetricAnswer = {
  label: string;
  value: string;
  confidence: 'high' | 'medium';
  reason: string;
  hit: EvidenceHit;
  evidenceSnippet: string;
};

export function buildMetricTerms(question: string) {
  if (!isMetricQuestion(question)) return [];

  const compactQuestion = question.replace(/[？?。！!，,、：:；;]/g, '').replace(/\s+/g, '');
  const terms: string[] = [];
  const afterDe = compactQuestion.match(/的([^的]{2,28}?)(?:是多少|多少|为多少|是几|几|$)/);
  if (afterDe?.[1]) terms.push(afterDe[1]);

  for (const match of compactQuestion.matchAll(/([\u4e00-\u9fa5A-Za-z0-9/-]{0,16}(?:收入|营收|金额|费用|成本|投资|利润|价格|总额|面积|规模|人数|数量))/g)) {
    if (match[1]) terms.push(match[1]);
  }

  if (/年均/.test(question)) terms.push('年均');
  if (/稳定运营期/.test(question)) terms.push('稳定运营期');
  if (/项目总收入/.test(question)) terms.push('项目总收入');
  if (/总收入/.test(question)) terms.push('总收入');
  if (/收入|营收/.test(question)) terms.push('收入', '营收');
  if (/住宅/.test(question)) terms.push('住宅', '住宅业态');
  if (/医疗/.test(question)) terms.push('医疗', '医疗业态', '医疗板块');
  if (/康养|养老|养生/.test(question)) terms.push('康养', '康养业态');
  if (/研发|科研/.test(question)) terms.push('研发', '研发业态');
  if (/文旅|旅游|旅居/.test(question)) terms.push('文旅', '文旅业态');
  if (/土地|用地|占地|面积|建筑面积/.test(question)) terms.push('土地面积', '面积', '用地', '占地');
  if (/多少/.test(question)) terms.push(...compactQuestion.split(/的/).filter((term) => term.length >= 2).slice(-2));

  return uniqueStrings(terms).slice(0, 12);
}

function isTocOrOcrNoise(item: string) {
  const compact = item.replace(/\s+/g, ' ').trim();
  if (/(\.{3,}|…{2,}|-{2,}|_{2,})/.test(compact)) return true;
  if (/\bof\s+\d+\b/i.test(compact)) return true;
  if (/^\s*(?:[IVX]+|\d+)(?:[.．]\d+){1,}/i.test(compact)) return true;
  if (/第\s*\d+\s*页|页码|目录|附录/.test(compact)) return true;
  const digitCount = (compact.match(/\d/g) ?? []).length;
  const hasMetricContext = /(收入|营收|金额|费用|成本|投资|利润|价格|总额|合计|面积|土地|用地|占地|建筑面积|万元|亿元|平方米|平米|㎡|亩|公顷|元)/.test(compact);
  if (digitCount >= 3 && digitCount / Math.max(compact.length, 1) > 0.2 && !hasMetricContext) return true;
  return false;
}

export function isLikelyTocOrNavigationSentence(sentence: string) {
  const compact = sentence.replace(/\s+/g, ' ').trim();
  if (isTocOrOcrNoise(compact)) return true;
  if (/[.·•]{3,}\s*\d/.test(compact)) return true;
  if (/--\s*\d+\s+of\s+\d+\s*--/i.test(compact)) return true;
  if (/(目录|页码|章节|附录|图目录|表目录)/.test(compact)) return true;

  const headingWords = /(业务协同|增长极|创新商业模式|资产价值|项目愿景|项目定位|温暖永生|为特色|为核心|养生息|消费场景|待.*建成后)/;
  const hasConcreteList =
    /(包括|包含|设有|设置|建设|配置|规划).{0,24}(项目|服务|机构|科室|门诊|中心|疗法|方法)/.test(compact) ||
    /(项目|服务|机构|科室|门诊|中心|疗法|方法).{0,12}(包括|包含|有|设有|设置|建设|配置|规划)/.test(compact);

  return headingWords.test(compact) && !hasConcreteList;
}

export function extractMetricAnswer(question: string, hits: EvidenceHit[]) {
  if (!isMetricQuestion(question)) return undefined;
  const terms = buildMetricTerms(question);
  if (terms.length === 0) return undefined;

  let mediumCandidate: MetricAnswer | undefined;
  for (const hit of hits) {
    const evidenceText = hit.entry.content || hit.snippet;
    const extraction = extractMetricValueFromText(evidenceText, terms);
    if (!extraction) continue;
    const evidenceSnippet = buildMetricEvidenceSnippet(evidenceText, extraction.value, terms, hit);
    const answer = {
      label: normalizeMetricLabel(terms[0] ?? '相关数值'),
      value: extraction.value,
      confidence: extraction.confidence,
      reason: extraction.reason,
      hit,
      evidenceSnippet,
    } satisfies MetricAnswer;
    if (answer.confidence === 'high') {
      return answer;
    }
    mediumCandidate ??= answer;
  }

  return mediumCandidate;
}

function buildMetricEvidenceSnippet(text: string, value: string, terms: string[], hit: EvidenceHit) {
  const sentence = findSentenceContaining(text, metricValueCandidates(value));
  if (sentence) return snippet(sentence, 180);

  const valueIndex = findFirstTermIndex(text, metricValueCandidates(value));
  if (valueIndex >= 0) return snippetAround(text, valueIndex, 180);

  const termIndex = findFirstTermIndex(text, terms);
  if (termIndex >= 0) return snippetAround(text, termIndex, 180);

  return hit.snippet;
}

function findSentenceContaining(text: string, terms: string[]) {
  const sentences = text
    .split(/[。；;\n]/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.find((sentence) => terms.some((term) => evidenceTextMatches(sentence, term)));
}

function extractMetricValueFromText(text: string, terms: string[]) {
  const cleaned = normalizeEvidenceForMetric(text);
  const sentences = cleaned
    .split(/[。\n；;]/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const matchedSentences = sentences.filter((sentence) =>
    !isLikelyTocOrNavigationSentence(sentence) &&
    metricSentenceMatchesScope(sentence, terms) &&
    terms.some((term) => evidenceTextMatches(sentence, term)),
  );

  for (const sentence of matchedSentences) {
    const value = extractMetricValueFromSentence(sentence, terms);
    if (value) {
      const confidence = adjustMetricConfidence(metricSentenceConfidence(sentence, terms), value, sentence, terms);
      return {
        value,
        confidence,
        reason: confidence === 'high'
          ? '来源句同时包含指标词和金额单位'
          : metricMediumReason(value, sentence, terms),
      } satisfies Pick<MetricAnswer, 'value' | 'confidence' | 'reason'>;
    }
  }

  if (matchedSentences.length > 0) {
    for (const sentence of sentences) {
      if (isLikelyTocOrNavigationSentence(sentence)) continue;
      if (!metricSentenceMatchesScope(sentence, terms)) continue;
      const value = extractMetricValueFromSentence(sentence, terms);
      if (value) {
        return {
          value,
          confidence: 'medium',
          reason: '同一来源中找到问题指标词和金额，但金额不在同一句中',
        } satisfies Pick<MetricAnswer, 'value' | 'confidence' | 'reason'>;
      }
    }
  }

  return undefined;
}

type MetricKind = 'money' | 'area' | 'count' | 'ratio' | 'generic';

function inferMetricKind(terms: string[], sentence = ''): MetricKind {
  const text = `${terms.join('')} ${sentence}`;
  if (/(面积|土地|用地|占地|建筑面积|住宅业态)/.test(text)) return 'area';
  if (/(收入|营收|金额|费用|成本|投资|利润|价格|总额|年均|年收入|总收入)/.test(text)) return 'money';
  if (/(比例|收益率|利润率|率|百分比|%)/.test(text)) return 'ratio';
  if (/(人数|数量|家数|机构数|项目数|个数|多少个|多少家|多少人)/.test(text)) return 'count';
  return 'generic';
}

function extractMetricValueFromSentence(sentence: string, terms: string[]) {
  if (isLikelyTocOrNavigationSentence(sentence)) return undefined;
  if (!metricSentenceMatchesScope(sentence, terms)) return undefined;

  const kind = inferMetricKind(terms, sentence);
  if (kind === 'area') return extractScopedAreaLikeValue(sentence, terms) ?? extractAreaLikeValue(sentence);
  if (kind === 'money') return extractMoneyLikeValue(sentence);
  if (kind === 'ratio') return extractRatioLikeValue(sentence);
  if (kind === 'count') return extractCountLikeValue(sentence);

  return (
    extractMoneyLikeValue(sentence) ??
    extractAreaLikeValue(sentence) ??
    extractRatioLikeValue(sentence) ??
    extractCountLikeValue(sentence) ??
    extractLooseMagnitudeValue(sentence)
  );
}

function metricSentenceMatchesScope(sentence: string, terms: string[]) {
  const scope = inferMetricScope(terms.join(''));
  if (!scope) return true;

  const normalizedSentence = normalize(sentence);
  const ownTerms = metricScopeTerms[scope];
  if (ownTerms.some((term) => normalizedSentence.includes(normalize(term)))) return true;

  return false;
}

function metricSentenceConfidence(sentence: string, terms: string[]): MetricAnswer['confidence'] {
  const normalizedSentence = normalize(sentence);
  const strongTermHit = terms.some((term) => {
    const normalizedTerm = normalize(term);
    return normalizedTerm.length >= 4 && normalizedSentence.includes(normalizedTerm);
  });
  const equivalentTermHit = metricSentenceHasEquivalentSignal(sentence, terms);
  const metricVerbHit = /(为|约|达到|合计|总计|预计|测算|收入|营收|[:：])/.test(sentence);
  return (strongTermHit || equivalentTermHit) && metricVerbHit ? 'high' : 'medium';
}

function metricSentenceHasEquivalentSignal(sentence: string, terms: string[]) {
  const termText = terms.join('');
  const kind = inferMetricKind(terms, sentence);
  if (kind === 'area') {
    const wantsBuildingArea = /建筑面积/.test(termText);
    if (wantsBuildingArea) return /建筑面积/.test(sentence);
    const wantsLandArea = /(土地|用地|占地|土地面积|用地面积|占地面积)/.test(termText);
    return wantsLandArea && /(土地面积|用地面积|占地面积|土地|用地|占地)/.test(sentence);
  }
  return false;
}

function adjustMetricConfidence(
  confidence: MetricAnswer['confidence'],
  value: string,
  sentence: string,
  terms: string[],
): MetricAnswer['confidence'] {
  if (confidence !== 'high') return confidence;
  if (isYuanOnlyRevenueValue(value, sentence, terms)) return 'medium';
  if (isLooseWanMetricValue(value, sentence, terms)) return 'medium';
  return confidence;
}

function metricMediumReason(value: string, sentence: string, terms: string[]) {
  if (isYuanOnlyRevenueValue(value, sentence, terms)) {
    return '金额单位为元，且问题是收入/营收类指标，可能存在表格单位或 OCR 单位丢失';
  }
  if (isLooseWanMetricValue(value, sentence, terms)) {
    return '数值只出现“万”这类量级词，缺少平方米、亩、万元等明确单位，上下文仍需确认';
  }
  return '来源句包含部分指标词和金额单位，但上下文仍需确认';
}

function isYuanOnlyRevenueValue(value: string, sentence: string, terms: string[]) {
  const normalizedValue = value.replace(/\s+/g, '');
  if (!/元$/.test(normalizedValue) || /(万元|亿元)$/.test(normalizedValue)) return false;
  const normalizedTerms = terms.join('');
  const revenueLike = /(收入|营收|年均|年收入|总收入|合计)/.test(`${normalizedTerms}${sentence}`);
  const explicitSmallUnit = /(单价|价格|费用|成本|每次|每人|每平|元\/|元每)/.test(sentence);
  return revenueLike && !explicitSmallUnit;
}

function isLooseWanMetricValue(value: string, sentence: string, terms: string[]) {
  const normalizedValue = value.replace(/\s+/g, '');
  if (!/^[0-9][0-9,]*(?:\.[0-9]+)?万$/.test(normalizedValue)) return false;
  const metricLike = /(面积|土地|规模|收入|营收|总额|合计|数量|人数)/.test(`${terms.join('')}${sentence}`);
  return metricLike;
}

function extractCurrencyLikeValue(text: string) {
  return extractMetricValueFromSentence(text, []);
}

function extractMoneyLikeValue(text: string) {
  const currencyMatch = text.match(/(?:人民币|RMB)?\s*([0-9][0-9,，]*(?:\.[0-9]+)?\s*(?:亿元|万元|元))/i);
  if (currencyMatch?.[1]) return normalizeMetricValue(currencyMatch[1]);

  if (/(收入|营收|金额|费用|成本|投资|利润|价格|总额|合计|年均)/.test(text)) {
    const looseMatch = text.match(/([0-9][0-9,，]*(?:\.[0-9]+)?\s*(?:亿|万))(?!平方米|平米|㎡|亩|公顷|人|家|个|套|间|床|户)/);
    if (looseMatch?.[1]) return normalizeMetricValue(looseMatch[1]);
  }

  return undefined;
}

function extractAreaLikeValue(text: string) {
  const areaMatch = findAreaLikeValueMatches(text)[0];
  if (areaMatch) return areaMatch.value;

  if (/(面积|土地|用地|占地|建筑面积|住宅|宅地)/.test(text)) {
    const looseWanMatch = text.match(/([0-9][0-9,，]*(?:\.[0-9]+)?\s*万)(?!元|人|家|个|套|间|床|户)/);
    if (looseWanMatch?.[1]) return normalizeMetricValue(looseWanMatch[1]);
  }

  return undefined;
}

function extractScopedAreaLikeValue(text: string, terms: string[]) {
  const matches = findAreaLikeValueMatches(text);
  if (matches.length <= 1) return matches[0]?.value;

  const scope = inferMetricScope(terms.join(''));
  if (!scope) return undefined;

  const scopeIndexes = findAllTermIndexes(text, metricScopeTerms[scope]);
  if (scopeIndexes.length === 0) return undefined;

  return matches
    .slice()
    .sort((left, right) =>
      distanceToNearestIndex(left.index, scopeIndexes) - distanceToNearestIndex(right.index, scopeIndexes) ||
      afterScopePenalty(left.index, scopeIndexes) - afterScopePenalty(right.index, scopeIndexes))
    [0]?.value;
}

function findAreaLikeValueMatches(text: string) {
  const matches = [...text.matchAll(/([0-9][0-9,，]*(?:\.[0-9]+)?\s*(?:万平方米|平方米|平米|㎡|亩|公顷))/g)]
    .map((match) => ({
      value: normalizeMetricValue(match[1] ?? ''),
      index: match.index ?? 0,
    }))
    .filter((match) => match.value.length > 0);

  if (/(面积|土地|用地|占地|建筑面积|住宅|宅地)/.test(text)) {
    matches.push(...[...text.matchAll(/([0-9][0-9,，]*(?:\.[0-9]+)?\s*万)(?!元|人|家|个|套|间|床|户)/g)]
      .map((match) => ({
        value: normalizeMetricValue(match[1] ?? ''),
        index: match.index ?? 0,
      }))
      .filter((match) => match.value.length > 0));
  }

  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${match.value}:${match.index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findAllTermIndexes(text: string, terms: string[]) {
  const lowerText = text.toLowerCase();
  const indexes: number[] = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (!needle) continue;
    let fromIndex = 0;
    while (fromIndex < lowerText.length) {
      const index = lowerText.indexOf(needle, fromIndex);
      if (index < 0) break;
      indexes.push(index);
      fromIndex = index + Math.max(needle.length, 1);
    }
  }
  return indexes;
}

function distanceToNearestIndex(index: number, targets: number[]) {
  return Math.min(...targets.map((target) => Math.abs(index - target)));
}

function afterScopePenalty(index: number, targets: number[]) {
  const nearest = targets.slice().sort((left, right) => Math.abs(index - left) - Math.abs(index - right))[0] ?? 0;
  return index >= nearest ? 0 : 1;
}

function extractRatioLikeValue(text: string) {
  const ratioMatch = text.match(/([0-9][0-9,，]*(?:\.[0-9]+)?\s*%)/);
  if (ratioMatch?.[1]) return normalizeMetricValue(ratioMatch[1]);

  return undefined;
}

function extractCountLikeValue(text: string) {
  const genericUnitMatch = text.match(/([0-9][0-9,，]*(?:\.[0-9]+)?\s*(?:人|家|个|套|间|床|户))/);
  if (genericUnitMatch?.[1]) return normalizeMetricValue(genericUnitMatch[1]);

  return undefined;
}

function extractLooseMagnitudeValue(text: string) {
  const looseMatch = text.match(/([0-9][0-9,，]*(?:\.[0-9]+)?\s*(?:亿|万))/);
  if (looseMatch?.[1]) return normalizeMetricValue(looseMatch[1]);

  return undefined;
}

function normalizeMetricLabel(label: string) {
  return label
    .replace(/^(这个|该|其)/, '')
    .replace(/是多少|多少|为多少|是几|几/g, '')
    .trim() || '相关数值';
}

export function expectedMetricLabel(question: string) {
  return normalizeMetricLabel(buildMetricTerms(question)[0] ?? '相关数值');
}

function normalizeMetricValue(value: string) {
  return value.replace(/，/g, ',').replace(/\s+/g, '');
}

function metricValueCandidates(value: string) {
  const normalized = normalizeMetricValue(value);
  const spacedWan = normalized.replace(/(万)(元|平方米)?$/, ' $1$2');
  const compactUnit = normalized
    .replace(/平方米$/, '㎡')
    .replace(/平米$/, '㎡');
  return uniqueStrings([normalized, spacedWan, compactUnit, normalized.replace(/㎡$/, '平方米')]);
}

export function normalizeEvidenceForMetric(value: string) {
  return value
    .replace(/[`>#*_]+/g, ' ')
    .replace(/万\s+元/g, '万元')
    .replace(/亿\s+元/g, '亿元')
    .replace(/([一-龥])\s+(?=[一-龥])/g, '$1')
    .replace(/([0-9])\s+(?=[0-9])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}


function evidenceTextMatches(text: string, term: string) {
  const normalizedText = normalize(text);
  const normalizedTerm = normalize(term);
  if (!normalizedText || !normalizedTerm) return false;
  return normalizedText.includes(normalizedTerm) || isSubsequence(normalizedTerm, normalizedText);
}

function findFirstTermIndex(text: string, terms: string[]) {
  const lowerText = text.toLowerCase();
  const indexes = terms
    .flatMap((term) => [term, term.replace(/\s+/g, '')])
    .map((term) => lowerText.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0);

  return indexes.length > 0 ? Math.min(...indexes) : -1;
}

function snippetAround(value: string, index: number, radius = 150) {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (index < 0) return snippet(compact, radius * 2);

  const start = Math.max(0, index - radius);
  const end = Math.min(compact.length, index + radius);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < compact.length ? '...' : '';
  return `${prefix}${compact.slice(start, end)}${suffix}`;
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
  return value
    .toLowerCase()
    .replace(/[^一-龥a-z0-9]/g, '')
    .trim();
}

function isSubsequence(needle: string, haystack: string) {
  if (!needle || !haystack) return false;
  let cursor = 0;
  for (const char of haystack) {
    if (char === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return true;
  }
  return false;
}
