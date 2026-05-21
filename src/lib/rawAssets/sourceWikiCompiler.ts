import { db } from '@/lib/db';
import { getProviderConfigForRole, loadProviderSettings } from '@/lib/llm/providerSettings';
import { requestConfiguredProviderText } from '@/lib/llm/runtimeProvider';
import { isProviderRetryableError } from '@/lib/llm/requestScheduler';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import { resolveActiveWorkspaceSchemaContext } from '@/lib/workspace/schemaContext';
import type { Entity, RawAsset } from '@/types';
import { buildBrowserWikiCompileContext } from '@/lib/wiki/browserCompileContext';
import { persistWikiCompileCandidate } from '@/lib/wiki/compilePersistence';
import {
  buildWikiMarkdownBatchCompilePrompt,
  normalizeWikiMarkdownBatchCompileResult,
  type WikiMarkdownBatchCompileInput,
  type WikiMarkdownBatchCompileResult,
  type WikiMarkdownCompileResult,
} from '@/lib/wiki/markdownCompiler';

export type RawAssetSourceWikiBatchResult = {
  compiled: number;
  missingEntityIds: string[];
  reviewQueuedEntityIds: string[];
  warnings: string[];
  provider: string;
  model: string;
};

const sourceWikiBatchSize = 6;
const sourceWikiBatchRetryLimit = 2;
const sourceWikiBatchRetryBaseDelayMs = 2500;

export async function compileRawAssetWikiPagesFromSource(
  asset: RawAsset,
  entityIds: string[],
  options: { signal?: AbortSignal } = {},
): Promise<RawAssetSourceWikiBatchResult> {
  if (!asset.entryId) {
    return { compiled: 0, missingEntityIds: entityIds, reviewQueuedEntityIds: [], warnings: [], provider: '', model: '' };
  }

  const sourceEntry = await db.entries.get(asset.entryId);
  if (!sourceEntry) throw new Error(`Source entry for ${asset.filename} is missing.`);

  const targetEntities = (await db.entities.bulkGet(entityIds)).filter((entity): entity is Entity => Boolean(entity));
  if (targetEntities.length === 0) {
    return { compiled: 0, missingEntityIds: entityIds, reviewQueuedEntityIds: [], warnings: [], provider: '', model: '' };
  }

  const [allEntities, allEntries, allRelationships] = await Promise.all([
    db.entities.toArray(),
    db.entries.orderBy('capturedAt').reverse().toArray(),
    db.relationships.toArray(),
  ]);
  const workspaceContext = await resolveActiveWorkspaceSchemaContext();
  const contextMap = buildBrowserWikiCompileContext({
    entities: allEntities,
    entries: allEntries,
    relationships: allRelationships,
    workspaceContext,
  });
  const relatedEntities = allEntities
    .filter((entity) => !targetEntities.some((target) => target.id === entity.id))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 80);
  const providerConfig = getProviderConfigForRole(loadProviderSettings(), 'wiki-compile');
  const today = new Date().toISOString().slice(0, 10);
  const warnings: string[] = [];
  const missingEntityIds = new Set(targetEntities.map((entity) => entity.id));
  const reviewQueuedEntityIds = new Set<string>();
  let compiled = 0;
  let provider = '';
  let model = '';

  for (const batch of chunkEntities(targetEntities, sourceWikiBatchSize)) {
    throwIfAborted(options.signal);
    const payload: WikiMarkdownBatchCompileInput & { providerConfig?: typeof providerConfig } = {
      sourceEntry,
      entities: batch,
      relatedEntities,
      relationships: allRelationships,
      contextMap,
      today,
      providerConfig,
    };
    const batchResult = await requestSourceWikiBatchCompileWithRetry(payload, options);
    provider = batchResult.provider || provider;
    model = batchResult.model || model;
    warnings.push(...(batchResult.warnings ?? []));

    for (const result of batchResult.results) {
      const entity = batch.find((item) => item.id === result.entityId);
      if (!entity) continue;
      const persisted = await persistSourceBatchWikiResult(entity, result, provider, model, 1);
      if (!persisted.applied) {
        reviewQueuedEntityIds.add(entity.id);
        warnings.push(`Wiki update for "${entity.title}" was queued for human review.`);
      } else {
        compiled += 1;
      }
      missingEntityIds.delete(entity.id);
    }
  }

  return { compiled, missingEntityIds: Array.from(missingEntityIds), reviewQueuedEntityIds: Array.from(reviewQueuedEntityIds), warnings, provider, model };
}

async function requestSourceWikiBatchCompile(
  payload: WikiMarkdownBatchCompileInput & {
    providerConfig?: ReturnType<typeof getProviderConfigForRole>;
  },
  options: { signal?: AbortSignal },
): Promise<WikiMarkdownBatchCompileResult & { provider: string; model: string }> {
  if (!import.meta.env.DEV && isTauriRuntime()) {
    if (!payload.providerConfig) {
      throw new Error('请先在设置里配置 Wiki 编译模型，安装版才能批量生成 Wiki 页面。');
    }
    const providerResult = await requestConfiguredProviderText(
      payload.providerConfig,
      {
        prompt: buildWikiMarkdownBatchCompilePrompt(payload),
        systemPrompt:
          '你是 MyWiki v2 的文件级 Wiki 编译 Agent。完整回复必须且只能是多个 ---FILE: wiki/...--- 到 ---END FILE--- 的 FILE blocks。第一字符必须是 -。严禁输出 <think>、思考过程、分析过程、任务复述或任何 FILE block 外说明。',
        maxTokens: 9000,
        reasoningMode: 'disabled',
      },
      { signal: options.signal },
    );
    if (!providerResult.ok) {
      throw new Error(`${providerResult.providerName} failed: ${providerResult.error}`);
    }
    const normalized = normalizeWikiMarkdownBatchCompileResult(providerResult.text, payload);
    return {
      ...normalized,
      provider: providerResult.providerName,
      model: providerResult.model,
    };
  }

  const response = await fetch('/api/wiki/recompile-source-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  const data = (await response.json()) as (WikiMarkdownBatchCompileResult & { provider: string; model: string }) | { error?: string };
  if (!response.ok || !('results' in data)) {
    throw new Error((data as { error?: string }).error || 'Wiki batch recompilation failed.');
  }
  return data;
}

async function requestSourceWikiBatchCompileWithRetry(
  payload: WikiMarkdownBatchCompileInput & {
    providerConfig?: ReturnType<typeof getProviderConfigForRole>;
  },
  options: { signal?: AbortSignal },
): Promise<WikiMarkdownBatchCompileResult & { provider: string; model: string }> {
  let lastError: unknown;
  let lastPartialResult: (WikiMarkdownBatchCompileResult & { provider: string; model: string }) | undefined;

  for (let attempt = 1; attempt <= sourceWikiBatchRetryLimit; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      const result = await requestSourceWikiBatchCompile(payload, options);
      if (result.missingEntityIds.length === 0 || attempt >= sourceWikiBatchRetryLimit) return result;
      lastPartialResult = result;
      throw new Error(`Wiki batch compiler did not return all requested FILE blocks: ${result.missingEntityIds.length} missing.`);
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
      if (attempt >= sourceWikiBatchRetryLimit || !isRetryableSourceWikiBatchError(error)) {
        if (lastPartialResult) return lastPartialResult;
        throw error;
      }
      await sleep(sourceWikiBatchRetryBaseDelayMs * attempt, options.signal);
    }
  }

  if (lastPartialResult) return lastPartialResult;
  throw lastError;
}

async function persistSourceBatchWikiResult(
  entity: Entity,
  payload: WikiMarkdownCompileResult,
  provider: string,
  model: string,
  sourceCount: number,
) {
  return persistWikiCompileCandidate({
    entity,
    payload,
    provider,
    model,
    sourceCount,
    sourceLabel: 'raw-asset-source-compile',
  });
}

function chunkEntities(entities: Entity[], size: number) {
  const chunks: Entity[][] = [];
  for (let index = 0; index < entities.length; index += size) {
    chunks.push(entities.slice(index, index + size));
  }
  return chunks;
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function isRetryableSourceWikiBatchError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || 'unknown error');
  return (
    isProviderRetryableError(message) ||
    /valid file block|file blocks|did not return|missing pages|missing file|malformed|empty content/i.test(message)
  );
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      globalThis.clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
