import { assertDevAiApiAvailable } from '@/lib/ai/devApiGuard';
import { requestConfiguredProviderText } from '@/lib/llm/runtimeProvider';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import type { LlmProviderConfig } from '@/lib/llm/providers';
import type { LlmReasoningMode } from '@/lib/llm/textProvider';
import {
  buildQueryAnswerPrompt,
  normalizeQueryAnswerResponse,
  type QueryAnswerRequest,
  type QueryAnswerResponse,
} from './queryAnswer';

export async function answerQueryWithWikiPages(
  payload: QueryAnswerRequest & { providerConfig?: LlmProviderConfig | null; reasoningMode?: LlmReasoningMode },
): Promise<QueryAnswerResponse> {
  if (!import.meta.env.DEV && isTauriRuntime()) {
    return answerQueryWithRuntimeProvider(payload);
  }

  assertDevAiApiAvailable('Query 2.0 页面回答');

  const response = await fetch('/api/query/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = (await response.json()) as QueryAnswerResponse | { error?: string };
  if (!response.ok || !('answer' in body)) {
    throw new Error((body as { error?: string }).error || 'Query 2.0 页面回答失败');
  }

  return body;
}

async function answerQueryWithRuntimeProvider(
  payload: QueryAnswerRequest & { providerConfig?: LlmProviderConfig | null; reasoningMode?: LlmReasoningMode },
): Promise<QueryAnswerResponse> {
  if (!payload.providerConfig) {
    throw new Error('请先在设置里配置 Query/Deep Research 模型，安装版才能生成最终回答。');
  }

  const providerResult = await requestConfiguredProviderText(payload.providerConfig, {
    prompt: buildQueryAnswerPrompt(payload),
    systemPrompt:
      '你是 MyWiki Query 2.0 的中文 Wiki 对话分析助手。请基于给定的编号 Wiki 页面进行高质量 Markdown 回答，禁止输出 <think>、思考过程或 JSON。必须在末尾追加一个形如 <!-- cited: 1,2 --> 的 HTML 注释。',
    maxTokens: 3600,
    reasoningMode: payload.reasoningMode,
  });
  if (!providerResult.ok) {
    throw new Error(`${providerResult.providerName} failed: ${providerResult.error}`);
  }

  const normalized = normalizeQueryAnswerResponse(
    providerResult.text,
    payload.structuredSupport?.draftAnswer || '现有 Wiki 页面还不能可靠回答这个问题。',
  );
  return {
    ...normalized,
    provider: providerResult.providerName,
    model: providerResult.model,
    llmTiming: providerResult.timing,
  };
}
