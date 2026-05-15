import type { CaptureDraft } from '../capture/draft';
import { db } from '@/lib/db';
import { assertDevAiApiAvailable } from './devApiGuard';
import { getProviderConfigForRole, loadProviderSettings } from '@/lib/llm/providerSettings';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import { requestConfiguredProviderText } from '@/lib/llm/runtimeProvider';
import type { LlmProviderId } from '@/lib/llm/providers';
import {
  buildCaptureAnalysisPrompt,
  buildCaptureAnalysisJsonRepairPrompt,
  buildCaptureDigestPrompt,
  buildCaptureSourceForStructuredProcessing,
  buildStructuredCaptureExcerpt,
  buildWikiPatchPrompt,
  buildWikiPatchJsonRepairPrompt,
  normalizeCaptureAnalysisToCaptureDraft,
  normalizeCaptureAnalysis,
  normalizeWikiPatchesToCaptureDraft,
  normalizeWikiPatchResponse,
  shouldUseCaptureDigest,
  splitCaptureContentIntoChunks,
} from './wikiPatch';

export type ExtractCaptureResult = {
  draft: CaptureDraft;
  provider: LlmProviderId | 'minimax' | 'deepseek';
  model: string;
  fallbackFrom?: string;
  mode?: 'two-step' | 'single-step';
};

export async function extractCaptureDraft(content: string): Promise<ExtractCaptureResult> {
  if (!import.meta.env.DEV && isTauriRuntime()) {
    return extractCaptureDraftWithRuntimeProvider(content);
  }

  assertDevAiApiAvailable('AI 提取');

  const entityIndex = await buildCaptureEntityIndex();
  const response = await fetch('/api/capture/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, entityIndex }),
  });

  const payload = (await response.json()) as ExtractCaptureResult | { error?: string };
  if (!response.ok || !('draft' in payload)) {
    throw new Error((payload as { error?: string }).error || 'AI 提取失败');
  }

  return payload;
}

async function extractCaptureDraftWithRuntimeProvider(content: string): Promise<ExtractCaptureResult> {
  const config = getProviderConfigForRole(loadProviderSettings(), 'wiki-compile');
  if (!config) {
    throw new Error('请先在设置里配置 Wiki 编译模型，安装版才能运行两步摄入。');
  }

  const entityIndex = await buildCaptureEntityIndex();
  const structuredContent = await prepareContentForStructuredCapture(content, config);
  const entityIndexJson = JSON.stringify(entityIndex.slice(0, 120), null, 2);
  const analysisResult = await requestConfiguredProviderText(config, {
    prompt: buildCaptureAnalysisPrompt(structuredContent, entityIndexJson),
    systemPrompt: '你是 MyWiki 摄入分析 Agent。只输出符合 schema 的 JSON 对象。',
    maxTokens: 2200,
    responseFormat: 'json_object',
  });
  if (!analysisResult.ok) {
    throw new Error(`${analysisResult.providerName} analysis failed: ${analysisResult.error}`);
  }

  const analysis = await normalizeCaptureAnalysisWithRepair({
    config,
    structuredContent,
    entityIndexJson,
    rawText: analysisResult.text,
  });
  const patchResult = await requestConfiguredProviderText(config, {
    prompt: buildWikiPatchPrompt(structuredContent, analysis),
    systemPrompt: '你是 MyWiki WikiPatch 生成 Agent。只输出 JSON 对象。',
    maxTokens: 2600,
    responseFormat: 'json_object',
  });
  if (!patchResult.ok) {
    return {
      draft: normalizeCaptureAnalysisToCaptureDraft(analysis, structuredContent),
      provider: config.providerId,
      model: config.model,
      fallbackFrom: `${patchResult.providerName} generation failed: ${patchResult.error}`,
      mode: 'two-step',
    };
  }

  let patches: ReturnType<typeof normalizeWikiPatchResponse>;
  try {
    patches = await normalizeWikiPatchResponseWithRepair({
      config,
      structuredContent,
      analysis,
      rawText: patchResult.text,
    });
  } catch (error) {
    return {
      draft: normalizeCaptureAnalysisToCaptureDraft(analysis, structuredContent),
      provider: config.providerId,
      model: config.model,
      fallbackFrom: error instanceof Error ? error.message : `${patchResult.providerName} returned invalid WikiPatch JSON.`,
      mode: 'two-step',
    };
  }
  if (patches.length === 0) {
    return {
      draft: normalizeCaptureAnalysisToCaptureDraft(analysis, structuredContent),
      provider: config.providerId,
      model: config.model,
      fallbackFrom: `${patchResult.providerName} 没有返回可用的 WikiPatch 条目。`,
      mode: 'two-step',
    };
  }

  return {
    draft: normalizeWikiPatchesToCaptureDraft(patches, structuredContent),
    provider: config.providerId,
    model: config.model,
    mode: 'two-step',
  };
}

async function prepareContentForStructuredCapture(content: string, config: NonNullable<ReturnType<typeof getProviderConfigForRole>>) {
  const structuredSource = buildCaptureSourceForStructuredProcessing(content);
  if (!shouldUseCaptureDigest(structuredSource)) return structuredSource;

  const chunks = splitCaptureContentIntoChunks(structuredSource);
  const digests: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const digestResult = await requestConfiguredProviderText(config, {
      prompt: buildCaptureDigestPrompt(chunks[index], index + 1, chunks.length),
      systemPrompt: '你是 MyWiki 长文档阅读 Agent。只输出 Markdown 阅读摘要，不要输出 JSON。',
      maxTokens: 1600,
    });
    if (!digestResult.ok) {
      return buildStructuredCaptureExcerpt(structuredSource);
    }
    digests.push(`## 分块 ${index + 1}/${chunks.length}\n\n${digestResult.text}`);
  }

  return [
    '# 长文档 Markdown 阅读摘要',
    '',
    '以下内容由 MyWiki 长文档阅读 Agent 从原始材料分块整理而来。结构化 WikiPatch 只能基于这些摘要生成；完整原文已保存在原始 Entry 中。',
    '',
    ...digests,
  ].join('\n');
}

async function normalizeCaptureAnalysisWithRepair(input: {
  config: NonNullable<ReturnType<typeof getProviderConfigForRole>>;
  structuredContent: string;
  entityIndexJson: string;
  rawText: string;
}) {
  try {
    return normalizeCaptureAnalysis(input.rawText);
  } catch (firstError) {
    const repairResult = await requestConfiguredProviderText(input.config, {
      prompt: buildCaptureAnalysisJsonRepairPrompt(input.rawText, input.structuredContent, input.entityIndexJson),
      systemPrompt: '你是 MyWiki JSON 修复 Agent。只输出一个合法 JSON 对象，不要 Markdown。',
      maxTokens: 2600,
      responseFormat: 'json_object',
    });
    if (!repairResult.ok) {
      throw new Error(`模型返回的摄入分析 JSON 不合法，自动修复请求失败：${repairResult.error}`);
    }

    try {
      return normalizeCaptureAnalysis(repairResult.text);
    } catch (secondError) {
      throw new Error(
        `模型返回的摄入分析 JSON 不合法，自动修复后仍失败：${formatJsonRepairError(secondError, firstError)}`,
      );
    }
  }
}

async function normalizeWikiPatchResponseWithRepair(input: {
  config: NonNullable<ReturnType<typeof getProviderConfigForRole>>;
  structuredContent: string;
  analysis: Parameters<typeof buildWikiPatchPrompt>[1];
  rawText: string;
}) {
  try {
    return normalizeWikiPatchResponse(input.rawText);
  } catch (firstError) {
    const repairResult = await requestConfiguredProviderText(input.config, {
      prompt: buildWikiPatchJsonRepairPrompt(input.rawText, input.structuredContent, input.analysis),
      systemPrompt: '你是 MyWiki WikiPatch JSON 修复 Agent。只输出一个合法 JSON 对象，不要 Markdown。',
      maxTokens: 2800,
      responseFormat: 'json_object',
    });
    if (!repairResult.ok) {
      throw new Error(`模型返回的 WikiPatch JSON 不合法，自动修复请求失败：${repairResult.error}`);
    }

    try {
      return normalizeWikiPatchResponse(repairResult.text);
    } catch (secondError) {
      throw new Error(`模型返回的 WikiPatch JSON 不合法，自动修复后仍失败：${formatJsonRepairError(secondError, firstError)}`);
    }
  }
}

function formatJsonRepairError(error: unknown, previous?: unknown) {
  const current = error instanceof Error ? error.message : '未知错误';
  const earlier = previous instanceof Error ? previous.message : '';
  return earlier && earlier !== current ? `${current}；首次错误：${earlier}` : current;
}

async function buildCaptureEntityIndex() {
  const entities = await db.entities.orderBy('updatedAt').reverse().limit(120).toArray();
  return entities.map((entity) => ({
    id: entity.id,
    type: entity.type,
    title: entity.title,
    summary: entity.summary,
    tags: entity.tags,
    scenes: entity.scenes,
    sourceCount: entity.sourceEntries.length,
    updatedAt: entity.updatedAt,
  }));
}
