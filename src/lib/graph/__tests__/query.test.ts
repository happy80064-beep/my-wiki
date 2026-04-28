import { beforeEach, describe, expect, it } from 'vitest';
import { createEntity, createEntry, createTask, resetDatabase } from '@/lib/db';
import { runStructuredQuery } from '@/lib/graph';

describe('structured query', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('answers pending tasks by exact owner id', async () => {
    const entry = await createEntry({ content: '任务归属测试', source: 'text' });
    const owner = await createEntity({ type: 'person', title: '虾总' });
    const other = await createEntity({ type: 'person', title: '张总' });

    await createTask({ description: '调通飞书推送', owner: owner.id, source: entry.id });
    await createTask({ description: '不应该出现的任务', owner: other.id, source: entry.id });

    const result = await runStructuredQuery('虾总有什么没完成的任务');

    expect(result.answer).toContain('调通飞书推送');
    expect(result.answer).not.toContain('不应该出现的任务');
    expect(result.sources.some((source) => source.id === owner.id)).toBe(true);
  });
});
