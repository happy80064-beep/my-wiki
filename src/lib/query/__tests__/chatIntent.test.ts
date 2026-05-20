import { describe, expect, it } from 'vitest';
import { detectQueryChatIntent } from '../chatIntent';

describe('query chat intent', () => {
  it('routes casual greetings to the chat lane', () => {
    const intent = detectQueryChatIntent('你好');

    expect(intent.isChat).toBe(true);
    expect(intent.kind).toBe('greeting');
  });

  it('routes assistant capability questions to the chat lane', () => {
    const intent = detectQueryChatIntent('你能做什么？');

    expect(intent.isChat).toBe(true);
    expect(intent.kind).toBe('assistant_meta');
  });

  it('does not steal a knowledge query with a greeting prefix', () => {
    const intent = detectQueryChatIntent('你好，福瑞科技园三期什么时候完工？');

    expect(intent.isChat).toBe(false);
    expect(intent.label).toBe('包含知识库查询意图');
  });

  it('keeps concrete wiki questions in retrieval flow', () => {
    const intent = detectQueryChatIntent('桌面生命体用了哪些模型？');

    expect(intent.isChat).toBe(false);
  });
});
