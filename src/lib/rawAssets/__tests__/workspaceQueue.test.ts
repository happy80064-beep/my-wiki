import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawAsset } from '@/types';

const workspaceFiles = vi.hoisted(() => new Map<string, string>());

vi.mock('@/lib/workspace', () => {
  const joinWorkspacePath = (first: string, ...rest: string[]) =>
    [first, ...rest]
      .join('/')
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/\/$/, '');

  return {
    canUseWorkspaceStorage: () => true,
    createWorkspaceStorage: () => ({
      ensureDir: async () => undefined,
      exists: async (path: string) => workspaceFiles.has(path),
      readTextFile: async (path: string) => workspaceFiles.get(path) ?? '',
      writeTextFile: async (path: string, content: string) => {
        workspaceFiles.set(path, content);
      },
      listFiles: async () => [],
    }),
    getPersistedWorkspaceRoot: () => 'D:/MyWikiProject',
    getWorkspaceDefaultRoot: async () => 'D:/MyWikiProject',
    initializeWorkspace: async () => ({
      layout: {
        root: 'D:/MyWikiProject',
        ingestQueue: 'D:/MyWikiProject/.mywiki/ingest-queue.json',
      },
      createdDirectories: [],
      createdFiles: [],
    }),
    joinWorkspacePath,
  };
});

import {
  clearRawAssetWorkspaceQueueTasks,
  getRawAssetWorkspaceQueueTask,
  loadRawAssetWorkspaceQueue,
  prepareRawAssetWorkspaceQueue,
  resetInterruptedRawAssetWorkspaceQueueTasks,
  summarizeRawAssetWorkspaceQueue,
  updateRawAssetWorkspaceQueueTask,
  updateRawAssetWorkspaceQueueTaskById,
} from '@/lib/rawAssets/workspaceQueue';

describe('raw asset workspace queue', () => {
  beforeEach(() => {
    workspaceFiles.clear();
  });

  it('writes queue tasks to the active workspace ingest queue file', async () => {
    await prepareRawAssetWorkspaceQueue([createAsset('raw_1', 'report.pdf')], {
      owner: 'wiki',
      compileWiki: true,
    });

    const snapshot = await loadRawAssetWorkspaceQueue();

    expect(snapshot?.path).toBe('D:/MyWikiProject/.mywiki/ingest-queue.json');
    expect(snapshot?.tasks).toMatchObject([
      {
        id: 'rawq-raw_1',
        rawAssetId: 'raw_1',
        sourcePath: 'raw/sources/report.pdf',
        status: 'pending',
        stage: 'queued',
        compileWiki: true,
      },
    ]);
  });

  it('updates task progress and preserves failed tasks for retry', async () => {
    await prepareRawAssetWorkspaceQueue([createAsset('raw_1', 'report.pdf')], {
      owner: 'wiki',
      compileWiki: true,
    });

    await updateRawAssetWorkspaceQueueTask('raw_1', (task) => ({
      ...task,
      status: 'processing',
      stage: 'wiki',
    }));
    await updateRawAssetWorkspaceQueueTask('raw_1', (task) => ({
      ...task,
      status: 'failed',
      retryCount: task.retryCount + 1,
      error: 'model timeout',
    }));

    const snapshot = await loadRawAssetWorkspaceQueue();

    expect(snapshot?.tasks[0]).toMatchObject({
      status: 'failed',
      stage: 'wiki',
      retryCount: 1,
      error: 'model timeout',
    });
    expect(summarizeRawAssetWorkspaceQueue(snapshot?.tasks ?? [])).toMatchObject({
      failed: 1,
      total: 1,
    });
  });

  it('removes completed tasks from the persisted workspace queue', async () => {
    await prepareRawAssetWorkspaceQueue([createAsset('raw_1', 'report.pdf')], {
      owner: 'wiki',
      compileWiki: true,
    });

    await updateRawAssetWorkspaceQueueTask('raw_1', (task) => ({
      ...task,
      status: 'done',
      completedAt: Date.now(),
    }));

    const snapshot = await loadRawAssetWorkspaceQueue();

    expect(snapshot?.tasks).toHaveLength(0);
    expect(summarizeRawAssetWorkspaceQueue(snapshot?.tasks ?? [])).toMatchObject({
      done: 0,
      total: 0,
    });
  });

  it('restores interrupted processing tasks to pending on the next run', async () => {
    await prepareRawAssetWorkspaceQueue([createAsset('raw_1', 'report.pdf')], {
      owner: 'wiki',
      compileWiki: false,
    });
    await updateRawAssetWorkspaceQueueTask('raw_1', (task) => ({
      ...task,
      status: 'processing',
      stage: 'structuring',
    }));

    await expect(resetInterruptedRawAssetWorkspaceQueueTasks()).resolves.toBe(1);
    const snapshot = await loadRawAssetWorkspaceQueue();

    expect(snapshot?.tasks[0]).toMatchObject({
      status: 'pending',
      stage: 'queued',
    });
  });

  it('updates tasks by queue id and clears completed or cancelled records', async () => {
    await prepareRawAssetWorkspaceQueue([createAsset('raw_1', 'report.pdf'), createAsset('raw_2', 'notes.md')], {
      owner: 'wiki',
      compileWiki: true,
    });

    await updateRawAssetWorkspaceQueueTaskById('rawq-raw_1', (task) => ({
      ...task,
      status: 'cancelled',
      error: 'user cancelled',
    }));
    await updateRawAssetWorkspaceQueueTaskById('rawq-raw_2', (task) => ({
      ...task,
      status: 'failed',
      error: 'model timeout',
    }));

    await expect(getRawAssetWorkspaceQueueTask('rawq-raw_1')).resolves.toMatchObject({
      status: 'cancelled',
      error: 'user cancelled',
    });
    await expect(clearRawAssetWorkspaceQueueTasks(['cancelled'])).resolves.toBe(1);
    const snapshot = await loadRawAssetWorkspaceQueue();

    expect(snapshot?.tasks).toHaveLength(1);
    expect(snapshot?.tasks[0]).toMatchObject({
      id: 'rawq-raw_2',
      status: 'failed',
    });
  });
});

function createAsset(id: string, filename: string): RawAsset {
  return {
    id,
    clientId: 'client-test',
    filename,
    mimeType: 'application/pdf',
    kind: 'pdf',
    size: 12,
    contentHash: `hash-${id}`,
    blob: new Blob(['test']),
    status: 'raw',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
