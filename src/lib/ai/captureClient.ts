import type { CaptureDraft } from '../capture/draft';
import { db } from '@/lib/db';
import { assertDevAiApiAvailable } from './devApiGuard';
import { getProviderConfigForRole, loadProviderSettings } from '@/lib/llm/providerSettings';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import { requestConfiguredProviderText } from '@/lib/llm/runtimeProvider';
import type { LlmProviderId } from '@/lib/llm/providers';
import { resolveActiveWorkspaceSchemaContext, type WorkspaceSchemaContext } from '@/lib/workspace/schemaContext';
import {
  buildCaptureAnalysisFromMarkdownPrompt,
  buildCaptureAnalysisJsonRepairPrompt,
  buildCaptureAnalysisStructuredOutput,
  buildCaptureDigestPrompt,
  buildCaptureMarkdownAnalysisPrompt,
  buildCaptureSourceIdentityBlock,
  buildCaptureSourceForStructuredProcessing,
  buildStructuredCaptureExcerpt,
  resolveCaptureDigestThreshold,
  normalizeCaptureAnalysisToCaptureDraft,
  normalizeCaptureAnalysis,
  shouldUseCaptureDigest,
  splitCaptureContentIntoChunks,
  type CaptureWorkspaceContext,
} from './wikiPatch';

export type ExtractCaptureResult = {
  draft: CaptureDraft;
  provider: LlmProviderId | 'minimax' | 'deepseek';
  model: string;
  fallbackFrom?: string;
  mode?: 'two-step' | 'single-step';
};

export type ExtractCaptureOptions = {
  workspaceContext?: CaptureWorkspaceContext;
  signal?: AbortSignal;
};

export async function extractCaptureDraft(
  content: string,
  options: ExtractCaptureOptions = {},
): Promise<ExtractCaptureResult> {
  const workspaceContext = options.workspaceContext ?? await resolveActiveWorkspaceSchemaContext();

  if (!import.meta.env.DEV && isTauriRuntime()) {
    return extractCaptureDraftWithRuntimeProvider(content, workspaceContext, options);
  }

  assertDevAiApiAvailable('AI 提取');

  const entityIndex = await buildCaptureEntityIndex();
  const response = await fetch('/api/capture/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, entityIndex, workspaceContext }),
    signal: options.signal,
  });

  const payload = (await response.json()) as ExtractCaptureResult | { error?: string };
  if (!response.ok || !('draft' in payload)) {
    throw new Error((payload as { error?: string }).error || 'AI 提取失败');
  }

  return payload;
}

async function extractCaptureDraftWithRuntimeProvider(
  content: string,
  workspaceContext: WorkspaceSchemaContext | CaptureWorkspaceContext,
  options: ExtractCaptureOptions,
): Promise<ExtractCaptureResult> {
  const config = getProviderConfigForRole(loadProviderSettings(), 'wiki-compile');
  if (!config) {
    throw new Error('请先在设置里配置 Wiki 编译模型，安装版才能运行两步摄入。');
  }

  const entityIndex = await buildCaptureEntityIndex();
  const structuredContent = await prepareContentForStructuredCapture(content, config, workspaceContext, options);
  const entityIndexJson = JSON.stringify(entityIndex.slice(0, 120), null, 2);

  const markdownAnalysisResult = await requestConfiguredProviderText(config, {
    prompt: buildCaptureMarkdownAnalysisPrompt(structuredContent, entityIndexJson, workspaceContext),
    systemPrompt: '你是 MyWiki 原文件阅读 Agent。只输出 Markdown 分析文本，不要输出 JSON。',
    maxTokens: 3200,
  }, { signal: options.signal });
  if (!markdownAnalysisResult.ok) {
    throw new Error(`${markdownAnalysisResult.providerName} markdown analysis failed: ${markdownAnalysisResult.error}`);
  }

  const analysisSourceExcerpt = buildStructuredCaptureExcerpt(structuredContent, 14000);
  const structuredAnalysisResult = await requestConfiguredProviderText(config, {
    prompt: buildCaptureAnalysisFromMarkdownPrompt({
      sourceExcerpt: analysisSourceExcerpt,
      markdownAnalysis: markdownAnalysisResult.text,
      entityIndexJson,
      workspaceContext,
    }),
    systemPrompt: '你是 MyWiki 结构化入库 Agent。只输出符合 schema 的 JSON 对象。',
    maxTokens: 4200,
    structuredOutput: buildCaptureAnalysisStructuredOutput(),
  }, { signal: options.signal });
  if (!structuredAnalysisResult.ok) {
    throw new Error(`${structuredAnalysisResult.providerName} structured analysis failed: ${structuredAnalysisResult.error}`);
  }

  const analysis = await normalizeCaptureAnalysisWithRepair({
    config,
    structuredContent: analysisSourceExcerpt,
    entityIndexJson,
    rawText: structuredAnalysisResult.text,
    workspaceContext,
    signal: options.signal,
  });
  return {
    draft: normalizeCaptureAnalysisToCaptureDraft(analysis, structuredContent, workspaceContext),
    provider: config.providerId,
    model: config.model,
    mode: 'two-step',
  };
}

async function prepareContentForStructuredCapture(
  content: string,
  config: NonNullable<ReturnType<typeof getProviderConfigForRole>>,
  workspaceContext: CaptureWorkspaceContext,
  options: ExtractCaptureOptions,
) {
  const structuredSource = buildCaptureSourceForStructuredProcessing(content);
  if (!shouldUseCaptureDigest(structuredSource, resolveCaptureDigestThreshold(config.contextWindow))) return structuredSource;

  const chunks = splitCaptureContentIntoChunks(structuredSource);
  const sourceIdentity = buildCaptureSourceIdentityBlock(structuredSource);
  const digests: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const digestResult = await requestConfiguredProviderText(config, {
      prompt: buildCaptureDigestPrompt(chunks[index], index + 1, chunks.length, workspaceContext),
      systemPrompt: '你是 MyWiki 长文档阅读 Agent。只输出 Markdown 阅读摘要，不要输出 JSON。',
      maxTokens: 1600,
    }, { signal: options.signal });
    if (!digestResult.ok) {
      throw new Error(`${digestResult.providerName} long document digest failed: ${digestResult.error}`);
    }
    digests.push(`## 分块 ${index + 1}/${chunks.length}\n\n${digestResult.text}`);
  }

  return [
    ...(sourceIdentity ? [sourceIdentity, ''] : []),
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
  workspaceContext: CaptureWorkspaceContext;
  signal?: AbortSignal;
}) {
  try {
    return normalizeCaptureAnalysis(input.rawText);
  } catch (firstError) {
    const repairResult = await requestConfiguredProviderText(input.config, {
      prompt: buildCaptureAnalysisJsonRepairPrompt(
        input.rawText,
        input.structuredContent,
        input.entityIndexJson,
        input.workspaceContext,
      ),
      systemPrompt: '你是 MyWiki JSON 修复 Agent。只输出一个合法 JSON 对象，不要 Markdown。',
      maxTokens: 2600,
      structuredOutput: buildCaptureAnalysisStructuredOutput('repair_capture_analysis'),
    }, { signal: input.signal });
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
