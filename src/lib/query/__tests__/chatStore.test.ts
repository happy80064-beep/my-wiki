import { beforeEach, describe, expect, it } from 'vitest';
import { useQueryChatStore } from '../chatStore';

describe('query chat store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useQueryChatStore.getState().clearAll();
  });

  it('creates a conversation and derives the title from the first user turn', () => {
    const conversationId = useQueryChatStore.getState().createConversation();
    expect(useQueryChatStore.getState().activeConversationId).toBe(conversationId);

    const message = useQueryChatStore.getState().addUserMessage('健康科技园三期的商业模式是什么？');
    expect(message?.conversationId).toBe(conversationId);
    expect(useQueryChatStore.getState().conversations[0]?.title).toBe('健康科技园三期的商业模式是什么？');
  });

  it('stores assistant answers with references and supports removing the latest assistant message', () => {
    const conversationId = useQueryChatStore.getState().createConversation();
    useQueryChatStore.getState().addUserMessage('这个项目的风险点是什么？');
    const assistant = useQueryChatStore.getState().addAssistantMessage(
      '这个项目的风险点是什么？',
      '这里是答案',
      {
        answer: '这里是答案',
        sources: [{ type: 'entity', id: 'e1', title: '福瑞健康科技园三期项目', href: '/wiki/project/p1' }],
        suggestions: ['继续问这个项目的合作模式'],
      },
      [{ key: 'entity:e1', type: 'entity', title: '福瑞健康科技园三期项目', href: '/wiki/project/p1' }],
    );

    expect(assistant?.references).toHaveLength(1);
    expect(useQueryChatStore.getState().getActiveMessages()).toHaveLength(2);

    useQueryChatStore.getState().removeLastAssistantMessage(conversationId);
    expect(useQueryChatStore.getState().getActiveMessages()).toHaveLength(1);
  });

  it('scopes conversations to the active workspace root', () => {
    useQueryChatStore.getState().setWorkspaceRoot('D:/Wiki/A');
    const firstConversationId = useQueryChatStore.getState().createConversation('A 项目');
    useQueryChatStore.getState().addUserMessage('A 的问题');

    useQueryChatStore.getState().setWorkspaceRoot('D:/Wiki/B');
    expect(useQueryChatStore.getState().activeConversationId).toBeNull();
    const secondConversationId = useQueryChatStore.getState().createConversation('B 项目');
    useQueryChatStore.getState().addUserMessage('B 的问题');

    expect(secondConversationId).not.toBe(firstConversationId);
    expect(useQueryChatStore.getState().getActiveMessages().map((message) => message.content)).toEqual(['B 的问题']);

    useQueryChatStore.getState().setWorkspaceRoot('D:/Wiki/A');
    expect(useQueryChatStore.getState().activeConversationId).toBe(firstConversationId);
    expect(useQueryChatStore.getState().getActiveMessages().map((message) => message.content)).toEqual(['A 的问题']);
  });
});
