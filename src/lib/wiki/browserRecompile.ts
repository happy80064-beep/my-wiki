import { db } from '@/lib/db';
import { getProviderConfigForRole, loadProviderSettings } from '@/lib/llm/providerSettings';
import { requestConfiguredProviderText } from '@/lib/llm/runtimeProvider';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import { resolveActiveWorkspaceSchemaContext } from '@/lib/workspace/schemaContext';
import type { Entity, Entry } from '@/types';
import { buildBrowserWikiCompileContext } from './browserCompileContext';
import {
  buildWikiMarkdownCompilePrompt,
  normalizeWikiMarkdownCompileResult,
  type WikiMarkdownCompileResult,
} from './markdownCompiler';

export type BrowserRecompileResult = WikiMarkdownCompileResult & {
  provider: string;
  model: string;
};

export async function recompileBrowserEntityWikiPage(
  entityId: string,
  options: { signal?: AbortSignal } = {},
): Promise<BrowserRecompileResult> {
  const entity = await db.entities.get(entityId);
  if (!entity) throw new Error('未找到要重编译的实体。');

  const [sourceEntries, relationships] = await Promise.all([
    entity.sourceEntries.length ? db.entries.bulkGet(entity.sourceEntries) : Promise.resolve([]),
    db.relationships.where('from').equals(entity.id).or('to').equals(entity.id).toArray(),
  ]);
  const [allEntities, allEntries, allRelationships] = await Promise.all([
    db.entities.toArray(),
    db.entries.orderBy('capturedAt').reverse().toArray(),
    db.relationships.toArray(),
  ]);

  const relatedIds = Array.from(
    new Set(relationships.flatMap((relationship) => [relationship.from, relationship.to]).filter((id) => id !== entity.id)),
  );
  const relatedEntities = relatedIds.length ? (await db.entities.bulkGet(relatedIds)).filter((item): item is Entity => Boolean(item)) : [];
  const providerConfig = getProviderConfigForRole(loadProviderSettings(), 'wiki-compile');
  const usableSourceEntries: Entry[] = sourceEntries.flatMap((entry) => (entry ? [entry] : []));
  const workspaceContext = await resolveActiveWorkspaceSchemaContext();
  const requestPayload = {
    entity,
    sourceEntries: usableSourceEntries,
    relatedEntities,
    relationships,
    contextMap: buildBrowserWikiCompileContext({
      entities: allEntities,
      entries: allEntries,
      relationships: allRelationships,
      workspaceContext,
    }),
    providerConfig,
  };

  if (!import.meta.env.DEV && isTauriRuntime()) {
    if (!providerConfig) {
      throw new Error('请先在设置里配置 Wiki 编译模型，安装版才能重编译 Wiki 页面。');
    }
    const today = new Date().toISOString().slice(0, 10);
    const providerResult = await requestConfiguredProviderText(providerConfig, {
      prompt: buildWikiMarkdownCompilePrompt({ ...requestPayload, today }),
      systemPrompt:
        '你是 MyWiki v2 的中文 Wiki 编译 Agent。完整回复必须且只能是一个 ---FILE: wiki/...--- 到 ---END FILE--- 的 FILE block。第一字符必须是 -。严禁输出 <think>、思考过程、分析过程、任务复述或任何 FILE block 外说明。',
      maxTokens: 4200,
    }, { signal: options.signal });
    if (!providerResult.ok) {
      throw new Error(`${providerResult.providerName} failed: ${providerResult.error}`);
    }
    const normalized = normalizeWikiMarkdownCompileResult(providerResult.text, entity, today, {
      requireFileBlock: true,
    });
    await persistRecompileResult(entity, normalized, providerResult.providerName, providerResult.model, usableSourceEntries.length);
    return {
      ...normalized,
      provider: providerResult.providerName,
      model: providerResult.model,
    };
  }

  const response = await fetch('/api/wiki/recompile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestPayload),
    signal: options.signal,
  });

  const payload = (await response.json()) as BrowserRecompileResult | { error?: string };
  if (!response.ok || !('markdown' in payload)) {
    throw new Error((payload as { error?: string }).error || 'Wiki 重编译失败。');
  }

  await persistRecompileResult(entity, payload, payload.provider, payload.model, usableSourceEntries.length);

  return payload;
}

async function persistRecompileResult(
  entity: Entity,
  payload: WikiMarkdownCompileResult,
  provider: string,
  model: string,
  sourceCount: number,
) {
  const now = Date.now();
  const tags = mergeTags(entity.tags, payload.tags);
  await db.entities.update(entity.id, {
    summary: payload.summary || entity.summary,
    tags,
    wikiMarkdown: payload.markdown,
    wikiCompiledAt: now,
    wikiCompileModel: `${provider}:${model}`,
    compiledProfile: {
      overview: payload.summary || entity.summary,
      keyFacts: [],
      openTasks: [],
      relationshipSummary: [],
      sourceSummary: `${sourceCount} 条来源已用于 v2 Wiki 页面重编译。`,
      updatedAt: now,
    },
    updatedAt: now,
  });
}

function mergeTags(existing: string[], incoming: string[]) {
  return Array.from(new Set([...existing, ...incoming].map((tag) => tag.trim()).filter(Boolean))).slice(0, 16);
}
