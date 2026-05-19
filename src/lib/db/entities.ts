import type {
  Entity,
  EntityProperties,
  EntityType,
  EventProps,
  PersonProps,
  ProjectProps,
  Scene,
  TopicProps,
} from '@/types';
import { db } from './schema';
import { createId } from './ids';
import { getClientId } from './clientId';

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
  await db.transaction('rw', [db.entities, db.relationships, db.tasks, db.entries, db.compileSuggestions, db.wikiReviewItems], async () => {
    await db.relationships.where('from').equals(id).or('to').equals(id).delete();
    await db.tasks.where('owner').equals(id).delete();
    await db.compileSuggestions.where('entityId').equals(id).delete();
    await db.wikiReviewItems.where('entityId').equals(id).delete();

    await db.tasks.toCollection().modify((task) => {
      task.linkedTo = task.linkedTo.filter((linkedId) => linkedId !== id);
      if (task.assignedBy === id) {
        delete task.assignedBy;
      }
    });

    await db.entries.toCollection().modify((entry) => {
      entry.derivedEntities = entry.derivedEntities.filter((entityId) => entityId !== id);
    });

    await db.entities.delete(id);
  });
}
