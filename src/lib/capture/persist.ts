import type { Entity, EntityProperties, EntrySource, PersonProps, TopicProps } from '@/types';
import {
  createId,
  createEntity,
  createEntry,
  createRelationship,
  createTask,
  db,
  materializeCompileSuggestions,
  updateEntity,
  updateEntry,
  updateRelationship,
} from '@/lib/db';
import { defaultEntityProperties } from '@/lib/db/entities';
import { refreshCompiledProfiles } from '@/lib/wikiIndex';
import { runTopicAutoAggregation } from '@/lib/wikiIndex/topicAggregation';
import type { CaptureDraft, DraftEntity } from './draft';
import { getDraftEntities } from './draft';

export type CaptureCompilationSummary = {
  createdEntities: number;
  reusedEntities: number;
  updatedPeople: number;
  updatedTopics: number;
  createdRelationships: number;
  updatedRelationships: number;
  createdTasks: number;
  queuedCompileSuggestions: number;
  autoAggregatedTopics: number;
};

export type PersistCaptureDraftOptions = {
  entryId?: string;
};

export async function persistCaptureDraft(
  content: string,
  draft: CaptureDraft,
  source: EntrySource = 'text',
  options: PersistCaptureDraftOptions = {},
) {
  const existingEntry = options.entryId ? await db.entries.get(options.entryId) : undefined;
  const entry =
    existingEntry ??
    (await createEntry({
      content,
      source,
      processed: true,
    }));

  if (existingEntry) {
    await updateEntry(existingEntry.id, {
      content,
      source,
      processed: true,
    });
  }
  const entityIdByClientId = new Map<string, string>();
  const compilation: CaptureCompilationSummary = {
    createdEntities: 0,
    reusedEntities: 0,
    updatedPeople: 0,
    updatedTopics: 0,
    createdRelationships: 0,
    updatedRelationships: 0,
    createdTasks: 0,
    queuedCompileSuggestions: 0,
    autoAggregatedTopics: 0,
  };

  const entities: Entity[] = [];
  const relationships = [];
  const tasks = [];

  for (const draftEntity of getDraftEntities(draft)) {
    const result = await resolveCaptureEntity(draftEntity, entry.id, entry.capturedAt);
    const entity = result.entity;
    entityIdByClientId.set(draftEntity.clientId, entity.id);
    entities.push(entity);

    if (result.action === 'created') compilation.createdEntities += 1;
    if (result.action === 'reused') compilation.reusedEntities += 1;
    if (result.compiledPerson) compilation.updatedPeople += 1;
    if (result.compiledTopic) compilation.updatedTopics += 1;
  }

  for (const draftRelationship of draft.relationships) {
    const from = entityIdByClientId.get(draftRelationship.fromClientId);
    const to = entityIdByClientId.get(draftRelationship.toClientId);
    if (!from || !to) continue;

    const result = await createOrUpdateRelationship({
      from,
      to,
      type: draftRelationship.type,
      evidence: [entry.id],
    });
    relationships.push(result.relationship);

    if (result.action === 'created') compilation.createdRelationships += 1;
    if (result.action === 'updated') compilation.updatedRelationships += 1;
  }

  for (const draftTask of draft.tasks) {
    const owner = entityIdByClientId.get(draftTask.ownerClientId);
    if (!owner) continue;

    tasks.push(
      await createTask({
        description: draftTask.description,
        owner,
        linkedTo: draftTask.linkedToClientIds
          .map((clientId) => entityIdByClientId.get(clientId))
          .filter((id): id is string => Boolean(id)),
        dueDate: draftTask.dueDate,
        status: draftTask.status,
        source: entry.id,
      }),
    );
    compilation.createdTasks += 1;
  }

  const compileSuggestions = await materializeCompileSuggestions(
    (draft.compileSuggestions ?? [])
      .map((suggestion) => {
        const entityId = entityIdByClientId.get(suggestion.entityClientId);
        if (!entityId) return undefined;

        return {
          entityId,
          entityTitle: suggestion.entityTitle,
          propertyKey: suggestion.propertyKey,
          propertyLabel: suggestion.propertyLabel,
          propertyValue: suggestion.propertyValue,
          evidenceEntryId: entry.id,
          evidenceSnippet: suggestion.evidenceSnippet,
          evidenceScope: 'entity-source' as const,
          confidence: suggestion.confidence,
        };
      })
      .filter((suggestion): suggestion is NonNullable<typeof suggestion> => Boolean(suggestion)),
    'capture-ingest',
  );
  compilation.queuedCompileSuggestions = compileSuggestions.length;
  const topicAggregation = await runTopicAutoAggregation(entities.map((entity) => entity.id), entry.id);
  compilation.autoAggregatedTopics = topicAggregation.topicIds.length;

  const derivedEntityIds = mergeUnique(entities.map((entity) => entity.id), topicAggregation.topicIds);
  const derivedRelationshipIds = mergeUnique(
    relationships.map((relationship) => relationship.id),
    topicAggregation.linkedRelationships,
  );

  await updateEntry(entry.id, {
    derivedEntities: derivedEntityIds,
    derivedRelationships: derivedRelationshipIds,
    derivedTasks: tasks.map((task) => task.id),
  });
  await refreshCompiledProfiles(derivedEntityIds);

  return {
    entry: (await updateEntry(entry.id, {}))!,
    entities,
    relationships,
    tasks,
    compilation,
    topicAggregation,
  };
}

async function resolveCaptureEntity(draftEntity: DraftEntity, entryId: string, capturedAt: number) {
  const reusableEntity = await findReusableEntity(draftEntity);
  const compiledPerson = draftEntity.type === 'person';
  const compiledTopic = draftEntity.type === 'topic';

  if (!reusableEntity) {
    const entity = await createEntity({
      type: draftEntity.type,
      title: draftEntity.title,
      summary: draftEntity.summary,
      tags: draftEntity.tags,
      scenes: draftEntity.scenes,
      categories: stampDraftCategories(draftEntity, capturedAt),
      indicators: stampDraftIndicators(draftEntity, capturedAt),
      properties: compileEntityProperties(defaultEntityProperties(draftEntity.type), draftEntity.type, entryId, capturedAt),
      sourceEntries: [entryId],
    });
    return { entity, action: 'created' as const, compiledPerson, compiledTopic };
  }

  const updated = await updateEntity(reusableEntity.id, {
    summary: reusableEntity.summary.trim() ? reusableEntity.summary : draftEntity.summary,
    tags: mergeUnique(reusableEntity.tags, draftEntity.tags),
    scenes: mergeUnique(reusableEntity.scenes, draftEntity.scenes),
    categories: mergeEntityCategories(reusableEntity.categories ?? [], stampDraftCategories(draftEntity, capturedAt)),
    indicators: mergeEntityIndicators(reusableEntity.indicators ?? [], stampDraftIndicators(draftEntity, capturedAt)),
    properties: compileEntityProperties(reusableEntity.properties, reusableEntity.type, entryId, capturedAt),
    sourceEntries: mergeUnique(reusableEntity.sourceEntries, [entryId]),
  });

  return { entity: updated ?? reusableEntity, action: 'reused' as const, compiledPerson, compiledTopic };
}

async function findReusableEntity(draftEntity: DraftEntity) {
  if (draftEntity.type === 'event') {
    return undefined;
  }

  const normalizedTitle = normalizeTitle(draftEntity.title);
  if (!normalizedTitle) return undefined;

  const candidates = await db.entities
    .where('type')
    .equals(draftEntity.type)
    .toArray();

  return (
    candidates.find((entity) => normalizeTitle(entity.title) === normalizedTitle) ??
    candidates.find((entity) => isReusableTitleMatch(normalizeTitle(entity.title), normalizedTitle, draftEntity.type)) ??
    (await findExactReusableEntityAcrossCompatibleTypes(draftEntity, normalizedTitle))
  );
}

async function findExactReusableEntityAcrossCompatibleTypes(draftEntity: DraftEntity, normalizedTitle: string) {
  if (draftEntity.type === 'person') return undefined;
  const candidates = await db.entities
    .filter((entity) => entity.type !== 'event' && entity.type !== 'person' && normalizeTitle(entity.title) === normalizedTitle)
    .toArray();
  return candidates.sort((left, right) => right.sourceEntries.length - left.sourceEntries.length || right.updatedAt - left.updatedAt)[0];
}

async function createOrUpdateRelationship(input: {
  from: string;
  to: string;
  type: Parameters<typeof createRelationship>[0]['type'];
  evidence: string[];
}) {
  const existingRelationship = await db.relationships
    .where('from')
    .equals(input.from)
    .filter((relationship) => relationship.to === input.to && relationship.type === input.type)
    .first();

  if (!existingRelationship) {
    return { relationship: await createRelationship(input), action: 'created' as const };
  }

  const updated = await updateRelationship(existingRelationship.id, {
    evidence: mergeUnique(existingRelationship.evidence, input.evidence),
  });

  return { relationship: updated ?? existingRelationship, action: 'updated' as const };
}

function compileEntityProperties(
  properties: EntityProperties,
  type: DraftEntity['type'],
  entryId: string,
  capturedAt: number,
): EntityProperties {
  if (type === 'person') {
    return {
      ...(properties as PersonProps),
      lastContactAt: capturedAt,
    } satisfies PersonProps;
  }

  if (type === 'topic') {
    const topicProps = properties as TopicProps;
    return {
      ...topicProps,
      autoCollectedSnippets: mergeUnique(topicProps.autoCollectedSnippets ?? [], [entryId]),
    } satisfies TopicProps;
  }

  return properties;
}

function mergeUnique<T>(left: T[], right: T[]) {
  return Array.from(new Set([...left, ...right]));
}

function stampDraftCategories(draftEntity: DraftEntity, updatedAt: number) {
  return (draftEntity.categories ?? [])
    .map((category) => ({
      name: category.name.trim(),
      aliases: mergeUnique(category.aliases ?? [], [category.name]).filter(Boolean),
      items: mergeCategoryItems(category.items ?? []),
      evidence: category.evidence?.trim(),
      updatedAt,
    }))
    .filter((category) => category.name && category.items.length > 0);
}

function mergeEntityCategories(
  existing: NonNullable<Entity['categories']>,
  incoming: NonNullable<Entity['categories']>,
) {
  const byName = new Map<string, NonNullable<Entity['categories']>[number]>();

  for (const category of existing) {
    byName.set(normalizeTitle(category.name), category);
  }

  for (const category of incoming) {
    const key = normalizeTitle(category.name);
    const current = byName.get(key);
    if (!current) {
      byName.set(key, category);
      continue;
    }

    byName.set(key, {
      ...current,
      aliases: mergeUnique(current.aliases ?? [], category.aliases ?? []),
      items: mergeCategoryItems([...(current.items ?? []), ...(category.items ?? [])]),
      evidence: category.evidence ?? current.evidence,
      updatedAt: Math.max(current.updatedAt, category.updatedAt),
    });
  }

  return Array.from(byName.values());
}

function mergeCategoryItems(items: NonNullable<Entity['categories']>[number]['items']) {
  const byTitle = new Map<string, NonNullable<Entity['categories']>[number]['items'][number]>();
  for (const item of items) {
    const title = item.title.trim();
    if (!title) continue;
    const key = normalizeTitle(title);
    const current = byTitle.get(key);
    byTitle.set(key, {
      ...current,
      ...item,
      title,
      summary: item.summary?.trim() || current?.summary,
      evidence: item.evidence?.trim() || current?.evidence,
    });
  }
  return Array.from(byTitle.values());
}

function stampDraftIndicators(draftEntity: DraftEntity, updatedAt: number) {
  return (draftEntity.indicators ?? [])
    .map((indicator) => {
      const categoryName = resolveIndicatorCategoryName(indicator, draftEntity);
      return {
        ...indicator,
        id: createId('indicator'),
        name: indicator.name.trim(),
        rawValue: indicator.rawValue?.trim(),
        unit: indicator.unit?.trim(),
        businessLine: normalizeIndicatorBusinessLine(indicator.businessLine, categoryName),
        categoryName,
        categoryId: indicator.categoryId?.trim(),
        source: indicator.source
          ? {
              entryId: indicator.source.entryId,
              section: indicator.source.section?.trim(),
              page: indicator.source.page,
              excerpt: indicator.source.excerpt?.trim(),
            }
          : undefined,
        note: indicator.note?.trim(),
        asOfDate: indicator.asOfDate?.trim(),
        extractedAt: updatedAt,
        updatedAt,
      };
    })
    .filter((indicator) => indicator.name && indicator.confidence);
}

function resolveIndicatorCategoryName(
  indicator: Pick<NonNullable<Entity['indicators']>[number], 'categoryName' | 'businessLine' | 'name'>,
  draftEntity: DraftEntity,
) {
  const categories = draftEntity.categories ?? [];
  const rawCategory = indicator.categoryName?.trim();
  const rawBusinessLine = indicator.businessLine?.trim();
  const searchText = normalizeTitle([rawCategory, rawBusinessLine, indicator.name].filter(Boolean).join(' '));
  if (!searchText) return rawCategory;

  const matched = categories.find((category) => {
    const aliases = [
      category.name,
      ...(category.aliases ?? []),
      category.name.replace(/(业态|版块|板块|业务线|子分类|子类)$/g, ''),
    ];
    return aliases.some((alias) => {
      const normalizedAlias = normalizeTitle(alias);
      return normalizedAlias.length >= 2 &&
        (searchText.includes(normalizedAlias) || normalizedAlias.includes(normalizeTitle(rawCategory ?? rawBusinessLine ?? '')));
    });
  });

  return matched?.name.trim() || rawCategory;
}

function normalizeIndicatorBusinessLine(value: string | undefined, categoryName: string | undefined) {
  const trimmed = value?.trim();
  if (trimmed) return trimmed;
  return categoryName?.replace(/(业态|版块|板块|业务线|子分类|子类)$/g, '').trim();
}

function mergeEntityIndicators(
  existing: NonNullable<Entity['indicators']>,
  incoming: NonNullable<Entity['indicators']>,
) {
  const byKey = new Map<string, NonNullable<Entity['indicators']>[number]>();

  for (const indicator of existing) {
    byKey.set(indicatorMergeKey(indicator), indicator);
  }

  for (const indicator of incoming) {
    const key = indicatorMergeKey(indicator);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, indicator);
      continue;
    }

    const shouldUseIncomingValue = indicator.value !== null || current.value === null;
    byKey.set(key, {
      ...current,
      ...indicator,
      id: current.id,
      value: shouldUseIncomingValue ? indicator.value : current.value,
      rawValue: shouldUseIncomingValue ? indicator.rawValue : current.rawValue,
      unit: shouldUseIncomingValue ? indicator.unit : current.unit,
      confidence: betterIndicatorConfidence(current.confidence, indicator.confidence),
      source: indicator.source ?? current.source,
      note: indicator.note ?? current.note,
      extractedAt: Math.min(current.extractedAt, indicator.extractedAt),
      updatedAt: Math.max(current.updatedAt, indicator.updatedAt),
    });
  }

  return Array.from(byKey.values());
}

function indicatorMergeKey(indicator: Pick<NonNullable<Entity['indicators']>[number], 'name' | 'businessLine' | 'categoryName'>) {
  return [
    normalizeTitle(indicator.businessLine ?? ''),
    normalizeTitle(indicator.categoryName ?? ''),
    normalizeTitle(indicator.name),
  ].join(':');
}

function betterIndicatorConfidence(
  left: NonNullable<Entity['indicators']>[number]['confidence'],
  right: NonNullable<Entity['indicators']>[number]['confidence'],
) {
  const rank = { low: 1, medium: 2, high: 3 } as const;
  return rank[right] > rank[left] ? right : left;
}

function normalizeTitle(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
    .trim();
}

function isReusableTitleMatch(existingTitle: string, draftTitle: string, type: DraftEntity['type']) {
  const minLength = type === 'person' ? 2 : 4;
  if (existingTitle.length < minLength || draftTitle.length < minLength) return false;
  return existingTitle.includes(draftTitle) || draftTitle.includes(existingTitle);
}
