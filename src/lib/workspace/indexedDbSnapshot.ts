import { db } from '@/lib/db';
import type {
  CompileSuggestionRecord,
  Entry,
  GraphInsightDismissal,
  IngestCacheRecord,
  IngestJob,
  QueryCacheRecord,
  RawAsset,
  Relationship,
  Task,
  WikiBatchJob,
  Entity,
} from '@/types';

export const workspaceIndexedDbSnapshotFileName = 'indexeddb-snapshot.json';

export type WorkspaceIndexedDbSnapshot = {
  version: 1;
  createdAt: number;
  records: {
    entries: Entry[];
    entities: Entity[];
    relationships: Relationship[];
    tasks: Task[];
    compileSuggestions: CompileSuggestionRecord[];
    ingestJobs: IngestJob[];
    ingestCache: IngestCacheRecord[];
    graphInsightDismissals: GraphInsightDismissal[];
    rawAssets: RawAssetSnapshot[];
    queryCache: QueryCacheRecord[];
    wikiBatchJobs: WikiBatchJob[];
  };
};

type RawAssetSnapshot = Omit<RawAsset, 'blob'> & {
  blobBase64?: string;
};

export async function buildIndexedDbSnapshot(): Promise<WorkspaceIndexedDbSnapshot> {
  const [
    entries,
    entities,
    relationships,
    tasks,
    compileSuggestions,
    ingestJobs,
    ingestCache,
    graphInsightDismissals,
    rawAssets,
    queryCache,
    wikiBatchJobs,
  ] = await Promise.all([
    db.entries.toArray(),
    db.entities.toArray(),
    db.relationships.toArray(),
    db.tasks.toArray(),
    db.compileSuggestions.toArray(),
    db.ingestJobs.toArray(),
    db.ingestCache.toArray(),
    db.graphInsightDismissals.toArray(),
    db.rawAssets.toArray(),
    db.queryCache.toArray(),
    db.wikiBatchJobs.toArray(),
  ]);

  return {
    version: 1,
    createdAt: Date.now(),
    records: {
      entries,
      entities,
      relationships,
      tasks,
      compileSuggestions,
      ingestJobs,
      ingestCache,
      graphInsightDismissals,
      rawAssets: await Promise.all(rawAssets.map(serializeRawAsset)),
      queryCache,
      wikiBatchJobs,
    },
  };
}

export async function restoreIndexedDbSnapshot(snapshot: WorkspaceIndexedDbSnapshot) {
  if (snapshot.version !== 1) {
    throw new Error(`不支持的知识库快照版本：${snapshot.version}`);
  }

  const rawAssets = await Promise.all(snapshot.records.rawAssets.map(deserializeRawAsset));

  await db.transaction(
    'rw',
    [
      db.entries,
      db.entities,
      db.relationships,
      db.tasks,
      db.compileSuggestions,
      db.ingestJobs,
      db.ingestCache,
      db.graphInsightDismissals,
      db.rawAssets,
      db.queryCache,
      db.wikiBatchJobs,
    ],
    async () => {
      await Promise.all([
        db.entries.clear(),
        db.entities.clear(),
        db.relationships.clear(),
        db.tasks.clear(),
        db.compileSuggestions.clear(),
        db.ingestJobs.clear(),
        db.ingestCache.clear(),
        db.graphInsightDismissals.clear(),
        db.rawAssets.clear(),
        db.queryCache.clear(),
        db.wikiBatchJobs.clear(),
      ]);

      await Promise.all([
        snapshot.records.entries.length ? db.entries.bulkPut(snapshot.records.entries) : Promise.resolve(),
        snapshot.records.entities.length ? db.entities.bulkPut(snapshot.records.entities) : Promise.resolve(),
        snapshot.records.relationships.length ? db.relationships.bulkPut(snapshot.records.relationships) : Promise.resolve(),
        snapshot.records.tasks.length ? db.tasks.bulkPut(snapshot.records.tasks) : Promise.resolve(),
        snapshot.records.compileSuggestions.length ? db.compileSuggestions.bulkPut(snapshot.records.compileSuggestions) : Promise.resolve(),
        snapshot.records.ingestJobs.length ? db.ingestJobs.bulkPut(snapshot.records.ingestJobs) : Promise.resolve(),
        snapshot.records.ingestCache.length ? db.ingestCache.bulkPut(snapshot.records.ingestCache) : Promise.resolve(),
        snapshot.records.graphInsightDismissals.length
          ? db.graphInsightDismissals.bulkPut(snapshot.records.graphInsightDismissals)
          : Promise.resolve(),
        rawAssets.length ? db.rawAssets.bulkPut(rawAssets) : Promise.resolve(),
        snapshot.records.queryCache.length ? db.queryCache.bulkPut(snapshot.records.queryCache) : Promise.resolve(),
        snapshot.records.wikiBatchJobs.length ? db.wikiBatchJobs.bulkPut(snapshot.records.wikiBatchJobs) : Promise.resolve(),
      ]);
    },
  );
}

export function countIndexedDbSnapshotRecords(snapshot: WorkspaceIndexedDbSnapshot) {
  return {
    entries: snapshot.records.entries.length,
    entities: snapshot.records.entities.length,
    relationships: snapshot.records.relationships.length,
    tasks: snapshot.records.tasks.length,
    compileSuggestions: snapshot.records.compileSuggestions.length,
    ingestJobs: snapshot.records.ingestJobs.length,
    rawAssets: snapshot.records.rawAssets.length,
    wikiBatchJobs: snapshot.records.wikiBatchJobs.length,
  };
}

function assertWorkspaceIndexedDbSnapshot(value: unknown): WorkspaceIndexedDbSnapshot {
  if (!value || typeof value !== 'object') {
    throw new Error('知识库快照格式无效。');
  }
  const snapshot = value as WorkspaceIndexedDbSnapshot;
  if (snapshot.version !== 1 || !snapshot.records || typeof snapshot.records !== 'object') {
    throw new Error('知识库快照格式无效。');
  }
  return {
    version: 1,
    createdAt: typeof snapshot.createdAt === 'number' ? snapshot.createdAt : Date.now(),
    records: {
      entries: asArray<Entry>(snapshot.records.entries),
      entities: asArray<Entity>(snapshot.records.entities),
      relationships: asArray<Relationship>(snapshot.records.relationships),
      tasks: asArray<Task>(snapshot.records.tasks),
      compileSuggestions: asArray<CompileSuggestionRecord>(snapshot.records.compileSuggestions),
      ingestJobs: asArray<IngestJob>(snapshot.records.ingestJobs),
      ingestCache: asArray<IngestCacheRecord>(snapshot.records.ingestCache),
      graphInsightDismissals: asArray<GraphInsightDismissal>(snapshot.records.graphInsightDismissals),
      rawAssets: asArray<RawAssetSnapshot>(snapshot.records.rawAssets),
      queryCache: asArray<QueryCacheRecord>(snapshot.records.queryCache),
      wikiBatchJobs: asArray<WikiBatchJob>(snapshot.records.wikiBatchJobs),
    },
  };
}

export function parseWorkspaceIndexedDbSnapshotJson(json: string) {
  return assertWorkspaceIndexedDbSnapshot(JSON.parse(json));
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

async function serializeRawAsset(asset: RawAsset): Promise<RawAssetSnapshot> {
  const { blob, ...rest } = asset;
  const blobBase64 = rest.dataBase64 || (blob ? await blobToBase64(blob) : undefined);
  return {
    ...rest,
    blobBase64,
    dataBase64: rest.dataBase64 ?? blobBase64,
  };
}

async function deserializeRawAsset(asset: RawAssetSnapshot): Promise<RawAsset> {
  const { blobBase64, ...rest } = asset;
  const encoded = blobBase64 || rest.dataBase64 || '';
  return {
    ...rest,
    dataBase64: rest.dataBase64 ?? encoded,
    blob: base64ToBlob(encoded, rest.mimeType || 'application/octet-stream'),
  };
}

async function blobToBase64(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBlob(base64: string, mimeType: string) {
  if (!base64) return new Blob([], { type: mimeType });
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}
