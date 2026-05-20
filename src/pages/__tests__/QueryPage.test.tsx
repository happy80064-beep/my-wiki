import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useQueryChatStore } from '@/lib/query/chatStore';
import { QueryPage } from '../QueryPage';

const answerQueryChatMock = vi.hoisted(() => vi.fn());
const retrieveQueryContextMock = vi.hoisted(() => vi.fn());
const runStructuredQueryMock = vi.hoisted(() => vi.fn());
const answerQueryWithWikiPagesMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/query/chatAnswerClient', () => ({
  answerQueryChat: answerQueryChatMock,
}));

vi.mock('@/lib/query/wikiRetrieval', () => ({
  retrieveQueryContext: retrieveQueryContextMock,
}));

vi.mock('@/lib/query/queryAnswerClient', () => ({
  answerQueryWithWikiPages: answerQueryWithWikiPagesMock,
}));

vi.mock('@/lib/graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/graph')>();
  return {
    ...actual,
    runStructuredQuery: runStructuredQueryMock,
  };
});

vi.mock('@/lib/workspace', () => ({
  useWorkspaceRuntimeStore: (selector: (state: { activeRoot: string }) => unknown) =>
    selector({ activeRoot: 'browser-indexeddb' }),
}));

describe('QueryPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useQueryChatStore.getState().clearAll();
    answerQueryChatMock.mockReset();
    retrieveQueryContextMock.mockReset();
    runStructuredQueryMock.mockReset();
    answerQueryWithWikiPagesMock.mockReset();
  });

  it('routes chat intent before wiki retrieval and structured query', async () => {
    answerQueryChatMock.mockResolvedValue({
      answer: '你好，我在。你可以直接问我知识库里的具体问题。',
      provider: 'test-provider',
      model: 'test-model',
    });

    render(<QueryPage />);

    fireEvent.change(screen.getByPlaceholderText(/输入你的问题/), {
      target: { value: '你好' },
    });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      expect(answerQueryChatMock).toHaveBeenCalledWith(
        expect.objectContaining({
          question: '你好',
          intentLabel: '问候/寒暄',
        }),
      );
    });
    expect(retrieveQueryContextMock).not.toHaveBeenCalled();
    expect(runStructuredQueryMock).not.toHaveBeenCalled();
    expect(answerQueryWithWikiPagesMock).not.toHaveBeenCalled();
    expect(await screen.findByText('你好，我在。你可以直接问我知识库里的具体问题。')).toBeTruthy();
  });

  it('uses unified wiki rag for concrete lookup questions without structured query', async () => {
    retrieveQueryContextMock.mockResolvedValue({
      tokens: ['福瑞'],
      indexSummary: '',
      pages: [makeRetrievedPage()],
      trace: ['问题分词：福瑞、完工', 'Wiki 候选页：1 个，实际选入上下文 1 个。'],
    });
    answerQueryWithWikiPagesMock.mockResolvedValue({
      answer: '**结论：** 当前 Wiki 没有明确写出完工/竣工日期，只能确认预计 2029 年投入运营。[1]',
      citedIndices: [1],
      provider: 'test-provider',
      model: 'test-model',
    });

    render(<QueryPage />);

    expect(screen.queryByRole('switch', { name: /简单查询/ })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/输入你的问题/), {
      target: { value: '福瑞科技园三期什么时候完工？' },
    });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      expect(retrieveQueryContextMock).toHaveBeenCalledWith(
        expect.stringContaining('投入运营'),
        expect.objectContaining({ limit: 10 }),
      );
      expect(answerQueryWithWikiPagesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          question: '福瑞科技园三期什么时候完工？',
          reasoningMode: 'disabled',
          pages: [expect.objectContaining({ title: '福瑞健康科技园三期项目' })],
        }),
      );
    });
    expect(runStructuredQueryMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/预计 2029 年投入运营/)).toBeTruthy();
  });

  it('uses the same unified wiki rag flow for analytical questions', async () => {
    retrieveQueryContextMock.mockResolvedValue({
      tokens: ['福瑞'],
      indexSummary: '',
      pages: [makeRetrievedPage()],
      trace: ['问题分词：福瑞、商业模式、风险', 'Wiki 候选页：1 个，实际选入上下文 1 个。'],
    });
    answerQueryWithWikiPagesMock.mockResolvedValue({
      answer: '**结论：** 项目以医康旅一体化为主线，关键风险集中在医疗资质、招商去化和现金流节奏。[1]',
      citedIndices: [1],
      provider: 'test-provider',
      model: 'test-model',
    });

    render(<QueryPage />);

    fireEvent.change(screen.getByPlaceholderText(/输入你的问题/), {
      target: { value: '福瑞健康科技园三期项目的商业模式和关键风险是什么？' },
    });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      expect(answerQueryWithWikiPagesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          question: '福瑞健康科技园三期项目的商业模式和关键风险是什么？',
          reasoningMode: 'disabled',
        }),
      );
    });
    expect(runStructuredQueryMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/医康旅一体化/)).toBeTruthy();
  });

  it('surfaces no-context results without calling the answer model', async () => {
    retrieveQueryContextMock.mockResolvedValue({
      tokens: ['不存在'],
      indexSummary: '',
      pages: [],
      trace: ['问题分词：不存在', 'Wiki 候选页：0 个，实际选入上下文 0 个。'],
    });

    render(<QueryPage />);

    fireEvent.change(screen.getByPlaceholderText(/输入你的问题/), {
      target: { value: '不存在项目是什么？' },
    });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      expect(retrieveQueryContextMock).toHaveBeenCalled();
    });
    expect(answerQueryWithWikiPagesMock).not.toHaveBeenCalled();
    expect(runStructuredQueryMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/当前 Wiki 没有检索到足以回答这个问题的页面/)).toBeTruthy();
  });
});

function makeRetrievedPage() {
  return {
    index: 1,
    entityId: 'project_1',
    type: 'project',
    title: '福瑞健康科技园三期项目',
    href: '/wiki/project/project_1',
    path: 'wiki/projects/furui.md',
    summary: '医康旅一体化园区项目。',
    content: '预计 2029 年投入运营。当前材料没有明确写出完工或竣工日期。',
    score: 120,
    tags: ['福瑞科技园三期'],
    sources: ['可研报告'],
    related: ['医疗业态'],
    updated: '2026-05-20',
    aliases: ['福瑞科技园三期'],
    relatedEntityIds: [],
    matchedTerms: ['福瑞', '完工'],
  };
}
