import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalCaptureDraft } from '@/lib/capture';
import { db, resetDatabase } from '@/lib/db';
import {
  INGEST_JOB_STALE_MS,
  createIngestJob,
  processIngestJob,
  resetStaleIngestJobs,
} from '@/lib/ingest';

describe('ingest queue', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('processes a queued job and caches the source hash', async () => {
    const job = await createIngestJob({ content: 'OpenMaic 是开源项目。' });

    const processed = await processIngestJob(job.id, async (content) => ({
      draft: createLocalCaptureDraft(content),
    }));

    expect(processed?.status).toBe('done');
    expect(processed?.entryId).toBeTruthy();
    expect(await db.ingestCache.get(job.contentHash)).toBeTruthy();
  });

  it('skips duplicated content when cached entries still exist', async () => {
    const first = await createIngestJob({ content: '重复内容测试。' });
    await processIngestJob(first.id, async (content) => ({ draft: createLocalCaptureDraft(content) }));

    const second = await createIngestJob({ content: '重复内容测试。' });
    const processed = await processIngestJob(second.id, async () => {
      throw new Error('extractor should not run for cached content');
    });

    expect(processed?.status).toBe('skipped');
    expect(processed?.entryId).toBeTruthy();
  });

  it('recovers stale processing jobs so they can be retried', async () => {
    const job = await createIngestJob({ content: '一条会卡住的长文档。' });
    const now = Date.now();
    await db.ingestJobs.update(job.id, {
      status: 'processing',
      updatedAt: now - INGEST_JOB_STALE_MS - 1000,
    });

    const recovered = await resetStaleIngestJobs(now);
    const reset = await db.ingestJobs.get(job.id);

    expect(recovered).toBe(1);
    expect(reset?.status).toBe('failed');
    expect(reset?.error).toContain('可重试');
  });

  it('does not reuse a stale duplicate processing job', async () => {
    const first = await createIngestJob({ content: '重复导入但旧任务已经中断。' });
    await db.ingestJobs.update(first.id, {
      status: 'processing',
      updatedAt: Date.now() - INGEST_JOB_STALE_MS - 1000,
    });

    const second = await createIngestJob({ content: '重复导入但旧任务已经中断。' });
    const stale = await db.ingestJobs.get(first.id);

    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('pending');
    expect(stale?.status).toBe('failed');
  });
});
