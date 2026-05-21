import { beforeEach, describe, expect, it } from 'vitest';
import {
  createEntity,
  createEntry,
  createRelationship,
  createTask,
  db,
  deleteEntity,
  deleteRelationship,
  deleteTask,
  getClientId,
  applyCompileSuggestion,
  listPendingTasksByOwner,
  listRelationshipsForEntity,
  mergeExactDuplicateCompatibleEntities,
  resetDatabase,
  upsertPendingCompileSuggestion,
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

  it('assigns the local client id to newly created records', async () => {
    const clientId = getClientId();
    const entry = await createEntry({ content: 'client id smoke test', source: 'text' });
    const entity = await createEntity({ type: 'topic', title: 'Client ID' });
    const relationship = await createRelationship({
      from: entity.id,
      to: entity.id,
      type: 'related-to',
      evidence: [entry.id],
    });
    const task = await createTask({
      description: 'check client id',
      owner: entity.id,
      source: entry.id,
    });

    expect(entry.clientId).toBe(clientId);
    expect(entity.clientId).toBe(clientId);
    expect(relationship.clientId).toBe(clientId);
    expect(task.clientId).toBe(clientId);
  });

  it('merges exact-title compatible duplicate wiki entities and rewires references', async () => {
    const firstEntry = await createEntry({ content: 'project source', source: 'text' });
    const secondEntry = await createEntry({ content: 'topic source', source: 'text' });
    const primary = await createEntity({
      type: 'project',
      title: 'Wellness Real Estate',
      tags: ['project'],
      sourceEntries: [firstEntry.id],
      createdAt: 1,
      updatedAt: 1,
    });
    const duplicate = await createEntity({
      type: 'topic',
      title: 'Wellness Real Estate',
      tags: ['concept'],
      sourceEntries: [secondEntry.id],
      createdAt: 2,
      updatedAt: 2,
    });
    const related = await createEntity({ type: 'topic', title: 'Health Park' });
    const selfRelationship = await createRelationship({
      from: duplicate.id,
      to: primary.id,
      type: 'about',
      evidence: [secondEntry.id],
    });
    const relatedRelationship = await createRelationship({
      from: duplicate.id,
      to: related.id,
      type: 'related-to',
      evidence: [secondEntry.id],
    });
    const task = await createTask({
      description: 'merge duplicate entity task',
      owner: duplicate.id,
      linkedTo: [primary.id],
      source: secondEntry.id,
    });
    await db.entries.update(firstEntry.id, {
      derivedEntities: [primary.id, duplicate.id],
      derivedRelationships: [selfRelationship.id, relatedRelationship.id],
    });
    const suggestion = await upsertPendingCompileSuggestion({
      entityId: duplicate.id,
      entityTitle: duplicate.title,
      propertyKey: 'openSourceStatus',
      propertyLabel: 'Open source status',
      propertyValue: 'unknown',
      evidenceEntryId: secondEntry.id,
      evidenceSnippet: 'topic source',
      evidenceScope: 'entity-source',
      confidence: 0.8,
    });

    const result = await mergeExactDuplicateCompatibleEntities();

    expect(result.mergedEntities).toBe(1);
    await expect(db.entities.get(duplicate.id)).resolves.toBeUndefined();
    await expect(db.entities.get(primary.id)).resolves.toMatchObject({
      id: primary.id,
      title: 'Wellness Real Estate',
      tags: expect.arrayContaining(['project', 'concept']),
      sourceEntries: expect.arrayContaining([firstEntry.id, secondEntry.id]),
    });
    await expect(db.entries.get(firstEntry.id)).resolves.toMatchObject({
      derivedEntities: [primary.id],
      derivedRelationships: [relatedRelationship.id],
    });
    await expect(db.relationships.get(selfRelationship.id)).resolves.toBeUndefined();
    await expect(db.relationships.get(relatedRelationship.id)).resolves.toMatchObject({
      from: primary.id,
      to: related.id,
    });
    await expect(db.tasks.get(task.id)).resolves.toMatchObject({
      owner: primary.id,
      linkedTo: [primary.id],
    });
    await expect(db.compileSuggestions.get(suggestion!.id)).resolves.toMatchObject({
      entityId: primary.id,
      entityTitle: primary.title,
    });
  });

  it('keeps business-line scope when applying metric compile suggestions', async () => {
    const entry = await createEntry({
      content: '住宅板块：用地面积 320 亩。医疗板块：用地面积 320 亩。',
      source: 'text',
    });
    const entity = await createEntity({
      type: 'project',
      title: '福瑞三期',
      sourceEntries: [entry.id],
    });

    const residential = await upsertPendingCompileSuggestion({
      entityId: entity.id,
      entityTitle: entity.title,
      propertyKey: 'metric_area',
      propertyLabel: '用地面积',
      propertyValue: '320 亩',
      businessLine: '住宅业态',
      categoryName: '住宅业态',
      evidenceEntryId: entry.id,
      evidenceSnippet: '住宅板块：用地面积 320 亩。',
      evidenceScope: 'entity-source',
      confidence: 0.82,
    });
    expect(residential?.status).toBe('pending');

    await applyCompileSuggestion(residential!.id);
    const updated = await db.entities.get(entity.id);
    expect(updated?.indicators?.[0]).toMatchObject({
      name: '用地面积',
      rawValue: '320 亩',
      unit: '亩',
      businessLine: '住宅业态',
      categoryName: '住宅业态',
    });

    const medical = await upsertPendingCompileSuggestion({
      entityId: entity.id,
      entityTitle: entity.title,
      propertyKey: 'metric_area',
      propertyLabel: '用地面积',
      propertyValue: '320 亩',
      businessLine: '医疗业态',
      categoryName: '医疗业态',
      evidenceEntryId: entry.id,
      evidenceSnippet: '医疗板块：用地面积 320 亩。',
      evidenceScope: 'entity-source',
      confidence: 0.82,
    });

    expect(medical?.status).toBe('pending');
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

  it('removes deleted relationship and task ids from source entries', async () => {
    const entry = await createEntry({ content: '派生引用清理测试。', source: 'text' });
    const person = await createEntity({ type: 'person', title: '虾总' });
    const project = await createEntity({ type: 'project', title: '股票监控' });
    const relationship = await createRelationship({
      from: person.id,
      to: project.id,
      type: 'participant',
      evidence: [entry.id],
    });
    const task = await createTask({
      description: '清理派生任务',
      owner: person.id,
      linkedTo: [project.id],
      source: entry.id,
    });

    await db.entries.update(entry.id, {
      derivedRelationships: [relationship.id],
      derivedTasks: [task.id],
    });

    await deleteRelationship(relationship.id);
    await deleteTask(task.id);

    const updatedEntry = await db.entries.get(entry.id);
    expect(updatedEntry?.derivedRelationships).toEqual([]);
    expect(updatedEntry?.derivedTasks).toEqual([]);
  });
});
