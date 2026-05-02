import Dexie, { type Table } from 'dexie';
import type {
  CompileSuggestionRecord,
  Entity,
  Entry,
  GraphInsightDismissal,
  IngestCacheRecord,
  IngestJob,
  RawAsset,
  Relationship,
  Task,
} from '@/types';

export class MyWikiDatabase extends Dexie {
  entries!: Table<Entry, string>;
  entities!: Table<Entity, string>;
  relationships!: Table<Relationship, string>;
  tasks!: Table<Task, string>;
  compileSuggestions!: Table<CompileSuggestionRecord, string>;
  ingestJobs!: Table<IngestJob, string>;
  ingestCache!: Table<IngestCacheRecord, string>;
  graphInsightDismissals!: Table<GraphInsightDismissal, string>;
  rawAssets!: Table<RawAsset, string>;

  constructor() {
    super('mywiki');

    this.version(1).stores({
      entries: 'id, capturedAt, processed, source',
      entities: 'id, type, title, *tags, *scenes, createdAt, updatedAt',
      relationships: 'id, from, to, type, createdAt, *evidence',
      tasks: 'id, owner, status, createdAt, dueDate, source, *linkedTo',
    });

    this.version(2).stores({
      entries: 'id, capturedAt, processed, source',
      entities: 'id, type, title, *tags, *scenes, createdAt, updatedAt',
      relationships: 'id, from, to, type, createdAt, *evidence',
      tasks: 'id, owner, status, createdAt, dueDate, source, *linkedTo',
      compileSuggestions: 'id, &fingerprint, status, entityId, propertyKey, evidenceEntryId, createdAt, updatedAt',
    });

    this.version(3).stores({
      entries: 'id, capturedAt, processed, source',
      entities: 'id, type, title, *tags, *scenes, createdAt, updatedAt',
      relationships: 'id, from, to, type, createdAt, *evidence',
      tasks: 'id, owner, status, createdAt, dueDate, source, *linkedTo',
      compileSuggestions: 'id, &fingerprint, status, entityId, propertyKey, evidenceEntryId, createdAt, updatedAt',
      ingestJobs: 'id, status, contentHash, createdAt, updatedAt',
      ingestCache: '&contentHash, updatedAt, *entryIds',
      graphInsightDismissals: 'id, type, dismissedAt',
    });

    this.version(4).stores({
      entries: 'id, capturedAt, processed, source',
      entities: 'id, type, title, *tags, *scenes, createdAt, updatedAt',
      relationships: 'id, from, to, type, createdAt, *evidence',
      tasks: 'id, owner, status, createdAt, dueDate, source, *linkedTo',
      compileSuggestions: 'id, &fingerprint, status, entityId, propertyKey, evidenceEntryId, createdAt, updatedAt',
      ingestJobs: 'id, status, contentHash, createdAt, updatedAt',
      ingestCache: '&contentHash, updatedAt, *entryIds',
      graphInsightDismissals: 'id, type, dismissedAt',
      rawAssets: 'id, status, kind, contentHash, filename, createdAt, updatedAt',
    });
  }
}

export const db = new MyWikiDatabase();

export async function resetDatabase() {
  await db.delete();
  await db.open();
}
