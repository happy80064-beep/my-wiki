import Dexie from 'dexie';
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
  resetDatabase,
  upsertPendingCompileSuggestion,
} from '@/lib/db';
import { MyWikiDatabase } from '@/lib/db/schema';

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

  it('migrates version 5 browser records to version 6 without losing data', async () => {
    const databaseName = `migration-smoke-${crypto.randomUUID()}`;
    const clientId = getClientId();

    class LegacyDatabase extends Dexie {
      constructor(name: string) {
        super(name);
        this.version(5).stores({
          entries: 'id, capturedAt, processed, source',
          entities: 'id, type, title, *tags, *scenes, createdAt, updatedAt',
          relationships: 'id, from, to, type, createdAt, *evidence',
          tasks: 'id, owner, status, createdAt, dueDate, source, *linkedTo',
          compileSuggestions: 'id, &fingerprint, status, entityId, propertyKey, evidenceEntryId, createdAt, updatedAt',
          ingestJobs: 'id, status, contentHash, createdAt, updatedAt',
          ingestCache: '&contentHash, updatedAt, *entryIds',
          graphInsightDismissals: 'id, type, dismissedAt',
          rawAssets: 'id, status, kind, contentHash, filename, createdAt, updatedAt',
          queryCache: '&key, updatedAt, dataUpdatedAt',
        });
      }
    }

    const legacy = new LegacyDatabase(databaseName);
    await legacy.open();
    await legacy.table('entries').add({
      id: 'legacy-entry',
      content: 'legacy content',
      capturedAt: 1,
      processed: false,
      source: 'text',
    });
    await legacy.table('entities').add({
      id: 'legacy-entity',
      type: 'topic',
      title: 'Legacy Topic',
      tags: ['legacy'],
      scenes: [],
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.close();

    const migrated = new MyWikiDatabase(databaseName);
    await migrated.open();

    await expect(migrated.entries.get('legacy-entry')).resolves.toMatchObject({
      id: 'legacy-entry',
      content: 'legacy content',
      clientId,
    });
    await expect(migrated.entities.get('legacy-entity')).resolves.toMatchObject({
      id: 'legacy-entity',
      title: 'Legacy Topic',
      clientId,
    });

    await migrated.delete();
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
