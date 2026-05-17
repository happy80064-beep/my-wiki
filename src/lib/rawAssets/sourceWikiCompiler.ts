import { db } from '@/lib/db';
import { getProviderConfigForRole, loadProviderSettings } from '@/lib/llm/providerSettings';
import { requestConfiguredProviderText } from '@/lib/llm/runtimeProvider';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import { resolveActiveWorkspaceSchemaContext } from '@/lib/workspace/schemaContext';
import type { Entity, RawAsset } from '@/types';
import { buildBrowserWikiCompileContext } from '@/lib/wiki/browserCompileContext';
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
  warnings: string[];
  provider: string;
  model: string;
};

const sourceWikiBatchSize = 6;

export async function compileRawAssetWikiPagesFromSource(
  asset: RawAsset,
  entityIds: string[],
  options: { signal?: AbortSignal } = {},
): Promise<RawAssetSourceWikiBatchResult> {
  if (!asset.entryId) {
    return { compiled: 0, missingEntityIds: entityIds, warnings: [], provider: '', model: '' };
  }

  const sourceEntry = await db.entries.get(asset.entryId);
  if (!sourceEntry) throw new Error(`Source entry for ${asset.filename} is missing.`);

  const targetEntities = (await db.entities.bulkGet(entityIds)).filter((entity): entity is Entity => Boolean(entity));
  if (targetEntities.length === 0) {
    return { compiled: 0, missingEntityIds: entityIds, warnings: [], provider: '', model: '' };
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
    const batchResult = await requestSourceWikiBatchCompile(payload, options);
    provider = batchResult.provider || provider;
    model = batchResult.model || model;
    warnings.push(...(batchResult.warnings ?? []));

    for (const result of batchResult.results) {
      const entity = batch.find((item) => item.id === result.entityId);
      if (!entity) continue;
      await persistSourceBatchWikiResult(entity, result, provider, model, 1);
      missingEntityIds.delete(entity.id);
      compiled += 1;
    }
  }

  return { compiled, missingEntityIds: Array.from(missingEntityIds), warnings, provider, model };
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

async function persistSourceBatchWikiResult(
  entity: Entity,
  payload: WikiMarkdownCompileResult,
  provider: string,
  model: string,
  sourceCount: number,
) {
  const now = Date.now();
  await db.entities.update(entity.id, {
    summary: payload.summary || entity.summary,
    tags: mergeTags(entity.tags, payload.tags),
    wikiMarkdown: payload.markdown,
    wikiCompiledAt: now,
    wikiCompileModel: `${provider}:${model}`,
    compiledProfile: {
      overview: payload.summary || entity.summary,
      keyFacts: [],
      openTasks: [],
      relationshipSummary: [],
      sourceSummary: `${sourceCount} 条来源已用于文件级 Wiki 页面批量编译。`,
      updatedAt: now,
    },
    updatedAt: now,
  });
}

function chunkEntities(entities: Entity[], size: number) {
  const chunks: Entity[][] = [];
  for (let index = 0; index < entities.length; index += size) {
    chunks.push(entities.slice(index, index + size));
  }
  return chunks;
}

function mergeTags(existing: string[], incoming: string[]) {
  return Array.from(new Set([...existing, ...incoming].map((tag) => tag.trim()).filter(Boolean))).slice(0, 16);
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
