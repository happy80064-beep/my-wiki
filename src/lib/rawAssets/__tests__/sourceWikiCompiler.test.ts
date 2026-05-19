import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEntity, createEntry, db, resetDatabase } from '@/lib/db';
import { buildHumanEditedWikiPatch } from '@/lib/wiki/humanEditGuard';
import type { RawAsset } from '@/types';
import { compileRawAssetWikiPages } from '../assets';
import { compileRawAssetWikiPagesFromSource } from '../sourceWikiCompiler';

describe('raw asset source wiki compiler', () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.restoreAllMocks();
  });

  it('queues AI updates from captured source files when they conflict with human-edited wiki pages', async () => {
    const entry = await createEntry({
      content: 'Excel 原文件：福瑞三期住宅建筑面积更新为 14.2 万平方米。',
      source: 'file',
      fileMetadata: {
        filename: 'furui-source.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        url: 'raw://furui-source',
      },
    });
    const entity = await createEntity({
      type: 'project',
      title: '福瑞三期',
      summary: '人工维护页',
      tags: ['项目'],
      sourceEntries: [entry.id],
    });
    const currentMarkdown = [
      '# 福瑞三期',
      '',
      '## 住宅建筑面积',
      '福瑞三期住宅建筑面积为 12 万平方米。',
    ].join('\n');
    const proposedMarkdown = [
      '# 福瑞三期',
      '',
      '## 住宅建筑面积',
      '福瑞三期住宅建筑面积为 14.2 万平方米。',
    ].join('\n');
    await db.entities.update(entity.id, {
      wikiMarkdown: currentMarkdown,
      ...buildHumanEditedWikiPatch(currentMarkdown, 1000),
    });
    const asset: RawAsset = {
      id: 'raw-asset-1',
      clientId: 'test',
      filename: 'furui-source.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      kind: 'spreadsheet',
      size: 128,
      contentHash: 'hash',
      blob: new Blob(['source']),
      status: 'compiled',
      entryId: entry.id,
      createdAt: 1,
      updatedAt: 1,
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                entityId: entity.id,
                markdown: proposedMarkdown,
                summary: 'AI 更新住宅建筑面积。',
                tags: ['项目'],
              },
            ],
            missingEntityIds: [],
            warnings: [],
            provider: 'minimax-cn',
            model: 'MiniMax-M2.7',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const result = await compileRawAssetWikiPagesFromSource(asset, [entity.id]);
    const unchanged = await db.entities.get(entity.id);
    const reviews = await db.wikiReviewItems.where('entityId').equals(entity.id).toArray();

    expect(result.compiled).toBe(0);
    expect(result.reviewQueuedEntityIds).toEqual([entity.id]);
    expect(result.warnings.join('\n')).toContain('queued for human review');
    expect(unchanged?.wikiMarkdown).toContain('12 万平方米');
    expect(unchanged?.wikiMarkdown).not.toContain('14.2 万平方米');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ status: 'pending', sourceLabel: 'raw-asset-source-compile' });
  });

  it('does not fall back to per-page recompilation after a source compile queues review', async () => {
    const entity = await createEntity({
      type: 'project',
      title: '福瑞三期',
      summary: '人工维护页',
      tags: ['项目'],
    });
    const entry = await createEntry({
      content: 'Excel 原文件：福瑞三期住宅建筑面积更新为 14.2 万平方米。',
      source: 'file',
      derivedEntities: [entity.id],
      fileMetadata: {
        filename: 'furui-source.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        url: 'raw://furui-source',
      },
    });
    await db.entities.update(entity.id, { sourceEntries: [entry.id] });
    const currentMarkdown = [
      '# 福瑞三期',
      '',
      '## 住宅建筑面积',
      '福瑞三期住宅建筑面积为 12 万平方米。',
    ].join('\n');
    const proposedMarkdown = [
      '# 福瑞三期',
      '',
      '## 住宅建筑面积',
      '福瑞三期住宅建筑面积为 14.2 万平方米。',
    ].join('\n');
    await db.entities.update(entity.id, {
      wikiMarkdown: currentMarkdown,
      ...buildHumanEditedWikiPatch(currentMarkdown, 1000),
    });
    const asset: RawAsset = {
      id: 'raw-asset-2',
      clientId: 'test',
      filename: 'furui-source.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      kind: 'spreadsheet',
      size: 128,
      contentHash: 'hash-2',
      blob: new Blob(['source']),
      status: 'compiled',
      entryId: entry.id,
      createdAt: 1,
      updatedAt: 1,
    };
    await db.rawAssets.add(asset);
    const fetchMock = vi.fn(async (url: string) => {
      if (url !== '/api/wiki/recompile-source-batch') {
        throw new Error(`Unexpected fallback request: ${url}`);
      }
      return new Response(
        JSON.stringify({
          results: [
            {
              entityId: entity.id,
              markdown: proposedMarkdown,
              summary: 'AI 更新住宅建筑面积。',
              tags: ['项目'],
            },
          ],
          missingEntityIds: [],
          warnings: [],
          provider: 'minimax-cn',
          model: 'MiniMax-M2.7',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await compileRawAssetWikiPages(asset.id);
    const reviews = await db.wikiReviewItems.where('entityId').equals(entity.id).toArray();

    expect(result?.status).toBe('compiled');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/wiki/recompile-source-batch');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ status: 'pending', sourceLabel: 'raw-asset-source-compile' });
  });
});
