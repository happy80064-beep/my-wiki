import { describe, expect, it } from 'vitest';
import { detectEntityLouvainCommunities, detectLouvainCommunities } from '@/lib/graph/community';
import type { Entity, Relationship } from '@/types';

describe('louvain community detection', () => {
  it('separates disconnected dense clusters and reports cohesion', () => {
    const detection = detectLouvainCommunities(
      ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'].map((id) => ({ id })),
      [
        edge('a1', 'a2'),
        edge('a2', 'a3'),
        edge('a1', 'a3'),
        edge('b1', 'b2'),
        edge('b2', 'b3'),
        edge('b1', 'b3'),
      ],
    );

    expect(detection.communities).toHaveLength(2);
    expect(detection.assignments.get('a1')).toBe(detection.assignments.get('a2'));
    expect(detection.assignments.get('b1')).toBe(detection.assignments.get('b2'));
    expect(detection.assignments.get('a1')).not.toBe(detection.assignments.get('b1'));
    expect(detection.communities.map((community) => community.cohesion)).toEqual([1, 1]);
  });

  it('uses shared source entries as soft community edges', () => {
    const entities = [
      entity('project_a', 'project', '福瑞项目', ['source_finance']),
      entity('topic_a', 'topic', 'EBITDA 利润率', ['source_finance']),
      entity('project_b', 'project', '智算项目', ['source_tech']),
      entity('topic_b', 'topic', 'GPU 集群', ['source_tech']),
    ];

    const model = detectEntityLouvainCommunities(entities, [], { sourceOverlapWeight: 1 });

    expect(model.assignment.get('project_a')).toBe(model.assignment.get('topic_a'));
    expect(model.assignment.get('project_b')).toBe(model.assignment.get('topic_b'));
    expect(model.assignment.get('project_a')).not.toBe(model.assignment.get('project_b'));
    expect(model.communities.every((community) => community.nodeCount === 2)).toBe(true);
  });

  it('keeps relationship weights in the derived edge model', () => {
    const entities = [
      entity('hub', 'project', '项目中枢', []),
      entity('left', 'topic', '左侧主题', []),
      entity('right', 'topic', '右侧主题', []),
    ];
    const relationships: Relationship[] = [
      relationship('rel_left', 'hub', 'left', 'about'),
      relationship('rel_right', 'hub', 'right', 'related-to'),
    ];

    const model = detectEntityLouvainCommunities(entities, relationships, {
      relationshipWeight: (relationship) => (relationship.type === 'about' ? 4 : 1),
      sourceOverlapWeight: 0,
    });

    expect(model.weightToHub.get('hub')).toBe(Number.POSITIVE_INFINITY);
    expect(model.weightToHub.get('left')).toBeGreaterThan(model.weightToHub.get('right') ?? 0);
  });
});

function edge(source: string, target: string) {
  return { source, target, weight: 1 };
}

function entity(id: string, type: Entity['type'], title: string, sourceEntries: string[]): Entity {
  return {
    id,
    clientId: 'test-client',
    type,
    title,
    summary: '',
    tags: [],
    scenes: ['work'],
    properties:
      type === 'project'
        ? { status: 'active' }
        : type === 'event'
          ? { occurredAt: 1 }
          : { isPersonal: false, autoCollectedSnippets: [] },
    sourceEntries,
    createdAt: 1,
    updatedAt: 1,
  } as Entity;
}

function relationship(id: string, from: string, to: string, type: Relationship['type']): Relationship {
  return {
    id,
    clientId: 'test-client',
    from,
    to,
    type,
    evidence: [],
    createdAt: 1,
  };
}
