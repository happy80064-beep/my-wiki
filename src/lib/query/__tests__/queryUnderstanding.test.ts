import { describe, expect, it } from 'vitest';
import { buildLookupRetrievalText, understandQuery } from '../queryUnderstanding';

describe('query understanding', () => {
  it('classifies completion date questions as lookup requests', () => {
    const understanding = understandQuery('福瑞科技园三期什么时候完工');

    expect(understanding.need).toBe('lookup');
    expect(understanding.intent).toBe('time_lookup');
    expect(understanding.attribute).toBe('completionDate');
    expect(understanding.answerStyle).toBe('direct');
    expect(understanding.evidenceTerms).toContain('竣工');
    expect(understanding.evidenceTerms).toContain('投入运营');
  });

  it('rewrites lookup retrieval text without changing the user question intent', () => {
    const understanding = understandQuery('福瑞科技园三期什么时候完工');
    const rewritten = buildLookupRetrievalText('福瑞科技园三期什么时候完工', understanding);

    expect(rewritten).toContain('福瑞科技园三期什么时候完工');
    expect(rewritten).toContain('竣工');
    expect(rewritten).toContain('投入运营');
  });

  it('keeps open analysis questions out of the simple lookup lane', () => {
    const understanding = understandQuery('福瑞科技园三期未来运营风险怎么优化');

    expect(understanding.need).toBe('open');
    expect(understanding.intent).toBe('open_analysis');
    expect(understanding.answerStyle).toBe('synthesis');
  });

  it('keeps commercial model and risk questions in the complex synthesis lane even with 是什么', () => {
    const understanding = understandQuery('福瑞健康科技园三期项目的商业模式和关键风险是什么？');

    expect(understanding.need).toBe('open');
    expect(understanding.intent).toBe('open_analysis');
    expect(understanding.answerStyle).toBe('synthesis');
  });
});
