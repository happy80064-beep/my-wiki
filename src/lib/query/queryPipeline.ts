import { dedupeSources } from '@/lib/graph/answer';
import type { StructuredQueryResult } from '@/lib/graph/types';
import {
  buildWikiPageReferences,
} from './chatHelpers';
import { buildWikiRagEvidenceTrace } from './evidenceReport';
import { describeQueryMode, type QueryMode } from './queryMode';
import { queryUnderstandingForPrompt, type QueryUnderstanding } from './queryUnderstanding';
import type { RetrievedWikiPage } from './wikiRetrieval';
import type { QueryAnswerResponse } from './queryAnswer';

export type QueryPipelineTiming = {
  retrievalMs: number;
  answerMs?: number;
};

export function buildWikiRagBaseResult(input: {
  retrievedPages: RetrievedWikiPage[];
  queryUnderstanding: QueryUnderstanding;
  queryMode?: QueryMode;
  retrievalTrace: string[];
  workspaceTrace?: string[];
  retrievalUsedConversation: boolean;
  timing: QueryPipelineTiming;
  formatDuration: (ms: number) => string;
}) {
  const result: StructuredQueryResult = {
    answer: '正在基于检索到的 Wiki 页面生成回答。',
    sources: input.retrievedPages.slice(0, 6).map((page) => ({
      type: 'entity',
      id: page.entityId,
      title: page.title,
      href: page.href,
    })),
    suggestions: [],
    trace: [
      {
        layer: 'directory',
        label: 'Wiki 页面检索',
        detail: `${input.retrievalUsedConversation ? '已结合最近对话补全检索语义。' : ''}${input.retrievalTrace.join(' ')} 耗时：${input.formatDuration(input.timing.retrievalMs)}。`,
      },
      ...(input.queryMode
        ? [
            {
              layer: 'intent' as const,
              label: '查询模式',
              detail: describeQueryMode(input.queryMode),
            },
          ]
        : []),
      ...(input.workspaceTrace?.length
        ? [
            {
              layer: 'context' as const,
              label: '工作区上下文',
              detail: input.workspaceTrace.join(' '),
            },
          ]
        : []),
      {
        layer: 'intent',
        label: '查询理解',
        detail: compactQueryUnderstanding(input.queryUnderstanding),
      },
      ...buildWikiRagEvidenceTrace({
        retrievedPages: input.retrievedPages,
        understanding: input.queryUnderstanding,
      }),
    ],
  };
  return {
    result,
    references: buildWikiPageReferences(input.retrievedPages),
  };
}

export function buildWikiRagNoContextResult(input: {
  question: string;
  queryUnderstanding: QueryUnderstanding;
  queryMode?: QueryMode;
  retrievalTrace: string[];
  workspaceTrace?: string[];
  retrievalUsedConversation: boolean;
  timing: Pick<QueryPipelineTiming, 'retrievalMs'>;
  formatDuration: (ms: number) => string;
}) {
  const result: StructuredQueryResult = {
    answer: [
      '**结论：** 当前 Wiki 没有检索到足以回答这个问题的页面。',
      '',
      `我已按“${input.question}”检索当前知识库，但没有选中可用于回答的 Wiki 页面。建议补充相关原始材料，或点击“补充/深度研究”用 Web Search 获取外部资料。`,
    ].join('\n'),
    sources: [],
    suggestions: ['补充相关原始材料', '触发补充/深度研究'],
    trace: [
      {
        layer: 'directory',
        label: 'Wiki 页面检索',
        detail: `${input.retrievalUsedConversation ? '已结合最近对话补全检索语义。' : ''}${input.retrievalTrace.join(' ')} 耗时：${input.formatDuration(input.timing.retrievalMs)}。`,
      },
      ...(input.queryMode
        ? [
            {
              layer: 'intent' as const,
              label: '查询模式',
              detail: describeQueryMode(input.queryMode),
            },
          ]
        : []),
      ...(input.workspaceTrace?.length
        ? [
            {
              layer: 'context' as const,
              label: '工作区上下文',
              detail: input.workspaceTrace.join(' '),
            },
          ]
        : []),
      {
        layer: 'intent',
        label: '查询理解',
        detail: compactQueryUnderstanding(input.queryUnderstanding),
      },
      {
        layer: 'evidence',
        label: '证据分层',
        detail: 'Wiki 页面证据：无。本轮没有调用回答模型，避免在缺少本地证据时编造答案。',
      },
    ],
  };
  return {
    result,
    references: [],
  };
}

export function applyWikiRagPageAnswer(input: {
  result: StructuredQueryResult;
  retrievedPages: RetrievedWikiPage[];
  answered: QueryAnswerResponse;
  answerMs: number;
  formatDuration: (ms: number) => string;
  formatProviderTimingDetail: (timing: QueryAnswerResponse['llmTiming']) => string;
}) {
  const references = buildWikiPageReferences(input.retrievedPages, input.answered.citedIndices);
  const result: StructuredQueryResult = {
    ...input.result,
    answer: input.answered.answer,
    sources: dedupeSources(
      references.map((reference) => ({
        type: reference.type,
        id: reference.key.replace(/^entity:/, ''),
        title: reference.title,
        href: reference.href,
      })),
    ),
    llm: {
      provider: input.answered.provider,
      model: input.answered.model,
      fallbackFrom: input.answered.fallbackFrom,
    },
    trace: [
      ...(input.result.trace ?? []),
      {
        layer: 'answer',
        label: 'Query 回答',
        detail: `${input.answered.provider} / ${input.answered.model} 基于 ${references.length} 个 Wiki 页面生成回答；回答阶段已请求关闭显式 thinking/reasoning。耗时：${input.formatDuration(input.answerMs)}。${input.formatProviderTimingDetail(input.answered.llmTiming)}`,
      },
    ],
  };
  return { result, references };
}

export function applyWikiRagPageAnswerFailure(result: StructuredQueryResult, error: unknown): StructuredQueryResult {
  return {
    ...result,
    answer: 'Query 回答生成失败。已保留本轮检索到的 Wiki 页面证据，请检查模型配置后重试。',
    trace: [
      ...(result.trace ?? []),
      {
        layer: 'answer',
        label: 'Query 回答',
        detail: `页面级回答失败，未把失败结果当作成功：${error instanceof Error ? error.message : '未知错误'}`,
      },
    ],
  };
}

export function buildStructuredSupport(input: {
  queryUnderstanding: QueryUnderstanding;
  structured: StructuredQueryResult;
}) {
  return {
    draftAnswer: input.structured.answer,
    keyHints: [
      queryUnderstandingForPrompt(input.queryUnderstanding),
      ...input.structured.sources.slice(0, 8).map((source) => `结构化来源：${source.title}`),
      ...(input.structured.trace ?? []).slice(0, 4).map((step) => `${step.label}：${step.detail}`),
    ].filter(Boolean),
  };
}

function compactQueryUnderstanding(understanding: QueryUnderstanding) {
  const styleLabel =
    understanding.answerStyle === 'direct'
      ? '直接短答'
      : understanding.answerStyle === 'brief_list'
        ? '短列表'
        : '综合分析';
  const parts = [
    `意图：${understanding.intent}`,
    `需求：${understanding.need === 'lookup' ? '查询型' : '开放型'}`,
    `回答方式：${styleLabel}`,
    understanding.attribute ? `字段：${understanding.attribute}` : '',
    understanding.guidance[0] ? `约束：${understanding.guidance[0]}` : '',
  ].filter(Boolean);
  return parts.join('；') + '。';
}

export const buildInitialQueryResult = buildWikiRagBaseResult;
export const applyWikiPageAnswer = applyWikiRagPageAnswer;
export const applyWikiPageAnswerFailure = applyWikiRagPageAnswerFailure;
