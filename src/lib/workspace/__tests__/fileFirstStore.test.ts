import type { TauriWorkspaceStorage } from '@/lib/workspace/tauriStorage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    const migrationPath = `${mocks.workspaceRoot}/.mywiki/migration-state.json`;
    const wikiPath = `${mocks.workspaceRoot}/wiki/concepts/文件优先存储.md`;
    expect(mocks.files.has(recordsPath)).toBe(true);
    expect(mocks.files.has(migrationPath)).toBe(true);
    expect(mocks.files.get(recordsPath)).toContain(entity.id);
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
});
