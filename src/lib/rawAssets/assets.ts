import { db } from '@/lib/db/schema';
import { createEntry, createId, updateEntry } from '@/lib/db';
import { extractCaptureDraft } from '@/lib/ai/captureClient';
import { createLocalCaptureDraft } from '@/lib/capture';
import { buildImportedContent, extractImportBlobText, getImportFileKind } from '@/lib/import/fileText';
import { createIngestJob, processIngestJob, type IngestExtractor } from '@/lib/ingest';
import type { RawAsset, RawAssetKind } from '@/types';

export type RawAssetImportResult = {
  asset: RawAsset;
  reused: boolean;
};

export type RawAssetCompileProgress = {
  percent: number;
  label: string;
};

export const RAW_ASSET_STALE_MS = 15 * 60 * 1000;

export async function createRawAssetFromFile(file: File): Promise<RawAssetImportResult> {
  const kind = getImportFileKind(file.name, file.type);
  if (!kind) {
    throw new Error(`${file.name} 的格式暂不支持。`);
  }

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
      filename: file.name,
      mimeType: file.type,
      url: `raw://${id}`,
    },
  });
  const asset: RawAsset = {
    id,
    filename: file.name,
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
    const content = buildImportedContent({
      filename: asset.filename,
      kind: asset.kind,
      source: asset.kind === 'image' ? 'image' : 'file',
      text: extractedText,
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
      extractedText,
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

    const finalStatus =
      processed?.status === 'skipped'
        ? 'skipped'
        : processed?.status === 'done'
          ? 'compiled'
          : processed?.status === 'processing'
            ? 'compiling'
            : 'failed';
    await db.rawAssets.update(asset.id, {
      status: finalStatus,
      ingestJobId: job.id,
      entryId: processed?.entryId ?? asset.entryId,
      error: finalStatus === 'failed' ? buildRawAssetFailureMessage(processed?.status, processed?.error) : undefined,
      compiledAt: completedAt,
      updatedAt: completedAt,
    });
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

export async function listRecentRawAssets(limit = 12) {
  return db.rawAssets.orderBy('createdAt').reverse().limit(limit).toArray();
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
  try {
    const result = await extractCaptureDraft(buildCaptureInputExcerpt(content));
    return { draft: result.draft };
  } catch {
    return { draft: createLocalCaptureDraft(content) };
  }
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

function buildRawAssetFailureMessage(status?: string, error?: string) {
  if (error) return error;
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

const rawKindLabels: Record<RawAssetKind, string> = {
  text: '文本',
  word: 'Word',
  pdf: 'PDF',
  image: '图片',
  spreadsheet: '表格',
  html: '网页 HTML',
};
