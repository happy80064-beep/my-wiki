import { describe, expect, it } from 'vitest';
import { buildQueryAnswerPrompt, normalizeQueryAnswerResponse } from '../queryAnswer';
import { classifyQueryMode } from '../queryMode';

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
    expect(prompt).toContain('本轮是开放分析或混合查询');
  });

  it('keeps lookup prompts short and strict', () => {
    const prompt = buildQueryAnswerPrompt({
      question: '福瑞科技园三期什么时候完工？',
      indexSummary: '',
      queryMode: classifyQueryMode('福瑞科技园三期什么时候完工？'),
      pages: [
        {
          index: 1,
          entityId: 'project_1',
          type: 'project',
          title: '福瑞健康科技园三期项目',
          href: '/wiki/project/project_1',
          summary: '项目概述',
          content: '预计 2029 年投入运营，当前 Wiki 未明确写出完工日期。',
          score: 120,
        },
      ],
    });

    expect(prompt).toContain('Mode: lookup');
    expect(prompt).toContain('Answer shape: direct');
    expect(prompt).toContain('本轮是单点事实查询');
    expect(prompt).toContain('直接短答通常不超过 120 中文字');
    expect(prompt).not.toContain('通常 600-1200 中文字');
  });

  it('adds workspace context without making it citable evidence', () => {
    const prompt = buildQueryAnswerPrompt({
      question: '福瑞三期未来运营风险怎么优化？',
      indexSummary: '',
      queryMode: classifyQueryMode('福瑞三期未来运营风险怎么优化？'),
      workspaceContext: {
        purpose: '关注园区运营与招商。',
        index: '- 福瑞健康科技园三期项目：医康旅一体化。',
        files: [
          {
            path: 'raw/sources/report.md',
            title: '可研报告',
            kind: 'source',
            excerpt: '原始材料片段',
            score: 18,
          },
        ],
      },
      pages: [
        {
          index: 1,
          entityId: 'project_1',
          type: 'project',
          title: '福瑞健康科技园三期项目',
          href: '/wiki/project/project_1',
          summary: '项目概述',
          content: '医疗资质、招商和空置率需要关注。',
          score: 120,
        },
      ],
    });

    expect(prompt).toContain('Workspace Context (scope and candidate material only)');
    expect(prompt).toContain('不能替代编号页引用');
    expect(prompt).toContain('raw/sources/report.md');
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
