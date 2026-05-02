import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalCaptureDraft } from '@/lib/capture';
import { db, resetDatabase } from '@/lib/db';
import { createIngestJob, processIngestJob } from '@/lib/ingest';

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
});
