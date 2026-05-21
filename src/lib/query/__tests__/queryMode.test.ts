import { describe, expect, it } from 'vitest';
import { classifyQueryMode } from '../queryMode';

describe('query mode classifier', () => {
  it('keeps pure chat out of wiki retrieval', () => {
    const mode = classifyQueryMode('你好');

    expect(mode.kind).toBe('chat');
    expect(mode.retrieval.profile).toBe('none');
    expect(mode.chatIntent?.isChat).toBe(true);
  });

  it('routes direct facts to lookup/direct', () => {
    const mode = classifyQueryMode('福瑞三期什么时候完工');

    expect(mode.kind).toBe('lookup');
    expect(mode.answerShape).toBe('direct');
    expect(mode.retrieval.pageLimit).toBe(8);
  });

  it('folds list questions into lookup with a list answer shape', () => {
    const mode = classifyQueryMode('福瑞三期有哪些业态');

    expect(mode.kind).toBe('lookup');
    expect(mode.answerShape).toBe('list');
    expect(mode.retrieval.pageLimit).toBe(10);
  });

  it('uses compact table shape for metric lists', () => {
    const mode = classifyQueryMode('福瑞三期各业态面积分别是多少');

    expect(mode.kind).toBe('lookup');
    expect(mode.answerShape).toBe('compact_table');
  });

  it('routes open risk and suggestion questions to analysis', () => {
    const mode = classifyQueryMode('福瑞三期运营难点和建议');

    expect(mode.kind).toBe('analysis');
    expect(mode.answerShape).toBe('analysis');
    expect(mode.retrieval.includeWorkspaceContext).toBe(true);
  });

  it('routes fact plus risk questions to mixed', () => {
    const mode = classifyQueryMode('福瑞三期什么时候运营，有什么风险');

    expect(mode.kind).toBe('mixed');
    expect(mode.retrieval.pageLimit).toBe(12);
  });
});
