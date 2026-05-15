import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import type { Entity, Relationship } from '../../types';

export type CommunityGraphNode = {
  id: string;
  label?: string;
  rank?: number;
};

export type CommunityGraphEdge = {
  source: string;
  target: string;
  weight?: number;
};

export type LouvainCommunityInfo = {
  id: string;
  rawId: string;
  index: number;
  nodeIds: string[];
  nodeCount: number;
  edgeCount: number;
  possibleEdges: number;
  cohesion: number;
  topNodeIds: string[];
};

export type LouvainCommunityDetection = {
  assignments: Map<string, string>;
  communities: LouvainCommunityInfo[];
  edgeWeights: Map<string, number>;
};

export type EntityLouvainCommunity = LouvainCommunityInfo & {
  hubId: string;
};

export type EntityLouvainCommunityModel = {
  hubs: Entity[];
  assignment: Map<string, string>;
  weightToHub: Map<string, number>;
  communities: EntityLouvainCommunity[];
  communityByHubId: Map<string, EntityLouvainCommunity>;
};

type LouvainFn = (
  graph: Graph,
  options?: { resolution?: number; getEdgeWeight?: string | ((edge: string, attributes: { weight?: number }) => number) },
) => Record<string, string | number>;

export function detectLouvainCommunities(
  nodes: CommunityGraphNode[],
  edges: CommunityGraphEdge[],
  options: { resolution?: number } = {},
): LouvainCommunityDetection {
  const uniqueNodes = dedupeNodes(nodes);
  if (uniqueNodes.length === 0) {
    return { assignments: new Map(), communities: [], edgeWeights: new Map() };
  }

  const graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
  for (const node of uniqueNodes) {
    graph.addNode(node.id);
  }

  const edgeWeights = mergeUndirectedEdges(edges, new Set(uniqueNodes.map((node) => node.id)));
  for (const [key, edge] of edgeWeights) {
    graph.addEdgeWithKey(key, edge.source, edge.target, { weight: edge.weight });
  }

  if (graph.size === 0) {
    return isolatedCommunities(uniqueNodes);
  }

  const rawAssignments = (louvain as LouvainFn)(graph, {
    resolution: options.resolution ?? 1,
    getEdgeWeight: 'weight',
  });

  const rankByNode = new Map(uniqueNodes.map((node) => [node.id, node.rank ?? 0]));
  const groups = new Map<string, string[]>();
  for (const node of uniqueNodes) {
    const rawCommunityId = String(rawAssignments[node.id] ?? node.id);
    groups.set(rawCommunityId, [...(groups.get(rawCommunityId) ?? []), node.id]);
  }

  const communities = [...groups.entries()]
    .map(([rawId, nodeIds]) => buildCommunityInfo(rawId, nodeIds, edgeWeights, rankByNode))
    .sort((left, right) => right.nodeCount - left.nodeCount || (right.topNodeIds[0] ?? '').localeCompare(left.topNodeIds[0] ?? ''))
    .map((community, index) => ({ ...community, id: `community-${index}`, index }));

  const rawToStableId = new Map(communities.map((community) => [community.rawId, community.id]));
  const assignments = new Map<string, string>();
  for (const node of uniqueNodes) {
    const rawCommunityId = String(rawAssignments[node.id] ?? node.id);
    assignments.set(node.id, rawToStableId.get(rawCommunityId) ?? rawCommunityId);
  }

  return { assignments, communities, edgeWeights: new Map([...edgeWeights].map(([key, edge]) => [key, edge.weight])) };
}

export function detectEntityLouvainCommunities(
  entities: Entity[],
  relationships: Relationship[],
  options: {
    relationshipWeight?: (relationship: Relationship) => number;
    resolution?: number;
    sourceOverlapWeight?: number;
  } = {},
): EntityLouvainCommunityModel {
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const relationshipWeight = options.relationshipWeight ?? (() => 1);
  const edges: CommunityGraphEdge[] = relationships
    .filter((relationship) => entityById.has(relationship.from) && entityById.has(relationship.to))
    .map((relationship) => ({
      source: relationship.from,
      target: relationship.to,
      weight: relationshipWeight(relationship),
    }));

  edges.push(...buildSourceOverlapEdges(entities, options.sourceOverlapWeight ?? 0.75));

  const degreeWeightById = weightedDegreeById(entities, edges);
  const detection = detectLouvainCommunities(
    entities.map((entity) => ({
      id: entity.id,
      label: entity.title,
      rank: communityHubScore(entity, degreeWeightById),
    })),
    edges,
    { resolution: options.resolution },
  );

  const entitiesByCommunity = new Map<string, Entity[]>();
  for (const entity of entities) {
    const communityId = detection.assignments.get(entity.id) ?? entity.id;
    entitiesByCommunity.set(communityId, [...(entitiesByCommunity.get(communityId) ?? []), entity]);
  }

  const hubs: Entity[] = [];
  const assignment = new Map<string, string>();
  const weightToHub = new Map<string, number>();
  const communities: EntityLouvainCommunity[] = [];
  const adjacencyWeight = buildAdjacencyWeight(edges);

  for (const community of detection.communities) {
    const members = entitiesByCommunity.get(community.id) ?? [];
    if (members.length === 0) continue;
    const hub = members
      .slice()
      .sort(
        (left, right) =>
          communityHubScore(right, degreeWeightById) - communityHubScore(left, degreeWeightById) ||
          right.updatedAt - left.updatedAt ||
          right.title.localeCompare(left.title, 'zh-Hans-CN'),
      )[0];
    hubs.push(hub);
    communities.push({ ...community, id: hub.id, hubId: hub.id });

    for (const member of members) {
      assignment.set(member.id, hub.id);
      weightToHub.set(member.id, member.id === hub.id ? Number.POSITIVE_INFINITY : weightedConnection(member.id, hub.id, adjacencyWeight));
    }
  }

  hubs.sort((left, right) => (entitiesByCommunity.get(assignment.get(right.id) ?? right.id)?.length ?? 0) - (entitiesByCommunity.get(assignment.get(left.id) ?? left.id)?.length ?? 0));

  const communityByHubId = new Map(communities.map((community) => [community.hubId, community]));
  return { hubs, assignment, weightToHub, communities, communityByHubId };
}

function buildCommunityInfo(
  rawId: string,
  nodeIds: string[],
  edgeMap: Map<string, { source: string; target: string; weight: number }>,
  rankByNode: Map<string, number>,
): LouvainCommunityInfo {
  const memberSet = new Set(nodeIds);
  let edgeCount = 0;
  for (const edge of edgeMap.values()) {
    if (memberSet.has(edge.source) && memberSet.has(edge.target)) {
      edgeCount += 1;
    }
  }
  const nodeCount = nodeIds.length;
  const possibleEdges = nodeCount > 1 ? (nodeCount * (nodeCount - 1)) / 2 : 1;
  const cohesion = edgeCount / possibleEdges;
  const topNodeIds = nodeIds
    .slice()
    .sort((left, right) => (rankByNode.get(right) ?? 0) - (rankByNode.get(left) ?? 0) || left.localeCompare(right))
    .slice(0, 5);

  return {
    id: rawId,
    rawId,
    index: 0,
    nodeIds,
    nodeCount,
    edgeCount,
    possibleEdges,
    cohesion,
    topNodeIds,
  };
}

function isolatedCommunities(nodes: CommunityGraphNode[]): LouvainCommunityDetection {
  const assignments = new Map<string, string>();
  const communities = nodes.map((node, index) => {
    assignments.set(node.id, `community-${index}`);
    return {
      id: `community-${index}`,
      rawId: node.id,
      index,
      nodeIds: [node.id],
      nodeCount: 1,
      edgeCount: 0,
      possibleEdges: 1,
      cohesion: 0,
      topNodeIds: [node.id],
    };
  });

  return { assignments, communities, edgeWeights: new Map() };
}

function dedupeNodes(nodes: CommunityGraphNode[]) {
  const byId = new Map<string, CommunityGraphNode>();
  for (const node of nodes) {
    if (!node.id.trim()) continue;
    byId.set(node.id, node);
  }
  return [...byId.values()];
}

function mergeUndirectedEdges(edges: CommunityGraphEdge[], nodeIds: Set<string>) {
  const merged = new Map<string, { source: string; target: string; weight: number }>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    if (edge.source === edge.target) continue;
    const [source, target] = [edge.source, edge.target].sort();
    const key = `${source}:::${target}`;
    const current = merged.get(key);
    merged.set(key, {
      source,
      target,
      weight: (current?.weight ?? 0) + Math.max(0.01, edge.weight ?? 1),
    });
  }
  return merged;
}

function buildSourceOverlapEdges(entities: Entity[], sourceOverlapWeight: number): CommunityGraphEdge[] {
  if (sourceOverlapWeight <= 0) return [];

  const bySource = new Map<string, Entity[]>();
  for (const entity of entities) {
    for (const sourceId of entity.sourceEntries) {
      bySource.set(sourceId, [...(bySource.get(sourceId) ?? []), entity]);
    }
  }

  const pairWeights = new Map<string, CommunityGraphEdge>();
  for (const group of bySource.values()) {
    if (group.length < 2 || group.length > 80) continue;
    for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
        const left = group[leftIndex];
        const right = group[rightIndex];
        const [source, target] = [left.id, right.id].sort();
        const key = `${source}:::${target}`;
        const current = pairWeights.get(key);
        pairWeights.set(key, {
          source,
          target,
          weight: Math.min((current?.weight ?? 0) + sourceOverlapWeight, sourceOverlapWeight * 4),
        });
      }
    }
  }

  return [...pairWeights.values()];
}

function weightedDegreeById(entities: Entity[], edges: CommunityGraphEdge[]) {
  const degreeById = new Map(entities.map((entity) => [entity.id, 0]));
  for (const edge of edges) {
    const weight = Math.max(0.01, edge.weight ?? 1);
    degreeById.set(edge.source, (degreeById.get(edge.source) ?? 0) + weight);
    degreeById.set(edge.target, (degreeById.get(edge.target) ?? 0) + weight);
  }
  return degreeById;
}

function buildAdjacencyWeight(edges: CommunityGraphEdge[]) {
  const adjacency = new Map<string, Map<string, number>>();
  for (const edge of edges) {
    const weight = Math.max(0.01, edge.weight ?? 1);
    const left = adjacency.get(edge.source) ?? new Map<string, number>();
    left.set(edge.target, (left.get(edge.target) ?? 0) + weight);
    adjacency.set(edge.source, left);
    const right = adjacency.get(edge.target) ?? new Map<string, number>();
    right.set(edge.source, (right.get(edge.source) ?? 0) + weight);
    adjacency.set(edge.target, right);
  }
  return adjacency;
}

function weightedConnection(left: string, right: string, adjacency: Map<string, Map<string, number>>) {
  return adjacency.get(left)?.get(right) ?? 0;
}

function communityHubScore(entity: Entity, degreeWeightById: Map<string, number>) {
  const typeBoost: Record<Entity['type'], number> = {
    project: 4.4,
    topic: 3.4,
    person: 2.4,
    event: 1.6,
  };
  return (degreeWeightById.get(entity.id) ?? 0) * 7 + typeBoost[entity.type] + Math.log10(Math.max(entity.sourceEntries.length, 1));
}
