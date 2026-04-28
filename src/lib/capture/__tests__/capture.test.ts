import { beforeEach, describe, expect, it } from 'vitest';
import { db, resetDatabase } from '@/lib/db';
import { createLocalCaptureDraft, persistCaptureDraft } from '@/lib/capture';

describe('capture flow', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('creates an editable draft from text and persists all derived records', async () => {
    const content = '今天和虾总约了股票监控项目的进度同步会，他确认这周内调通飞书推送';
    const draft = createLocalCaptureDraft(content);

    draft.primaryEntity.title = '股票监控进度同步';

    const result = await persistCaptureDraft(content, draft);

    expect(result.entry.processed).toBe(true);
    expect(result.entities.some((entity) => entity.title === '股票监控进度同步')).toBe(true);
    expect(result.relationships.length).toBeGreaterThan(0);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.owner).toBeTruthy();

    const savedEntry = await db.entries.get(result.entry.id);
    expect(savedEntry?.derivedEntities).toHaveLength(result.entities.length);
    expect(savedEntry?.derivedTasks).toHaveLength(result.tasks.length);
  });
});
