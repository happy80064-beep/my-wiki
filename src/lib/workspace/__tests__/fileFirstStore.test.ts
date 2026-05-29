import type { TauriWorkspaceStorage } from '@/lib/workspace/tauriStorage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

const mocks = vi.hoisted(() => ({
  workspaceRoot: 'D:/FileFirstWiki',
  files: new Map<string, string>(),
  dirs: new Set<string>(),
}));

vi.mock('@/lib/workspace/storage', () => ({
  canUseWorkspaceStorage: () => true,
  createWorkspaceStorage: () => memoryWorkspaceStorage(),
  getWorkspaceDefaultRoot: async () => mocks.workspaceRoot,
}));

vi.mock('@/lib/workspace/activeWorkspace', () => ({
  getPersistedWorkspaceRoot: () => mocks.workspaceRoot,
  persistWorkspaceRoot: vi.fn(),
  clearPersistedWorkspaceRoot: vi.fn(),
}));

import { createEntity, createEntry, db, resetDatabase } from '@/lib/db';
import { clearWorkspaceRecordRuntimeCache } from '@/lib/db/schema';
import { createLocalCaptureDraft } from '@/lib/capture';
import { createRawAssetFromFile, processRawAsset } from '@/lib/rawAssets';
import { restoreWorkspaceRecordsFromWorkspace, syncWorkspaceRecordsToDefaultWorkspace } from '@/lib/workspace/workspaceRecordsSync';

function memoryWorkspaceStorage(): TauriWorkspaceStorage {
  return {
    async ensureDir(path) {
      mocks.dirs.add(path);
    },
    async exists(path) {
      return mocks.dirs.has(path) || mocks.files.has(path);
    },
    async writeTextFile(path, content) {
      mocks.files.set(path, content);
    },
    async writeBinaryFile(path, dataBase64) {
      mocks.files.set(path, dataBase64);
    },
    async listMarkdownFiles(root) {
      return [...mocks.files.keys()].filter((path) => path.startsWith(`${root}/`) && path.endsWith('.md'));
    },
    async listFiles(root) {
      return [...mocks.files.keys()].filter((path) => path.startsWith(`${root}/`));
    },
    async readTextFile(path) {
      const content = mocks.files.get(path);
      if (content === undefined) throw new Error(`Missing file: ${path}`);
      return content;
    },
    async deletePath(_root, path) {
      mocks.files.delete(path);
    },
  };
}

describe('workspace file-first store', () => {
  beforeEach(async () => {
    mocks.files.clear();
    mocks.dirs.clear();
    await resetDatabase();
  });

  it('persists runtime records to .mywiki/records.json and reloads without browser storage fallback', async () => {
    const entry = await createEntry({
      content: '真实用例：文件优先存储验证。',
      source: 'text',
      processed: true,
    });
    const entity = await createEntity({
      type: 'topic',
      title: '文件优先存储',
      summary: '运行时主库写入 workspace 文件。',
      sourceEntries: [entry.id],
    });

    await syncWorkspaceRecordsToDefaultWorkspace(mocks.workspaceRoot);

    const recordsPath = `${mocks.workspaceRoot}/.mywiki/records.json`;
    const snapshotPath = `${mocks.workspaceRoot}/.mywiki/snapshots/records.latest.json`;
    const migrationPath = `${mocks.workspaceRoot}/.mywiki/migration-state.json`;
    const wikiPath = `${mocks.workspaceRoot}/wiki/concepts/文件优先存储.md`;
    expect(mocks.files.has(recordsPath)).toBe(true);
    expect(mocks.files.has(snapshotPath)).toBe(true);
    expect(mocks.files.has(migrationPath)).toBe(true);
    expect(mocks.files.get(recordsPath)).toContain(entity.id);
    expect(mocks.files.get(snapshotPath)).toContain(entity.id);
    expect(mocks.files.get(migrationPath)).toContain('"status": "migrated"');
    expect(mocks.files.has(wikiPath)).toBe(true);

    clearWorkspaceRecordRuntimeCache();

    const restored = await restoreWorkspaceRecordsFromWorkspace(mocks.workspaceRoot);
    expect(restored?.mode).toBe('records');
    expect(await db.entities.get(entity.id)).toMatchObject({
      id: entity.id,
      title: '文件优先存储',
    });
    expect(await db.entries.get(entry.id)).toMatchObject({
      id: entry.id,
      content: '真实用例：文件优先存储验证。',
    });
  });

  it('repairs a damaged records.json from the latest valid snapshot without markdown fallback', async () => {
    const entry = await createEntry({
      content: 'lossless workspace switch source',
      source: 'text',
      processed: true,
    });
    const entity = await createEntity({
      type: 'project',
      title: 'Lossless Workspace Switch',
      summary: 'Validates records snapshot recovery.',
      sourceEntries: [entry.id],
    });

    await syncWorkspaceRecordsToDefaultWorkspace(mocks.workspaceRoot);

    const recordsPath = `${mocks.workspaceRoot}/.mywiki/records.json`;
    const originalRecords = mocks.files.get(recordsPath) ?? '';
    mocks.files.set(recordsPath, '\0'.repeat(originalRecords.length || 32));
    clearWorkspaceRecordRuntimeCache();

    const restored = await restoreWorkspaceRecordsFromWorkspace(mocks.workspaceRoot);

    expect(restored?.mode).toBe('records');
    expect(mocks.files.get(recordsPath)).toContain(entity.id);
    expect(await db.entities.get(entity.id)).toMatchObject({
      id: entity.id,
      title: 'Lossless Workspace Switch',
    });
  });

  it('does not silently downgrade to markdown after a records migration failure', async () => {
    const recordsPath = `${mocks.workspaceRoot}/.mywiki/records.json`;
    const migrationPath = `${mocks.workspaceRoot}/.mywiki/migration-state.json`;
    mocks.files.delete(recordsPath);
    mocks.files.set(
      migrationPath,
      JSON.stringify({
        version: 1,
        status: 'failed',
        source: 'workspace-records',
        failedAt: Date.now(),
        error: 'Unexpected token \\0',
      }),
    );
    mocks.files.set(`${mocks.workspaceRoot}/wiki/concepts/fallback.md`, '# Fallback');
    clearWorkspaceRecordRuntimeCache();

    await expect(restoreWorkspaceRecordsFromWorkspace(mocks.workspaceRoot)).rejects.toThrow(/Lossless workspace switch stopped/);
  });

  it('repairs old degraded markdown-restore records when workspace markdown is richer', async () => {
    const recordsPath = `${mocks.workspaceRoot}/.mywiki/records.json`;
    mocks.files.set(
      recordsPath,
      JSON.stringify({
        version: 1,
        createdAt: 1,
        updatedAt: 1,
        records: {
          entries: [],
          entities: [
            {
              id: 'project_furui',
              clientId: 'test-client',
              type: 'project',
              title: '福瑞三期',
              summary: '',
              tags: [],
              scenes: [],
              properties: { status: 'active' },
              sourceEntries: [],
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          relationships: [],
          tasks: [],
          compileSuggestions: [],
          ingestJobs: [],
          ingestCache: [],
          graphInsightDismissals: [],
          rawAssets: [],
          queryCache: [],
          wikiBatchJobs: [],
          wikiReviewItems: [],
        },
      }),
    );
    mocks.files.set(
      `${mocks.workspaceRoot}/raw/entries/entry_report.md`,
      [
        '---',
        'id: "entry_report"',
        'type: "raw-entry"',
        'source: "file"',
        'capturedAt: 1779859967907',
        'processed: true',
        '---',
        '',
        '# 捕获原文 entry_report',
        '',
        '## 原文',
        '',
        '# 导入文件：report.pdf',
        '',
        '福瑞三期项目原文。',
      ].join('\n'),
    );
    mocks.files.set(
      `${mocks.workspaceRoot}/wiki/projects/福瑞三期.md`,
      [
        '---',
        'id: "project_furui"',
        'type: project',
        'title: "福瑞三期"',
        'tags: ["project"]',
        'sources: ["report.pdf"]',
        '---',
        '',
        '# 福瑞三期',
        '',
        '## 摘要',
        '这是磁盘上的完整 Wiki 正文。',
      ].join('\n'),
    );
    clearWorkspaceRecordRuntimeCache();

    await restoreWorkspaceRecordsFromWorkspace(mocks.workspaceRoot);

    const restored = await db.entities.get('project_furui');
    expect(restored?.wikiMarkdown).toContain('这是磁盘上的完整 Wiki 正文。');
    expect(restored?.sourceEntries).toEqual(['entry_report']);
    expect(mocks.files.get(recordsPath)).toContain('这是磁盘上的完整 Wiki 正文。');
  });

  it('reloads raw asset bytes from records.json dataBase64 when only an empty Blob remains in runtime state', async () => {
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet([
      ['项目', '收入'],
      ['福瑞三期', '4.22亿元'],
    ]);
    XLSX.utils.book_append_sheet(workbook, worksheet, '利润表');
    const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const { asset } = await createRawAssetFromFile(
      new File([buffer], '真实项目测算.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    );
    await db.rawAssets.update(asset.id, {
      blob: new Blob([], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      status: 'raw',
    });

    clearWorkspaceRecordRuntimeCache();
    let capturedContent = '';
    const compiled = await processRawAsset(asset.id, async (content) => {
      capturedContent = content;
      return { draft: createLocalCaptureDraft(content) };
    });

    expect(capturedContent).toContain('福瑞三期');
    expect(capturedContent).toContain('4.22亿元');
    expect(compiled?.status).toBe('compiled');
    expect(compiled?.extractedText).toContain('福瑞三期');
  });
});
