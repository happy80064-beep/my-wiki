import type { CompileSuggestionDraft, CompileSuggestionRecord, Entity, EntityIndicator } from '@/types';
import { createId } from './ids';
import { db } from './schema';
import { getClientId } from './clientId';
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

export function createCompileSuggestionFingerprint(
  suggestion: Pick<CompileSuggestionDraft, 'entityId' | 'propertyKey' | 'propertyValue' | 'businessLine' | 'categoryName'>,
) {
  return [
    suggestion.entityId,
    normalizeCompileValue(suggestion.businessLine ?? ''),
    normalizeCompileValue(suggestion.categoryName ?? ''),
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

  if (entityHasCompileValue(entity, draft)) {
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
    clientId: getClientId(),
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
  if (suggestion.propertyKey.startsWith('metric_')) {
    const indicator = compileSuggestionToIndicator(suggestion, now);
    const indicators = mergeEntityIndicators(entity.indicators ?? [], [indicator]);

    await db.transaction('rw', db.entities, db.compileSuggestions, async () => {
      await db.entities.update(entity.id, {
        indicators,
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
    if (!entity || entityHasCompileValue(entity, suggestion)) {
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

function entityHasCompileValue(
  entity: Entity,
  suggestion: Pick<CompileSuggestionDraft, 'propertyKey' | 'propertyLabel' | 'propertyValue' | 'businessLine' | 'categoryName'>,
) {
  if (suggestion.propertyKey.startsWith('metric_')) {
    const hasScopedKey = Boolean(suggestion.businessLine || suggestion.categoryName);
    const targetKey = indicatorCompileKey({
      name: metricNameFromPropertyKey(suggestion.propertyKey, suggestion.propertyLabel),
      businessLine: suggestion.businessLine,
      categoryName: suggestion.categoryName,
    });

    return (entity.indicators ?? []).some((indicator) => {
      if (hasScopedKey && indicatorCompileKey(indicator) !== targetKey) return false;
      return indicatorContainsValue(indicator, suggestion.propertyValue);
    });
  }

  const properties = entity.properties as Record<string, unknown>;
  return propertyContainsValue(properties[suggestion.propertyKey], suggestion.propertyValue);
}

function compileSuggestionToIndicator(suggestion: CompileSuggestionRecord, now: number): EntityIndicator {
  const parsed = parseMetricSuggestionValue(suggestion.propertyValue);
  return {
    id: createId('indicator'),
    name: metricNameFromPropertyKey(suggestion.propertyKey, suggestion.propertyLabel),
    value: parsed.value,
    rawValue: parsed.rawValue,
    unit: parsed.unit,
    businessLine: suggestion.businessLine,
    categoryName: suggestion.categoryName,
    categoryId: suggestion.categoryId,
    source: {
      entryId: suggestion.evidenceEntryId,
      excerpt: suggestion.evidenceSnippet,
    },
    confidence: suggestion.confidence >= 0.8 ? 'high' : suggestion.confidence >= 0.6 ? 'medium' : 'low',
    note: /疑似|核对|不明确|无法确认/.test(suggestion.propertyValue)
      ? '用户确认前该指标来自低置信线索，建议核对来源。'
      : undefined,
    extractedAt: now,
    updatedAt: now,
  };
}

function metricNameFromPropertyKey(propertyKey: string, fallback: string) {
  return propertyKey.startsWith('metric_') ? fallback : propertyKey;
}

function parseMetricSuggestionValue(value: string) {
  const rawValue = value.replace(/[（(]疑似，?需核对原文[）)]/g, '').trim();
  const number = Number(rawValue.replace(/[,，]/g, '').match(/-?\d+(?:\.\d+)?/)?.[0]);
  const unit = rawValue.match(/(?:亿元|万元|元|万平方米|平方米|平米|㎡|亩|公顷|人|家|个|套|间|床|户|%|万|亿)/)?.[0];
  return {
    value: Number.isFinite(number) ? number : null,
    rawValue,
    unit,
  };
}

function mergeEntityIndicators(existing: EntityIndicator[], incoming: EntityIndicator[]) {
  const byKey = new Map<string, EntityIndicator>();
  for (const indicator of existing) byKey.set(indicatorCompileKey(indicator), indicator);
  for (const indicator of incoming) {
    const key = indicatorCompileKey(indicator);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, indicator);
      continue;
    }
    byKey.set(key, {
      ...current,
      ...indicator,
      id: current.id,
      extractedAt: Math.min(current.extractedAt, indicator.extractedAt),
      updatedAt: Math.max(current.updatedAt, indicator.updatedAt),
    });
  }
  return Array.from(byKey.values());
}

function indicatorCompileKey(indicator: Pick<EntityIndicator, 'name' | 'businessLine' | 'categoryName'>) {
  return [
    normalizeCompileValue(indicator.businessLine ?? ''),
    normalizeCompileValue(indicator.categoryName ?? ''),
    normalizeCompileValue(indicator.name),
  ].join(':');
}

function indicatorContainsValue(indicator: EntityIndicator, propertyValue: string) {
  return propertyContainsValue(indicator.rawValue, propertyValue) ||
    propertyContainsValue(`${indicator.value ?? ''}${indicator.unit ?? ''}`, propertyValue);
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
