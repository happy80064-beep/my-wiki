import { describe, expect, it } from 'vitest';
import type { RetrievedWikiPage } from '../wikiRetrieval';
import {
  applyWikiRagPageAnswer,
  buildStructuredSupport,
  buildWikiRagBaseResult,
  buildWikiRagNoContextResult,
} from '../queryPipeline';
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

describe('query pipeline helpers', () => {
  it('builds unified wiki rag results with evidence layers and no filtered candidates', () => {
    const initial = buildWikiRagBaseResult({
      retrievedPages: [makePage({ index: 1, entityId: 'p1', title: '福瑞科技园三期' })],
      queryUnderstanding: understandQuery('福瑞科技园三期什么时候完工'),
      retrievalTrace: ['问题分词：福瑞、完工', 'Wiki 候选页：1 个，实际选入上下文 1 个。'],
      retrievalUsedConversation: false,
      timing: { retrievalMs: 12 },
      formatDuration: (ms) => `${ms}ms`,
    });

    expect(initial.result.sources).toHaveLength(1);
    expect(initial.result.trace?.some((step) => step.label === 'Wiki 页面检索')).toBe(true);
    expect(initial.result.trace?.some((step) => step.label === '查询理解')).toBe(true);
    expect(initial.result.trace?.some((step) => step.label === '证据分层')).toBe(true);
    expect(initial.result.trace?.map((step) => step.detail).join('\n')).not.toContain('filtered');
    expect(initial.result.trace?.map((step) => step.detail).join('\n')).not.toContain('被过滤');
  });

  it('applies page-level answers with cited wiki references', () => {
    const pages = [makePage({ index: 1, entityId: 'p1', title: '福瑞健康科技园三期项目' })];
    const initial = buildWikiRagBaseResult({
      retrievedPages: pages,
      queryUnderstanding: understandQuery('福瑞健康科技园三期项目的商业模式是什么？'),
      retrievalTrace: ['选入上下文 1 个。'],
      retrievalUsedConversation: false,
      timing: { retrievalMs: 20 },
      formatDuration: (ms) => `${ms}ms`,
    });

    const applied = applyWikiRagPageAnswer({
      result: initial.result,
      retrievedPages: pages,
      answered: {
        answer: '**结论：** 医康旅一体化。[1]',
        citedIndices: [1],
        provider: 'minimax',
        model: 'MiniMax-M2.7',
      },
      answerMs: 1200,
      formatDuration: (ms) => `${ms}ms`,
      formatProviderTimingDetail: () => '',
    });

    expect(applied.result.answer).toContain('医康旅一体化');
    expect(applied.references).toHaveLength(1);
    expect(applied.result.trace?.some((step) => step.label === 'Query 回答')).toBe(true);
  });

  it('returns a visible no-context result without pretending success', () => {
    const noContext = buildWikiRagNoContextResult({
      question: '不存在项目是什么？',
      queryUnderstanding: understandQuery('不存在项目是什么？'),
      retrievalTrace: ['Wiki 候选页：0 个，实际选入上下文 0 个。'],
      retrievalUsedConversation: false,
      timing: { retrievalMs: 6 },
      formatDuration: (ms) => `${ms}ms`,
    });

    expect(noContext.result.answer).toContain('当前 Wiki 没有检索到足以回答这个问题的页面');
    expect(noContext.result.sources).toHaveLength(0);
    expect(noContext.result.trace?.map((step) => step.detail).join('\n')).toContain('没有调用回答模型');
  });

  it('passes query understanding into structured support hints for compatibility callers', () => {
    const support = buildStructuredSupport({
      queryUnderstanding: understandQuery('福瑞科技园三期什么时候完工'),
      structured: {
        answer: '草稿',
        sources: [{ type: 'entity', id: 'p1', title: '福瑞科技园三期' }],
        suggestions: [],
      },
    });

    expect(support.keyHints.join('\n')).toContain('Query Understanding');
    expect(support.keyHints.join('\n')).toContain('completionDate');
  });
});
