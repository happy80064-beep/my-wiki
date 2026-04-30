import type { Entity, Relationship } from '@/types';

export type RelevanceSignals = {
  directLink: number;
  sourceOverlap: number;
  commonNeighbor: number;
  typeAffinity: number;
};

export type RankedEntity = {
  entity: Entity;
  score: number;
  signals: RelevanceSignals;
};

const typeAffinity: Record<Entity['type'], Partial<Record<Entity['type'], number>>> = {
  person: { project: 1.2, event: 1.1, person: 0.8, topic: 0.7 },
  project: { person: 1.2, event: 1.0, topic: 1.15, project: 0.9 },
  event: { person: 1.1, project: 1.0, topic: 0.85, event: 0.6 },
  topic: { project: 1.15, topic: 0.85, event: 0.85, person: 0.7 },
};

export function rankRelatedEntities(seed: Entity, candidates: Entity[], relationships: Relationship[]): RankedEntity[] {
  const entitiesById = new Map([seed, ...candidates].map((entity) => [entity.id, entity]));
  const adjacency = buildAdjacency(relationships);

  return candidates
    .map((candidate) => {
      const signals = calculateRelevanceSignals(seed, candidate, relationships, adjacency);
      const score =
        3.0 * signals.directLink +
        4.0 * signals.sourceOverlap +
        1.5 * signals.commonNeighbor +
        1.0 * signals.typeAffinity;

      return { entity: candidate, score, signals };
    })
    .filter((ranked) => ranked.score > 0 && entitiesById.has(ranked.entity.id))
    .sort((a, b) => b.score - a.score || b.entity.updatedAt - a.entity.updatedAt);
}

export function calculateRelevanceSignals(
  left: Entity,
  right: Entity,
  relationships: Relationship[],
  adjacency = buildAdjacency(relationships),
): RelevanceSignals {
  const directLink = relationships.filter(
    (relationship) =>
      (relationship.from === left.id && relationship.to === right.id) ||
      (relationship.from === right.id && relationship.to === left.id),
  ).length;

  const sourceOverlap = intersectionSize(left.sourceEntries, right.sourceEntries);
  const leftNeighbors = adjacency.get(left.id) ?? new Set<string>();
  const rightNeighbors = adjacency.get(right.id) ?? new Set<string>();
  const commonNeighbor = [...leftNeighbors]
    .filter((neighborId) => rightNeighbors.has(neighborId))
    .reduce((score, neighborId) => {
      const degree = adjacency.get(neighborId)?.size ?? 0;
      return score + 1 / Math.log(degree + 2);
    }, 0);

  return {
    directLink,
    sourceOverlap,
    commonNeighbor,
    typeAffinity: typeAffinity[left.type][right.type] ?? 0.6,
  };
}

function buildAdjacency(relationships: Relationship[]) {
  const adjacency = new Map<string, Set<string>>();

  for (const relationship of relationships) {
    addNeighbor(adjacency, relationship.from, relationship.to);
    addNeighbor(adjacency, relationship.to, relationship.from);
  }

  return adjacency;
}

function addNeighbor(adjacency: Map<string, Set<string>>, from: string, to: string) {
  const neighbors = adjacency.get(from) ?? new Set<string>();
  neighbors.add(to);
  adjacency.set(from, neighbors);
}

function intersectionSize(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item)).length;
}
