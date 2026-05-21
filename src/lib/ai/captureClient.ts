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

const captureDigestCacheKey = 'mywiki.v2.captureDigestCache.v1';
const captureDigestPromptVersion = '2026-05-18-long-pdf-v1';
const captureDigestCacheMaxEntries = 400;

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
    body: JSON.stringify({
      content,
      entityIndex,
      workspaceContext,
      providerConfig: getProviderConfigForRole(loadProviderSettings(), 'wiki-compile'),
    }),
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
    reasoningMode: 'disabled',
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
    reasoningMode: 'disabled',
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
  const fullSource = content.trim();
  const structuredSource = buildCaptureSourceForStructuredProcessing(fullSource);
  if (!shouldUseCaptureDigest(fullSource, resolveCaptureDigestThreshold(config.contextWindow))) return structuredSource;

  const chunks = splitCaptureContentIntoChunks(
    fullSource,
    resolveCaptureDigestChunkSize(config.contextWindow),
    resolveCaptureDigestChunkLimit(fullSource.length),
  );
  const sourceIdentity = buildCaptureSourceIdentityBlock(fullSource);
  const digests: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const digest = await getOrCreateCaptureDigest({
      config,
      chunk: chunks[index],
      chunkIndex: index + 1,
      totalChunks: chunks.length,
      workspaceContext,
      signal: options.signal,
    });
    digests.push(`## Chunk ${index + 1}/${chunks.length}\n\n${digest}`);
    /*
    const digestResult = await requestConfiguredProviderText(config, {
      prompt: buildCaptureDigestPrompt(chunks[index], index + 1, chunks.length, workspaceContext),
      systemPrompt: 'You are the MyWiki long-document reading agent. Output only a Markdown reading digest, not JSON.',
      systemPrompt: '你是 MyWiki 长文档阅读 Agent。只输出 Markdown 阅读摘要，不要输出 JSON。',
      maxTokens: 1600,
    }, { signal: options.signal });
    if (!digestResult.ok) {
      throw new Error(`${digestResult.providerName} long document digest failed: ${digestResult.error}`);
    }
    digests.push(`## 分块 ${index + 1}/${chunks.length}\n\n${digestResult.text}`);
    */
  }

  return [
    ...(sourceIdentity ? [sourceIdentity, ''] : []),
    '# Long Document Markdown Digest',
    '',
    'The following digest was generated from the complete raw source in chunks. The complete source remains stored in the raw entry.',
    /*
    '# 长文档 Markdown 阅读摘要',
    '',
    '以下内容由 MyWiki 长文档阅读 Agent 从原始材料分块整理而来。结构化 WikiPatch 只能基于这些摘要生成；完整原文已保存在原始 Entry 中。',
    '',
    */
    ...digests,
  ].join('\n');
}

function resolveCaptureDigestChunkSize(contextWindow?: number) {
  if (!Number.isFinite(contextWindow) || !contextWindow || contextWindow < 32_000) return 8000;
  if (contextWindow >= 128_000) return 14_000;
  return 10_000;
}

function resolveCaptureDigestChunkLimit(contentLength: number) {
  if (contentLength <= 50_000) return 6;
  if (contentLength <= 120_000) return 10;
  if (contentLength <= 260_000) return 16;
  return 20;
}

async function getOrCreateCaptureDigest(input: {
  config: NonNullable<ReturnType<typeof getProviderConfigForRole>>;
  chunk: string;
  chunkIndex: number;
  totalChunks: number;
  workspaceContext: CaptureWorkspaceContext;
  signal?: AbortSignal;
}) {
  const prompt = buildCaptureDigestPrompt(input.chunk, input.chunkIndex, input.totalChunks, input.workspaceContext);
  const digestId = await buildCaptureDigestCacheId(input.config, input.workspaceContext, input.chunk);
  const cached = digestId ? readCaptureDigestCacheEntry(digestId) : '';
  if (cached) return cached;

  const digestResult = await requestConfiguredProviderText(input.config, {
    prompt,
    systemPrompt: 'You are the MyWiki long-document reading agent. Output only a Markdown reading digest, not JSON.',
    maxTokens: 1800,
    reasoningMode: 'disabled',
  }, { signal: input.signal });
  if (!digestResult.ok) {
    throw new Error(`${digestResult.providerName} long document digest failed: ${digestResult.error}`);
  }

  if (digestId) writeCaptureDigestCacheEntry(digestId, digestResult.text, input.config);
  return digestResult.text;
}

async function buildCaptureDigestCacheId(
  config: NonNullable<ReturnType<typeof getProviderConfigForRole>>,
  workspaceContext: CaptureWorkspaceContext,
  chunk: string,
) {
  return sha256Text([
    captureDigestPromptVersion,
    config.providerId,
    config.apiMode,
    config.endpoint,
    config.model,
    workspaceContext.templateId ?? '',
    workspaceContext.purpose ?? '',
    workspaceContext.schema ?? '',
    chunk,
  ].join('\n\n---mywiki-digest-cache---\n\n'));
}

function readCaptureDigestCacheEntry(id: string) {
  const cache = loadCaptureDigestCache();
  const entry = cache[id];
  if (!entry?.text?.trim()) return '';
  entry.usedAt = Date.now();
  saveCaptureDigestCache(cache);
  return entry.text;
}

function writeCaptureDigestCacheEntry(
  id: string,
  text: string,
  config: NonNullable<ReturnType<typeof getProviderConfigForRole>>,
) {
  if (!text.trim()) return;
  const cache = loadCaptureDigestCache();
  const now = Date.now();
  cache[id] = {
    text,
    providerId: config.providerId,
    model: config.model,
    createdAt: cache[id]?.createdAt ?? now,
    usedAt: now,
  };
  saveCaptureDigestCache(cache);
}

type CaptureDigestCacheEntry = {
  text: string;
  providerId: string;
  model: string;
  createdAt: number;
  usedAt: number;
};

function loadCaptureDigestCache(): Record<string, CaptureDigestCacheEntry> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(captureDigestCacheKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, CaptureDigestCacheEntry>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveCaptureDigestCache(cache: Record<string, CaptureDigestCacheEntry>) {
  if (typeof window === 'undefined') return;
  try {
    const trimmed = Object.fromEntries(
      Object.entries(cache)
        .filter(([, entry]) => entry?.text?.trim())
        .sort((left, right) => (right[1].usedAt || 0) - (left[1].usedAt || 0))
        .slice(0, captureDigestCacheMaxEntries),
    );
    window.localStorage.setItem(captureDigestCacheKey, JSON.stringify(trimmed));
  } catch {
    // Cache failures must never block source ingestion.
  }
}

async function sha256Text(value: string) {
  if (!globalThis.crypto?.subtle) return '';
  const bytes = new TextEncoder().encode(value);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
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
      reasoningMode: 'disabled',
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
