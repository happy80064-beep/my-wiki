import type { ResearchWikiContext, WebSearchResult } from './store';

export function classifyWebResultsForResearchContext(
  webResults: WebSearchResult[],
  wikiContext: ResearchWikiContext[],
  question: string,
) {
  if (wikiContext.length === 0 || webResults.length === 0) return webResults;
  const projectTerms = buildResearchProjectTerms(question, wikiContext);
  if (projectTerms.length === 0) return webResults;
  return webResults.map((result) => {
    const text = normalizeResearchText(`${result.title} ${result.snippet} ${result.source}`);
    const direct = projectTerms.some((term) => text.includes(term));
    return direct
      ? { ...result, relevance: 'direct' as const }
      : {
          ...result,
          relevance: 'weak' as const,
          relevanceReason: '未命中当前 Wiki 项目关键词，仅可作为策划方法或行业案例参考',
        };
  });
}

function buildResearchProjectTerms(question: string, wikiContext: ResearchWikiContext[]) {
  const projectPages = wikiContext.filter(isProjectContextPage);
  const boundaryPages = projectPages.length ? projectPages : wikiContext.slice(0, 1);
  const values = [
    ...extractProjectCandidates(question),
    ...boundaryPages.flatMap((page) => [page.title, page.path ? fileStem(page.path) : '']),
  ];
  const stopTerms = new Set(['项目', '事项', '健康', '医疗', '科技', '园区', '三期', '业态', '研究', '概念']);
  return uniqueStrings(
    values.flatMap((value) => {
      const normalized = normalizeResearchText(value);
      const withoutGenericSuffix = normalized.replace(/项目|事项/g, '');
      const withoutHealthDescriptor = withoutGenericSuffix.replace(/健康(?=科技园|产业园|园区)/g, '');
      const withoutStage = withoutGenericSuffix.replace(/[一二三四五六七八九十]期.*$/g, '');
      return [normalized, withoutGenericSuffix, withoutHealthDescriptor, withoutStage];
    }),
  )
    .map(normalizeResearchText)
    .filter((term) => term.length >= 4 && !stopTerms.has(term))
    .slice(0, 40);
}

function isProjectContextPage(page: ResearchWikiContext) {
  return /(^|[\\/])projects[\\/]/i.test(page.path ?? '') || /项目|园区|园|地块|基地|中心|公司|集团|商圈|医院/.test(page.title);
}

function extractProjectCandidates(question: string) {
  return uniqueStrings(
    [...question.matchAll(/([\u4e00-\u9fa5A-Za-z0-9]{2,30}(?:项目|园区|园|一期|二期|三期|四期|五期|地块|基地|中心|公司|集团|商圈|医院|综合体))/g)].map((match) =>
      trimProjectCandidatePrefix(match[1] ?? ''),
    ),
  );
}

function trimProjectCandidatePrefix(value: string) {
  let candidate = value.trim();
  for (const marker of ['针对', '围绕', '关于', '基于', '面向', '给', '为']) {
    const index = candidate.lastIndexOf(marker);
    if (index >= 0 && index < candidate.length - marker.length) {
      candidate = candidate.slice(index + marker.length);
    }
  }
  return candidate.replace(/^(如果|请|帮我|我想|想要|想|需要|可以|能否|请你|你可以|帮忙|看看|分析)+/g, '');
}

function fileStem(path: string) {
  const normalized = path.replace(/\\/g, '/');
  const filename = normalized.split('/').pop() ?? normalized;
  return filename.replace(/\.[^.]+$/g, '');
}

function normalizeResearchText(value: string) {
  return value.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  return values
    .map((value) => value.trim())
    .filter((value) => {
      if (!value) return false;
      const key = normalizeResearchText(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
