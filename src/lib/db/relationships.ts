import type { Relationship } from '@/types';
import { db } from './schema';
import { createId } from './ids';
import { getClientId } from './clientId';

export type CreateRelationshipInput = Omit<Relationship, 'id' | 'clientId' | 'createdAt'> & {
  id?: string;
  createdAt?: number;
};

export async function createRelationship(input: CreateRelationshipInput) {
  const relationship: Relationship = {
    id: input.id ?? createId('rel'),
    clientId: getClientId(),
    from: input.from,
    to: input.to,
    type: input.type,
    properties: input.properties,
    evidence: input.evidence,
    createdAt: input.createdAt ?? Date.now(),
  };

  await db.relationships.add(relationship);
  return relationship;
}

export function getRelationship(id: string) {
  return db.relationships.get(id);
}

export async function listRelationshipsForEntity(entityId: string) {
  const [outgoing, incoming] = await Promise.all([
    db.relationships.where('from').equals(entityId).toArray(),
    db.relationships.where('to').equals(entityId).toArray(),
  ]);
  return [...outgoing, ...incoming].sort((a, b) => b.createdAt - a.createdAt);
}

export function listRelationshipsByType(type: Relationship['type']) {
  return db.relationships.where('type').equals(type).toArray();
}

export async function updateRelationship(id: string, patch: Partial<Omit<Relationship, 'id' | 'createdAt'>>) {
  await db.relationships.update(id, patch);
  return db.relationships.get(id);
}

export async function deleteRelationship(id: string) {
  await db.transaction('rw', db.relationships, db.entries, async () => {
    await db.relationships.delete(id);
    await db.entries.toCollection().modify((entry) => {
      entry.derivedRelationships = entry.derivedRelationships.filter((relationshipId) => relationshipId !== id);
    });
  });
}
