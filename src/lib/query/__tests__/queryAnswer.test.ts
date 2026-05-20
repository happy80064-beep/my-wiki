import { describe, expect, it } from 'vitest';
import { buildQueryAnswerPrompt, normalizeQueryAnswerResponse } from '../queryAnswer';

describe('query answer prompt helpers', () => {
  it('builds a wiki-page-first answer prompt', () => {
    const prompt = buildQueryAnswerPrompt({
      question: '健康科技园三期的商业模式是什么？',
      indexSummary: '- 福瑞健康科技园三期项目（project）：围绕医康旅一体化展开。',
      pages: [
        {
          index: 1,
          entityId: 'project_1',
          type: 'project',
          title: '福瑞健康科技园三期项目',
          href: '/wiki/project/project_1',
          summary: '项目概述',
          content: '# 福瑞健康科技园三期项目\n\n## 商业模式\n医康旅一体化',
          score: 120,
        },
      ],
      structuredSupport: {
        draftAnswer: '草稿答案',
        keyHints: ['预计年均营收 4.22 亿元'],
      },
    });

    expect(prompt).toContain('严格基于提供的编号 Wiki 页面回答用户问题');
    expect(prompt).toContain('## Selected Wiki Pages');
    expect(prompt).toContain('[1] 福瑞健康科技园三期项目');
    expect(prompt).toContain('Structured Support');
    expect(prompt).toContain('专业、严谨、内容精炼');
    expect(prompt).toContain('不要补编页面没有明示的信息');
    expect(prompt).toContain('开放性问题通常不超过 600 中文字');
  });

  it('can build a pure wiki-page prompt without structured-query draft contamination', () => {
    const prompt = buildQueryAnswerPrompt({
      question: '这个项目未来运营有什么风险？',
      indexSummary: '- 福瑞健康科技园三期项目（entity）：医康旅一体化项目。',
      pages: [
        {
          index: 1,
          entityId: 'project_1',
          type: 'entity',
          title: '福瑞健康科技园三期项目',
          href: '/wiki/project/project_1',
          summary: '项目概述',
          content: '# 福瑞健康科技园三期项目\n\n## 风险\n医疗资质、招商和空置率需要关注。',
          score: 120,
        },
      ],
    });

    expect(prompt).toContain('Selected Wiki Pages');
    expect(prompt).not.toContain('Structured Support');
    expect(prompt).not.toContain('草稿答案');
  });

  it('parses cited indices from model output and strips the comment', () => {
    const normalized = normalizeQueryAnswerResponse(
      '项目的商业模式是医康旅一体化，核心包括智算中心与医疗服务。[1][2]\n<!-- cited: 1, 2 -->',
      'fallback',
    );

    expect(normalized.answer).toContain('医康旅一体化');
    expect(normalized.answer).not.toContain('<!-- cited');
    expect(normalized.citedIndices).toEqual([1, 2]);
  });

  it('strips model thinking blocks and keeps inferred citations', () => {
    const normalized = normalizeQueryAnswerResponse(
      '<think>先分析资料。</think>\n**结论：** 项目需要关注招商和医疗资质。[2]',
      'fallback',
    );

    expect(normalized.answer).toBe('**结论：** 项目需要关注招商和医疗资质。[2]');
    expect(normalized.citedIndices).toEqual([2]);
  });

  it('falls back to the provided answer when model output is empty', () => {
    const normalized = normalizeQueryAnswerResponse('<!-- cited: 1 -->', '原始草稿');
    expect(normalized.answer).toBe('原始草稿');
    expect(normalized.citedIndices).toEqual([1]);
  });
});
