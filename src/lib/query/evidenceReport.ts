import type { StructuredQueryResult, QueryTraceStep } from '@/lib/graph/types';
import type { RetrievedWikiPage } from './wikiRetrieval';
import type { QueryUnderstanding } from './queryUnderstanding';

export function buildWikiRagEvidenceTrace(input: {
  retrievedPages: RetrievedWikiPage[];
  understanding: QueryUnderstanding;
}): QueryTraceStep[] {
  const topPages = input.retrievedPages.slice(0, 6);
  const directPages = topPages.filter((page) => page.score >= 0);
  const relatedPages = topPages.filter((page) => page.score < 0);
  const guidance = input.understanding.guidance[0] ?? '根据 Wiki 证据综合回答。';

  return [
    {
      layer: 'evidence',
      label: '证据分层',
      detail: [
        directPages.length
          ? `Wiki 页面证据：${directPages.map((page) => `[${page.index}] ${page.title}`).join('、')}`
          : 'Wiki 页面证据：无',
        relatedPages.length ? `关系扩展证据：${relatedPages.map((page) => `[${page.index}] ${page.title}`).join('、')}` : '',
        `回答约束：${guidance}`,
      ]
        .filter(Boolean)
        .join('；'),
    },
    {
      layer: 'answer',
      label: '完整性判断',
      detail: '回答将以已选入的 Wiki 页面为证据边界；页面未覆盖的信息需要在回答中明确标注“当前 Wiki 不能确认”。',
    },
  ];
}

export function buildSimpleQueryEvidenceTrace(input: {
  structured: StructuredQueryResult;
  retrievedPages: RetrievedWikiPage[];
  understanding: QueryUnderstanding;
}): QueryTraceStep[] {
  const trace: QueryTraceStep[] = [];
  const entitySources = input.structured.sources.filter((source) => source.type === 'entity');
  const entrySources = input.structured.sources.filter((source) => source.type === 'entry');

  trace.push({
    layer: 'evidence',
    label: '证据分层',
    detail: [
      entitySources.length ? `结构化命中：${entitySources.slice(0, 5).map((source) => source.title).join('、')}` : '结构化命中：无明确 Wiki 实体',
      entrySources.length ? `原始材料补充：${entrySources.slice(0, 4).map((source) => source.title).join('、')}` : '原始材料补充：无',
      input.retrievedPages.length
        ? `可追溯 Wiki 页面：${input.retrievedPages.slice(0, 5).map((page) => page.title).join('、')}`
        : '可追溯 Wiki 页面：无',
    ].join('；'),
  });

  trace.push({
    layer: 'answer',
    label: '完整性判断',
    detail: buildCompletenessDetail(input.structured.answer, input.understanding),
  });

  return trace;
}

export function buildComplexQueryEvidenceTrace(input: {
  structured: StructuredQueryResult;
  retrievedPages: RetrievedWikiPage[];
}): QueryTraceStep[] {
  const topPages = input.retrievedPages.slice(0, 6);
  const aligned = buildEntityPageAlignment(input.structured, topPages);
  return [
    {
      layer: 'evidence',
      label: '页面/实体对齐',
      detail: aligned,
    },
    {
      layer: 'evidence',
      label: '证据分层',
      detail: [
        topPages.length ? `Wiki 页面证据：${topPages.map((page) => `[${page.index}] ${page.title}`).join('、')}` : 'Wiki 页面证据：无',
        input.structured.sources.length
          ? `结构化辅助线索：${input.structured.sources.slice(0, 6).map((source) => source.title).join('、')}`
          : '结构化辅助线索：无',
      ].join('；'),
    },
  ];
}

export function buildEntityPageAlignment(structured: StructuredQueryResult, pages: RetrievedWikiPage[]) {
  const structuredTitles = uniqueTitles([
    ...(structured.candidates ?? []).map((entity) => entity.title),
    ...structured.sources.filter((source) => source.type === 'entity').map((source) => source.title),
  ]);
  const pageTitles = pages.map((page) => page.title);

  if (pageTitles.length === 0 && structuredTitles.length === 0) {
    return '没有命中明确 Wiki 页面或结构化实体。';
  }
  if (pageTitles.length === 0) {
    return `结构化查询命中 ${structuredTitles.slice(0, 5).join('、')}，但页面检索没有选入可回答的 Wiki 页面。`;
  }
  if (structuredTitles.length === 0) {
    return `页面检索选入 ${pageTitles.slice(0, 5).join('、')}；结构化查询未命中明确实体，仅作为页面级回答。`;
  }

  const normalizedPages = pageTitles.map(normalizeTitle);
  const matched = structuredTitles.filter((title) =>
    normalizedPages.some((pageTitle) => pageTitle.includes(normalizeTitle(title)) || normalizeTitle(title).includes(pageTitle)),
  );
  if (matched.length > 0) {
    return `结构化实体与页面检索对齐：${matched.slice(0, 5).join('、')}。`;
  }

  return `结构化实体（${structuredTitles.slice(0, 5).join('、')}）与页面检索（${pageTitles.slice(0, 5).join('、')}）不完全一致，回答优先以选入 Wiki 页面为准。`;
}

function buildCompletenessDetail(answer: string, understanding: QueryUnderstanding) {
  if (/(没有找到|未找到|没有明确|未明确|未写明|未披露|无法确认|不能确认|不确定|不足以)/.test(answer)) {
    return `当前答案存在缺口：${understanding.guidance[0] ?? '知识库没有足够证据直接回答'}。可以补充材料或触发补充/深度研究。`;
  }
  if (understanding.answerStyle === 'direct') {
    return '已按查询型需求返回直接答案；如需解释原因，可继续追问。';
  }
  if (understanding.answerStyle === 'brief_list') {
    return '已按查询型需求返回短列表；列表范围以命中的结构化证据和关联原始材料为准。';
  }
  return '已返回综合答案，并保留可追溯来源。';
}

function uniqueTitles(values: string[]) {
  const seen = new Set<string>();
  return values
    .map((value) => value.trim())
    .filter((value) => {
      const key = normalizeTitle(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeTitle(value: string) {
  return value.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
}
