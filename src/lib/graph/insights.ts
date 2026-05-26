import type { Entity, Relationship } from '@/types';
import { detectEntityLouvainCommunities, type EntityLouvainCommunityModel } from './community';

export type GraphInsightType =
  | 'bridge-node'
  | 'knowledge-gap'
  | 'surprising-link'
  | 'sparse-community'
  | 'dense-hub';

export type GraphInsight = {
  id: string;
  type: GraphInsightType;
  title: string;
  detail: string;
  entityIds: string[];
  relationshipIds: string[];
  priority: number;
};

export type GraphOverview = {
  entityCount: number;
  relationshipCount: number;
  componentCount: number;
  orphanCount: number;
  hubCount: number;
  insights: GraphInsight[];
};

export function buildGraphOverview(entities: Entity[], relationships: Relationship[]): GraphOverview {
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const validRelationships = relationships.filter(
    (relationship) => entityById.has(relationship.from) && entityById.has(relationship.to),
  );
  const adjacency = buildAdjacency(entities, validRelationships);
  const components = findComponents(entities, adjacency);
  const degreeByEntity = new Map(entities.map((entity) => [entity.id, adjacency.get(entity.id)?.size ?? 0]));
  const communityModel = detectEntityLouvainCommunities(entities, validRelationships);
  const insights = [
    ...findBridgeNodeInsights(entities, validRelationships, adjacency, degreeByEntity, communityModel),
    ...findSparseCommunityInsights(entities, communityModel),
    ...findKnowledgeGapInsights(entities, degreeByEntity),
    ...findSurprisingLinkInsights(validRelationships, entityById, communityModel),
    ...findDenseHubInsights(entities, adjacency, degreeByEntity),
  ]
    .sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title, 'zh-Hans-CN'))
    .filter(uniqueInsightById())
    .slice(0, 12);

  return {
    entityCount: entities.length,
    relationshipCount: validRelationships.length,
    componentCount: components.length,
    orphanCount: [...degreeByEntity.values()].filter((degree) => degree === 0).length,
    hubCount: insights.filter((insight) => insight.type === 'dense-hub').length,
    insights,
  };
}

function uniqueInsightById() {
  const seen = new Set<string>();
  return (insight: GraphInsight) => {
    if (seen.has(insight.id)) return false;
    seen.add(insight.id);
    return true;
  };
}

function findBridgeNodeInsights(
  entities: Entity[],
  relationships: Relationship[],
  adjacency: Map<string, Set<string>>,
  degreeByEntity: Map<string, number>,
  communityModel: EntityLouvainCommunityModel,
): GraphInsight[] {
  return entities
    .map((entity) => {
      const neighbors = [...(adjacency.get(entity.id) ?? [])]
        .map((id) => entities.find((candidate) => candidate.id === id))
        .filter((candidate): candidate is Entity => Boolean(candidate));
      const neighborTypes = new Set(neighbors.map((neighbor) => neighbor.type));
      const neighborCommunities = new Set(
        neighbors
          .map((neighbor) => communityModel.assignment.get(neighbor.id))
          .filter((communityId): communityId is string => Boolean(communityId)),
      );
      const relatedRelationshipIds = relationships
        .filter((relationship) => relationship.from === entity.id || relationship.to === entity.id)
        .map((relationship) => relationship.id);

      return {
        entity,
        neighborTypes,
        neighborCommunities,
        degree: degreeByEntity.get(entity.id) ?? 0,
        relatedRelationshipIds,
      };
    })
    .filter((item) => item.degree >= 3 && (item.neighborTypes.size >= 3 || item.neighborCommunities.size >= 3))
    .map((item) => ({
      id: `bridge-node:${item.entity.id}`,
      type: 'bridge-node' as const,
      title: `桥接节点：${item.entity.title}`,
      detail: `它连接了 ${item.neighborCommunities.size} 个 Louvain 知识社区、${item.neighborTypes.size} 类实体，是跨主题追问和补链的优先入口。`,
      entityIds: [item.entity.id],
      relationshipIds: item.relatedRelationshipIds,
      priority: 80 + item.neighborCommunities.size * 8 + item.neighborTypes.size * 4 + item.degree,
    }));
}

function findSparseCommunityInsights(
  entities: Entity[],
  communityModel: EntityLouvainCommunityModel,
): GraphInsight[] {
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));

  return communityModel.communities
    .filter((community) => community.nodeCount >= 3 && community.cohesion < 0.15)
    .map((community) => {
      const hub = entityById.get(community.hubId);
      const title = hub?.title ?? community.topNodeIds[0] ?? community.id;
      return {
        id: `sparse-community:${community.hubId}`,
        type: 'sparse-community' as const,
        title: `低凝聚社区：${title}`,
        detail: `Louvain 识别到 ${community.nodeCount} 个实体属于同一知识社区，但内部连接密度仅 ${community.cohesion.toFixed(2)}，建议补充 synthesis/query 页面或交叉引用。`,
        entityIds: community.nodeIds,
        relationshipIds: [],
        priority: 72 + Math.min(community.nodeCount, 12) - Math.round(community.cohesion * 20),
      };
    });
}

function findKnowledgeGapInsights(
  entities: Entity[],
  degreeByEntity: Map<string, number>,
): GraphInsight[] {
  return entities
    .filter((entity) => (degreeByEntity.get(entity.id) ?? 0) <= 1 || entity.sourceEntries.length === 0)
    .map((entity) => {
      const degree = degreeByEntity.get(entity.id) ?? 0;
      const missingSource = entity.sourceEntries.length === 0;
      return {
        id: `knowledge-gap:${entity.id}`,
        type: 'knowledge-gap' as const,
        title: `知识空白：${entity.title}`,
        detail:
          [
            degree <= 1 ? '关系连接较少' : '',
            missingSource ? '缺少可追溯来源' : '',
          ]
            .filter(Boolean)
            .join('；') + '，建议补充来源或建立明确关系。',
        entityIds: [entity.id],
        relationshipIds: [],
        priority: 58 + (missingSource ? 12 : 0) + (degree === 0 ? 10 : 0),
      };
    });
}

function findSurprisingLinkInsights(
  relationships: Relationship[],
  entityById: Map<string, Entity>,
  communityModel: EntityLouvainCommunityModel,
): GraphInsight[] {
  const insights: GraphInsight[] = [];

  for (const relationship of relationships) {
    const from = entityById.get(relationship.from);
    const to = entityById.get(relationship.to);
    if (!from || !to) continue;
    const crossType = from.type !== to.type;
    const crossCommunity = communityModel.assignment.get(from.id) !== communityModel.assignment.get(to.id);
    if (!crossType && !crossCommunity) continue;

    const sharedSources = intersectionSize(from.sourceEntries, to.sourceEntries);
    const hasEvidence = relationship.evidence.length > 0;
    const priority = 50 + (crossCommunity ? 12 : 0) + sharedSources * 10 + (hasEvidence ? 8 : 0);

    insights.push({
      id: `surprising-link:${relationship.id}`,
      type: 'surprising-link',
      title: crossCommunity
        ? `跨社区连接：${from.title} -> ${to.title}`
        : `跨类型连接：${from.title} -> ${to.title}`,
      detail:
        sharedSources > 0
          ? `二者${crossCommunity ? '跨 Louvain 社区' : '跨类型'}相连，并共享 ${sharedSources} 条来源，适合继续挖掘背后的上下文。`
          : `二者${crossCommunity ? '跨 Louvain 社区' : '跨类型'}相连，但共同来源较少，适合确认这条关系是否需要补证据。`,
      entityIds: [from.id, to.id],
      relationshipIds: [relationship.id],
      priority,
    });
  }

  return insights
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 4);
}

function findDenseHubInsights(
  entities: Entity[],
  adjacency: Map<string, Set<string>>,
  degreeByEntity: Map<string, number>,
): GraphInsight[] {
  const degrees = [...degreeByEntity.values()].sort((a, b) => b - a);
  const threshold = Math.max(3, degrees[Math.min(2, degrees.length - 1)] ?? 0);

  return entities
    .filter((entity) => (degreeByEntity.get(entity.id) ?? 0) >= threshold && threshold > 0)
    .map((entity) => {
      const neighbors = [...(adjacency.get(entity.id) ?? [])];
      return {
        id: `dense-hub:${entity.id}`,
        type: 'dense-hub' as const,
        title: `高密节点：${entity.title}`,
        detail: `它连接了 ${neighbors.length} 个实体，适合作为知识库概览、查询入口或拆分主题的候选。`,
        entityIds: [entity.id, ...neighbors],
        relationshipIds: [],
        priority: 65 + neighbors.length,
      };
    });
}

function buildAdjacency(entities: Entity[], relationships: Relationship[]) {
  const adjacency = new Map<string, Set<string>>();
  for (const entity of entities) {
    adjacency.set(entity.id, new Set());
  }
  for (const relationship of relationships) {
    adjacency.get(relationship.from)?.add(relationship.to);
    adjacency.get(relationship.to)?.add(relationship.from);
  }
  return adjacency;
}

function findComponents(entities: Entity[], adjacency: Map<string, Set<string>>) {
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const entity of entities) {
    if (visited.has(entity.id)) continue;
    const component: string[] = [];
    const queue = [entity.id];
    visited.add(entity.id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }

    components.push(component);
  }

  return components;
}

function intersectionSize(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item)).length;
}
