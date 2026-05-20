import { describe, expect, it } from 'vitest';
import type { StructuredQueryResult } from '@/lib/graph/types';
import type { RetrievedWikiPage } from '../wikiRetrieval';
import { buildComplexQueryEvidenceTrace, buildEntityPageAlignment, buildSimpleQueryEvidenceTrace } from '../evidenceReport';
import { understandQuery } from '../queryUnderstanding';

function makePage(input: Partial<RetrievedWikiPage> & Pick<RetrievedWikiPage, 'index' | 'entityId' | 'title'>): RetrievedWikiPage {
  return {
    type: 'project',
    href: `/wiki/project/${input.entityId}`,
    summary: '',
    content: '',
    score: 100,
    aliases: [],
    relatedEntityIds: [],
    matchedTerms: [],
    ...input,
  };
}

describe('query evidence report', () => {
  it('builds simple-query evidence layers without exposing filtered candidates', () => {
    const structured: StructuredQueryResult = {
      answer: '福瑞科技园三期没有明确写出完工日期。',
      sources: [
        { type: 'entity', id: 'p1', title: '福瑞科技园三期' },
        { type: 'entry', id: 'e1', title: '原始材料 1' },
      ],
      suggestions: [],
    };

    const trace = buildSimpleQueryEvidenceTrace({
      structured,
      retrievedPages: [makePage({ index: 1, entityId: 'p1', title: '福瑞科技园三期' })],
      understanding: understandQuery('福瑞科技园三期什么时候完工'),
    });

    const detail = trace.map((step) => step.detail).join('\n');
    expect(detail).toContain('结构化命中：福瑞科技园三期');
    expect(detail).toContain('原始材料补充：原始材料 1');
    expect(detail).toContain('当前答案存在缺口');
    expect(detail).not.toContain('被过滤');
    expect(detail).not.toContain('filtered');
  });

  it('reports aligned structured entities and wiki pages for complex queries', () => {
    const structured: StructuredQueryResult = {
      answer: '草稿',
      sources: [{ type: 'entity', id: 'p1', title: '福瑞健康科技园三期项目' }],
      suggestions: [],
    };

    const alignment = buildEntityPageAlignment(structured, [
      makePage({ index: 1, entityId: 'p1', title: '福瑞健康科技园三期项目' }),
    ]);

    expect(alignment).toContain('对齐');
    expect(alignment).toContain('福瑞健康科技园三期项目');
  });

  it('reports mismatched entities and pages without listing rejected candidates', () => {
    const structured: StructuredQueryResult = {
      answer: '草稿',
      sources: [{ type: 'entity', id: 'p1', title: 'A 项目' }],
      suggestions: [],
    };

    const trace = buildComplexQueryEvidenceTrace({
      structured,
      retrievedPages: [makePage({ index: 1, entityId: 'p2', title: 'B 项目' })],
    });

    const detail = trace.map((step) => step.detail).join('\n');
    expect(detail).toContain('不完全一致');
    expect(detail).not.toContain('被过滤');
    expect(detail).not.toContain('filtered');
  });
});
