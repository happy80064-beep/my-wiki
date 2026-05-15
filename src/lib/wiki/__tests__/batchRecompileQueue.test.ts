import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, resetDatabase } from '@/lib/db';
import { loadWikiBatchCompileStatus } from '@/lib/wiki/batchCompileStatus';
import {
  reconcileInterruptedWikiBatchRun,
  startBrowserWikiBatchRecompile,
} from '@/lib/wiki/batchRecompileQueue';

vi.mock('@/lib/wiki/browserRecompile', () => ({
  recompileBrowserEntityWikiPage: vi.fn(async () => ({
    markdown: '# 已生成',
    summary: '已生成',
    tags: [],
    provider: 'test',
    model: 'mock',
  })),
}));

describe('browser wiki batch recompile queue', () => {
  beforeEach(async () => {
    await resetDatabase();
    window.localStorage.clear();
  });

  it('publishes done after the final item instead of staying at running 99%', async () => {
    const result = await startBrowserWikiBatchRecompile([{ id: 'entity_1', title: '测试页面' }]);
    const snapshot = loadWikiBatchCompileStatus();
    const job = await db.wikiBatchJobs.get(snapshot?.id ?? '');

    expect(result.status).toBe('done');
    expect(snapshot?.stage).toBe('done');
    expect(snapshot?.percent).toBe(100);
    expect(job?.status).toBe('done');
  });

  it('repairs an interrupted running snapshot whose job already finished all items', async () => {
    const startedAt = Date.now() - 1000;
    const job = {
      id: 'wiki_batch_stuck',
      clientId: 'client_test',
      owner: 'wiki',
      status: 'running' as const,
      items: [
        {
          entityId: 'entity_1',
          title: '测试页面',
          status: 'done' as const,
          attempts: 1,
          completedAt: startedAt,
          updatedAt: startedAt,
        },
      ],
      total: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      currentEntityId: 'entity_1',
      currentTitle: '测试页面',
      createdAt: startedAt,
      startedAt,
      updatedAt: startedAt,
    };
    await db.wikiBatchJobs.put(job);
    window.localStorage.setItem(
      'mywiki.v2.wikiBatchCompileStatus',
      JSON.stringify({
        id: job.id,
        owner: 'wiki',
        stage: 'running',
        percent: 99,
        label: '已完成《测试页面》',
        total: 1,
        processed: 1,
        succeeded: 1,
        failed: 0,
        currentEntityId: 'entity_1',
        currentTitle: '测试页面',
        startedAt,
        updatedAt: startedAt,
      }),
    );

    await reconcileInterruptedWikiBatchRun();
    const snapshot = loadWikiBatchCompileStatus();
    const repaired = await db.wikiBatchJobs.get(job.id);

    expect(snapshot?.stage).toBe('done');
    expect(snapshot?.percent).toBe(100);
    expect(repaired?.status).toBe('done');
  });
});
