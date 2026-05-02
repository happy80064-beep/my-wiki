import { extractCaptureDraft } from '@/lib/ai/captureClient';
import { persistCaptureDraft, type CaptureDraft } from '@/lib/capture';
import { createId, db } from '@/lib/db';
import type { EntrySource, IngestJob } from '@/types';

export type IngestExtractor = (content: string) => Promise<{ draft: CaptureDraft }>;

export type CreateIngestJobInput = {
  content: string;
  source?: EntrySource;
  filename?: string;
};

export async function createIngestJob(input: CreateIngestJobInput) {
  const content = input.content.trim();
  if (!content) {
    throw new Error('content is required.');
  }

  const now = Date.now();
  const contentHash = await sha256(content);
  const activeDuplicate = await db.ingestJobs
    .where('contentHash')
    .equals(contentHash)
    .filter((job) => ['pending', 'processing'].includes(job.status))
    .first();
  if (activeDuplicate) {
    return activeDuplicate;
  }

  const job: IngestJob = {
    id: createId('ingest'),
    content,
    source: input.source ?? 'text',
    filename: input.filename,
    contentHash,
    status: 'pending',
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  await db.ingestJobs.add(job);
  return job;
}

export async function listIngestJobs(limit = 20) {
  return db.ingestJobs.orderBy('createdAt').reverse().limit(limit).toArray();
}

export async function processNextIngestJob(extractor: IngestExtractor = extractCaptureDraft) {
  const job = await db.ingestJobs
    .where('status')
    .equals('pending')
    .first();
  if (!job) return undefined;
  return processIngestJob(job.id, extractor);
}

export async function processIngestJob(id: string, extractor: IngestExtractor = extractCaptureDraft) {
  const job = await db.ingestJobs.get(id);
  if (!job || !['pending', 'failed'].includes(job.status)) return job;

  const cached = await getUsableCache(job.contentHash);
  if (cached) {
    const now = Date.now();
    await db.ingestJobs.update(job.id, {
      status: 'skipped',
      entryId: cached.entryIds[0],
      completedAt: now,
      updatedAt: now,
      error: undefined,
    });
    return db.ingestJobs.get(job.id);
  }

  const now = Date.now();
  await db.ingestJobs.update(job.id, {
    status: 'processing',
    updatedAt: now,
    error: undefined,
  });

  try {
    const result = await extractor(job.content);
    const persisted = await persistCaptureDraft(job.content, result.draft, job.source);
    const completedAt = Date.now();
    await db.transaction('rw', db.ingestJobs, db.ingestCache, async () => {
      await db.ingestCache.put({
        contentHash: job.contentHash,
        entryIds: [persisted.entry.id],
        createdAt: completedAt,
        updatedAt: completedAt,
      });
      await db.ingestJobs.update(job.id, {
        status: 'done',
        entryId: persisted.entry.id,
        completedAt,
        updatedAt: completedAt,
      });
    });
  } catch (error) {
    const failedAt = Date.now();
    const retryCount = job.retryCount + 1;
    await db.ingestJobs.update(job.id, {
      status: retryCount >= 3 ? 'failed' : 'pending',
      retryCount,
      error: error instanceof Error ? error.message : '摄入失败',
      updatedAt: failedAt,
    });
  }

  return db.ingestJobs.get(job.id);
}

export async function clearFinishedIngestJobs() {
  return db.ingestJobs
    .filter((job) => ['done', 'skipped'].includes(job.status))
    .delete();
}

async function getUsableCache(contentHash: string) {
  const cached = await db.ingestCache.get(contentHash);
  if (!cached || cached.entryIds.length === 0) return undefined;

  const entries = await db.entries.bulkGet(cached.entryIds);
  const allEntriesExist = entries.every(Boolean);
  if (!allEntriesExist) {
    await db.ingestCache.delete(contentHash);
    return undefined;
  }

  return cached;
}

async function sha256(value: string) {
  if (!globalThis.crypto?.subtle) {
    return `fnv1a-${fnv1a(value)}`;
  }

  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function fnv1a(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
