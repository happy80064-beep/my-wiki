import { db } from '@/lib/db';
import type { Entity, EntityType, Relationship, RelationshipType, Scene } from '@/types';

export type NeighborDirection = 'in' | 'out' | 'both';

export type GetNeighborsOptions = {
  relationshipTypes?: RelationshipType[];
  direction?: NeighborDirection;
};

export type GetSubgraphOptions = {
  sceneFilter?: Scene[];
  timeRange?: { start: number; end: number };
  excludeTypes?: EntityType[];
  relationshipTypes?: RelationshipType[];
};

export type Subgraph = {
  nodes: Entity[];
  edges: Relationship[];
};

export async function getNeighbors(entityId: string, opts: GetNeighborsOptions = {}) {
  const relationships = await getRelationshipsByDirection(entityId, opts.direction ?? 'both');
  const filteredRelationships = filterRelationshipsByType(relationships, opts.relationshipTypes);
  const neighborIds = Array.from(
    new Set(
      filteredRelationships.map((relationship) => (relationship.from === entityId ? relationship.to : relationship.from)),
    ),
  );

  const entities = await db.entities.bulkGet(neighborIds);
  return entities.filter((entity): entity is Entity => Boolean(entity));
}

export async function getSubgraph(entityId: string, depth: number, opts: GetSubgraphOptions = {}): Promise<Subgraph> {
  const maxDepth = Math.max(0, depth);
  const visited = new Set<string>([entityId]);
  const edgeById = new Map<string, Relationship>();
  let frontier = [entityId];

  for (let level = 0; level < maxDepth && frontier.length > 0; level += 1) {
    const nextFrontier: string[] = [];

    for (const currentId of frontier) {
      const relationships = await getRelationshipsByDirection(currentId, 'both');
      const filteredRelationships = filterRelationshipsByType(
        relationships.filter((relationship) => isRelationshipInTimeRange(relationship, opts.timeRange)),
        opts.relationshipTypes,
      );

      for (const relationship of filteredRelationships) {
        const otherId = relationship.from === currentId ? relationship.to : relationship.from;
        edgeById.set(relationship.id, relationship);
        if (!visited.has(otherId)) {
          visited.add(otherId);
          nextFrontier.push(otherId);
        }
      }
    }

    frontier = nextFrontier;
  }

  const entities = await db.entities.bulkGet([...visited]);
  const nodes = entities
    .filter((entity): entity is Entity => Boolean(entity))
    .filter((entity) => isEntityIncluded(entity, opts));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = [...edgeById.values()].filter((relationship) => nodeIds.has(relationship.from) && nodeIds.has(relationship.to));

  return { nodes, edges };
}

export async function findPaths(fromId: string, toId: string, maxDepth = 3) {
  if (fromId === toId) return [[]];

  const paths: Relationship[][] = [];
  const queue: Array<{ entityId: string; path: Relationship[]; visited: Set<string> }> = [
    { entityId: fromId, path: [], visited: new Set([fromId]) },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.path.length >= maxDepth) continue;

    const relationships = await getRelationshipsByDirection(current.entityId, 'both');
    for (const relationship of relationships) {
      const nextId = relationship.from === current.entityId ? relationship.to : relationship.from;
      if (current.visited.has(nextId)) continue;

      const nextPath = [...current.path, relationship];
      if (nextId === toId) {
        paths.push(nextPath);
        continue;
      }

      queue.push({
        entityId: nextId,
        path: nextPath,
        visited: new Set([...current.visited, nextId]),
      });
    }
  }

  return paths.sort((a, b) => a.length - b.length);
}

async function getRelationshipsByDirection(entityId: string, direction: NeighborDirection) {
  if (direction === 'out') {
    return db.relationships.where('from').equals(entityId).toArray();
  }
  if (direction === 'in') {
    return db.relationships.where('to').equals(entityId).toArray();
  }

  const [outgoing, incoming] = await Promise.all([
    db.relationships.where('from').equals(entityId).toArray(),
    db.relationships.where('to').equals(entityId).toArray(),
  ]);
  return [...outgoing, ...incoming];
}

function filterRelationshipsByType(relationships: Relationship[], relationshipTypes?: RelationshipType[]) {
  if (!relationshipTypes || relationshipTypes.length === 0) return relationships;
  const allowedTypes = new Set(relationshipTypes);
  return relationships.filter((relationship) => allowedTypes.has(relationship.type));
}

function isRelationshipInTimeRange(relationship: Relationship, timeRange?: { start: number; end: number }) {
  if (!timeRange) return true;
  return relationship.createdAt >= timeRange.start && relationship.createdAt <= timeRange.end;
}

function isEntityIncluded(entity: Entity, opts: GetSubgraphOptions) {
  if (opts.excludeTypes?.includes(entity.type)) return false;
  if (opts.sceneFilter && opts.sceneFilter.length > 0) {
    return entity.scenes.some((scene) => opts.sceneFilter?.includes(scene));
  }
  return true;
}
