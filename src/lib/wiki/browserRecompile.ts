import { db } from '@/lib/db';
import { getProviderConfigForRole, loadProviderSettings } from '@/lib/llm/providerSettings';
import { requestConfiguredProviderText } from '@/lib/llm/runtimeProvider';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import { resolveActiveWorkspaceSchemaContext } from '@/lib/workspace/schemaContext';
import type { Entity, Entry } from '@/types';
import { buildBrowserWikiCompileContext } from './browserCompileContext';
import { persistWikiCompileCandidate } from './compilePersistence';
import {
  buildWikiMarkdownCompilePrompt,
  normalizeWikiMarkdownCompileResult,
  type WikiMarkdownCompileResult,
} from './markdownCompiler';

export type BrowserRecompileResult = WikiMarkdownCompileResult & {
  provider: string;
  model: string;
  reviewQueued?: boolean;
  reviewId?: string;
};

export async function recompileBrowserEntityWikiPage(
  entityId: string,
  options: { signal?: AbortSignal } = {},
): Promise<BrowserRecompileResult> {
  const entity = await db.entities.get(entityId);
  if (!entity) throw new Error('Cannot find entity to recompile.');

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
      throw new Error('Please configure a Wiki compile model before recompiling a wiki page.');
    }
    const today = new Date().toISOString().slice(0, 10);
    const providerResult = await requestConfiguredProviderText(providerConfig, {
      prompt: buildWikiMarkdownCompilePrompt({ ...requestPayload, today }),
      systemPrompt:
        'You are the MyWiki v2 wiki compiler. Return exactly one FILE block and no commentary.',
      maxTokens: 4200,
      reasoningMode: 'disabled',
    }, { signal: options.signal });
    if (!providerResult.ok) {
      throw new Error(`${providerResult.providerName} failed: ${providerResult.error}`);
    }
    const normalized = normalizeWikiMarkdownCompileResult(providerResult.text, entity, today, {
      requireFileBlock: true,
    });
    const persisted = await persistRecompileResult(entity, normalized, providerResult.providerName, providerResult.model, usableSourceEntries.length);
    return {
      ...normalized,
      provider: providerResult.providerName,
      model: providerResult.model,
      reviewQueued: !persisted.applied,
      reviewId: persisted.review?.id,
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
    throw new Error((payload as { error?: string }).error || 'Wiki recompilation failed.');
  }

  const persisted = await persistRecompileResult(entity, payload, payload.provider, payload.model, usableSourceEntries.length);

  return {
    ...payload,
    reviewQueued: !persisted.applied,
    reviewId: persisted.review?.id,
  };
}

function persistRecompileResult(
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
    sourceLabel: 'manual-recompile',
  });
}
