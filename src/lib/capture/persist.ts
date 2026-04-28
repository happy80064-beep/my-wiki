import type { Entity, EntityProperties, EntrySource, PersonProps, TopicProps } from '@/types';
import {
  createEntity,
  createEntry,
  createRelationship,
  createTask,
  db,
  updateEntity,
  updateEntry,
  updateRelationship,
} from '@/lib/db';
import { defaultEntityProperties } from '@/lib/db/entities';
import type { CaptureDraft, DraftEntity } from './draft';
import { getDraftEntities } from './draft';

export async function persistCaptureDraft(content: string, draft: CaptureDraft, source: EntrySource = 'text') {
  const entry = await createEntry({ content, source, processed: true });
  const entityIdByClientId = new Map<string, string>();

  const entities: Entity[] = [];
  const relationships = [];
  const tasks = [];

  for (const draftEntity of getDraftEntities(draft)) {
    const entity = await resolveCaptureEntity(draftEntity, entry.id, entry.capturedAt);
    entityIdByClientId.set(draftEntity.clientId, entity.id);
    entities.push(entity);
  }

  for (const draftRelationship of draft.relationships) {
    const from = entityIdByClientId.get(draftRelationship.fromClientId);
    const to = entityIdByClientId.get(draftRelationship.toClientId);
    if (!from || !to) continue;

    relationships.push(
      await createOrUpdateRelationship({
        from,
        to,
        type: draftRelationship.type,
        evidence: [entry.id],
      }),
    );
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
  }

  await updateEntry(entry.id, {
    derivedEntities: entities.map((entity) => entity.id),
    derivedRelationships: relationships.map((relationship) => relationship.id),
    derivedTasks: tasks.map((task) => task.id),
  });

  return {
    entry: (await updateEntry(entry.id, {}))!,
    entities,
    relationships,
    tasks,
  };
}

async function resolveCaptureEntity(draftEntity: DraftEntity, entryId: string, capturedAt: number) {
  const reusableEntity = await findReusableEntity(draftEntity);

  if (!reusableEntity) {
    return createEntity({
      type: draftEntity.type,
      title: draftEntity.title,
      summary: draftEntity.summary,
      tags: draftEntity.tags,
      scenes: draftEntity.scenes,
      properties: compileEntityProperties(defaultEntityProperties(draftEntity.type), draftEntity.type, entryId, capturedAt),
      sourceEntries: [entryId],
    });
  }

  const updated = await updateEntity(reusableEntity.id, {
    summary: reusableEntity.summary.trim() ? reusableEntity.summary : draftEntity.summary,
    tags: mergeUnique(reusableEntity.tags, draftEntity.tags),
    scenes: mergeUnique(reusableEntity.scenes, draftEntity.scenes),
    properties: compileEntityProperties(reusableEntity.properties, reusableEntity.type, entryId, capturedAt),
    sourceEntries: mergeUnique(reusableEntity.sourceEntries, [entryId]),
  });

  return updated ?? reusableEntity;
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
    candidates.find((entity) => isReusableTitleMatch(normalizeTitle(entity.title), normalizedTitle, draftEntity.type))
  );
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
    return createRelationship(input);
  }

  const updated = await updateRelationship(existingRelationship.id, {
    evidence: mergeUnique(existingRelationship.evidence, input.evidence),
  });

  return updated ?? existingRelationship;
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
