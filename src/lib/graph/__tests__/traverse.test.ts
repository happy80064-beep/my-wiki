import { beforeEach, describe, expect, it } from 'vitest';
import { createEntity, createRelationship, resetDatabase } from '@/lib/db';
import { findPaths, getNeighbors, getSubgraph } from '@/lib/graph';

describe('graph traversal API', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('returns direct neighbors with relationship type and direction filters', async () => {
    const person = await createEntity({ type: 'person', title: '虾总' });
    const project = await createEntity({ type: 'project', title: '股票监控' });
    const topic = await createEntity({ type: 'topic', title: 'AI' });

    await createRelationship({ from: person.id, to: project.id, type: 'participant', evidence: [] });
    await createRelationship({ from: project.id, to: topic.id, type: 'relevant-to', evidence: [] });

    const outgoing = await getNeighbors(project.id, { direction: 'out' });
    const incomingParticipant = await getNeighbors(project.id, {
      direction: 'in',
      relationshipTypes: ['participant'],
    });

    expect(outgoing.map((entity) => entity.title)).toEqual(['AI']);
    expect(incomingParticipant.map((entity) => entity.title)).toEqual(['虾总']);
  });

  it('returns a bounded subgraph', async () => {
    const me = await createEntity({ type: 'person', title: '我', scenes: ['work'] });
    const project = await createEntity({ type: 'project', title: '桌面数字生命体', scenes: ['work'] });
    const topic = await createEntity({ type: 'topic', title: '语音交互', scenes: ['work'] });
    const farTopic = await createEntity({ type: 'topic', title: '远端主题', scenes: ['work'] });

    await createRelationship({ from: me.id, to: project.id, type: 'owner', evidence: [] });
    await createRelationship({ from: project.id, to: topic.id, type: 'relevant-to', evidence: [] });
    await createRelationship({ from: topic.id, to: farTopic.id, type: 'related-to', evidence: [] });

    const oneHop = await getSubgraph(project.id, 1);
    const twoHop = await getSubgraph(project.id, 2);

    expect(oneHop.nodes.map((entity) => entity.title).sort()).toEqual(['我', '桌面数字生命体', '语音交互']);
    expect(twoHop.nodes.map((entity) => entity.title).sort()).toEqual([
      '我',
      '桌面数字生命体',
      '语音交互',
      '远端主题',
    ]);
  });

  it('finds paths between entities', async () => {
    const person = await createEntity({ type: 'person', title: '虾总' });
    const project = await createEntity({ type: 'project', title: '股票监控' });
    const topic = await createEntity({ type: 'topic', title: 'AI' });

    const first = await createRelationship({ from: person.id, to: project.id, type: 'participant', evidence: [] });
    const second = await createRelationship({ from: project.id, to: topic.id, type: 'relevant-to', evidence: [] });

    const paths = await findPaths(person.id, topic.id, 2);

    expect(paths).toHaveLength(1);
    expect(paths[0].map((relationship) => relationship.id)).toEqual([first.id, second.id]);
  });
});
