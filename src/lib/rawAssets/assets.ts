import { db } from '@/lib/db/schema';
import { createId } from '@/lib/db/ids';
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
  const asset: RawAsset = {
    id: createId('raw'),
    filename: file.name,
    mimeType: file.type,
    kind,
    size: file.size,
    contentHash,
    blob: file,
    dataBase64: bytesToBase64(new Uint8Array(buffer)),
    status: 'raw',
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
    });
    const processed = await processIngestJob(job.id, extractor);
    const completedAt = Date.now();

    const finalStatus = processed?.status === 'skipped' ? 'skipped' : processed?.status === 'done' ? 'compiled' : 'failed';
    await db.rawAssets.update(asset.id, {
      status: finalStatus,
      ingestJobId: job.id,
      entryId: processed?.entryId,
      error: finalStatus === 'failed' ? processed?.error ?? '编译失败。' : undefined,
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

export async function listRecentRawAssets(limit = 12) {
  return db.rawAssets.orderBy('createdAt').reverse().limit(limit).toArray();
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
