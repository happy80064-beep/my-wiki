import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queueMocks = vi.hoisted(() => ({
  listener: undefined as undefined | ((snapshot: unknown) => void),
}));

const reloadRecordsMock = vi.hoisted(() => vi.fn(async () => undefined));
const workspaceMocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
}));

function memoryWorkspaceStorage() {
  return {
    async ensureDir(path: string) {
      workspaceMocks.dirs.add(path);
    },
    async exists(path: string) {
      return workspaceMocks.files.has(path) || workspaceMocks.dirs.has(path);
    },
    async readTextFile(path: string) {
      const content = workspaceMocks.files.get(path);
      if (content === undefined) throw new Error(`Missing file: ${path}`);
      return content;
    },
    async writeTextFile(path: string, content: string) {
      workspaceMocks.files.set(path, content);
    },
    async writeBinaryFile(path: string, content: string) {
      workspaceMocks.files.set(path, content);
    },
    async listMarkdownFiles() {
      return [];
    },
    async listFiles() {
      return [];
    },
    async deletePath(_root: string, path: string) {
      workspaceMocks.files.delete(path);
    },
  };
}

vi.mock('@/lib/db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/schema')>();
  return {
    ...actual,
    reloadWorkspaceRecordStateFromDisk: reloadRecordsMock,
  };
});

vi.mock('@/lib/runtime/tauri', () => ({
  isTauriRuntime: () => true,
}));

vi.mock('@/lib/workspace/storage', () => ({
  canUseWorkspaceStorage: () => true,
  createWorkspaceStorage: () => memoryWorkspaceStorage(),
  getWorkspaceDefaultRoot: async () => 'D:/QueueSyncWiki',
}));

vi.mock('@/lib/workspace/activeWorkspace', () => ({
  getPersistedWorkspaceRoot: () => 'D:/QueueSyncWiki',
  persistWorkspaceRoot: vi.fn(),
  clearPersistedWorkspaceRoot: vi.fn(),
}));

vi.mock('@/lib/workspace', () => ({
  assertSafeWorkspaceRelativePath: (value: string) => value,
  canUseWorkspaceStorage: () => true,
  createWorkspaceStorage: () => ({}),
  getPersistedWorkspaceRoot: () => 'D:/QueueSyncWiki',
  getWorkspaceDefaultRoot: async () => 'D:/QueueSyncWiki',
  initializeWorkspace: async () => ({ layout: { root: 'D:/QueueSyncWiki' } }),
  joinWorkspacePath: (...parts: string[]) => parts.join('/'),
  resolveActiveWorkspaceSchemaContext: async () => ({ schema: '' }),
  syncWorkspaceRecordsToDefaultWorkspace: vi.fn(async () => undefined),
  useWorkspaceRuntimeStore: (selector: (state: { activeRoot: string; snapshot: { layout: { root: string } } }) => unknown) =>
    selector({ activeRoot: 'D:/QueueSyncWiki', snapshot: { layout: { root: 'D:/QueueSyncWiki' } } }),
}));

vi.mock('@/lib/rawAssets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rawAssets')>();
  return {
    ...actual,
    cancelActiveRawAssetQueueTasks: vi.fn(async () => 0),
    cancelRawAssetQueueTask: vi.fn(async () => true),
    clearTerminalRawAssetQueueTasks: vi.fn(async () => 0),
    createRawAssetFromFile: vi.fn(),
    loadRawAssetWorkspaceQueue: vi.fn(async () => ({ tasks: [], path: 'D:/QueueSyncWiki/.mywiki/ingest-queue.json' })),
    processRawAssetQueue: vi.fn(async () => ({ total: 0, processed: 0, failed: 0 })),
    reconcileInterruptedRawAssetQueueRun: vi.fn(async () => 0),
    retryRawAssetQueueTask: vi.fn(async () => true),
    subscribeRawAssetQueueStatus: vi.fn((listener: (snapshot: unknown) => void) => {
      queueMocks.listener = listener;
      return () => undefined;
    }),
  };
});

import { resetDatabase } from '@/lib/db';
import { RuntimeWikiPage } from '../WikiPage';

describe('RuntimeWikiPage queue sync', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    workspaceMocks.files.clear();
    workspaceMocks.dirs.clear();
    reloadRecordsMock.mockClear();
    queueMocks.listener = undefined;
    await resetDatabase();
  });

  it('reloads workspace records when Frog publishes raw queue progress from another window', async () => {
    render(<RuntimeWikiPage />);

    await waitFor(() => {
      expect(queueMocks.listener).toBeTruthy();
    });

    await act(async () => {
      queueMocks.listener?.({
        id: 'frog-test',
        owner: 'frog',
        stage: 'running',
        percent: 12,
        label: '提取 real.xlsx',
        total: 1,
        processed: 0,
        failed: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    await waitFor(() => {
      expect(reloadRecordsMock).toHaveBeenCalledTimes(1);
    });
  });
});
