import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalCaptureDraft } from '@/lib/capture';
import { buildImportedContent, extractImportBlobText } from '@/lib/import/fileText';
import type { db as dbType, resetDatabase as resetDatabaseType } from '@/lib/db';
import type { RawAsset } from '@/types';

const workspaceFiles = new Map<string, string>();
let workspaceBinaryWriteError: Error | null = null;
let workspaceTextWriteError: Error | null = null;

type DbModule = {
  db: typeof dbType;
  resetDatabase: typeof resetDatabaseType;
};

let db: DbModule['db'];
let resetDatabase: DbModule['resetDatabase'];
let createIngestJob: typeof import('@/lib/ingest').createIngestJob;
let cancelRawAssetQueueTask: typeof import('@/lib/rawAssets/assets').cancelRawAssetQueueTask;
let createRawAssetFromFile: typeof import('@/lib/rawAssets/assets').createRawAssetFromFile;
let processRawAsset: typeof import('@/lib/rawAssets/assets').processRawAsset;
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
    workspaceBinaryWriteError = null;
    workspaceTextWriteError = null;
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
            if (workspaceTextWriteError) throw workspaceTextWriteError;
            workspaceFiles.set(path, content);
          },
          writeBinaryFile: async (path: string, content: string) => {
            if (workspaceBinaryWriteError) throw workspaceBinaryWriteError;
            workspaceFiles.set(path, content);
          },
          readBinaryFileBase64: async (path: string) => {
            const content = workspaceFiles.get(path);
            if (content === undefined) throw new Error(`Missing binary file: ${path}`);
            return { dataBase64: content, size: base64ByteLength(content) };
          },
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
    ({ createIngestJob } = await import('@/lib/ingest'));
    ({ cancelRawAssetQueueTask, createRawAssetFromFile, processRawAsset, processRawAssetQueue, retryRawAssetQueueTask, reconcileInterruptedRawAssetQueueRun } =
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

  it('recovers a missing raw asset record from the workspace source file before processing', async () => {
    const sourceText = [
      '# Recovered MD Project',
      '',
      'Recovered MD Project is a real markdown import case with project goals, risks, owners, and next actions.',
      'The queue task remains in the existing workspace, but records.json no longer has the raw asset row.',
    ].join('\n');
    const asset = {
      ...createAsset('raw_recovered_md', 'recovered-md-project.md'),
      mimeType: 'text/markdown',
      kind: 'text' as const,
      contentHash: '',
    };
    workspaceFiles.set('D:/MyWikiProject/raw/sources/recovered-md-project.md', utf8ToBase64(sourceText));
    await prepareRawAssetWorkspaceQueue([asset], { owner: 'wiki', compileWiki: true });

    expect(await db.rawAssets.get(asset.id)).toBeUndefined();

    const result = await processRawAssetQueue({
      compileWiki: true,
      extractor: async (content) => ({ draft: createLocalCaptureDraft(content) }),
      wikiCompiler: async (entityId) => {
        const entity = await db.entities.get(entityId);
        await db.entities.update(entityId, {
          wikiMarkdown: buildUsefulWikiMarkdown(entity?.title ?? 'Recovered MD Project'),
          wikiCompiledAt: Date.now(),
          updatedAt: Date.now(),
        });
      },
    });

    const recovered = await db.rawAssets.get(asset.id);
    const queue = await loadRawAssetWorkspaceQueue();

    expect(result).toEqual({ total: 1, processed: 1, failed: 0 });
    expect(recovered).toMatchObject({
      id: asset.id,
      filename: 'recovered-md-project.md',
      status: 'compiled',
      mimeType: 'text/markdown',
    });
    expect(recovered?.extractedText).toContain('Recovered MD Project');
    expect(queue?.tasks.find((task) => task.rawAssetId === asset.id)).toBeUndefined();
  });

  it('fails a raw asset visibly when a duplicate ingest job is still processing', async () => {
    const sourceText = 'Active duplicate project content with enough context to build a source page.';
    const { asset } = await createRawAssetFromFile(new File([sourceText], 'active-duplicate.md', { type: 'text/markdown' }));
    const extractedText = await extractImportBlobText({
      blob: asset.blob,
      filename: asset.filename,
      mimeType: asset.mimeType,
      kind: asset.kind,
    });
    const importedContent = buildImportedContent({
      filename: asset.filename,
      kind: asset.kind,
      source: 'file',
      text: extractedText,
    });
    const job = await createIngestJob({
      content: importedContent,
      source: 'file',
      filename: asset.filename,
      targetEntryId: asset.entryId,
    });
    await db.ingestJobs.update(job.id, {
      status: 'processing',
      updatedAt: Date.now(),
    });
    await db.rawAssets.update(asset.id, {
      ingestJobId: job.id,
    });

    const processed = await processRawAsset(asset.id, async () => {
      throw new Error('extractor should not run while duplicate job is processing');
    });
    const updatedJob = await db.ingestJobs.get(job.id);

    expect(processed?.status).toBe('failed');
    expect(processed?.error).toContain('旧结构化任务');
    expect(updatedJob?.status).toBe('failed');
    expect(updatedJob?.error).toContain('旧结构化任务');
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

  it('fails raw file import visibly when the workspace source copy cannot be written', async () => {
    workspaceBinaryWriteError = new Error('disk is read-only');

    await expect(createRawAssetFromFile(new File(['cannot persist'], 'readonly.md', { type: 'text/markdown' }))).rejects.toThrow(
      '原文件写入工作区失败',
    );

    expect(await db.rawAssets.count()).toBe(0);
    expect(await db.entries.count()).toBe(0);
  });

  it('fails queue processing visibly when the persisted workspace queue cannot be updated', async () => {
    const { asset } = await createRawAssetFromFile(new File(['queue write failure'], 'queue-failure.md', { type: 'text/markdown' }));
    workspaceTextWriteError = new Error('queue file is locked');

    await expect(
      processRawAssetQueue({
        extractor: async (content) => ({ draft: createLocalCaptureDraft(content) }),
      }),
    ).rejects.toThrow('queue file is locked');

    expect((await db.rawAssets.get(asset.id))?.status).toBe('raw');
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

function utf8ToBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ByteLength(value: string) {
  return atob(value).length;
}

function buildUsefulWikiMarkdown(title: string) {
  const body = [
    'This recovered wiki page is intentionally long enough to verify that the wiki compiler finished successfully.',
    'It includes project context, source evidence, operational risks, and concrete follow-up actions for the imported material.',
    'The assertions rely on compiled knowledge being present rather than merely checking that a function returned.',
  ].join(' ');
  return [
    '---',
    `title: ${title}`,
    'type: project',
    '---',
    '',
    `# ${title}`,
    '',
    '## Summary',
    body,
    body,
    '',
    '## Evidence',
    body,
    body,
    '',
    '## Actions',
    body,
    body,
  ].join('\n');
}
