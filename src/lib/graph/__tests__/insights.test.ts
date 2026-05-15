import { describe, expect, it } from 'vitest';
import { buildGraphOverview } from '@/lib/graph/insights';
import type { Entity, Relationship } from '@/types';

describe('graph insights', () => {
  it('detects bridge nodes, gaps, hubs, and cross-type links', () => {
    const project = entity('project_1', 'project', '桌面数字生命体', ['entry_1']);
    const person = entity('person_1', 'person', 'Serina', ['entry_1']);
    const topic = entity('topic_1', 'topic', '唤醒方案', ['entry_1']);
    const event = entity('event_1', 'event', '语音调优记录', ['entry_2']);
    const orphan = entity('topic_2', 'topic', '待补主题', []);
    const relationships: Relationship[] = [
      relationship('rel_1', project.id, person.id, 'related-to', ['entry_1']),
      relationship('rel_2', project.id, topic.id, 'about', ['entry_1']),
      relationship('rel_3', project.id, event.id, 'mentioned-in', ['entry_2']),
      relationship('rel_4', topic.id, event.id, 'relevant-to', []),
    ];

    const overview = buildGraphOverview([project, person, topic, event, orphan], relationships);

    expect(overview.entityCount).toBe(5);
    expect(overview.relationshipCount).toBe(4);
    expect(overview.orphanCount).toBe(1);
    expect(overview.insights.map((insight) => insight.type)).toEqual(
      expect.arrayContaining(['bridge-node', 'knowledge-gap', 'surprising-link', 'dense-hub']),
    );
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

function relationship(
  id: string,
  from: string,
  to: string,
  type: Relationship['type'],
  evidence: string[],
): Relationship {
  return {
    id,
    clientId: 'test-client',
    from,
    to,
    type,
    evidence,
    createdAt: 1,
  };
}
