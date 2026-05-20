import { assertDevAiApiAvailable, buildDevApiUrl } from '@/lib/ai/devApiGuard';
import type { LlmProviderConfig } from '@/lib/llm/providers';
import { requestConfiguredProviderText } from '@/lib/llm/runtimeProvider';
import type { LlmReasoningMode } from '@/lib/llm/textProvider';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import {
  buildQueryChatPrompt,
  normalizeQueryChatResponse,
  type QueryChatAnswerRequest,
  type QueryChatAnswerResponse,
} from './chatAnswer';

export async function answerQueryChat(
  payload: QueryChatAnswerRequest & { providerConfig?: LlmProviderConfig | null; reasoningMode?: LlmReasoningMode },
): Promise<QueryChatAnswerResponse> {
  if (!import.meta.env.DEV && isTauriRuntime()) {
    return answerQueryChatWithRuntimeProvider(payload);
  }

  assertDevAiApiAvailable('Query 闲聊回复');

  const response = await fetch(buildDevApiUrl('/api/query/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = (await response.json()) as QueryChatAnswerResponse | { error?: string };
  if (!response.ok || !('answer' in body)) {
    throw new Error((body as { error?: string }).error || 'Query 闲聊回复失败');
  }

  return body;
}

async function answerQueryChatWithRuntimeProvider(
  payload: QueryChatAnswerRequest & { providerConfig?: LlmProviderConfig | null; reasoningMode?: LlmReasoningMode },
): Promise<QueryChatAnswerResponse> {
  if (!payload.providerConfig) {
    throw new Error('请先在设置里配置 Query/Deep Research 模型，安装版才能回复闲聊消息。');
  }

  const providerResult = await requestConfiguredProviderText(payload.providerConfig, {
    prompt: buildQueryChatPrompt(payload),
    systemPrompt: '你是 MyWiki 的中文对话助手。当前轮次是闲聊或助手能力说明，简短自然回复，不要声称检索了 Wiki。',
    maxTokens: 800,
    reasoningMode: payload.reasoningMode,
  });
  if (!providerResult.ok) {
    throw new Error(`${providerResult.providerName} failed: ${providerResult.error}`);
  }

  const answer = normalizeQueryChatResponse(providerResult.text) || '你好，我在。你可以直接问我知识库里的具体问题。';
  return {
    answer,
    provider: providerResult.providerName,
    model: providerResult.model,
    llmTiming: providerResult.timing,
  };
}
