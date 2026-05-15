import { db } from '@/lib/db/schema';
import { createEntry, createId, getClientId, updateEntry } from '@/lib/db';
import { extractCaptureDraft } from '@/lib/ai/captureClient';
import {
  buildImportedContent,
  extractImportBlobImages,
  extractImportBlobText,
  getImportFileKind,
  type ExtractedImportImage,
} from '@/lib/import/fileText';
import { createIngestJob, processIngestJob, type IngestExtractor } from '@/lib/ingest';
import { loadMultimodalSettings } from '@/lib/multimodal/settings';
import {
  buildImageKnowledgeMarkdown,
  captionImageForWiki,
  isVisionRefusalCaption,
  ocrImageForWiki,
} from '@/lib/multimodal/visionCaption';
import { syncIndexedDbKnowledgeToDefaultWorkspace } from '@/lib/workspace';
import type { RawAsset, RawAssetKind } from '@/types';
import {
  createRawAssetQueueRunId,
  isRawAssetQueueRunning,
  loadRawAssetQueueStatus,
  publishRawAssetQueueStatus,
  type RawAssetQueueSnapshot,
} from './queueStatus';

export type RawAssetImportResult = {
  asset: RawAsset;
  reused: boolean;
};

export type RawAssetCompileProgress = {
  percent: number;
  label: string;
};

export const RAW_ASSET_STALE_MS = 15 * 60 * 1000;

export type RawAssetQueueResult = {
  total: number;
  processed: number;
  failed: number;
};

export async function createRawAssetFromFile(file: File): Promise<RawAssetImportResult> {
  const kind = getImportFileKind(file.name, file.type);
  if (!kind) {
    throw new Error(`${file.name} 的格式暂不支持。`);
  }

  const sourcePath = getFileSourcePath(file);
  const buffer = await file.arrayBuffer();
  const contentHash = await hashBytes(new Uint8Array(buffer));
  const existing = await db.rawAssets.where('contentHash').equals(contentHash).first();
  if (existing) {
    return { asset: existing, reused: true };
  }

  const now = Date.now();
  const id = createId('raw');
  const source = kind === 'image' ? 'image' : 'file';
  const rawEntry = await createEntry({
    content: buildRawEntryContent({
      filename: file.name,
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
  return { asset, reused: false };
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

  const recovered = await resetStaleRawAssets();
  const recoveredInvalidVision = await resetInvalidCompiledVisionAssets();
  const candidateIds = await listRunnableRawAssetIds();
  const total = candidateIds.length;
  if (total === 0) {
    publish({
      stage: 'done',
      percent: 100,
      label: '没有待编译材料',
      detail: buildRecoveredDetail(recovered, recoveredInvalidVision),
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
    detail: [`共 ${total} 个材料`, buildRecoveredDetail(recovered, recoveredInvalidVision)].filter(Boolean).join('，'),
    total,
    processed: 0,
    failed: 0,
    queuedAssetIds: candidateIds,
  });

  let processed = 0;
  let failed = 0;
  const remainingIds = new Set(candidateIds);
  for (let index = 0; index < candidateIds.length; index += 1) {
    const result = await processRawAsset(candidateIds[index], input.extractor, (current) => {
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
    });
    if (!result) break;
    processed += 1;
    if (result.status === 'failed') failed += 1;
    remainingIds.delete(candidateIds[index]);
    publish({
      stage: 'running',
      percent: Math.min(98, Math.round((processed / total) * 100)),
      label: result.status === 'failed' ? `${result.filename} 编译失败` : `${result.filename} 已入库`,
      detail: `本轮已完成 ${processed} / ${total} 个 · 剩余 ${Math.max(0, total - processed)} 个`,
      currentAssetId: undefined,
      queuedAssetIds: Array.from(remainingIds),
      total,
      processed,
      failed,
    });
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

export async function processRawAsset(
  id: string,
  extractor?: IngestExtractor,
  onProgress?: (progress: RawAssetCompileProgress) => void,
) {
  const asset = await db.rawAssets.get(id);
  if (!asset || !['raw', 'failed'].includes(asset.status)) return asset;

  const now = Date.now();
  await db.rawAssets.update(asset.id, {
    status: 'extracting',
    error: undefined,
    updatedAt: now,
  });
  onProgress?.({ percent: 12, label: `提取 ${asset.filename}` });

  try {
    const extractedText = await extractImportBlobText(
      {
        blob: getUsableBlob(asset),
        filename: asset.filename,
        mimeType: asset.mimeType,
        kind: asset.kind as RawAssetKind,
      },
      (progress) => onProgress?.({ percent: Math.min(58, 12 + Math.round(progress.percent * 0.46)), label: progress.label }),
    );
    const enrichedText = await enrichExtractedTextWithMultimodalContext(asset, extractedText, getUsableBlob(asset), (progress) =>
      onProgress?.({ percent: Math.min(60, 58 + Math.round(progress * 2)), label: `理解图片 ${asset.filename}` }),
    );
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
    const processed = await processIngestJob(job.id, extractor ?? extractRawAssetCaptureDraft);
    const completedAt = Date.now();

    const compiledHasKnowledge = processed?.status === 'done' ? await entryHasDerivedKnowledge(processed.entryId) : false;
    const finalStatus =
      processed?.status === 'skipped'
        ? 'skipped'
        : processed?.status === 'done' && compiledHasKnowledge
          ? 'compiled'
          : processed?.status === 'processing'
            ? 'compiling'
            : 'failed';
    await db.rawAssets.update(asset.id, {
      status: finalStatus,
      ingestJobId: job.id,
      entryId: processed?.entryId ?? asset.entryId,
      error:
        finalStatus === 'failed'
          ? buildRawAssetFailureMessage(processed?.status, processed?.error, processed?.status === 'done' && !compiledHasKnowledge)
          : undefined,
      compiledAt: completedAt,
      updatedAt: completedAt,
    });
    if (finalStatus === 'compiled' || finalStatus === 'skipped') {
      await syncIndexedDbKnowledgeToDefaultWorkspace().catch(() => undefined);
    }
    onProgress?.({ percent: 100, label: finalStatus === 'failed' ? `${asset.filename} 编译失败` : `${asset.filename} 已编译` });
  } catch (error) {
    await db.rawAssets.update(asset.id, {
      status: 'failed',
      error: error instanceof Error ? error.message : '编译失败。',
      updatedAt: Date.now(),
    });
  }

  return db.rawAssets.get(asset.id);
}

async function entryHasDerivedKnowledge(entryId?: string) {
  if (!entryId) return false;
  const entry = await db.entries.get(entryId);
  return Boolean(entry && (entry.derivedEntities?.length ?? 0) > 0);
}

async function enrichExtractedTextWithMultimodalContext(
  asset: RawAsset,
  extractedText: string,
  blob: Blob,
  onProgress?: (progress: number) => void,
) {
  const settings = loadMultimodalSettings();
  if (!settings.enabled || !settings.captionStandaloneImages) return extractedText;

  if (asset.kind !== 'image') {
    return enrichDocumentTextWithEmbeddedImages(asset, extractedText, blob, onProgress);
  }

  if (!asset.dataBase64) return extractedText;
  onProgress?.(0.2);
  let ocrText: string | undefined;
  try {
    ocrText =
      settings.includeOcrText
        ? extractedText.trim() ||
          (await ocrImageForWiki({
            imageBase64: asset.dataBase64,
            mimeType: asset.mimeType || 'image/png',
            filename: asset.filename,
            contentHash: asset.contentHash,
          }))
        : undefined;
    const caption = await captionImageForWiki({
      imageBase64: asset.dataBase64,
      mimeType: asset.mimeType || 'image/png',
      filename: asset.filename,
      contentHash: asset.contentHash,
      ocrText,
    });
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
    if (ocrText?.trim()) {
      onProgress?.(1);
      return [
        buildImageKnowledgeMarkdown({
          filename: asset.filename,
          ocrText,
          rawUrl: `raw://${asset.id}`,
        }),
        '',
        '## 视觉描述待重试',
        '',
        `图片/多模态模型本次没有返回有效描述：${message}`,
      ].join('\n');
    }
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
) {
  if (!['word', 'pdf', 'presentation'].includes(asset.kind)) return extractedText;
  const settings = loadMultimodalSettings();
  const includePdfPageScreenshots = asset.kind === 'pdf' && shouldCapturePdfPageScreenshots(extractedText);
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
      },
    );
  } catch {
    images = [];
  }

  if (images.length === 0) return extractedText;

  const sections: string[] = [];
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    onProgress?.((index + 0.2) / Math.max(images.length, 1));
    const ocrText = settings.includeOcrText ? await ocrImageForWiki(image) : '';
    let caption = '';
    try {
      caption =
        (await captionImageForWiki({
          imageBase64: image.imageBase64,
          mimeType: image.mimeType,
          filename: image.filename,
          contentHash: image.contentHash,
          ocrText,
        })) ?? '';
    } catch (error) {
      caption = `图片描述生成失败：${error instanceof Error ? error.message : '未知错误'}`;
    }
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

function sanitizeMarkdownAlt(value: string) {
  return value.replace(/[\r\n]+/g, ' ').replace(/]/g, ')').trim().slice(0, 160);
}

export async function resetStaleRawAssets(now = Date.now(), staleMs = RAW_ASSET_STALE_MS) {
  const staleBefore = now - staleMs;
  const staleAssets = await db.rawAssets
    .where('status')
    .anyOf(['extracting', 'compiling'])
    .filter((asset) => asset.updatedAt < staleBefore)
    .toArray();

  await Promise.all(
    staleAssets.map((asset) =>
      db.rawAssets.update(asset.id, {
        status: 'failed',
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

export async function listRecentRawAssets(limit = 12) {
  return db.rawAssets.orderBy('createdAt').reverse().limit(limit).toArray();
}

async function listRunnableRawAssetIds() {
  const assets = await db.rawAssets.where('status').anyOf(['raw', 'failed']).toArray();
  return assets.sort((left, right) => left.createdAt - right.createdAt).map((asset) => asset.id);
}

function buildRecoveredDetail(staleCount: number, invalidVisionCount: number) {
  return [
    staleCount > 0 ? `已恢复 ${staleCount} 个旧任务` : '',
    invalidVisionCount > 0 ? `已恢复 ${invalidVisionCount} 个无效图片编译结果` : '',
  ]
    .filter(Boolean)
    .join('，') || undefined;
}

function isInvalidVisionContent(value: string) {
  return isVisionRefusalCaption(value) || /多模态视觉描述暂未生成/i.test(value);
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

async function extractRawAssetCaptureDraft(content: string) {
  const result = await extractCaptureDraft(content);
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
  if (asset.blob && typeof asset.blob.arrayBuffer === 'function') {
    return asset.blob;
  }

  if (!asset.dataBase64) {
    return asset.blob;
  }

  return new Blob([base64ToBytes(asset.dataBase64)], {
    type: asset.mimeType,
  });
}

function buildRawAssetFailureMessage(status?: string, error?: string, emptyKnowledge = false) {
  if (error) return error;
  if (emptyKnowledge) {
    return '原文件已经解析，但结构化入库没有生成任何知识页。请重试，或检查 Wiki 编译模型是否返回了有效结构化结果。';
  }
  if (status === 'pending') {
    return '摄入任务暂未完成，已恢复为可重试状态。';
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

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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
};
