import { describe, expect, it } from 'vitest';
import { calculateRelevanceSignals, rankRelatedEntities } from '@/lib/graph/relevance';
import type { Entity, Relationship } from '@/types';

describe('graph relevance', () => {
  it('ranks related pages by direct links, shared sources, common neighbors, and type affinity', () => {
    const seed = entity('project_1', 'project', '桌面数字生命体', ['entry_1']);
    const direct = entity('topic_1', 'topic', '语音交互', ['entry_1']);
    const bridge = entity('topic_2', 'topic', '唤醒方案', []);
    const weak = entity('person_1', 'person', '弱关联人员', []);
    const relationships: Relationship[] = [
      relationship('rel_1', seed.id, direct.id, 'relevant-to'),
      relationship('rel_2', direct.id, bridge.id, 'related-to'),
      relationship('rel_3', seed.id, weak.id, 'mentions'),
      relationship('rel_4', weak.id, bridge.id, 'mentions'),
    ];

    const ranked = rankRelatedEntities(seed, [bridge, weak, direct], relationships);

    expect(ranked[0].entity.title).toBe('语音交互');
    expect(ranked.map((item) => item.entity.title)).toContain('唤醒方案');
    expect(calculateRelevanceSignals(seed, bridge, relationships).commonNeighbor).toBeGreaterThan(0);
  });
});

function entity(id: string, type: Entity['type'], title: string, sourceEntries: string[]): Entity {
  return {
    id,
    clientId: 'test-client',
    type,
    title,
    summary: '',
    tags: [],
    scenes: ['work'],
    properties: type === 'project' ? { status: 'active' } : { isPersonal: false, autoCollectedSnippets: [] },
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
