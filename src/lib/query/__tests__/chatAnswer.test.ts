import { describe, expect, it } from 'vitest';
import { buildQueryChatPrompt, normalizeQueryChatResponse } from '../chatAnswer';

describe('query chat answer helpers', () => {
  it('builds a no-retrieval chat prompt', () => {
    const prompt = buildQueryChatPrompt({
      question: '你好',
      intentLabel: '问候/寒暄',
    });

    expect(prompt).toContain('不是知识库检索任务');
    expect(prompt).toContain('不要声称已经检索 Wiki');
    expect(prompt).toContain('## User Message');
    expect(prompt).toContain('你好');
  });

  it('normalizes model chat output', () => {
    const normalized = normalizeQueryChatResponse('<think>hidden</think>\n你好，我在。<!-- cited: 1 -->');

    expect(normalized).toBe('你好，我在。');
  });
});
