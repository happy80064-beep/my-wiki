import type {
  CompileSuggestionRecord,
  Entity,
  EntityProperties,
  EntityType,
  EventProps,
  PersonProps,
  ProjectProps,
  Scene,
  TopicProps,
  WikiReviewRecord,
} from '@/types';
import { db } from './schema';
import { createId } from './ids';
import { getClientId } from './clientId';
import { createWikiMarkdownHash } from '@/lib/wiki/humanEditGuard';

export type CreateEntityInput = {
  type: EntityType;
  title: string;
  summary?: string;
  tags?: string[];
  scenes?: Scene[];
  properties?: EntityProperties;
  categories?: Entity['categories'];
  indicators?: Entity['indicators'];
  sourceEntries?: string[];
  createdAt?: number;
  updatedAt?: number;
};

export type UpdateEntityInput = Partial<Omit<Entity, 'id' | 'createdAt' | 'updatedAt'>>;

export function defaultEntityProperties(type: EntityType): EntityProperties {
  if (type === 'person') {
    return {} satisfies PersonProps;
  }
  if (type === 'project') {
    return { status: 'active' } satisfies ProjectProps;
  }
  if (type === 'event') {
    return { occurredAt: Date.now() } satisfies EventProps;
  }
  return { isPersonal: false, autoCollectedSnippets: [] } satisfies TopicProps;
}

export async function createEntity(input: CreateEntityInput) {
  const now = Date.now();
  const entity = {
    id: createId(input.type),
    clientId: getClientId(),
    type: input.type,
    title: input.title,
    summary: input.summary ?? '',
    tags: input.tags ?? [],
    scenes: input.scenes ?? [],
    properties: input.properties ?? defaultEntityProperties(input.type),
    categories: input.categories,
    indicators: input.indicators,
    sourceEntries: input.sourceEntries ?? [],
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  } as Entity;

  await db.entities.add(entity);
  return entity;
}

export function getEntity(id: string) {
  return db.entities.get(id);
}

export function listEntities() {
  return db.entities.orderBy('updatedAt').reverse().toArray();
}

export function listEntitiesByType(type: EntityType) {
  return db.entities.where('type').equals(type).reverse().sortBy('updatedAt');
}

export async function updateEntity(id: string, patch: UpdateEntityInput) {
  await db.entities.update(id, { ...patch, updatedAt: Date.now() });
  return db.entities.get(id);
}

export async function deleteEntity(id: string) {
  await deleteEntities([id]);
}

export async function deleteEntities(ids: string[]) {
  const idSet = new Set(ids.filter(Boolean));
  if (idSet.size === 0) return;

  await db.transaction('rw', [db.entities, db.relationships, db.tasks, db.entries, db.compileSuggestions, db.wikiReviewItems], async () => {
    await db.relationships
      .filter((relationship) => idSet.has(relationship.from) || idSet.has(relationship.to))
      .delete();
    await db.tasks.where('owner').anyOf(Array.from(idSet)).delete();
    await db.compileSuggestions.where('entityId').anyOf(Array.from(idSet)).delete();
    await db.wikiReviewItems.where('entityId').anyOf(Array.from(idSet)).delete();

    await db.tasks.toCollection().modify((task) => {
      task.linkedTo = task.linkedTo.filter((linkedId) => !idSet.has(linkedId));
      if (task.assignedBy && idSet.has(task.assignedBy)) {
        delete task.assignedBy;
      }
    });

    await db.entries.toCollection().modify((entry) => {
      entry.derivedEntities = entry.derivedEntities.filter((entityId) => !idSet.has(entityId));
    });

    await db.entities.bulkDelete(Array.from(idSet));
  });
}

export type EntityDuplicateMergeResult = {
  mergedEntities: number;
  groups: Array<{
    key: string;
    title: string;
    primaryId: string;
    removedIds: string[];
  }>;
};

export async function mergeExactDuplicateCompatibleEntities(): Promise<EntityDuplicateMergeResult> {
  const result: EntityDuplicateMergeResult = { mergedEntities: 0, groups: [] };

  await db.transaction(
    'rw',
    [
      db.entities,
      db.relationships,
      db.tasks,
      db.entries,
      db.compileSuggestions,
      db.wikiReviewItems,
      db.wikiBatchJobs,
    ],
    async () => {
      const entities = await db.entities.toArray();
      const groups = groupCompatibleExactTitleDuplicates(entities);

      for (const group of groups) {
        const [primary, ...duplicates] = selectPrimaryDuplicateEntity(group);
        if (!primary || duplicates.length === 0) continue;

        let mergedPrimary = primary;
        const removedIds: string[] = [];
        for (const duplicate of duplicates) {
          mergedPrimary = mergeEntityRecord(mergedPrimary, duplicate);
          await redirectEntityReferences(duplicate, mergedPrimary);
          await db.entities.delete(duplicate.id);
          removedIds.push(duplicate.id);
          result.mergedEntities += 1;
        }

        await db.entities.update(primary.id, {
          ...mergedPrimary,
          id: primary.id,
          clientId: primary.clientId,
          type: primary.type,
          createdAt: primary.createdAt,
          updatedAt: Date.now(),
        });
        result.groups.push({
          key: duplicateEntityKey(primary),
          title: mergedPrimary.title,
          primaryId: primary.id,
          removedIds,
        });
      }

      if (result.mergedEntities > 0) {
        await collapseDuplicateRelationships();
      }
    },
  );

  return result;
}

function groupCompatibleExactTitleDuplicates(entities: Entity[]) {
  const groups = new Map<string, Entity[]>();
  for (const entity of entities) {
    if (!isCompatibleExactDuplicateEntity(entity)) continue;
    const key = duplicateEntityKey(entity);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), entity]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function isCompatibleExactDuplicateEntity(entity: Entity) {
  return entity.type !== 'person' && entity.type !== 'event' && Boolean(duplicateEntityKey(entity));
}

function duplicateEntityKey(entity: Pick<Entity, 'title'>) {
  return normalizeEntityDuplicateTitle(entity.title);
}

function selectPrimaryDuplicateEntity(group: Entity[]) {
  return [...group].sort(compareDuplicatePrimary);
}

function compareDuplicatePrimary(left: Entity, right: Entity) {
  return (
    Number(Boolean(right.wikiHumanEditedAt)) - Number(Boolean(left.wikiHumanEditedAt)) ||
    right.sourceEntries.length - left.sourceEntries.length ||
    (right.wikiMarkdown?.trim().length ?? 0) - (left.wikiMarkdown?.trim().length ?? 0) ||
    left.createdAt - right.createdAt ||
    right.updatedAt - left.updatedAt
  );
}

function mergeEntityRecord(primary: Entity, duplicate: Entity): Entity {
  const duplicateWikiIsBetter = isBetterWikiMarkdown(duplicate, primary);
  return {
    ...primary,
    summary: primary.summary.trim() ? primary.summary : duplicate.summary,
    tags: uniqueStrings([...primary.tags, ...duplicate.tags]),
    scenes: uniqueStrings([...primary.scenes, ...duplicate.scenes]) as Entity['scenes'],
    properties: mergeEntityProperties(primary, duplicate),
    categories: mergeDuplicateCategories(primary.categories ?? [], duplicate.categories ?? []),
    indicators: mergeDuplicateIndicators(primary.indicators ?? [], duplicate.indicators ?? []),
    compiledProfile: primary.compiledProfile ?? duplicate.compiledProfile,
    wikiMarkdown: duplicateWikiIsBetter ? duplicate.wikiMarkdown : primary.wikiMarkdown,
    wikiCompiledAt: duplicateWikiIsBetter ? duplicate.wikiCompiledAt : primary.wikiCompiledAt,
    wikiCompileModel: duplicateWikiIsBetter ? duplicate.wikiCompileModel : primary.wikiCompileModel,
    wikiHumanEditedAt: duplicateWikiIsBetter ? duplicate.wikiHumanEditedAt : primary.wikiHumanEditedAt,
    wikiHumanEditHash: duplicateWikiIsBetter ? duplicate.wikiHumanEditHash : primary.wikiHumanEditHash,
    wikiLastAiMarkdownHash: duplicateWikiIsBetter ? duplicate.wikiLastAiMarkdownHash : primary.wikiLastAiMarkdownHash,
    sourceEntries: uniqueStrings([...primary.sourceEntries, ...duplicate.sourceEntries]),
  } as Entity;
}

function isBetterWikiMarkdown(candidate: Entity, current: Entity) {
  const candidateLength = candidate.wikiMarkdown?.trim().length ?? 0;
  const currentLength = current.wikiMarkdown?.trim().length ?? 0;
  if (candidateLength === 0) return false;
  if (currentLength === 0) return true;
  if (candidate.wikiHumanEditedAt && !current.wikiHumanEditedAt) return true;
  if (!candidate.wikiHumanEditedAt && current.wikiHumanEditedAt) return false;
  return candidateLength > currentLength;
}

function mergeEntityProperties(primary: Entity, duplicate: Entity): EntityProperties {
  if (primary.type !== duplicate.type) return primary.properties;
  if (primary.type === 'topic' && duplicate.type === 'topic') {
    const primaryProps = primary.properties as TopicProps;
    const duplicateProps = duplicate.properties as TopicProps;
    return {
      ...duplicateProps,
      ...primaryProps,
      autoCollectedSnippets: uniqueStrings([
        ...(primaryProps.autoCollectedSnippets ?? []),
        ...(duplicateProps.autoCollectedSnippets ?? []),
      ]),
    };
  }
  return {
    ...(duplicate.properties as Record<string, unknown>),
    ...(primary.properties as Record<string, unknown>),
  } as EntityProperties;
}

function mergeDuplicateCategories(
  primary: NonNullable<Entity['categories']>,
  duplicate: NonNullable<Entity['categories']>,
) {
  const byName = new Map<string, NonNullable<Entity['categories']>[number]>();
  for (const category of [...primary, ...duplicate]) {
    const key = normalizeEntityDuplicateTitle(category.name);
    if (!key) continue;
    const current = byName.get(key);
    if (!current) {
      byName.set(key, category);
      continue;
    }
    byName.set(key, {
      ...current,
      aliases: uniqueStrings([...(current.aliases ?? []), ...(category.aliases ?? [])]),
      items: mergeDuplicateCategoryItems([...(current.items ?? []), ...(category.items ?? [])]),
      evidence: current.evidence ?? category.evidence,
      updatedAt: Math.max(current.updatedAt, category.updatedAt),
    });
  }
  return [...byName.values()];
}

function mergeDuplicateCategoryItems(items: NonNullable<Entity['categories']>[number]['items']) {
  const byTitle = new Map<string, NonNullable<Entity['categories']>[number]['items'][number]>();
  for (const item of items) {
    const key = normalizeEntityDuplicateTitle(item.title);
    if (!key) continue;
    byTitle.set(key, { ...byTitle.get(key), ...item });
  }
  return [...byTitle.values()];
}

function mergeDuplicateIndicators(
  primary: NonNullable<Entity['indicators']>,
  duplicate: NonNullable<Entity['indicators']>,
) {
  const byKey = new Map<string, NonNullable<Entity['indicators']>[number]>();
  for (const indicator of [...primary, ...duplicate]) {
    const key = [
      normalizeEntityDuplicateTitle(indicator.businessLine ?? ''),
      normalizeEntityDuplicateTitle(indicator.categoryName ?? ''),
      normalizeEntityDuplicateTitle(indicator.name),
    ].join(':');
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
  return [...byKey.values()];
}

async function redirectEntityReferences(duplicate: Entity, primary: Entity) {
  await db.entries.toCollection().modify((entry) => {
    entry.derivedEntities = uniqueStrings(entry.derivedEntities.map((entityId) => (entityId === duplicate.id ? primary.id : entityId)));
  });

  await db.relationships.toCollection().modify((relationship) => {
    if (relationship.from === duplicate.id) relationship.from = primary.id;
    if (relationship.to === duplicate.id) relationship.to = primary.id;
  });

  await db.tasks.toCollection().modify((task) => {
    if (task.owner === duplicate.id) task.owner = primary.id;
    if (task.assignedBy === duplicate.id) task.assignedBy = primary.id;
    task.linkedTo = uniqueStrings(task.linkedTo.map((entityId) => (entityId === duplicate.id ? primary.id : entityId)));
  });

  await redirectCompileSuggestions(duplicate, primary);
  await redirectWikiReviewItems(duplicate, primary);

  await db.wikiBatchJobs.toCollection().modify((job) => {
    job.items = job.items.map((item) =>
      item.entityId === duplicate.id ? { ...item, entityId: primary.id, title: primary.title } : item,
    );
    if (job.currentEntityId === duplicate.id) {
      job.currentEntityId = primary.id;
      job.currentTitle = primary.title;
    }
  });
}

async function redirectCompileSuggestions(duplicate: Entity, primary: Entity) {
  const suggestions = await db.compileSuggestions.where('entityId').equals(duplicate.id).toArray();
  const now = Date.now();
  for (const suggestion of suggestions) {
    const fingerprint = createRedirectedCompileSuggestionFingerprint(primary.id, suggestion);
    const conflict = await db.compileSuggestions.where('fingerprint').equals(fingerprint).first();
    if (conflict && conflict.id !== suggestion.id) {
      await db.compileSuggestions.update(suggestion.id, {
        entityId: primary.id,
        entityTitle: primary.title,
        status: 'superseded',
        supersededAt: now,
        updatedAt: now,
      });
      continue;
    }
    await db.compileSuggestions.update(suggestion.id, {
      entityId: primary.id,
      entityTitle: primary.title,
      fingerprint,
      updatedAt: now,
    });
  }
}

async function redirectWikiReviewItems(duplicate: Entity, primary: Entity) {
  const reviews = await db.wikiReviewItems.where('entityId').equals(duplicate.id).toArray();
  const now = Date.now();
  for (const review of reviews) {
    const fingerprint = createRedirectedWikiReviewFingerprint(primary.id, review);
    const conflict = await db.wikiReviewItems.where('fingerprint').equals(fingerprint).first();
    if (conflict && conflict.id !== review.id) {
      await db.wikiReviewItems.update(review.id, {
        entityId: primary.id,
        entityTitle: primary.title,
        status: 'superseded',
        supersededAt: now,
        updatedAt: now,
      });
      continue;
    }
    await db.wikiReviewItems.update(review.id, {
      entityId: primary.id,
      entityTitle: primary.title,
      fingerprint,
      updatedAt: now,
    });
  }
}

async function collapseDuplicateRelationships() {
  const relationships = await db.relationships.toArray();
  const byKey = new Map<string, (typeof relationships)[number]>();

  for (const relationship of relationships) {
    if (relationship.from === relationship.to) {
      await removeRelationshipReference(relationship.id);
      await db.relationships.delete(relationship.id);
      continue;
    }

    const key = [relationship.from, relationship.to, relationship.type].join(':');
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, relationship);
      continue;
    }

    const evidence = uniqueStrings([...current.evidence, ...relationship.evidence]);
    await db.relationships.update(current.id, { evidence });
    await replaceRelationshipReference(relationship.id, current.id);
    await db.relationships.delete(relationship.id);
    byKey.set(key, { ...current, evidence });
  }
}

async function removeRelationshipReference(relationshipId: string) {
  await db.entries.toCollection().modify((entry) => {
    entry.derivedRelationships = entry.derivedRelationships.filter((id) => id !== relationshipId);
  });
}

async function replaceRelationshipReference(fromId: string, toId: string) {
  await db.entries.toCollection().modify((entry) => {
    entry.derivedRelationships = uniqueStrings(entry.derivedRelationships.map((id) => (id === fromId ? toId : id)));
  });
}

function normalizeEntityDuplicateTitle(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
    .trim();
}

function createRedirectedCompileSuggestionFingerprint(
  entityId: string,
  suggestion: Pick<CompileSuggestionRecord, 'businessLine' | 'categoryName' | 'propertyKey' | 'propertyValue'>,
) {
  return [
    entityId,
    normalizeEntityDuplicateTitle(suggestion.businessLine ?? ''),
    normalizeEntityDuplicateTitle(suggestion.categoryName ?? ''),
    suggestion.propertyKey,
    normalizeEntityDuplicateTitle(suggestion.propertyValue),
  ].join(':');
}

function createRedirectedWikiReviewFingerprint(
  entityId: string,
  review: Pick<WikiReviewRecord, 'type' | 'currentMarkdown' | 'proposedMarkdown'>,
) {
  return [
    review.type,
    entityId,
    createWikiMarkdownHash(review.currentMarkdown),
    createWikiMarkdownHash(review.proposedMarkdown),
  ].join(':');
}

function uniqueStrings<T extends string>(values: T[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
