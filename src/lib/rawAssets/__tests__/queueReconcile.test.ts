import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { db as dbType, resetDatabase as resetDatabaseType } from '@/lib/db';
import type { RawAsset } from '@/types';

const workspaceFiles = new Map<string, string>();

type DbModule = {
  db: typeof dbType;
  resetDatabase: typeof resetDatabaseType;
};

let db: DbModule['db'];
let resetDatabase: DbModule['resetDatabase'];
let cancelRawAssetQueueTask: typeof import('@/lib/rawAssets/assets').cancelRawAssetQueueTask;
let createRawAssetFromFile: typeof import('@/lib/rawAssets/assets').createRawAssetFromFile;
let processRawAssetQueue: typeof import('@/lib/rawAssets/assets').processRawAssetQueue;
let retryRawAssetQueueTask: typeof import('@/lib/rawAssets/assets').retryRawAssetQueueTask;
let reconcileInterruptedRawAssetQueueRun: typeof import('@/lib/rawAssets/assets').reconcileInterruptedRawAssetQueueRun;
let loadRawAssetWorkspaceQueue: typeof import('@/lib/rawAssets/workspaceQueue').loadRawAssetWorkspaceQueue;
let prepareRawAssetWorkspaceQueue: typeof import('@/lib/rawAssets/workspaceQueue').prepareRawAssetWorkspaceQueue;
let updateRawAssetWorkspaceQueueTask: typeof import('@/lib/rawAssets/workspaceQueue').updateRawAssetWorkspaceQueueTask;

describe('raw asset queue reconciliation', () => {
  beforeEach(async () => {
    vi.resetModules();
    workspaceFiles.clear();
    window.localStorage.clear();

    vi.doMock('@/lib/workspace', async () => {
      const actual = await vi.importActual<typeof import('@/lib/workspace')>('@/lib/workspace');
      return {
        ...actual,
        canUseWorkspaceStorage: () => true,
        createWorkspaceStorage: () => ({
          ensureDir: async () => undefined,
          exists: async (path: string) => workspaceFiles.has(path),
          readTextFile: async (path: string) => workspaceFiles.get(path) ?? '',
          writeTextFile: async (path: string, content: string) => {
            workspaceFiles.set(path, content);
          },
          writeBinaryFile: async () => undefined,
          listFiles: async () => [],
          listMarkdownFiles: async () => [],
          deletePath: async () => undefined,
        }),
        getPersistedWorkspaceRoot: () => 'D:/MyWikiProject',
        getWorkspaceDefaultRoot: async () => 'D:/MyWikiProject',
        initializeWorkspace: async (_storage: unknown, root: string) => {
          const layout = actual.buildWorkspaceLayout(root);
          return { layout, createdDirectories: [], createdFiles: [] };
        },
      };
    });

    ({ db, resetDatabase } = await import('@/lib/db'));
    ({ cancelRawAssetQueueTask, createRawAssetFromFile, processRawAssetQueue, retryRawAssetQueueTask, reconcileInterruptedRawAssetQueueRun } =
      await import('@/lib/rawAssets/assets'));
    ({ loadRawAssetWorkspaceQueue, prepareRawAssetWorkspaceQueue, updateRawAssetWorkspaceQueueTask } = await import('@/lib/rawAssets/workspaceQueue'));
    await resetDatabase();
  });

  afterEach(() => {
    vi.doUnmock('@/lib/workspace');
    vi.resetModules();
  });

  it('turns interrupted processing assets into retryable failures immediately', async () => {
    const asset = createAsset('raw_1', 'report.pdf');
    await db.rawAssets.add({ ...asset, status: 'compiling' });
    await prepareRawAssetWorkspaceQueue([asset], { owner: 'wiki', compileWiki: true });
    await updateRawAssetWorkspaceQueueTask(asset.id, (task) => ({
      ...task,
      status: 'processing',
      stage: 'structuring',
    }));

    await expect(reconcileInterruptedRawAssetQueueRun()).resolves.toBe(1);

    const recoveredAsset = await db.rawAssets.get(asset.id);
    const queue = await loadRawAssetWorkspaceQueue();

    expect(recoveredAsset?.status).toBe('failed');
    expect(recoveredAsset?.error).toContain('已恢复为可重试状态');
    expect(queue?.tasks[0]).toMatchObject({
      status: 'failed',
      retryCount: 1,
    });
  });

  it('cancels and retries a persisted raw asset queue task', async () => {
    const asset = createAsset('raw_1', 'report.pdf');
    await db.rawAssets.add(asset);
    await prepareRawAssetWorkspaceQueue([asset], { owner: 'wiki', compileWiki: true });

    await expect(cancelRawAssetQueueTask('rawq-raw_1')).resolves.toBe(true);
    let queue = await loadRawAssetWorkspaceQueue();
    let stored = await db.rawAssets.get(asset.id);

    expect(stored?.status).toBe('cancelled');
    expect(queue?.tasks[0]).toMatchObject({
      status: 'cancelled',
    });

    await expect(retryRawAssetQueueTask('rawq-raw_1')).resolves.toBe(true);
    queue = await loadRawAssetWorkspaceQueue();
    stored = await db.rawAssets.get(asset.id);

    expect(stored?.status).toBe('failed');
    expect(queue?.tasks[0]).toMatchObject({
      status: 'pending',
      stage: 'queued',
    });
  });

  it('aborts the running raw asset extractor when a processing queue task is cancelled', async () => {
    const { asset } = await createRawAssetFromFile(new File(['cancel me'], 'cancel.md', { type: 'text/markdown' }));
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let capturedSignal: AbortSignal | undefined;

    const queuePromise = processRawAssetQueue({
      extractor: async (_content, options) => {
        capturedSignal = options?.signal;
        started();
        return new Promise<never>((_, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      },
    });

    await startedPromise;
    await expect(cancelRawAssetQueueTask(`rawq-${asset.id}`)).resolves.toBe(true);
    await expect(queuePromise).resolves.toMatchObject({ total: 1, processed: 1, failed: 0 });

    const stored = await db.rawAssets.get(asset.id);
    const queue = await loadRawAssetWorkspaceQueue();
    expect(capturedSignal?.aborted).toBe(true);
    expect(stored?.status).toBe('cancelled');
    expect(queue?.tasks.find((task) => task.rawAssetId === asset.id)).toMatchObject({ status: 'cancelled' });
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
