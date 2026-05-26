import { db } from '@/lib/db/schema';
import { createEntry, createId, getClientId, updateEntry } from '@/lib/db';
import { extractCaptureDraft } from '@/lib/ai/captureClient';
import { loadProviderSettings, resolveProviderConfigForRole } from '@/lib/llm/providerSettings';
import {
  buildImportedContent,
  extractImportBlobImages,
  extractImportBlobText,
  extractImportUrlText,
  getImportFileKind,
  type ExtractedImportImage,
} from '@/lib/import/fileText';
import { buildWebImportFilename } from '@/lib/import/webUrl';
import { createIngestJob, processIngestJob, type IngestExtractor, type IngestExtractorOptions } from '@/lib/ingest';
import { loadMultimodalSettings } from '@/lib/multimodal/settings';
import {
  buildImageKnowledgeMarkdown,
  captionImageForWiki,
  isVisionRefusalCaption,
  ocrImageForWiki,
} from '@/lib/multimodal/visionCaption';
import { buildSupersededBlock } from '@/lib/wiki/superseded';
import {
  assertSafeWorkspaceRelativePath,
  canUseWorkspaceStorage,
  createWorkspaceStorage,
  getPersistedWorkspaceRoot,
  getWorkspaceDefaultRoot,
  initializeWorkspace,
  joinWorkspacePath,
  syncWorkspaceRecordsToDefaultWorkspace,
  withWorkspaceLock,
  type WorkspaceFileStorageAdapter,
} from '@/lib/workspace';
import type { Entity, RawAsset, RawAssetKind } from '@/types';
import {
  createRawAssetQueueRunId,
  isRawAssetQueueRunning,
  loadRawAssetQueueStatus,
  publishRawAssetQueueStatus,
  type RawAssetQueueSnapshot,
} from './queueStatus';
import {
  clearRawAssetWorkspaceQueueTasks,
  getRawAssetWorkspaceQueueTask,
  loadRawAssetWorkspaceQueue,
  prepareRawAssetWorkspaceQueue,
  updateRawAssetWorkspaceQueueTask,
  updateRawAssetWorkspaceQueueTaskById,
  type RawAssetWorkspaceQueueTask,
  type RawAssetWorkspaceQueueTaskStage,
} from './workspaceQueue';

export type RawAssetImportResult = {
  asset: RawAsset;
  reused: boolean;
};

export type RawAssetCompileProgress = {
  percent: number;
  label: string;
};

export type RawAssetWikiCompiler = (entityId: string, asset: RawAsset, options?: IngestExtractorOptions) => Promise<void>;

export const RAW_ASSET_STALE_MS = 15 * 60 * 1000;
const LONG_TEXT_PDF_IMAGE_ENRICHMENT_PAGE_LIMIT = 30;
const rawAssetCancelMessage = 'User cancelled this raw asset ingest task.';
const rawAssetWikiEntityRetryLimit = 3;
const rawAssetWikiEntityRetryBaseDelayMs = 1500;
const rawAssetQueueFailureCooldownMs = 8000;
const minUsefulWikiMarkdownLength = 700;

let activeRawAssetQueueAbort:
  | {
      rawAssetId: string;
      controller: AbortController;
    }
  | null = null;

export type RawAssetQueueResult = {
  total: number;
  processed: number;
  failed: number;
};

export type WritableRawWorkspace = {
  storage: ReturnType<typeof createWorkspaceStorage>;
  rawSources: string;
};

export async function createRawAssetFromFile(file: File): Promise<RawAssetImportResult> {
  const kind = getImportFileKind(file.name, file.type);
  if (!kind) {
    throw new Error(`${file.name} 的格式暂不支持。`);
  }

  const buffer = await file.arrayBuffer();
  const contentHash = await hashBytes(new Uint8Array(buffer));
  const existing = await db.rawAssets.where('contentHash').equals(contentHash).first();
  if (existing) {
    await persistRawAssetFileToWorkspace(existing);
    return { asset: existing, reused: true };
  }

  const workspace = await getWritableRawWorkspace();
  const sourcePath = await resolveUniqueRawAssetFilename(getFileSourcePath(file), contentHash, workspace);
  const now = Date.now();
  const id = createId('raw');
  const source = kind === 'image' ? 'image' : 'file';
  const rawEntry = await createEntry({
    content: buildRawEntryContent({
      filename: sourcePath,
      kind,
      size: file.size,
      contentHash,
      status: '待解析，原始文件已保存到 Raw Inbox。',
    }),
    source,
    processed: false,
    capturedAt: now,
    fileMetadata: {
      filename: sourcePath,
      mimeType: file.type,
      url: `raw://${id}`,
    },
  });
  const asset: RawAsset = {
    id,
    clientId: getClientId(),
    filename: sourcePath,
    mimeType: file.type,
    kind,
    size: file.size,
    contentHash,
    blob: file,
    dataBase64: bytesToBase64(new Uint8Array(buffer)),
    status: 'raw',
    entryId: rawEntry.id,
    createdAt: now,
    updatedAt: now,
  };

  await db.rawAssets.add(asset);
  try {
    await persistRawAssetFileToWorkspace(asset, workspace);
  } catch (error) {
    await db.rawAssets.delete(asset.id);
    await db.entries.delete(rawEntry.id);
    throw new Error(`原文件写入工作区失败，已停止入库：${formatErrorMessage(error)}`);
  }
  return { asset: (await db.rawAssets.get(asset.id)) ?? asset, reused: false };
}

export async function createRawAssetFromUrl(url: string): Promise<RawAssetImportResult> {
  const extraction = await extractImportUrlText(url);
  assertUsefulImportedWebText(extraction.text);
  const title = inferWebTitle(extraction.text) ?? new URL(extraction.url).hostname;
  const content = buildImportedWebContent({
    url: extraction.url,
    title,
    text: extraction.text,
  });
  const file = new File([content], buildWebImportFilename(extraction.url, title), {
    type: 'text/markdown',
    lastModified: Date.now(),
  });
  return createRawAssetFromFile(file);
}

export async function resolveUniqueRawAssetFilename(
  originalPath: string,
  contentHash: string,
  workspace?: WritableRawWorkspace | null,
): Promise<string> {
  const safePath = sanitizeRawSourceRelativePath(originalPath);
  const sameHash = await db.rawAssets.where('contentHash').equals(contentHash).first();
  if (sameHash) return sameHash.filename;
  if (!(await rawAssetFilenameExists(safePath, workspace))) return safePath;

  const dated = withFilenameSuffix(safePath, `-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`);
  if (!(await rawAssetFilenameExists(dated, workspace))) return dated;

  for (let index = 2; index <= 99; index += 1) {
    const candidate = withFilenameSuffix(dated, `-${index}`);
    if (!(await rawAssetFilenameExists(candidate, workspace))) return candidate;
  }

  return withFilenameSuffix(safePath, `-${Date.now()}`);
}

export async function persistRawAssetFileToWorkspace(asset: RawAsset, workspace?: WritableRawWorkspace | null) {
  const targetWorkspace = workspace ?? (await getWritableRawWorkspace());
  if (!targetWorkspace) return undefined;
  if (!targetWorkspace.storage.writeBinaryFile) {
    throw new Error('当前工作区存储不支持原文件写入。');
  }

  const relativePath = assertSafeWorkspaceRelativePath(sanitizeRawSourceRelativePath(asset.filename));
  const targetPath = joinWorkspacePath(targetWorkspace.rawSources, relativePath);
  const dataBase64 = asset.dataBase64 || bytesToBase64(new Uint8Array(await getUsableBlob(asset).arrayBuffer()));
  await targetWorkspace.storage.writeBinaryFile(targetPath, dataBase64);
  return targetPath;
}

export async function processNextRawAsset(
  extractor?: IngestExtractor,
  onProgress?: (progress: RawAssetCompileProgress) => void,
) {
  await resetStaleRawAssets();
  const asset = await db.rawAssets
    .where('status')
    .equals('raw')
    .or('status')
    .equals('failed')
    .first();
  if (!asset) return undefined;
  return processRawAsset(asset.id, extractor, onProgress);
}

export async function processRawAssetQueue(input: {
  owner?: string;
  extractor?: IngestExtractor;
  compileWiki?: boolean;
  wikiCompiler?: RawAssetWikiCompiler;
  onStatus?: (snapshot: RawAssetQueueSnapshot) => void;
} = {}): Promise<RawAssetQueueResult> {
  return withRawAssetQueueRunLock(input.owner ?? 'queue', () => processRawAssetQueueUnlocked(input));
}

async function withRawAssetQueueRunLock<T>(owner: string, fn: () => Promise<T>): Promise<T> {
  if (!canUseWorkspaceStorage()) return fn();
  const storage = createWorkspaceStorage();
  const root = getPersistedWorkspaceRoot() ?? (await getWorkspaceDefaultRoot());
  const initialized = await initializeWorkspace(storage, root, { outputLanguage: 'zh-CN' });

  try {
    return await withWorkspaceLock(initialized.layout.root, 'raw-asset-run', fn, {
      timeoutMs: 900,
      retryMs: 60,
      ttlMs: 120_000,
    });
  } catch (error) {
    if (formatErrorMessage(error).includes('Workspace lock "raw-asset-run" is busy')) {
      throw new Error(`${owner === 'frog' ? '桌面 Frog' : '知识库页面'}已有入库任务正在运行，请等待当前任务结束后再开始新的入库。`);
    }
    throw error;
  }
}

async function processRawAssetQueueUnlocked(input: {
  owner?: string;
  extractor?: IngestExtractor;
  compileWiki?: boolean;
  wikiCompiler?: RawAssetWikiCompiler;
  onStatus?: (snapshot: RawAssetQueueSnapshot) => void;
} = {}): Promise<RawAssetQueueResult> {
  const owner = input.owner ?? 'queue';
  const activeSnapshot = loadRawAssetQueueStatus();
  if (isRawAssetQueueRunning(activeSnapshot)) {
    throw new Error(`${activeSnapshot?.owner === 'frog' ? '桌面 Frog' : '知识库页面'}正在编译队列，请等待当前任务完成。`);
  }

  const startedAt = Date.now();
  const runId = createRawAssetQueueRunId(owner);
  const publish = (snapshot: Omit<RawAssetQueueSnapshot, 'id' | 'owner' | 'startedAt' | 'updatedAt'>) => {
    const next: RawAssetQueueSnapshot = {
      ...snapshot,
      id: runId,
      owner,
      startedAt,
      updatedAt: Date.now(),
    };
    publishRawAssetQueueStatus(next);
    input.onStatus?.(next);
  };

  const recoveredInterrupted = await reconcileInterruptedRawAssetQueueRun();
  const recoveredMissingRecords = await recoverMissingRawAssetsFromWorkspaceQueue();
  const recovered = await resetStaleRawAssets();
  const recoveredInvalidVision = await resetInvalidCompiledVisionAssets();
  const recoveredSourceOnly = await resetSourceOnlyCompiledRawAssets();
  const candidateIds = await listRunnableRawAssetIds(Boolean(input.compileWiki));
  const candidateAssets = (await db.rawAssets.bulkGet(candidateIds)).filter((asset): asset is RawAsset => Boolean(asset));
  validateRawAssetQueueModelCapabilities(candidateAssets, {
    requireWikiCompile: !input.extractor || (Boolean(input.compileWiki) && !input.wikiCompiler),
  });
  await prepareRawAssetWorkspaceQueue(candidateAssets, { owner, compileWiki: Boolean(input.compileWiki) });
  const total = candidateIds.length;
  if (total === 0) {
    publish({
      stage: 'done',
      percent: 100,
      label: '没有待编译材料',
      detail: buildRecoveredDetail(recovered, recoveredInvalidVision, recoveredInterrupted, recoveredSourceOnly, recoveredMissingRecords),
      total: 0,
      processed: 0,
      failed: 0,
      queuedAssetIds: [],
    });
    return { total: 0, processed: 0, failed: 0 };
  }

  publish({
    stage: 'running',
    percent: 1,
    label: '开始编译 Raw Inbox',
    detail: joinQueueDetails(
      `共 ${total} 个材料`,
      buildRecoveredDetail(recovered, recoveredInvalidVision, recoveredInterrupted, recoveredSourceOnly, recoveredMissingRecords),
    ),
    total,
    processed: 0,
    failed: 0,
    queuedAssetIds: candidateIds,
  });

  let processed = 0;
  let failed = 0;
  const remainingIds = new Set(candidateIds);
  for (let index = 0; index < candidateIds.length; index += 1) {
    if (await isRawAssetQueueTaskCancelled(candidateIds[index])) {
      const cancelled = await markRawAssetCancelled(candidateIds[index]);
      processed += 1;
      remainingIds.delete(candidateIds[index]);
      publish({
        stage: 'running',
        percent: Math.min(98, Math.round((processed / total) * 100)),
        label: `${cancelled?.filename ?? '原文件'} 已取消`,
        detail: `本轮已完成 ${processed} / ${total} 个 · 剩余 ${Math.max(0, total - processed)} 个`,
        currentAssetId: undefined,
        queuedAssetIds: Array.from(remainingIds),
        total,
        processed,
        failed,
      });
      continue;
    }
    await markWorkspaceQueueTaskProcessing(candidateIds[index], 'extracting');
    const abortController = createActiveRawAssetQueueAbortController(candidateIds[index]);
    let result = await processRawAsset(candidateIds[index], input.extractor, (current) => {
      const percent = Math.min(96, Math.round(((processed + current.percent / 100) / total) * 100));
      publish({
        stage: 'running',
        percent,
        label: current.label,
        detail: `本轮第 ${Math.min(processed + 1, total)} / ${total} 个 · 已完成 ${processed} 个`,
        currentAssetId: candidateIds[index],
        queuedAssetIds: Array.from(remainingIds),
        total,
        processed,
        failed,
      });
    }, { signal: abortController?.signal });
    if (!result) {
      clearActiveRawAssetQueueAbortController(candidateIds[index], abortController);
      break;
    }
    let finalResult = result;
    if (await isRawAssetQueueTaskCancelled(candidateIds[index])) {
      finalResult = (await markRawAssetCancelled(candidateIds[index])) ?? result;
    } else if (input.compileWiki && ['compiled', 'skipped', 'wiki_failed'].includes(result.status)) {
      await markWorkspaceQueueTaskProcessing(candidateIds[index], 'wiki');
      publish({
        stage: 'running',
        percent: Math.min(97, Math.round(((processed + 0.96) / total) * 100)),
        label: `生成/更新 Wiki：${result.filename}`,
        detail: '正在根据本文件影响到的知识条目生成/更新 Wiki 页面。',
        currentAssetId: candidateIds[index],
        queuedAssetIds: Array.from(remainingIds),
        total,
        processed,
        failed,
      });
      finalResult = await compileRawAssetWikiPages(result.id, input.wikiCompiler, { signal: abortController?.signal });
      if (await isRawAssetQueueTaskCancelled(candidateIds[index])) {
        finalResult = (await markRawAssetCancelled(candidateIds[index])) ?? finalResult;
      }
    }
    await markWorkspaceQueueTaskCompleted(finalResult);
    processed += 1;
    if (finalResult.status === 'failed' || finalResult.status === 'wiki_failed') failed += 1;
    result = finalResult.status === 'wiki_failed' ? ({ ...finalResult, status: 'failed' } as RawAsset) : finalResult;
    remainingIds.delete(candidateIds[index]);
    if (
      remainingIds.size > 0 &&
      (finalResult.status === 'failed' || finalResult.status === 'wiki_failed') &&
      isLikelyTransportWikiCompileError(finalResult.error)
    ) {
      publish({
        stage: 'running',
        percent: Math.min(98, Math.round((processed / total) * 100)),
        label: '模型服务冷却后继续处理队列',
        detail: `刚才的任务疑似网络、超时或限流失败，暂停 ${Math.round(rawAssetQueueFailureCooldownMs / 1000)} 秒后再处理下一个文件。`,
        currentAssetId: undefined,
        queuedAssetIds: Array.from(remainingIds),
        total,
        processed,
        failed,
      });
      await sleep(rawAssetQueueFailureCooldownMs, abortController?.signal).catch(() => undefined);
    }
    publish({
      stage: 'running',
      percent: Math.min(98, Math.round((processed / total) * 100)),
      label: result.status === 'failed' ? `${result.filename} 编译失败` : result.status === 'cancelled' ? `${result.filename} 已取消` : `${result.filename} 已入库`,
      detail: `本轮已完成 ${processed} / ${total} 个 · 剩余 ${Math.max(0, total - processed)} 个`,
      currentAssetId: undefined,
      queuedAssetIds: Array.from(remainingIds),
      total,
      processed,
      failed,
    });
    clearActiveRawAssetQueueAbortController(candidateIds[index], abortController);
  }

  const finalStage = failed > 0 ? 'failed' : 'done';
  publish({
    stage: finalStage,
    percent: 100,
    label: finalStage === 'failed' ? '部分材料未编译成功' : '队列编译完成',
    detail: `本轮处理 ${processed} / ${total} 个材料${failed > 0 ? `，失败 ${failed} 个` : ''}`,
    currentAssetId: undefined,
    queuedAssetIds: [],
    total,
    processed,
    failed,
  });

  return { total, processed, failed };
}

export async function cancelRawAssetQueueTask(taskId: string): Promise<boolean> {
  const task = await getRawAssetWorkspaceQueueTask(taskId);
  if (!task) return false;
  if (task.status !== 'pending' && task.status !== 'processing') return false;

  abortActiveRawAssetQueueTask(task.rawAssetId);
  const now = Date.now();
  await db.rawAssets.update(task.rawAssetId, {
    status: 'cancelled',
    error: '用户已取消该原文件入库任务。',
    updatedAt: now,
  });
  await updateRawAssetWorkspaceQueueTaskById(taskId, (draft) => ({
    ...draft,
    status: 'cancelled',
    error: '用户已取消该原文件入库任务。',
    completedAt: now,
  }));
  return true;
}

export async function retryRawAssetQueueTask(taskId: string): Promise<boolean> {
  const task = await getRawAssetWorkspaceQueueTask(taskId);
  if (!task) return false;
  if (task.status !== 'failed' && task.status !== 'cancelled') return false;
  const asset = await db.rawAssets.get(task.rawAssetId);
  if (!asset) return false;

  const now = Date.now();
  await db.rawAssets.update(asset.id, {
    status: task.stage === 'wiki' && task.compileWiki && asset.entryId ? 'wiki_failed' : 'failed',
    error: undefined,
    updatedAt: now,
  });
  await updateRawAssetWorkspaceQueueTaskById(taskId, (draft) => ({
    ...draft,
    status: 'pending',
    stage: 'queued',
    error: undefined,
    startedAt: undefined,
    completedAt: undefined,
  }));
  return true;
}

export async function cancelActiveRawAssetQueueTasks(): Promise<number> {
  const queue = await loadRawAssetWorkspaceQueue();
  const cancellable = queue?.tasks.filter((task) => task.status === 'pending' || task.status === 'processing') ?? [];
  let cancelled = 0;
  for (const task of cancellable) {
    if (await cancelRawAssetQueueTask(task.id)) cancelled += 1;
  }
  return cancelled;
}

export async function clearTerminalRawAssetQueueTasks(): Promise<number> {
  return clearRawAssetWorkspaceQueueTasks(['done', 'cancelled']);
}

export async function processRawAsset(
  id: string,
  extractor?: IngestExtractor,
  onProgress?: (progress: RawAssetCompileProgress) => void,
  options: IngestExtractorOptions = {},
) {
  throwIfAborted(options.signal);
  const asset = await db.rawAssets.get(id);
  if (!asset || !['raw', 'failed'].includes(asset.status)) return asset;
  if (asset.ingestJobId) {
    const existingJob = await db.ingestJobs.get(asset.ingestJobId);
    if (existingJob?.status === 'processing') {
      const recoveredAt = Date.now();
      const failureMessage = buildRawAssetFailureMessage('processing');
      await db.ingestJobs.update(existingJob.id, {
        status: 'failed',
        error: failureMessage,
        updatedAt: recoveredAt,
      });
      await db.rawAssets.update(asset.id, {
        status: 'failed',
        error: failureMessage,
        updatedAt: recoveredAt,
      });
      return db.rawAssets.get(asset.id);
    }
  }

  const now = Date.now();
  await db.rawAssets.update(asset.id, {
    status: 'extracting',
    error: undefined,
    updatedAt: now,
  });
  onProgress?.({ percent: 12, label: `提取 ${asset.filename}` });

  try {
    throwIfAborted(options.signal);
    const extractedText = await extractImportBlobText(
      {
        blob: getUsableBlob(asset),
        filename: asset.filename,
        mimeType: asset.mimeType,
        kind: asset.kind as RawAssetKind,
      },
      (progress) => onProgress?.({ percent: Math.min(58, 12 + Math.round(progress.percent * 0.46)), label: progress.label }),
      { signal: options.signal },
    );
    throwIfAborted(options.signal);
    const enrichedText = await enrichExtractedTextWithMultimodalContext(asset, extractedText, getUsableBlob(asset), (progress) =>
      onProgress?.({ percent: Math.min(60, 58 + Math.round(progress * 2)), label: `理解图片 ${asset.filename}` }),
      options,
    );
    throwIfAborted(options.signal);
    const content = buildImportedContent({
      filename: asset.filename,
      kind: asset.kind,
      source: asset.kind === 'image' ? 'image' : 'file',
      text: enrichedText,
    });
    const extractedAt = Date.now();

    if (asset.entryId) {
      await updateEntry(asset.entryId, {
        content,
        source: asset.kind === 'image' ? 'image' : 'file',
        processed: false,
      });
    }

    await db.rawAssets.update(asset.id, {
      status: 'compiling',
      extractedText: enrichedText,
      updatedAt: extractedAt,
    });
    onProgress?.({ percent: 62, label: `编译 ${asset.filename}` });

    const job = await createIngestJob({
      content,
      source: asset.kind === 'image' ? 'image' : 'file',
      filename: asset.filename,
      targetEntryId: asset.entryId,
    });
    const processed = await processIngestJob(job.id, extractor ?? extractRawAssetCaptureDraft, { signal: options.signal });
    throwIfAborted(options.signal);
    const completedAt = Date.now();

    const compiledHasKnowledge = processed?.status === 'done' ? await entryHasSubstantiveDerivedKnowledge(processed.entryId) : false;
    const missingSubstantiveKnowledge = processed?.status === 'done' && !compiledHasKnowledge;
    const finalStatus =
      processed?.status === 'skipped'
        ? 'skipped'
        : processed?.status === 'done' && compiledHasKnowledge
          ? 'compiled'
          : 'failed';
    const failureMessage =
      finalStatus === 'failed'
        ? buildRawAssetFailureMessage(processed?.status, processed?.error, missingSubstantiveKnowledge)
        : undefined;
    if (processed?.status === 'processing') {
      await db.ingestJobs.update(job.id, {
        status: 'failed',
        error: failureMessage,
        updatedAt: completedAt,
      });
    }
    if (missingSubstantiveKnowledge) {
      await db.ingestCache.delete(job.contentHash);
      await db.ingestJobs.update(job.id, {
        status: 'failed',
        error: failureMessage,
        updatedAt: completedAt,
      });
      const entryId = processed?.entryId ?? asset.entryId;
      if (entryId) {
        await updateEntry(entryId, {
          processed: false,
        });
      }
    }
    await db.rawAssets.update(asset.id, {
      status: finalStatus,
      ingestJobId: job.id,
      entryId: processed?.entryId ?? asset.entryId,
      error: failureMessage,
      compiledAt: completedAt,
      updatedAt: completedAt,
    });
    if (finalStatus === 'compiled' || finalStatus === 'skipped') {
      await syncWorkspaceRecordsToDefaultWorkspace();
    }
    onProgress?.({ percent: 100, label: finalStatus === 'failed' ? `${asset.filename} 编译失败` : `${asset.filename} 已编译` });
  } catch (error) {
    if (isAbortError(error)) {
      await db.rawAssets.update(asset.id, {
        status: 'cancelled',
        error: rawAssetCancelMessage,
        updatedAt: Date.now(),
      });
      return db.rawAssets.get(asset.id);
    }
    await db.rawAssets.update(asset.id, {
      status: 'failed',
      error: formatErrorMessage(error),
      updatedAt: Date.now(),
    });
  }

  return db.rawAssets.get(asset.id);
}

export async function compileRawAssetWikiPages(
  id: string,
  wikiCompiler: RawAssetWikiCompiler = defaultRawAssetWikiCompiler,
  options: IngestExtractorOptions = {},
) {
  throwIfAborted(options.signal);
  const asset = await db.rawAssets.get(id);
  if (!asset) throw new Error('Raw asset not found.');
  if (!asset.entryId) return asset;

  const entry = await db.entries.get(asset.entryId);
  const entityIds = Array.from(new Set(entry?.derivedEntities ?? []));
  if (entityIds.length === 0) return asset;

  await db.rawAssets.update(asset.id, {
    status: 'wiki_compiling',
    error: undefined,
    updatedAt: Date.now(),
  });
  await syncWorkspaceQueueTaskWikiStage(asset.id);

  try {
    const failures: string[] = [];
    if (wikiCompiler === defaultRawAssetWikiCompiler) {
      const pendingEntityIds: string[] = [];
      const entities = (await db.entities.bulkGet(entityIds)).filter((entity): entity is Entity => Boolean(entity));
      for (const entity of entities) {
        if (!hasUsefulCompiledWikiMarkdown(entity)) pendingEntityIds.push(entity.id);
      }

      if (pendingEntityIds.length > 0) {
        const { compileRawAssetWikiPagesFromSource } = await import('./sourceWikiCompiler');
        const batchResult = await compileRawAssetWikiPagesFromSource(asset, pendingEntityIds, { signal: options.signal });
        const retryEntityIds = new Set(batchResult.missingEntityIds);
        const reviewQueuedEntityIds = new Set(batchResult.reviewQueuedEntityIds);
        const refreshedEntities = (await db.entities.bulkGet(pendingEntityIds)).filter((entity): entity is Entity => Boolean(entity));
        for (const entity of refreshedEntities) {
          if (reviewQueuedEntityIds.has(entity.id)) continue;
          if (!hasUsefulCompiledWikiMarkdown(entity)) retryEntityIds.add(entity.id);
        }

        for (const entityId of retryEntityIds) {
          throwIfAborted(options.signal);
          const entity = await db.entities.get(entityId);
          try {
            await compileRawAssetWikiEntityWithRetry(entityId, asset, defaultRawAssetWikiCompiler, options);
          } catch (error) {
            if (isAbortError(error)) throw error;
            failures.push(`${entity?.title ?? entityId}: ${formatErrorMessage(error)}`);
            if (isLikelyTransportWikiCompileError(error)) break;
            continue;
          }
          const updated = await db.entities.get(entityId);
          if (!updated || (!hasUsefulCompiledWikiMarkdown(updated) && !(await hasPendingWikiReviewForEntity(entityId)))) {
            failures.push(`${updated?.title ?? entity?.title ?? entityId}: Wiki generation returned incomplete content`);
          }
        }
      }
    } else {
      for (const entityId of entityIds) {
        throwIfAborted(options.signal);
        const entity = await db.entities.get(entityId);
        if (entity && hasUsefulCompiledWikiMarkdown(entity)) continue;

        try {
          await compileRawAssetWikiEntityWithRetry(entityId, asset, wikiCompiler, options);
          const updated = await db.entities.get(entityId);
          if (!updated || !hasUsefulCompiledWikiMarkdown(updated)) {
            failures.push(`${updated?.title ?? entity?.title ?? entityId}: Wiki generation returned incomplete content`);
          }
        } catch (error) {
          if (isAbortError(error)) throw error;
          failures.push(`${entity?.title ?? entityId}: ${formatErrorMessage(error)}`);
          if (isLikelyTransportWikiCompileError(error)) break;
        }
      }
    }
    throwIfAborted(options.signal);
    if (failures.length > 0) {
      throw new Error(failures.slice(0, 3).join('；'));
    }
    await db.rawAssets.update(asset.id, {
      status: 'compiled',
      error: undefined,
      compiledAt: Date.now(),
      updatedAt: Date.now(),
    });
    await syncWorkspaceRecordsToDefaultWorkspace();
  } catch (error) {
    if (isAbortError(error)) {
      await db.rawAssets.update(asset.id, {
        status: 'cancelled',
        error: rawAssetCancelMessage,
        updatedAt: Date.now(),
      });
      return (await db.rawAssets.get(asset.id)) ?? asset;
    }
    await db.rawAssets.update(asset.id, {
      status: 'wiki_failed',
      error: `Wiki generation failed: ${formatErrorMessage(error)}`,
      updatedAt: Date.now(),
    });
  }

  return (await db.rawAssets.get(asset.id)) ?? asset;
}

async function compileRawAssetWikiEntityWithRetry(
  entityId: string,
  asset: RawAsset,
  wikiCompiler: RawAssetWikiCompiler,
  options: IngestExtractorOptions,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= rawAssetWikiEntityRetryLimit; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      await wikiCompiler(entityId, asset, { signal: options.signal });
      return;
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
      if (attempt >= rawAssetWikiEntityRetryLimit || !isRetryableWikiCompileError(error)) break;
      await sleep(rawAssetWikiEntityRetryBaseDelayMs * attempt, options.signal);
    }
  }
  throw lastError;
}

function hasUsefulCompiledWikiMarkdown(entity: Entity) {
  const markdown = entity.wikiMarkdown?.trim() ?? '';
  if (!entity.wikiCompiledAt || markdown.length < minUsefulWikiMarkdownLength) return false;
  if (!markdown.startsWith('---') || !/^#\s+/m.test(markdown)) return false;
  const sectionCount = markdown.match(/^##\s+/gm)?.length ?? 0;
  return sectionCount >= 3;
}

async function hasPendingWikiReviewForEntity(entityId: string) {
  const count = await db.wikiReviewItems
    .where('entityId')
    .equals(entityId)
    .filter((review) => review.status === 'pending')
    .count();
  return count > 0;
}

function isRetryableWikiCompileError(error: unknown) {
  const message = formatErrorMessage(error).toLowerCase();
  return /429|rate limit|too many requests|timeout|timed out|temporar|try again|fetch failed|network|error sending request|502|503|504|valid file block|did not return/.test(
    message,
  );
}

function isLikelyTransportWikiCompileError(error: unknown) {
  const message = formatErrorMessage(error).toLowerCase();
  return /fetch failed|network|error sending request|timeout|timed out|502|503|504/.test(message);
}

async function entryHasSubstantiveDerivedKnowledge(entryId?: string) {
  if (!entryId) return false;
  const entry = await db.entries.get(entryId);
  const entityIds = Array.from(new Set(entry?.derivedEntities ?? []));
  if (entityIds.length === 0) return false;
  const entities = (await db.entities.bulkGet(entityIds)).filter((entity): entity is Entity => Boolean(entity));
  return entities.some((entity) => !isSourceOnlyEntity(entity));
}

function isSourceOnlyEntity(entity: Pick<Entity, 'tags' | 'wikiMarkdown'>) {
  if (/^---[\s\S]*?\btype:\s*["']?source["']?\b/im.test(entity.wikiMarkdown ?? '')) return true;
  return entity.tags.some((tag) => {
    const normalized = tag.trim().toLowerCase();
    return (
      normalized === 'source' ||
      normalized === '来源' ||
      normalized === '源文件' ||
      normalized === '导入材料' ||
      normalized === '来源文档' ||
      normalized === 'source document'
    );
  });
}

async function defaultRawAssetWikiCompiler(entityId: string, _asset: RawAsset, options: IngestExtractorOptions = {}) {
  const { recompileBrowserEntityWikiPage } = await import('@/lib/wiki/browserRecompile');
  await recompileBrowserEntityWikiPage(entityId, { signal: options.signal });
}

async function enrichExtractedTextWithMultimodalContext(
  asset: RawAsset,
  extractedText: string,
  blob: Blob,
  onProgress?: (progress: number) => void,
  options: IngestExtractorOptions = {},
) {
  throwIfAborted(options.signal);
  const settings = loadMultimodalSettings();
  if (!settings.enabled || !settings.captionStandaloneImages) return extractedText;

  if (asset.kind !== 'image') {
    return enrichDocumentTextWithEmbeddedImages(asset, extractedText, blob, onProgress, options);
  }

  if (!asset.dataBase64) return extractedText;
  onProgress?.(0.2);
  let ocrText: string | undefined;
  try {
    ocrText = settings.includeOcrText
      ? extractedText.trim() ||
        (await ocrImageForWiki(
          {
            imageBase64: asset.dataBase64,
            mimeType: asset.mimeType || 'image/png',
            filename: asset.filename,
            contentHash: asset.contentHash,
          },
          { signal: options.signal },
        ))
      : undefined;
    const caption = await captionImageForWiki({
      imageBase64: asset.dataBase64,
      mimeType: asset.mimeType || 'image/png',
      filename: asset.filename,
      contentHash: asset.contentHash,
      ocrText,
    }, { signal: options.signal });
    onProgress?.(1);
    if (!caption) return extractedText;
    return buildImageKnowledgeMarkdown({
      filename: asset.filename,
      caption,
      ocrText,
      rawUrl: `raw://${asset.id}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '图片视觉描述失败';
    if (settings.enabled && settings.captionStandaloneImages) {
      throw new Error(`图片/多模态模型没有返回有效描述：${message}`);
    }
    return buildImageKnowledgeMarkdown({
      filename: asset.filename,
      ocrText,
      rawUrl: `raw://${asset.id}`,
    });
  }
}

async function enrichDocumentTextWithEmbeddedImages(
  asset: RawAsset,
  extractedText: string,
  blob: Blob,
  onProgress?: (progress: number) => void,
  options: IngestExtractorOptions = {},
) {
  throwIfAborted(options.signal);
  if (!['word', 'pdf', 'presentation'].includes(asset.kind)) return extractedText;
  const settings = loadMultimodalSettings();
  const includePdfPageScreenshots = asset.kind === 'pdf' && shouldCapturePdfPageScreenshots(extractedText);
  if (
    asset.kind === 'pdf' &&
    !includePdfPageScreenshots &&
    inferPdfPageCount(extractedText) > LONG_TEXT_PDF_IMAGE_ENRICHMENT_PAGE_LIMIT
  ) {
    return extractedText;
  }
  let images: ExtractedImportImage[] = [];
  try {
    images = await extractImportBlobImages(
      {
        blob,
        filename: asset.filename,
        mimeType: asset.mimeType,
        kind: asset.kind as RawAssetKind,
      },
      {
        includePdfPageScreenshots,
        maxImages: 8,
        maxPdfPages: 4,
        signal: options.signal,
      },
    );
  } catch {
    images = [];
  }

  if (images.length === 0) return extractedText;

  const sections: string[] = [];
  for (let index = 0; index < images.length; index += 1) {
    throwIfAborted(options.signal);
    const image = images[index];
    onProgress?.((index + 0.2) / Math.max(images.length, 1));
    const ocrText = settings.includeOcrText ? await ocrImageForWiki(image, { signal: options.signal }) : '';
    let caption = '';
    try {
      caption =
        (await captionImageForWiki({
          imageBase64: image.imageBase64,
          mimeType: image.mimeType,
          filename: image.filename,
          contentHash: image.contentHash,
          ocrText,
        }, { signal: options.signal })) ?? '';
    } catch (error) {
      caption = `图片描述生成失败：${error instanceof Error ? error.message : '未知错误'}`;
    }
    throwIfAborted(options.signal);
    sections.push(buildEmbeddedImageMarkdown(asset, image, caption, ocrText));
  }
  onProgress?.(1);

  return [extractedText.trim(), '## 文档内嵌图片描述', ...sections].filter(Boolean).join('\n\n');
}

function buildEmbeddedImageMarkdown(asset: RawAsset, image: ExtractedImportImage, caption: string, ocrText?: string) {
  const title = image.pageNumber
    ? `${image.filename}（第 ${image.pageNumber} 页）`
    : image.filename;
  const rawUrl = `raw://${asset.id}#image=${image.contentHash}`;
  return [
    `### ${title}`,
    '',
    `![${sanitizeMarkdownAlt(caption || title)}](${rawUrl})`,
    '',
    `图片来源：${embeddedImageOriginLabel(image.origin)}`,
    `图片指纹：${image.contentHash}`,
    caption ? `视觉描述：${caption.trim()}` : '',
    ocrText?.trim() ? `OCR 文本：\n${ocrText.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function embeddedImageOriginLabel(origin: ExtractedImportImage['origin']) {
  return {
    standalone: '独立图片',
    docx: 'Word 内嵌图片',
    pptx: 'PPT 内嵌图片',
    'pdf-image': 'PDF 内嵌图片',
    'pdf-page': 'PDF 页面截图',
  }[origin];
}

export function shouldCapturePdfPageScreenshots(extractedText: string) {
  const trimmed = extractedText.trim();
  if (trimmed.length < 80) return true;

  const semanticText = trimmed
    .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ')
    .replace(/\b\d+\s*\/\s*\d+\b/g, ' ')
    .replace(/第\s*\d+\s*页(?:\s*共\s*\d+\s*页)?/g, ' ')
    .replace(/\s+/g, '');

  return semanticText.length < 80;
}

function inferPdfPageCount(extractedText: string) {
  const counts = [...extractedText.matchAll(/--\s*\d+\s+of\s+(\d+)\s*--/gi)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  return counts.length ? Math.max(...counts) : 0;
}

function sanitizeMarkdownAlt(value: string) {
  return value.replace(/[\r\n]+/g, ' ').replace(/]/g, ')').trim().slice(0, 160);
}

export async function resetStaleRawAssets(now = Date.now(), staleMs = RAW_ASSET_STALE_MS) {
  const staleBefore = now - staleMs;
  const staleAssets = await db.rawAssets
    .where('status')
    .anyOf(['extracting', 'compiling', 'wiki_compiling'])
    .filter((asset) => asset.updatedAt < staleBefore)
    .toArray();

  await Promise.all(
    staleAssets.map((asset) =>
      db.rawAssets.update(asset.id, {
        status: asset.status === 'wiki_compiling' ? 'wiki_failed' : 'failed',
        error: '上次编译未正常结束，已恢复为可重试状态。',
        updatedAt: now,
      }),
    ),
  );

  return staleAssets.length;
}

export async function resetInvalidCompiledVisionAssets(now = Date.now()) {
  const candidates = await db.rawAssets
    .where('status')
    .equals('compiled')
    .filter((asset) => asset.kind === 'image' && Boolean(asset.entryId))
    .toArray();
  let recovered = 0;

  for (const asset of candidates) {
    const entry = asset.entryId ? await db.entries.get(asset.entryId) : undefined;
    const text = [asset.extractedText, entry?.content].filter(Boolean).join('\n');
    if (!isInvalidVisionContent(text)) continue;
    await markDerivedEntitiesSuperseded(entry?.derivedEntities ?? [], {
      reason: 'invalid-vision-compile',
      source: asset.filename,
      now,
    });
    await db.rawAssets.update(asset.id, {
      status: 'failed',
      error: '旧版本图片视觉描述疑似无效，已恢复为可重试状态。请配置支持 Vision 的模型后重新编译。',
      updatedAt: now,
    });
    if (entry) {
      await updateEntry(entry.id, { processed: false });
    }
    recovered += 1;
  }

  return recovered;
}

export async function resetSourceOnlyCompiledRawAssets(now = Date.now()) {
  const candidates = await db.rawAssets
    .where('status')
    .equals('compiled')
    .filter((asset) => Boolean(asset.entryId))
    .toArray();
  let recovered = 0;

  for (const asset of candidates) {
    if (await entryHasSubstantiveDerivedKnowledge(asset.entryId)) continue;
    const entry = asset.entryId ? await db.entries.get(asset.entryId) : undefined;
    await markDerivedEntitiesSuperseded(entry?.derivedEntities ?? [], {
      reason: 'source-only-compile',
      source: asset.filename,
      now,
    });
    await db.rawAssets.update(asset.id, {
      status: 'failed',
      error: buildRawAssetFailureMessage('done', undefined, true),
      updatedAt: now,
    });
    if (asset.entryId) {
      await updateEntry(asset.entryId, { processed: false });
    }
    recovered += 1;
  }

  return recovered;
}

async function markDerivedEntitiesSuperseded(
  entityIds: string[],
  input: { reason: string; source: string; now: number },
) {
  const entities = (await db.entities.bulkGet(Array.from(new Set(entityIds)))).filter((entity): entity is Entity => Boolean(entity));
  await Promise.all(
    entities.map((entity) => {
      const wikiMarkdown = entity.wikiMarkdown?.trim();
      if (!wikiMarkdown || /<!--\s*mywiki:superseded\b/i.test(wikiMarkdown)) return Promise.resolve();
      return db.entities.update(entity.id, {
        wikiMarkdown: buildSupersededBlock(wikiMarkdown, {
          reason: input.reason,
          supersededAt: input.now,
          source: input.source,
        }),
        updatedAt: input.now,
      });
    }),
  );
}

export async function reconcileInterruptedRawAssetQueueRun(now = Date.now()) {
  if (isRawAssetQueueRunning()) return 0;

  const queue = await loadRawAssetWorkspaceQueue();
  const processingTasks = queue?.tasks.filter((task) => task.status === 'processing') ?? [];
  if (processingTasks.length === 0) return 0;

  let recovered = 0;
  for (const task of processingTasks) {
    const asset = await db.rawAssets.get(task.rawAssetId);
    if (!asset) {
      await updateRawAssetWorkspaceQueueTask(task.rawAssetId, (draft) => ({
        ...draft,
        status: 'failed',
        error: 'Raw asset record is missing.',
        completedAt: now,
      }));
      continue;
    }

    if (asset.status === 'compiled' || asset.status === 'skipped') {
      await markWorkspaceQueueTaskCompleted(asset);
      continue;
    }

    if (asset.status === 'wiki_failed' || asset.status === 'failed' || asset.status === 'raw' || asset.status === 'cancelled') {
      await updateRawAssetWorkspaceQueueTask(asset.id, (draft) => ({
        ...draft,
        status: asset.status === 'raw' ? 'pending' : asset.status === 'cancelled' ? 'cancelled' : 'failed',
        stage: asset.status === 'wiki_failed' ? 'wiki' : draft.stage,
        error: asset.error,
        completedAt: asset.status === 'raw' ? undefined : now,
      }));
      continue;
    }

    if (asset.status !== 'extracting' && asset.status !== 'compiling' && asset.status !== 'wiki_compiling') continue;

    const wikiStage = asset.status === 'wiki_compiling';
    await db.rawAssets.update(asset.id, {
      status: wikiStage ? 'wiki_failed' : 'failed',
      error: '页面刷新、浏览器关闭或运行上下文中断，已恢复为可重试状态。',
      updatedAt: now,
    });
    const updated = (await db.rawAssets.get(asset.id)) ?? asset;
    await markWorkspaceQueueTaskCompleted(updated);
    recovered += 1;
  }

  return recovered;
}

async function recoverMissingRawAssetsFromWorkspaceQueue(now = Date.now()) {
  if (!canUseWorkspaceStorage()) return 0;
  const queue = await loadRawAssetWorkspaceQueue();
  if (!queue) return 0;

  const storage = createWorkspaceStorage();
  let recovered = 0;
  for (const task of queue.tasks) {
    if (task.status === 'done' || task.status === 'cancelled') continue;
    if (await db.rawAssets.get(task.rawAssetId)) continue;

    const restored = await rebuildRawAssetFromWorkspaceQueueTask(storage, queue.root, task, now);
    if (restored) recovered += 1;
  }
  return recovered;
}

async function rebuildRawAssetFromWorkspaceQueueTask(
  storage: WorkspaceFileStorageAdapter,
  root: string,
  task: RawAssetWorkspaceQueueTask,
  now: number,
) {
  try {
    const source = await readRawAssetQueueSourceFile(storage, root, task);
    if (!source) {
      await updateRawAssetWorkspaceQueueTask(task.rawAssetId, (draft) => ({
        ...draft,
        status: 'failed',
        error: 'Raw asset record is missing and the workspace source file was not found.',
        completedAt: now,
      }));
      return false;
    }

    const filename = sanitizeRawSourceRelativePath(task.filename);
    const mimeType = inferMimeTypeFromFilename(filename);
    const kind = getImportFileKind(filename, mimeType) ?? 'text';
    const contentHash = task.contentHash || (await hashBytes(source.bytes));
    const rawEntry = await createEntry({
      content: buildRawEntryContent({
        filename,
        kind,
        size: source.size,
        contentHash,
        status: '已从工作区源文件恢复，等待重新结构化入库。',
      }),
      source: kind === 'image' ? 'image' : 'file',
      processed: false,
      capturedAt: now,
      fileMetadata: {
        filename,
        mimeType,
        url: `raw://${task.rawAssetId}`,
      },
    });
    const asset: RawAsset = {
      id: task.rawAssetId,
      clientId: getClientId(),
      filename,
      mimeType,
      kind,
      size: source.size,
      contentHash,
      blob: new Blob([bytesToArrayBuffer(source.bytes)], { type: mimeType }),
      dataBase64: bytesToBase64(source.bytes),
      status: 'failed',
      error: 'Raw asset record was rebuilt from the workspace source file and is ready to retry.',
      entryId: rawEntry.id,
      createdAt: task.addedAt || now,
      updatedAt: now,
    };

    await db.rawAssets.put(asset);
    await updateRawAssetWorkspaceQueueTask(task.rawAssetId, (draft) => ({
      ...draft,
      filename,
      sourcePath: joinWorkspacePath('raw/sources', filename),
      contentHash,
      status: 'pending',
      stage: 'queued',
      completedAt: undefined,
      error: undefined,
    }));
    return true;
  } catch (error) {
    await updateRawAssetWorkspaceQueueTask(task.rawAssetId, (draft) => ({
      ...draft,
      status: 'failed',
      error: `Failed to rebuild missing raw asset record: ${formatErrorMessage(error)}`,
      completedAt: now,
    }));
    return false;
  }
}

async function readRawAssetQueueSourceFile(
  storage: WorkspaceFileStorageAdapter,
  root: string,
  task: RawAssetWorkspaceQueueTask,
): Promise<{ bytes: Uint8Array; size: number } | null> {
  for (const path of rawAssetQueueSourceCandidates(root, task)) {
    if (!(await storage.exists(path).catch(() => false))) continue;
    if (storage.readBinaryFileBase64) {
      const file = await storage.readBinaryFileBase64(path);
      const bytes = base64ToBytes(file.dataBase64);
      return { bytes, size: Number.isFinite(file.size) ? file.size : bytes.byteLength };
    }
    const text = await storage.readTextFile(path);
    const bytes = new TextEncoder().encode(text);
    return { bytes, size: bytes.byteLength };
  }
  return null;
}

function rawAssetQueueSourceCandidates(root: string, task: RawAssetWorkspaceQueueTask) {
  return Array.from(
    new Set(
      [task.sourcePath, joinWorkspacePath('raw/sources', task.filename)]
        .filter(Boolean)
        .map((path) => (isAbsoluteWorkspacePathLike(path) ? path : joinWorkspacePath(root, path))),
    ),
  );
}

function isAbsoluteWorkspacePathLike(path: string) {
  return /^[A-Za-z]:\//.test(path.replace(/\\/g, '/')) || path.startsWith('/');
}

function inferMimeTypeFromFilename(filename: string) {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  return (
    {
      md: 'text/markdown',
      markdown: 'text/markdown',
      txt: 'text/plain',
      csv: 'text/csv',
      tsv: 'text/tab-separated-values',
      html: 'text/html',
      htm: 'text/html',
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
    } satisfies Record<string, string>
  )[extension] ?? '';
}

export async function listRecentRawAssets(limit = 12) {
  return db.rawAssets.orderBy('createdAt').reverse().limit(limit).toArray();
}

export function validateRawAssetQueueModelCapabilities(
  assets: RawAsset[],
  input: { requireWikiCompile: boolean },
) {
  const settings = loadProviderSettings();
  const errors: string[] = [];

  if (input.requireWikiCompile) {
    const wikiResolution = resolveProviderConfigForRole(settings, 'wiki-compile');
    if (wikiResolution.error) errors.push(wikiResolution.error);
    else if (!wikiResolution.config) errors.push('请先在设置里启用默认 LLM，或为“Wiki 编译模型”选择支持文本能力的模型。');
  }

  const multimodalSettings = loadMultimodalSettings();
  const needsVision = multimodalSettings.enabled && multimodalSettings.captionStandaloneImages && assets.some(shouldPreflightVisionForAsset);
  if (needsVision) {
    const visionResolution = resolveProviderConfigForRole(settings, 'vision');
    if (visionResolution.error) errors.push(visionResolution.error);
    else if (!visionResolution.config) errors.push('图片/多模态导入需要“图片/多模态模型”，请在设置里选择支持 Vision 的模型。');
  }

  if (errors.length > 0) {
    throw new Error(`模型能力检查失败：${Array.from(new Set(errors)).join(' ')}`);
  }
}

async function listRunnableRawAssetIds(includeWikiFailed = false) {
  const statuses = includeWikiFailed ? ['raw', 'failed', 'wiki_failed', 'compiled', 'skipped'] : ['raw', 'failed'];
  const assets = await db.rawAssets.where('status').anyOf(statuses).toArray();
  const sorted = assets.sort(compareRawAssetsForQueue);
  if (!includeWikiFailed) return sorted.map((asset) => asset.id);

  const runnable: string[] = [];
  for (const asset of sorted) {
    if (asset.status === 'compiled' || asset.status === 'skipped') {
      if (await rawAssetNeedsWikiCompile(asset)) runnable.push(asset.id);
      continue;
    }
    runnable.push(asset.id);
  }
  return runnable;
}

function compareRawAssetsForQueue(left: RawAsset, right: RawAsset) {
  return left.createdAt - right.createdAt || left.filename.localeCompare(right.filename, 'zh-Hans-CN') || left.id.localeCompare(right.id);
}

function shouldPreflightVisionForAsset(asset: RawAsset) {
  return asset.kind === 'image';
}

async function rawAssetNeedsWikiCompile(asset: RawAsset) {
  if (!asset.entryId) return false;
  const entry = await db.entries.get(asset.entryId);
  const entityIds = Array.from(new Set(entry?.derivedEntities ?? []));
  if (!entityIds.length) return false;
  const entities = (await db.entities.bulkGet(entityIds)).filter((entity): entity is Entity => Boolean(entity));
  return entities.some((entity) => !hasUsefulCompiledWikiMarkdown(entity));
}

async function markWorkspaceQueueTaskProcessing(rawAssetId: string, stage: RawAssetWorkspaceQueueTaskStage) {
  await updateRawAssetWorkspaceQueueTask(rawAssetId, (task) => ({
    ...task,
    status: 'processing',
    stage,
    startedAt: task.startedAt ?? Date.now(),
    completedAt: undefined,
    error: undefined,
  }));
}

async function syncWorkspaceQueueTaskWikiStage(rawAssetId: string) {
  await updateRawAssetWorkspaceQueueTask(rawAssetId, (task) => {
    if (task.status !== 'processing' || !task.compileWiki) return task;
    return {
      ...task,
      stage: 'wiki',
      error: undefined,
    };
  });
}

async function markWorkspaceQueueTaskCompleted(asset: RawAsset) {
  const done = asset.status === 'compiled' || asset.status === 'skipped';
  const cancelled = asset.status === 'cancelled';
  const failed = !done && !cancelled;
  await updateRawAssetWorkspaceQueueTask(asset.id, (task) => ({
    ...task,
    status: cancelled ? 'cancelled' : done ? 'done' : 'failed',
    stage: asset.status === 'wiki_failed' || asset.status === 'wiki_compiling' ? 'wiki' : task.stage,
    retryCount: failed ? task.retryCount + 1 : task.retryCount,
    completedAt: Date.now(),
    error: failed || cancelled ? asset.error || 'Raw asset processing did not complete.' : undefined,
  }));
}

async function isRawAssetQueueTaskCancelled(rawAssetId: string) {
  const queue = await loadRawAssetWorkspaceQueue();
  return Boolean(queue?.tasks.some((task) => task.rawAssetId === rawAssetId && task.status === 'cancelled'));
}

async function markRawAssetCancelled(rawAssetId: string) {
  const asset = await db.rawAssets.get(rawAssetId);
  if (!asset) return null;
  const now = Date.now();
  await db.rawAssets.update(asset.id, {
    status: 'cancelled',
    error: '用户已取消该原文件入库任务。',
    updatedAt: now,
  });
  const updated = (await db.rawAssets.get(asset.id)) ?? ({ ...asset, status: 'cancelled', updatedAt: now } as RawAsset);
  await markWorkspaceQueueTaskCompleted(updated);
  return updated;
}

function createActiveRawAssetQueueAbortController(rawAssetId: string) {
  if (typeof AbortController === 'undefined') return undefined;
  const controller = new AbortController();
  activeRawAssetQueueAbort = { rawAssetId, controller };
  return controller;
}

function clearActiveRawAssetQueueAbortController(rawAssetId: string, controller?: AbortController) {
  if (!controller) return;
  if (activeRawAssetQueueAbort?.rawAssetId === rawAssetId && activeRawAssetQueueAbort.controller === controller) {
    activeRawAssetQueueAbort = null;
  }
}

function abortActiveRawAssetQueueTask(rawAssetId: string) {
  if (activeRawAssetQueueAbort?.rawAssetId !== rawAssetId) return;
  activeRawAssetQueueAbort.controller.abort(new DOMException(rawAssetCancelMessage, 'AbortError'));
}

function joinQueueDetails(...parts: Array<string | undefined>) {
  return parts.filter(Boolean).join('，');
}

function buildRecoveredDetail(
  staleCount: number,
  invalidVisionCount: number,
  interruptedCount = 0,
  sourceOnlyCount = 0,
  missingRecordCount = 0,
) {
  return [
    staleCount > 0 ? `已恢复 ${staleCount} 个旧任务` : '',
    invalidVisionCount > 0 ? `已恢复 ${invalidVisionCount} 个无效图片编译结果` : '',
    interruptedCount > 0 ? `已恢复 ${interruptedCount} 个中断任务` : '',
    sourceOnlyCount > 0 ? `已恢复 ${sourceOnlyCount} 个仅生成来源页的编译结果` : '',
    missingRecordCount > 0 ? `已从工作区源文件恢复 ${missingRecordCount} 个丢失的入库记录` : '',
  ]
    .filter(Boolean)
    .join('，') || undefined;
}

function isInvalidVisionContent(value: string) {
  return (
    isVisionRefusalCaption(value) ||
    /视觉描述待重试|多模态视觉描述暂未生成|图片\/多模态模型(?:本次)?(?:没有返回有效描述|服务繁忙或限流)|模型限流|访问量过大|稍后重试/i.test(value)
  );
}

export function buildCaptureInputExcerpt(content: string, maxChars = 32000) {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) return trimmed;

  const headerBudget = Math.round(maxChars * 0.36);
  const priorityBudget = Math.round(maxChars * 0.34);
  const tailBudget = maxChars - headerBudget - priorityBudget;
  const priorityLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /(摘要|结论|总结|建议|问题|风险|任务|行动|计划|路线|优先级|目标|项目|下一阶段|待办|TODO|todo)/i.test(line))
    .join('\n')
    .slice(0, priorityBudget);

  return [
    '以下为原始材料摘录。原文较长，已保留开头、关键行和结尾；完整原文仍会写入 Wiki 原始材料。',
    '',
    '--- 开头 ---',
    trimmed.slice(0, headerBudget),
    priorityLines ? '\n--- 关键行 ---' : '',
    priorityLines,
    '\n--- 结尾 ---',
    trimmed.slice(-tailBudget),
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, maxChars + 220);
}

async function extractRawAssetCaptureDraft(content: string, options: IngestExtractorOptions = {}) {
  const result = await extractCaptureDraft(content, { signal: options.signal });
  if (result.fallbackFrom) {
    throw new Error(`Wiki compile did not return a normal structured result: ${result.fallbackFrom}`);
  }
  return { draft: result.draft };
}

async function hashBytes(bytes: Uint8Array) {
  if (!globalThis.crypto?.subtle) {
    return `fnv1a-${fnv1a(bytes)}`;
  }
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fnv1a(bytes: Uint8Array) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function getUsableBlob(asset: RawAsset) {
  if (asset.blob && typeof asset.blob.arrayBuffer === 'function' && asset.blob.size > 0) {
    return asset.blob;
  }

  if (asset.dataBase64) {
    return new Blob([base64ToBytes(asset.dataBase64)], {
      type: asset.mimeType,
    });
  }

  return asset.blob;
}

function buildRawAssetFailureMessage(status?: string, error?: string, emptyKnowledge = false) {
  if (error) return error;
  if (emptyKnowledge) {
    return '原文件已经解析，但结构化入库只生成了来源页，没有生成实际知识页。请重试，或检查 Wiki 编译模型是否提取了文档中的项目、概念、指标或任务。';
  }
  if (status === 'pending') {
    return '摄入任务暂未完成，已恢复为可重试状态。';
  }
  if (status === 'processing') {
    return '检测到同一内容的旧结构化任务仍停留在处理中，已恢复为可重试失败状态。请重新入库或点击重试。';
  }
  if (!status) {
    return '未找到对应的摄入任务，请重新编译。';
  }
  return '编译失败，请重新尝试。';
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function bytesToArrayBuffer(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function getWritableRawWorkspace(): Promise<WritableRawWorkspace | null> {
  if (!canUseWorkspaceStorage()) return null;
  const storage = createWorkspaceStorage();
  if (!storage.writeBinaryFile) throw new Error('当前工作区存储不支持原文件写入。');
  const root = getPersistedWorkspaceRoot() ?? (await getWorkspaceDefaultRoot());
  const initialized = await initializeWorkspace(storage, root, { outputLanguage: 'zh-CN' });
  return {
    storage,
    rawSources: initialized.layout.rawSources,
  };
}

async function rawAssetFilenameExists(relativePath: string, workspace?: WritableRawWorkspace | null) {
  const normalized = sanitizeRawSourceRelativePath(relativePath);
  const existing = await db.rawAssets.where('filename').equals(normalized).first();
  if (existing) return true;
  if (!workspace) return false;
  return workspace.storage.exists(joinWorkspacePath(workspace.rawSources, normalized)).catch(() => false);
}

function sanitizeRawSourceRelativePath(value: string) {
  const normalized = value.replace(/\\/g, '/').trim();
  const parts = normalized
    .split('/')
    .map((part) => sanitizeRawSourceSegment(part))
    .filter(Boolean);
  return parts.join('/') || 'unknown';
}

function sanitizeRawSourceSegment(value: string) {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+$/g, '')
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 120);
}

function withFilenameSuffix(relativePath: string, suffix: string) {
  const slash = relativePath.lastIndexOf('/');
  const directory = slash >= 0 ? `${relativePath.slice(0, slash + 1)}` : '';
  const filename = slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return `${directory}${filename}${suffix}`;
  return `${directory}${filename.slice(0, dot)}${suffix}${filename.slice(dot)}`;
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'unknown error');
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timeout = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function buildRawEntryContent(input: {
  filename: string;
  kind: RawAssetKind;
  size: number;
  contentHash: string;
  status: string;
}) {
  return [
    `# 原始文件：${input.filename}`,
    '',
    `来源格式：${rawKindLabels[input.kind]}`,
    `文件大小：${input.size} bytes`,
    `内容指纹：${input.contentHash}`,
    `采集状态：${input.status}`,
    '',
    '这条记录用于保证文件采集先成功。解析和结构化编译会异步补充完整正文、实体、关系和任务。',
  ].join('\n');
}

function buildImportedWebContent(input: { url: string; title: string; text: string }) {
  return [
    `# 导入网页：${input.title}`,
    '',
    `来源 URL：${input.url}`,
    '来源格式：网页 URL',
    '',
    input.text.trim(),
  ].join('\n');
}

function inferWebTitle(markdown: string) {
  const heading = markdown.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim();
  if (heading) return heading.replace(/\s+/g, ' ').slice(0, 80);
  const firstLine = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^来源\s*URL/i.test(line));
  return firstLine ? firstLine.replace(/^#+\s*/, '').replace(/\s+/g, ' ').slice(0, 80) : undefined;
}

function assertUsefulImportedWebText(markdown: string) {
  const normalized = markdown.replace(/\s+/g, ' ').trim();
  if (
    normalized.length < 80 ||
    /(环境异常|完成验证|去验证|访问验证|安全验证|验证码|滑块验证|captcha|verify you are human|server error|521)/i.test(normalized)
  ) {
    throw new Error('网页正文没有被正常提取，可能被站点验证、登录或反爬机制拦截。');
  }
}

function getFileSourcePath(file: File) {
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath?.trim();
  return relativePath || file.name;
}

const rawKindLabels: Record<RawAssetKind, string> = {
  text: '文本',
  word: 'Word',
  pdf: 'PDF',
  image: '图片',
  spreadsheet: '表格',
  html: '网页 HTML',
  presentation: '演示文稿',
  archive: '压缩包',
};
