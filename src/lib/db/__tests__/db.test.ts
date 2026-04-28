import { beforeEach, describe, expect, it } from 'vitest';
import {
  createEntity,
  createEntry,
  createRelationship,
  createTask,
  db,
  deleteEntity,
  listPendingTasksByOwner,
  listRelationshipsForEntity,
  resetDatabase,
} from '@/lib/db';

describe('MyWiki data layer', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('creates an entry and derived graph records', async () => {
    const entry = await createEntry({
      content: '今天和虾总同步股票监控项目。',
      source: 'text',
    });
    const person = await createEntity({
      type: 'person',
      title: '虾总',
      scenes: ['work'],
      sourceEntries: [entry.id],
    });
    const project = await createEntity({
      type: 'project',
      title: '股票监控',
      scenes: ['work'],
      sourceEntries: [entry.id],
    });
    const relationship = await createRelationship({
      from: person.id,
      to: project.id,
      type: 'owner',
      evidence: [entry.id],
    });
    const task = await createTask({
      description: '调通飞书推送',
      owner: person.id,
      linkedTo: [project.id],
      source: entry.id,
    });

    expect(entry.processed).toBe(false);
    expect(relationship.type).toBe('owner');
    expect(task.status).toBe('pending');
  });

  it('filters pending tasks by exact owner id', async () => {
    const entry = await createEntry({ content: '两个人各有任务。', source: 'text' });
    const owner = await createEntity({ type: 'person', title: '虾总' });
    const other = await createEntity({ type: 'person', title: '张总' });

    await createTask({ description: '属于虾总的任务', owner: owner.id, source: entry.id });
    await createTask({ description: '属于张总的任务', owner: other.id, source: entry.id });

    const tasks = await listPendingTasksByOwner(owner.id);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.description).toBe('属于虾总的任务');
    expect(tasks[0]?.owner).toBe(owner.id);
  });

  it('cascades relationships when deleting an entity', async () => {
    const entry = await createEntry({ content: '删除关系测试。', source: 'text' });
    const person = await createEntity({ type: 'person', title: '虾总' });
    const project = await createEntity({ type: 'project', title: '股票监控' });

    await createRelationship({
      from: person.id,
      to: project.id,
      type: 'participant',
      evidence: [entry.id],
    });

    await deleteEntity(person.id);

    expect(await db.entities.get(person.id)).toBeUndefined();
    expect(await listRelationshipsForEntity(project.id)).toEqual([]);
  });
});
