import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { QueryChatMessage } from '@/lib/query/chatStore';
import { QueryMessageCard } from '../QueryMessageCard';

function renderCard(message: QueryChatMessage) {
  render(
    <MemoryRouter>
      <QueryMessageCard message={message} />
    </MemoryRouter>,
  );
}

describe('QueryMessageCard', () => {
  it('shows web sources before the research conclusion and keeps actions disabled while synthesis is pending', () => {
    const message: QueryChatMessage = {
      id: 'assistant-1',
      role: 'assistant',
      content: '正在根据上方网页来源生成补充研究结论，请稍候。',
      conversationId: 'conv-1',
      timestamp: Date.now(),
      question: '特斯拉最新财报怎么看？',
      references: [
        {
          key: 'web:https://example.com/report',
          type: 'web',
          title: 'Tesla Q1 Report',
          href: 'https://example.com/report',
          preview: {
            kind: 'web',
            title: 'Tesla Q1 Report',
            url: 'https://example.com/report',
            source: 'example.com',
            snippet: 'Revenue grew year over year.',
            content: 'Revenue grew year over year.',
          },
        },
      ],
      result: {
        answer: '正在根据上方网页来源生成补充研究结论，请稍候。',
        sources: [
          {
            type: 'web',
            id: 'https://example.com/report',
            title: 'Tesla Q1 Report',
            href: 'https://example.com/report',
          },
        ],
        suggestions: [],
        trace: [
          {
            layer: 'web',
            label: 'Web Search',
            detail: '围绕问题检索到 1 条网页来源。',
          },
        ],
      },
    };

    renderCard(message);

    const sourcesHeading = screen.getByText('网页来源（1）');
    const conclusionHeading = screen.getByText('研究结论');
    expect(Boolean(sourcesHeading.compareDocumentPosition(conclusionHeading) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
    expect(screen.getByText(/正在根据上方网页来源生成补充研究结论/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '保存到 Wiki' }).hasAttribute('disabled')).toBe(true);
  });

  it('keeps normal wiki answers using the generic reference label', () => {
    const message: QueryChatMessage = {
      id: 'assistant-2',
      role: 'assistant',
      content: '这是普通回答。',
      conversationId: 'conv-1',
      timestamp: Date.now(),
      question: '项目背景是什么？',
      references: [
        {
          key: 'entity:project-overview',
          type: 'entity',
          title: '项目概览',
          href: '/wiki?ref=项目概览',
          preview: {
            kind: 'wiki',
            entityId: 'project-overview',
            title: '项目概览',
            pageType: 'overview',
          },
        },
      ],
      result: {
        answer: '这是普通回答。',
        sources: [
          {
            type: 'entity',
            id: 'project-overview',
            title: '项目概览',
            href: '/wiki?ref=项目概览',
          },
        ],
        suggestions: [],
        trace: [
          {
            layer: 'answer',
            label: 'Query 2.0 回答',
            detail: '基于 Wiki 页面生成了回答。',
          },
        ],
      },
    };

    renderCard(message);

    expect(screen.getByText('参考来源（1）')).toBeTruthy();
    expect(screen.getByText('这是普通回答。')).toBeTruthy();
  });
});
