import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalCaptureDraft } from '@/lib/capture';
import { db, resetDatabase } from '@/lib/db';
import {
  RAW_ASSET_STALE_MS,
  buildCaptureInputExcerpt,
  createRawAssetFromFile,
  processNextRawAsset,
  processRawAsset,
  resetStaleRawAssets,
} from '@/lib/rawAssets';

describe('raw assets', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores files in Raw Inbox without compiling immediately', async () => {
    const file = new File(['OpenMaic 是开源项目。'], 'openmaic.md', { type: 'text/markdown' });

    const result = await createRawAssetFromFile(file);
    const rawEntry = result.asset.entryId ? await db.entries.get(result.asset.entryId) : undefined;

    expect(result.reused).toBe(false);
    expect(result.asset.status).toBe('raw');
    expect(await db.entries.count()).toBe(1);
    expect(rawEntry?.processed).toBe(false);
    expect(rawEntry?.content).toContain('原始文件：openmaic.md');
    expect(await db.ingestJobs.count()).toBe(0);
  });

  it('accepts spreadsheet files into Raw Inbox before compilation', async () => {
    const file = new File(['项目,收入\n福瑞三期,4.22亿元'], 'revenue.csv', { type: 'text/csv' });

    const result = await createRawAssetFromFile(file);

    expect(result.reused).toBe(false);
    expect(result.asset.kind).toBe('spreadsheet');
    expect(result.asset.status).toBe('raw');
    expect(await db.entries.count()).toBe(1);
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
    expect((await db.entries.get(compiled!.entryId!))?.processed).toBe(true);
  });

  it('falls back to local indexing when AI extraction fails for a raw file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'invalid model json' }), { status: 502 })),
    );
    const file = new File(['一份很长的 PDF 解析文本。'], 'report.md', { type: 'text/markdown' });
    const { asset } = await createRawAssetFromFile(file);

    const compiled = await processRawAsset(asset.id);

    expect(compiled?.status).toBe('compiled');
    expect(compiled?.entryId).toBeTruthy();
    expect(await db.entries.count()).toBe(1);
  });

  it('recovers stale compiling raw assets so they can be retried', async () => {
    const file = new File(['OpenMaic 是开源项目。'], 'stale.md', { type: 'text/markdown' });
    const { asset } = await createRawAssetFromFile(file);
    const now = Date.now();
    await db.rawAssets.update(asset.id, {
      status: 'compiling',
      updatedAt: now - RAW_ASSET_STALE_MS - 1000,
    });

    const recovered = await resetStaleRawAssets(now);
    const reset = await db.rawAssets.get(asset.id);

    expect(recovered).toBe(1);
    expect(reset?.status).toBe('failed');
    expect(reset?.error).toContain('可重试');
  });

  it('processes recovered stale raw assets from the queue', async () => {
    const file = new File(['OpenMaic 是开源项目。'], 'recover.md', { type: 'text/markdown' });
    const { asset } = await createRawAssetFromFile(file);
    await db.rawAssets.update(asset.id, {
      status: 'compiling',
      updatedAt: Date.now() - RAW_ASSET_STALE_MS - 1000,
    });

    const compiled = await processNextRawAsset(async (content) => ({
      draft: createLocalCaptureDraft(content),
    }));

    expect(compiled?.id).toBe(asset.id);
    expect(compiled?.status).toBe('compiled');
  });

  it('builds a bounded excerpt for long raw content before sending it to AI', () => {
    const longContent = [
      '# 导入文件：report.pdf',
      '开头内容'.repeat(5000),
      '## 关键建议\n下一阶段需要完成任务规划和风险处理。',
      '结尾内容'.repeat(5000),
    ].join('\n');

    const excerpt = buildCaptureInputExcerpt(longContent, 1200);

    expect(excerpt.length).toBeLessThanOrEqual(1420);
    expect(excerpt).toContain('原文较长');
    expect(excerpt).toContain('下一阶段需要完成任务规划和风险处理');
    expect(excerpt).toContain('--- 结尾 ---');
  });
});
