import { beforeEach, describe, expect, it } from 'vitest';
import { createEntity, createEntry, db, resetDatabase } from '@/lib/db';
import { buildIndexedDbSnapshot, restoreIndexedDbSnapshot } from '@/lib/workspace/indexedDbSnapshot';

describe('workspace IndexedDB snapshot', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('round-trips core local knowledge records for workspace switching', async () => {
    const entry = await createEntry({ content: '福瑞健康科技园三期项目可研报告。', source: 'file' });
    const entity = await createEntity({
      type: 'project',
      title: '福瑞健康科技园三期项目',
      sourceEntries: [entry.id],
    });

    const snapshot = await buildIndexedDbSnapshot();
    await resetDatabase();
    expect(await db.entities.count()).toBe(0);

    await restoreIndexedDbSnapshot(snapshot);

    expect(await db.entries.count()).toBe(1);
    expect(await db.entities.count()).toBe(1);
    expect((await db.entities.get(entity.id))?.title).toBe('福瑞健康科技园三期项目');
  });
});
