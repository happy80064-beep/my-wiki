import type { CompileSuggestionDraft, CompileSuggestionRecord, Entity } from '@/types';
import { createId } from './ids';
import { db } from './schema';
import { refreshCompiledProfile } from '@/lib/wikiIndex';

const allowedCompilePropertyKeys = new Set([
  'runtimeEnvironment',
  'wakeWord',
  'stopWord',
  'localPath',
  'models',
  'ownerNote',
  'derivedFrom',
  'openSourceStatus',
]);

export function isAllowedCompilePropertyKey(propertyKey: string) {
  return allowedCompilePropertyKeys.has(propertyKey) || /^metric_[a-z0-9_]{3,80}$/.test(propertyKey);
}

export function createCompileSuggestionFingerprint(suggestion: Pick<CompileSuggestionDraft, 'entityId' | 'propertyKey' | 'propertyValue'>) {
  return [
    suggestion.entityId,
    suggestion.propertyKey,
    normalizeCompileValue(suggestion.propertyValue),
  ].join(':');
}

export async function materializeCompileSuggestions(
  drafts: CompileSuggestionDraft[],
  sourceQuestion?: string,
): Promise<CompileSuggestionRecord[]> {
  if (drafts.length === 0) return [];

  await sweepCompileSuggestions(drafts.map((draft) => draft.entityId));

  const records: CompileSuggestionRecord[] = [];
  for (const draft of drafts) {
    const record = await upsertPendingCompileSuggestion(draft, sourceQuestion);
    if (record?.status === 'pending') {
      records.push(record);
    }
  }

  return records.sort((a, b) => b.confidence - a.confidence || b.updatedAt - a.updatedAt);
}

export async function upsertPendingCompileSuggestion(
  draft: CompileSuggestionDraft,
  sourceQuestion?: string,
): Promise<CompileSuggestionRecord | undefined> {
  if (!isAllowedCompilePropertyKey(draft.propertyKey)) return undefined;

  const entity = await db.entities.get(draft.entityId);
  if (!entity) return undefined;

  const fingerprint = createCompileSuggestionFingerprint(draft);
  const existing = await db.compileSuggestions.where('fingerprint').equals(fingerprint).first();
  const now = Date.now();

  if (entityHasCompileValue(entity, draft.propertyKey, draft.propertyValue)) {
    if (existing?.status === 'pending') {
      await db.compileSuggestions.update(existing.id, {
        status: 'superseded',
        supersededAt: now,
        updatedAt: now,
      });
    }
    return undefined;
  }

  if (existing) {
    if (existing.status !== 'pending') return undefined;

    const patch =
      draft.confidence > existing.confidence
        ? {
            ...draft,
            sourceQuestion: sourceQuestion ?? existing.sourceQuestion,
            updatedAt: now,
          }
        : {
            sourceQuestion: existing.sourceQuestion ?? sourceQuestion,
            updatedAt: now,
          };

    await db.compileSuggestions.update(existing.id, patch);
    return (await db.compileSuggestions.get(existing.id)) ?? existing;
  }

  const record: CompileSuggestionRecord = {
    ...draft,
    id: createId('compile'),
    fingerprint,
    status: 'pending',
    sourceQuestion,
    createdAt: now,
    updatedAt: now,
  };
  await db.compileSuggestions.add(record);
  return record;
}

export async function listPendingCompileSuggestions() {
  await sweepCompileSuggestions();
  return db.compileSuggestions.where('status').equals('pending').reverse().sortBy('updatedAt');
}

export async function applyCompileSuggestion(id: string) {
  const suggestion = await db.compileSuggestions.get(id);
  if (!suggestion || suggestion.status !== 'pending') return undefined;
  if (!isAllowedCompilePropertyKey(suggestion.propertyKey)) {
    await markCompileSuggestion(id, 'dismissed');
    return undefined;
  }

  const entity = await db.entities.get(suggestion.entityId);
  if (!entity) {
    await markCompileSuggestion(id, 'superseded');
    return undefined;
  }

  const now = Date.now();
  const properties = {
    ...(entity.properties as Record<string, unknown>),
    [suggestion.propertyKey]: mergePropertyValue(
      (entity.properties as Record<string, unknown>)[suggestion.propertyKey],
      suggestion.propertyValue,
    ),
  };

  await db.transaction('rw', db.entities, db.compileSuggestions, async () => {
    await db.entities.update(entity.id, {
      properties: properties as Entity['properties'],
      updatedAt: now,
    });
    await db.compileSuggestions.update(suggestion.id, {
      status: 'applied',
      appliedAt: now,
      updatedAt: now,
    });
  });
  await refreshCompiledProfile(entity.id);

  return db.compileSuggestions.get(id);
}

export async function dismissCompileSuggestion(id: string) {
  return markCompileSuggestion(id, 'dismissed');
}

export async function sweepCompileSuggestions(entityIds?: string[]) {
  const scopedEntityIds = entityIds ? new Set(entityIds) : undefined;
  const pending = await db.compileSuggestions.where('status').equals('pending').toArray();
  const now = Date.now();

  for (const suggestion of pending) {
    if (scopedEntityIds && !scopedEntityIds.has(suggestion.entityId)) continue;

    const entity = await db.entities.get(suggestion.entityId);
    if (!entity || entityHasCompileValue(entity, suggestion.propertyKey, suggestion.propertyValue)) {
      await db.compileSuggestions.update(suggestion.id, {
        status: 'superseded',
        supersededAt: now,
        updatedAt: now,
      });
    }
  }
}

async function markCompileSuggestion(id: string, status: 'dismissed' | 'superseded') {
  const now = Date.now();
  await db.compileSuggestions.update(id, {
    status,
    dismissedAt: status === 'dismissed' ? now : undefined,
    supersededAt: status === 'superseded' ? now : undefined,
    updatedAt: now,
  });
  return db.compileSuggestions.get(id);
}

function entityHasCompileValue(entity: Entity, propertyKey: string, propertyValue: string) {
  const properties = entity.properties as Record<string, unknown>;
  return propertyContainsValue(properties[propertyKey], propertyValue);
}

function propertyContainsValue(currentValue: unknown, propertyValue: string): boolean {
  if (currentValue === undefined || currentValue === null) return false;

  if (Array.isArray(currentValue)) {
    return currentValue.some((item) => propertyContainsValue(item, propertyValue));
  }

  const normalizedCurrent = normalizeCompileValue(String(currentValue));
  const normalizedTarget = normalizeCompileValue(propertyValue);
  if (!normalizedCurrent || !normalizedTarget) return false;

  return normalizedCurrent === normalizedTarget || normalizedCurrent.includes(normalizedTarget);
}

function mergePropertyValue(currentValue: unknown, propertyValue: string): unknown {
  if (Array.isArray(currentValue)) {
    const exists = currentValue.some((item) => propertyContainsValue(item, propertyValue));
    return exists ? currentValue : [...currentValue, propertyValue];
  }

  return propertyValue;
}

function normalizeCompileValue(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
    .trim();
}
