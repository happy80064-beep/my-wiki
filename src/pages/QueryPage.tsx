import { Loader2, MessageSquareText } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { QueryConversationList } from '@/components/query/QueryConversationList';
import { QueryInput } from '@/components/query/QueryInput';
import { QueryMessageCard } from '@/components/query/QueryMessageCard';
import { QueryReferencePanel } from '@/components/query/QueryReferencePanel';
import { dedupeSources } from '@/lib/graph/answer';
import { runStructuredQuery } from '@/lib/graph';
import type { StructuredQueryResult } from '@/lib/graph/types';
import { getProviderConfigForRole, loadProviderSettings } from '@/lib/llm/providerSettings';
import {
  buildQueryReferences,
  buildWikiPageReferences,
  type QueryChatReference,
} from '@/lib/query/chatHelpers';
import { type QueryChatMessage, useQueryChatStore } from '@/lib/query/chatStore';
import { answerQueryWithWikiPages } from '@/lib/query/queryAnswerClient';
import type { QueryConversationContextMessage } from '@/lib/query/queryAnswer';
import { retrieveQueryContext } from '@/lib/query/wikiRetrieval';
import {
  searchConfiguredDeepResearch,
  synthesizeConfiguredDeepResearch,
  type WebSearchResult,
} from '@/lib/research/store';
import { useWorkspaceRuntimeStore } from '@/lib/workspace';

export function QueryPage() {
  const activeWorkspaceRoot = useWorkspaceRuntimeStore((state) => state.activeRoot);
  const conversations = useQueryChatStore((state) => state.conversations);
  const activeConversationId = useQueryChatStore((state) => state.activeConversationId);
  const messages = useQueryChatStore((state) => state.messages);
  const workspaceRoot = useQueryChatStore((state) => state.workspaceRoot);
  const setWorkspaceRoot = useQueryChatStore((state) => state.setWorkspaceRoot);
  const createConversation = useQueryChatStore((state) => state.createConversation);
  const addUserMessage = useQueryChatStore((state) => state.addUserMessage);
  const addAssistantMessage = useQueryChatStore((state) => state.addAssistantMessage);
  const addAssistantMessageToConversation = useQueryChatStore((state) => state.addAssistantMessageToConversation);
  const removeLastAssistantMessage = useQueryChatStore((state) => state.removeLastAssistantMessage);
  const updateMessageResult = useQueryChatStore((state) => state.updateMessageResult);
  const setIsResponding = useQueryChatStore((state) => state.setIsResponding);
  const isResponding = useQueryChatStore((state) => state.isResponding);
  const [draftSeed, setDraftSeed] = useState('');
  const [selectedReference, setSelectedReference] = useState<QueryChatReference | null>(null);
  const [referencePanelOpen, setReferencePanelOpen] = useState(false);
  const [responseMode, setResponseMode] = useState<'wiki' | 'research-search' | 'research-synthesis' | null>(null);
  const currentWorkspaceRoot = activeWorkspaceRoot || 'browser-indexeddb';

  const activeMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          message.conversationId === activeConversationId &&
          (message.workspaceRoot ?? 'browser-indexeddb') === workspaceRoot,
      ),
    [activeConversationId, messages, workspaceRoot],
  );
  const workspaceConversations = useMemo(
    () => conversations.filter((conversation) => (conversation.workspaceRoot ?? 'browser-indexeddb') === workspaceRoot),
    [conversations, workspaceRoot],
  );

  const lastAssistantId = [...activeMessages].reverse().find((message) => message.role === 'assistant')?.id;

  useEffect(() => {
    setSelectedReference(null);
    setReferencePanelOpen(false);
  }, [activeConversationId]);

  useEffect(() => {
    setWorkspaceRoot(currentWorkspaceRoot);
    setSelectedReference(null);
    setReferencePanelOpen(false);
  }, [currentWorkspaceRoot, setWorkspaceRoot]);

  function handleReferenceSelect(reference: QueryChatReference) {
    setSelectedReference(reference);
    setReferencePanelOpen(true);
  }

  async function runConversationTurn(question: string, options: { regenerate?: boolean } = {}) {
    const trimmed = question.trim();
    if (!trimmed) return;

    let userMessage: QueryChatMessage | null = null;
    if (!options.regenerate) {
      userMessage = addUserMessage(trimmed);
      if (!userMessage) return;
    }

    setIsResponding(true);
    setResponseMode('wiki');
    try {
      const providerSettings = loadProviderSettings();
      const queryProviderConfig = getProviderConfigForRole(providerSettings, 'query-deep');
      const storeState = useQueryChatStore.getState();
      const conversationId = userMessage?.conversationId ?? storeState.activeConversationId;
      const conversationContext = buildConversationContextForQuery(
        storeState.messages,
        conversationId,
        userMessage?.id,
        trimmed,
      );
      const retrievalQuestion = buildRetrievalQuestion(trimmed, conversationContext);
      const retrievalUsedConversation = retrievalQuestion !== trimmed;

      const [retrieved, structured] = await Promise.all([
        retrieveQueryContext(retrievalQuestion, {
          limit: 10,
          maxContextChars: queryProviderConfig?.contextWindow,
        }),
        runStructuredQuery(retrievalQuestion, {
          composeWithLlm: false,
          planWithAgent: true,
          useCache: false,
        }),
      ]);

      let result: StructuredQueryResult = {
        ...structured,
        trace: [
          {
            layer: 'directory',
            label: 'Wiki 页面检索',
            detail: `${retrievalUsedConversation ? '已结合最近对话补全检索语义。' : ''}${retrieved.trace.join(' ')}`,
          },
          ...(structured.trace ?? []),
        ],
      };
      let finalReferences = buildQueryReferences(result);

      if (retrieved.pages.length > 0) {
        try {
          const answered = await answerQueryWithWikiPages({
            question: trimmed,
            indexSummary: retrieved.indexSummary,
            pages: retrieved.pages.map((page) => ({
              index: page.index,
              entityId: page.entityId,
              type: page.type,
              title: page.title,
              href: page.href,
              path: page.path,
              summary: page.summary,
              content: page.content,
              score: page.score,
              tags: page.tags,
              sources: page.sources,
              related: page.related,
              updated: page.updated,
            })),
            structuredSupport: {
              draftAnswer: structured.answer,
              keyHints: [
                ...structured.sources.slice(0, 8).map((source) => `结构化来源：${source.title}`),
                ...(structured.trace ?? []).slice(0, 4).map((step) => `${step.label}：${step.detail}`),
              ],
            },
            conversationContext,
            providerConfig: queryProviderConfig,
          });

          finalReferences = buildWikiPageReferences(retrieved.pages, answered.citedIndices);
          result = {
            ...result,
            answer: answered.answer,
            sources: dedupeSources([
              ...finalReferences.map((reference) => ({
                type: reference.type,
                id: reference.key.replace(/^entity:/, ''),
                title: reference.title,
                href: reference.href,
              })),
              ...structured.sources,
            ]),
            llm: {
              provider: answered.provider,
              model: answered.model,
              fallbackFrom: answered.fallbackFrom,
            },
            trace: [
              ...(result.trace ?? []),
              {
                layer: 'answer',
                label: 'Query 2.0 回答',
                detail: `${answered.provider} / ${answered.model} 基于 ${finalReferences.length} 个 Wiki 页面生成了回答。`,
              },
            ],
          };
        } catch (error) {
          result = {
            ...result,
            trace: [
              ...(result.trace ?? []),
              {
                layer: 'answer',
                label: 'Query 2.0 回答',
                detail: `页面级回答失败，已回退到结构化查询结果：${error instanceof Error ? error.message : '未知错误'}`,
              },
            ],
          };
        }
      }

      addAssistantMessage(trimmed, result.answer, result, finalReferences);
    } finally {
      setIsResponding(false);
      setResponseMode(null);
    }
  }

  async function runDeepResearchTurn(message: QueryChatMessage, options: { replaceLatest?: boolean } = {}) {
    if (!message.question || !message.conversationId) return;
    if (options.replaceLatest) {
      removeLastAssistantMessage(message.conversationId);
    }

    let webResults: WebSearchResult[] = [];
    let placeholderMessage: QueryChatMessage | null = null;

    setIsResponding(true);
    setResponseMode('research-search');
    try {
      const searchPayload = await searchConfiguredDeepResearch(message.question, {
        searchQueries: [message.question],
      });
      webResults = searchPayload.webResults;

      const pending = buildPendingDeepResearchQueryResult(message.question, webResults);
      placeholderMessage = addAssistantMessageToConversation(
        message.conversationId,
        message.question,
        pending.result.answer,
        pending.result,
        pending.references,
      );

      setResponseMode('research-synthesis');
      const synthesisPayload = await synthesizeConfiguredDeepResearch(message.question, webResults);
      const finalPayload = {
        webResults,
        synthesis: synthesisPayload.synthesis,
        provider: synthesisPayload.provider,
        model: synthesisPayload.model,
      };
      const { result, references } = buildDeepResearchQueryResult(message.question, finalPayload);

      if (placeholderMessage) {
        updateMessageResult(placeholderMessage.id, result);
      } else {
        addAssistantMessageToConversation(message.conversationId, message.question, result.answer, result, references);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '补充/深度研究失败。';
      const failure = buildDeepResearchErrorQueryResult(message.question, webResults, errorMessage);
      if (placeholderMessage) {
        updateMessageResult(placeholderMessage.id, failure.result);
      } else {
        addAssistantMessageToConversation(
          message.conversationId,
          message.question,
          failure.result.answer,
          failure.result,
          failure.references,
        );
      }
    } finally {
      setIsResponding(false);
      setResponseMode(null);
    }
  }

  async function handleRegenerate(message: QueryChatMessage) {
    if (!message.question || !message.conversationId) return;
    removeLastAssistantMessage(message.conversationId);
    if (isDeepResearchMessage(message)) {
      await runDeepResearchTurn(message);
      return;
    }
    await runConversationTurn(message.question, { regenerate: true });
  }

  async function handleDeepResearch(message: QueryChatMessage) {
    await runDeepResearchTurn(message);
  }

  return (
    <section className="mx-auto h-full max-w-[1900px] overflow-hidden px-5 py-6">
      <div
        className={[
          'grid h-full min-h-0 gap-5',
          referencePanelOpen ? 'xl:grid-cols-[280px_minmax(0,1fr)_430px]' : 'xl:grid-cols-[280px_minmax(0,1fr)]',
        ].join(' ')}
      >
        <QueryConversationList onCreateConversation={() => createConversation()} />

        <section className="flex h-full min-h-0 flex-col rounded-[16px] border border-[#e5e5e4] bg-white">
          <header className="shrink-0 border-b border-[#ececeb] px-5 py-4">
            <p className="text-xs font-medium text-[#155eef]">Query 2.0</p>
            <div className="mt-2 flex items-center gap-3">
              <h2 className="text-xl font-semibold text-[#1f2937]">查询工作台</h2>
              <span className="rounded-full border border-[#d9d9d6] bg-[#fbfbfa] px-2.5 py-1 text-xs text-[#626965]">
                独立会话 · 引用可追溯 · 可保存回 Wiki
              </span>
            </div>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[#626965]">
              每轮问题会优先检索现有 Wiki 页面，再结合查询模型生成回答。若当前 Wiki 暂时没有覆盖到需要的信息，可以继续触发补充/深度研究，先查看搜索到的网页来源，再生成这一轮的综合结论。
            </p>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
            {!activeConversationId && workspaceConversations.length === 0 ? (
              <EmptyConversationState onStart={() => createConversation()} />
            ) : activeMessages.length === 0 ? (
              <EmptyConversationState onStart={() => createConversation()} />
            ) : (
              <div className="space-y-5">
                {activeMessages.map((message) => (
                  <QueryMessageCard
                    key={message.id}
                    message={message}
                    isLastAssistant={message.id === lastAssistantId}
                    onRegenerate={handleRegenerate}
                    onDeepResearch={handleDeepResearch}
                    onPrefillSuggestion={setDraftSeed}
                    onMessageResultUpdate={updateMessageResult}
                    selectedReferenceKey={selectedReference?.key}
                    onReferenceSelect={handleReferenceSelect}
                  />
                ))}
                {isResponding ? (
                  <div className="rounded-[16px] border border-[#d9e5ff] bg-[#f4f8ff] px-4 py-3 text-sm text-[#155eef]">
                    <span className="inline-flex items-center gap-2">
                      <Loader2 size={15} className="animate-spin" />
                      {responseMode === 'research-search'
                        ? '正在搜索网页来源，准备补充研究。'
                        : responseMode === 'research-synthesis'
                          ? '已获取网页来源，正在生成补充研究结论。'
                          : '正在检索相关 Wiki 页面、整理上下文并生成本轮回答。'}
                    </span>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-[#ececeb] bg-white/95 p-4 shadow-[0_-10px_30px_rgba(15,23,42,0.04)]">
            <QueryInput
              key={draftSeed}
              initialValue={draftSeed}
              isSending={isResponding}
              onSend={async (question) => {
                setDraftSeed('');
                await runConversationTurn(question);
              }}
            />
          </div>
        </section>

        {referencePanelOpen ? (
          <QueryReferencePanel
            reference={selectedReference}
            onClose={() => {
              setSelectedReference(null);
              setReferencePanelOpen(false);
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

function buildConversationContextForQuery(
  messages: QueryChatMessage[],
  conversationId: string | null,
  currentUserMessageId: string | undefined,
  question: string,
): QueryConversationContextMessage[] {
  if (!conversationId || !shouldUseConversationContext(question)) return [];

  return messages
    .filter((message) => message.conversationId === conversationId && message.id !== currentUserMessageId)
    .slice(-6)
    .map((message) => ({
      role: message.role,
      content: message.content,
      references: message.references?.slice(0, 6).map((reference) => ({
        title: reference.title,
        href: reference.href,
      })),
    }));
}

function buildRetrievalQuestion(question: string, context: QueryConversationContextMessage[]) {
  if (context.length === 0) return question;
  const referenceTitles = Array.from(
    new Set(
      context
        .flatMap((message) => message.references ?? [])
        .map((reference) => reference.title.trim())
        .filter(Boolean),
    ),
  ).slice(0, 8);
  const recentUserQuestions = context
    .filter((message) => message.role === 'user')
    .slice(-2)
    .map((message) => compactForRetrieval(message.content, 80));
  const subjectHint = [...referenceTitles, ...recentUserQuestions].join(' ');
  return subjectHint ? `${subjectHint} ${question}` : question;
}

function buildPendingDeepResearchQueryResult(question: string, webResults: WebSearchResult[]) {
  const sources = buildDeepResearchSources(webResults);
  const references = buildDeepResearchReferences(webResults);
  const result: StructuredQueryResult = {
    answer: webResults.length
      ? '正在根据上方网页来源生成补充研究结论，请稍候。'
      : '没有检索到可用网页来源，正在整理当前搜索结果。',
    sources,
    suggestions: [],
    trace: [
      {
        layer: 'web',
        label: 'Web Search',
        detail: `围绕“${question}”检索到 ${webResults.length} 条网页来源。`,
      },
    ],
  };
  return { result, references };
}

function buildDeepResearchQueryResult(
  question: string,
  payload: {
    webResults: WebSearchResult[];
    synthesis: string;
    provider: string;
    model: string;
  },
) {
  const sources = buildDeepResearchSources(payload.webResults);
  const references = buildDeepResearchReferences(payload.webResults);
  const providerLabel = [payload.provider, payload.model].filter(Boolean).join(' / ');
  const result: StructuredQueryResult = {
    answer: payload.synthesis,
    sources,
    suggestions: ['把这条补充研究保存到 Wiki', '基于最新资料继续追问'],
    trace: [
      {
        layer: 'web',
        label: 'Web Search',
        detail: `围绕“${question}”检索到 ${payload.webResults.length} 条网页来源。`,
      },
      {
        layer: 'answer',
        label: '补充/深度研究',
        detail: providerLabel
          ? `${providerLabel} 基于网页来源生成了补充研究回答。`
          : '未检索到可用网页来源，已返回提示结果。',
      },
    ],
    ...(providerLabel
      ? {
          llm: {
            provider: payload.provider,
            model: payload.model,
          },
        }
      : {}),
  };
  return { result, references };
}

function buildDeepResearchErrorQueryResult(question: string, webResults: WebSearchResult[], errorMessage: string) {
  const sources = buildDeepResearchSources(webResults);
  const references = buildDeepResearchReferences(webResults);
  const trace: NonNullable<StructuredQueryResult['trace']> = [];
  if (webResults.length > 0) {
    trace.push({
      layer: 'web',
      label: 'Web Search',
      detail: `围绕“${question}”检索到 ${webResults.length} 条网页来源。`,
    });
  }
  trace.push({
    layer: 'answer',
    label: '补充/深度研究',
    detail: errorMessage,
  });
  return {
    result: {
      answer: `补充/深度研究失败：${errorMessage}`,
      sources,
      suggestions: ['检查深度研究 / Web Search 设置', '换一个更具体的问题再试'],
      trace,
    } satisfies StructuredQueryResult,
    references,
  };
}

function buildDeepResearchSources(webResults: WebSearchResult[]) {
  return webResults.map((item) => ({
    type: 'web' as const,
    id: item.url,
    title: item.title,
    href: item.url,
  }));
}

function buildDeepResearchReferences(webResults: WebSearchResult[]): QueryChatReference[] {
  return webResults.map((item, index) => ({
    key: `web:${item.url || index}`,
    type: 'web',
    title: item.title || item.source || `Web 来源 ${index + 1}`,
    href: item.url,
    preview: {
      kind: 'web',
      title: item.title || item.source || `Web 来源 ${index + 1}`,
      url: item.url,
      source: item.source || safeHost(item.url),
      snippet: item.snippet,
      content: item.snippet,
    },
  }));
}

function isDeepResearchMessage(message: QueryChatMessage) {
  return Boolean(
    message.result?.sources.some((source) => source.type === 'web') ||
      message.result?.trace?.some((step) => step.layer === 'web'),
  );
}

function safeHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function shouldUseConversationContext(question: string) {
  return /(这个|这次|上述|上面|前面|刚才|它|它们|这里|这些|那些|此项目|该项目|这个项目)/.test(question);
}

function compactForRetrieval(value: string, maxLength: number) {
  const text = value
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function EmptyConversationState({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex h-full min-h-[420px] flex-col items-center justify-center rounded-[16px] border border-dashed border-[#d9d9d6] bg-[#fbfbfa] px-6 py-10 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-white text-[#155eef] shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <MessageSquareText size={26} />
      </div>
      <h3 className="mt-4 text-lg font-semibold text-[#1f2937]">从一个问题开始</h3>
      <p className="mt-2 max-w-xl text-sm leading-7 text-[#626965]">
        现在的查询会以独立会话为单位保存，减少不同问题之间的上下文串扰。每条回答都会尽量保留引用，并支持复制、保存回 Wiki，以及在当前知识库不足时继续做补充研究。
      </p>
      <button
        type="button"
        onClick={onStart}
        className="mt-5 rounded-full bg-[#155eef] px-4 py-2 text-sm font-medium text-white"
      >
        新建对话
      </button>
    </div>
  );
}
