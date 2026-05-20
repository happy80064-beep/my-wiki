import { getProviderConfigForRole, loadProviderSettings } from '@/lib/llm/providerSettings';
import type { LlmReasoningMode } from '@/lib/llm/textProvider';
import { requestConfiguredProviderText } from '@/lib/llm/runtimeProvider';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import { buildQueryPlanPrompt, normalizeQueryPlan, type QueryIndexEntity, type QueryPlan } from './queryPlanner';
import { assertDevAiApiAvailable, buildDevApiUrl } from './devApiGuard';

export async function planQueryWithAgent(
  question: string,
  index: QueryIndexEntity[],
  options: { reasoningMode?: LlmReasoningMode } = {},
): Promise<QueryPlan> {
  if (!import.meta.env.DEV && isTauriRuntime()) {
    const providerConfig = getProviderConfigForRole(loadProviderSettings(), 'query-fast');
    if (!providerConfig) {
      throw new Error('请先在设置里配置 Query 快速模型，安装版才能运行 Query Agent 规划。');
    }

    const providerResult = await requestConfiguredProviderText(providerConfig, {
      prompt: buildQueryPlanPrompt({ question, index }),
      systemPrompt:
        'You are MyWiki Query Agent. Return only one valid JSON object that matches the requested schema. Do not include markdown, comments, or chain-of-thought.',
      maxTokens: 1800,
      responseFormat: 'json_object',
      reasoningMode: options.reasoningMode,
    });
    if (!providerResult.ok) {
      throw new Error(`${providerResult.providerName} failed: ${providerResult.error}`);
    }

    return { ...normalizeQueryPlan(providerResult.text, { question, index }), llmTiming: providerResult.timing };
  }

  assertDevAiApiAvailable('Query Agent 规划');

  const response = await fetch(buildDevApiUrl('/api/query/plan'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, index, reasoningMode: options.reasoningMode }),
  });

  const body = (await response.json()) as QueryPlan | { error?: string };
  if (!response.ok || !('intent' in body)) {
    throw new Error((body as { error?: string }).error || 'Query Agent 规划失败');
  }

  return body;
}
