import { describe, expect, it } from 'vitest';
import { buildConversationTitle, buildQueryReferences, stripAnswerForCopy } from '../chatHelpers';

describe('query chat helpers', () => {
  it('builds a compact conversation title from the first question', () => {
    expect(buildConversationTitle('')).toBe('新对话');
    expect(buildConversationTitle('健康科技园三期的商业模式是什么？')).toBe('健康科技园三期的商业模式是什么？');
    expect(buildConversationTitle('这是一个特别特别长的问题，需要被截断，不然左侧会话列表会变得很难看。')).toContain('…');
  });

  it('converts structured query sources into references', () => {
    const references = buildQueryReferences({
      answer: 'test',
      sources: [
        { type: 'entity', id: 'e1', title: '福瑞健康科技园三期项目', href: '/wiki/project/project_1' },
        { type: 'entry', id: 'entry_1', title: '福瑞项目测算书' },
        { type: 'web', id: 'https://example.com/report', title: '外部研究报告', href: 'https://example.com/report' },
      ],
      suggestions: [],
    });

    expect(references).toEqual([
      {
        key: 'entity:e1',
        type: 'entity',
        title: '福瑞健康科技园三期项目',
        href: '/wiki?ref=%E7%A6%8F%E7%91%9E%E5%81%A5%E5%BA%B7%E7%A7%91%E6%8A%80%E5%9B%AD%E4%B8%89%E6%9C%9F%E9%A1%B9%E7%9B%AE',
        preview: {
          kind: 'wiki',
          entityId: 'e1',
          title: '福瑞健康科技园三期项目',
        },
      },
      {
        key: 'entry:entry_1',
        type: 'entry',
        title: '福瑞项目测算书',
        href: '/wiki?source=entry_1',
        preview: {
          kind: 'source',
          entryId: 'entry_1',
          title: '福瑞项目测算书',
        },
      },
      {
        key: 'web:https://example.com/report',
        type: 'web',
        title: '外部研究报告',
        href: 'https://example.com/report',
        preview: {
          kind: 'web',
          title: '外部研究报告',
          url: 'https://example.com/report',
          source: 'example.com',
        },
      },
    ]);
  });

  it('strips trailing whitespace when copying answers', () => {
    expect(stripAnswerForCopy('答案内容\n\n')).toBe('答案内容');
  });

  it('strips hidden comments and thinking blocks when copying answers', () => {
    expect(stripAnswerForCopy('<think>推理</think>\n答案内容\n<!-- cited: 1 -->')).toBe('答案内容');
  });
});
