import { db } from '@/lib/db';
import type { Entity, EntityType, Entry, Relationship, Task } from '@/types';

export type EntityCandidate = {
  entity: Entity;
  score: number;
};

export async function findEntityCandidates(name: string | undefined, types?: EntityType[]) {
  const entities = await db.entities.toArray();
  const pool = types ? entities.filter((entity) => types.includes(entity.type)) : entities;
  const normalizedName = normalizeName(name ?? '');

  if (!normalizedName) {
    return [];
  }

  return pool
    .map((entity) => ({ entity, score: scoreEntity(entity, normalizedName) }))
    .filter((candidate) => candidate.score >= 45)
    .sort((a, b) => b.score - a.score || b.entity.updatedAt - a.entity.updatedAt)
    .slice(0, 5);
}

export async function getPendingTasksByOwner(ownerId: string) {
  return db.tasks
    .where('owner')
    .equals(ownerId)
    .filter(isOpenTask)
    .toArray();
}

export async function getPendingTasksForProject(projectId: string) {
  return db.tasks
    .filter((task) => task.linkedTo.includes(projectId) && isOpenTask(task))
    .toArray();
}

export async function getRelationshipsWithEntity(entityId: string) {
  const [outgoing, incoming] = await Promise.all([
    db.relationships.where('from').equals(entityId).toArray(),
    db.relationships.where('to').equals(entityId).toArray(),
  ]);

  return [...outgoing, ...incoming].sort((a, b) => b.createdAt - a.createdAt);
}

export async function getRelatedEntities(entityId: string, relationships: Relationship[]) {
  const relatedIds = Array.from(
    new Set(
      relationships
        .map((relationship) => (relationship.from === entityId ? relationship.to : relationship.from))
        .filter((id) => id !== entityId),
    ),
  );

  const entities = await db.entities.bulkGet(relatedIds);
  const entityById = new Map(entities.filter((entity): entity is Entity => Boolean(entity)).map((entity) => [entity.id, entity]));

  return relatedIds
    .map((id) => entityById.get(id))
    .filter((entity): entity is Entity => Boolean(entity));
}

export async function getEntriesByIds(ids: string[]) {
  const uniqueIds = Array.from(new Set(ids));
  const entries = await db.entries.bulkGet(uniqueIds);
  return entries.filter((entry): entry is Entry => Boolean(entry));
}

export async function fuzzyFindEntities(question: string) {
  const normalizedQuestion = normalizeName(question);
  const entities = await db.entities.toArray();

  return entities
    .map((entity) => ({ entity, score: scoreEntity(entity, normalizedQuestion) }))
    .filter((candidate) => candidate.score >= 30)
    .sort((a, b) => b.score - a.score || b.entity.updatedAt - a.entity.updatedAt)
    .slice(0, 5);
}

function isOpenTask(task: Task) {
  return task.status !== 'done' && task.status !== 'cancelled';
}

function scoreEntity(entity: Entity, normalizedName: string) {
  const title = normalizeName(entity.title);
  const summary = normalizeName(entity.summary);
  const tags = normalizeName(entity.tags.join(''));

  if (title === normalizedName) return 100;
  if (title.includes(normalizedName) || normalizedName.includes(title)) return 85;
  if (isSubsequence(normalizedName, title)) return 70;
  if (isSubsequence(title, normalizedName)) return 58;
  if (summary.includes(normalizedName) || tags.includes(normalizedName)) return 42;

  const overlap = overlapRatio(normalizedName, title);
  if (overlap >= 0.75) return 55;
  if (overlap >= 0.55) return 38;
  return 0;
}

function normalizeName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
    .trim();
}

function isSubsequence(needle: string, haystack: string) {
  if (!needle || !haystack) return false;
  let cursor = 0;
  for (const char of haystack) {
    if (char === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return true;
  }
  return false;
}

function overlapRatio(a: string, b: string) {
  if (!a || !b) return 0;
  const bChars = new Set([...b]);
  const matched = [...new Set([...a])].filter((char) => bChars.has(char)).length;
  return matched / new Set([...a]).size;
}
