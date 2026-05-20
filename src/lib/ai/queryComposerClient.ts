import { getProviderConfigForRole, loadProviderSettings } from '@/lib/llm/providerSettings';
import type { LlmReasoningMode } from '@/lib/llm/textProvider';
import { requestConfiguredProviderText, stripThinking } from '@/lib/llm/runtimeProvider';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import { buildQueryComposePrompt, type QueryComposePayload, type QueryComposeResult } from './queryComposer';
import { assertDevAiApiAvailable } from './devApiGuard';

export async function composeQueryAnswer(
  payload: QueryComposePayload,
  options: { reasoningMode?: LlmReasoningMode } = {},
): Promise<QueryComposeResult> {
  if (!import.meta.env.DEV && isTauriRuntime()) {
    const providerConfig = getProviderConfigForRole(loadProviderSettings(), 'query-deep');
    if (!providerConfig) {
      throw new Error('请先在设置里配置 Query/Deep Research 模型，安装版才能优化查询回答。');
    }

    const providerResult = await requestConfiguredProviderText(providerConfig, {
      prompt: buildQueryComposePrompt(payload),
      systemPrompt:
        'You are MyWiki query answer composer. Write the final answer only. Do not include JSON, markdown tables, chain-of-thought, or <think> tags.',
      maxTokens: 2400,
      reasoningMode: options.reasoningMode,
    });
    if (!providerResult.ok) {
      throw new Error(`${providerResult.providerName} failed: ${providerResult.error}`);
    }

    return {
      answer: stripThinking(providerResult.text),
      provider: providerResult.providerName,
      model: providerResult.model,
    };
  }

  assertDevAiApiAvailable('查询表达优化');

  const response = await fetch('/api/query/compose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, reasoningMode: options.reasoningMode }),
  });

  const body = (await response.json()) as QueryComposeResult | { error?: string };
  if (!response.ok || !('answer' in body)) {
    throw new Error((body as { error?: string }).error || '查询表达优化失败');
  }

  return body;
}
