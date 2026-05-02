import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalCaptureDraft } from '@/lib/capture';
import { db, resetDatabase } from '@/lib/db';
import { createRawAssetFromFile, processRawAsset } from '@/lib/rawAssets';

describe('raw assets', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('stores files in Raw Inbox without compiling immediately', async () => {
    const file = new File(['OpenMaic 是开源项目。'], 'openmaic.md', { type: 'text/markdown' });

    const result = await createRawAssetFromFile(file);

    expect(result.reused).toBe(false);
    expect(result.asset.status).toBe('raw');
    expect(await db.entries.count()).toBe(0);
    expect(await db.ingestJobs.count()).toBe(0);
  });

  it('deduplicates raw files by content hash', async () => {
    const first = new File(['重复内容'], 'a.md', { type: 'text/markdown' });
    const second = new File(['重复内容'], 'b.md', { type: 'text/markdown' });

    await createRawAssetFromFile(first);
    const duplicated = await createRawAssetFromFile(second);

    expect(duplicated.reused).toBe(true);
    expect(await db.rawAssets.count()).toBe(1);
  });

  it('compiles a raw text file asynchronously', async () => {
    const file = new File(['OpenMaic 是开源项目。'], 'openmaic.md', { type: 'text/markdown' });
    const { asset } = await createRawAssetFromFile(file);

    const compiled = await processRawAsset(asset.id, async (content) => ({
      draft: createLocalCaptureDraft(content),
    }));

    expect(compiled?.status).toBe('compiled');
    expect(compiled?.entryId).toBeTruthy();
    expect(await db.entries.count()).toBe(1);
  });
});
