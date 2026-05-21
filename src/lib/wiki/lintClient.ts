import { assertDevAiApiAvailable } from '@/lib/ai/devApiGuard';
import { requestConfiguredProviderText } from '@/lib/llm/runtimeProvider';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import type { LlmProviderConfig } from '@/lib/llm/providers';
import {
  buildSemanticWikiLintPrompt,
  normalizeSemanticWikiLintResponse,
  type WikiLintContextMap,
  type WikiLintPage,
  type WikiLintResult,
} from './lint';

export type SemanticWikiLintRequest = {
  pages: WikiLintPage[];
  contextMap?: WikiLintContextMap;
  providerConfig?: LlmProviderConfig | null;
  outputLanguage?: 'zh-CN' | 'en';
};

export type SemanticWikiLintResponse = {
  results: WikiLintResult[];
  provider: string;
  model: string;
};

export async function runSemanticWikiLint(
  payload: SemanticWikiLintRequest,
): Promise<SemanticWikiLintResponse> {
  if (!import.meta.env.DEV && isTauriRuntime()) {
    if (!payload.providerConfig) {
      throw new Error('请先在设置里配置 Review / Lint 模型，安装版才能运行语义校验。');
    }
    const providerResult = await requestConfiguredProviderText(payload.providerConfig, {
      prompt: buildSemanticWikiLintPrompt({
        pages: payload.pages.slice(0, 80),
        contextMap: payload.contextMap,
        outputLanguage: payload.outputLanguage ?? 'zh-CN',
      }),
      systemPrompt:
        'You are MyWiki Wiki Lint. Return only strict ---LINT--- blocks. Do not include markdown fences, JSON, or chain-of-thought.',
      maxTokens: 2600,
      reasoningMode: 'disabled',
    });
    if (!providerResult.ok) {
      throw new Error(`${providerResult.providerName} failed: ${providerResult.error}`);
    }
    return {
      results: normalizeSemanticWikiLintResponse(providerResult.text),
      provider: providerResult.providerName,
      model: providerResult.model,
    };
  }

  assertDevAiApiAvailable('Wiki Lint 语义校验');

  const response = await fetch('/api/wiki/lint/semantic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = (await response.json()) as SemanticWikiLintResponse | { error?: string };
  if (!response.ok || !('results' in body)) {
    throw new Error((body as { error?: string }).error || 'Wiki Lint 语义校验失败');
  }

  return body;
}
