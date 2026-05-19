import Dexie, { type Table } from 'dexie';
import type {
  CompileSuggestionRecord,
  Entity,
  Entry,
  GraphInsightDismissal,
  IngestCacheRecord,
  IngestJob,
  QueryCacheRecord,
  RawAsset,
  Relationship,
  Task,
  WikiReviewRecord,
  WikiBatchJob,
} from '@/types';
import { getClientId } from './clientId';

const clientIdBackfillTables = [
  'entries',
  'entities',
  'relationships',
  'tasks',
  'compileSuggestions',
  'ingestJobs',
  'ingestCache',
  'graphInsightDismissals',
  'rawAssets',
  'queryCache',
] as const;

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
  queryCache!: Table<QueryCacheRecord, string>;
  wikiBatchJobs!: Table<WikiBatchJob, string>;
  wikiReviewItems!: Table<WikiReviewRecord, string>;

  constructor(name = 'mywiki') {
    super(name);

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

    this.version(5).stores({
      entries: 'id, capturedAt, processed, source',
      entities: 'id, type, title, *tags, *scenes, createdAt, updatedAt',
      relationships: 'id, from, to, type, createdAt, *evidence',
      tasks: 'id, owner, status, createdAt, dueDate, source, *linkedTo',
      compileSuggestions: 'id, &fingerprint, status, entityId, propertyKey, evidenceEntryId, createdAt, updatedAt',
      ingestJobs: 'id, status, contentHash, createdAt, updatedAt',
      ingestCache: '&contentHash, updatedAt, *entryIds',
      graphInsightDismissals: 'id, type, dismissedAt',
      rawAssets: 'id, status, kind, contentHash, filename, createdAt, updatedAt',
      queryCache: '&key, updatedAt, dataUpdatedAt',
    });

    this.version(6)
      .stores({
        entries: 'id, clientId, capturedAt, processed, source',
        entities: 'id, clientId, type, title, *tags, *scenes, createdAt, updatedAt',
        relationships: 'id, clientId, from, to, type, createdAt, *evidence',
        tasks: 'id, clientId, owner, status, createdAt, dueDate, source, *linkedTo',
        compileSuggestions: 'id, clientId, &fingerprint, status, entityId, propertyKey, evidenceEntryId, createdAt, updatedAt',
        ingestJobs: 'id, clientId, status, contentHash, createdAt, updatedAt',
        ingestCache: '&contentHash, clientId, updatedAt, *entryIds',
        graphInsightDismissals: 'id, clientId, type, dismissedAt',
        rawAssets: 'id, clientId, status, kind, contentHash, filename, createdAt, updatedAt',
        queryCache: '&key, clientId, updatedAt, dataUpdatedAt',
      })
      .upgrade(async (tx) => {
        const clientId = getClientId();
        for (const tableName of clientIdBackfillTables) {
          await tx.table(tableName).toCollection().modify((record) => {
            record.clientId ??= clientId;
          });
        }
      });

    this.version(7).stores({
      entries: 'id, clientId, capturedAt, processed, source',
      entities: 'id, clientId, type, title, *tags, *scenes, createdAt, updatedAt',
      relationships: 'id, clientId, from, to, type, createdAt, *evidence',
      tasks: 'id, clientId, owner, status, createdAt, dueDate, source, *linkedTo',
      compileSuggestions: 'id, clientId, &fingerprint, status, entityId, propertyKey, evidenceEntryId, createdAt, updatedAt',
      ingestJobs: 'id, clientId, status, contentHash, createdAt, updatedAt',
      ingestCache: '&contentHash, clientId, updatedAt, *entryIds',
      graphInsightDismissals: 'id, clientId, type, dismissedAt',
      rawAssets: 'id, clientId, status, kind, contentHash, filename, createdAt, updatedAt',
      queryCache: '&key, clientId, updatedAt, dataUpdatedAt',
      wikiBatchJobs: 'id, clientId, owner, status, createdAt, updatedAt',
    });

    this.version(8).stores({
      entries: 'id, clientId, capturedAt, processed, source',
      entities: 'id, clientId, type, title, *tags, *scenes, createdAt, updatedAt',
      relationships: 'id, clientId, from, to, type, createdAt, *evidence',
      tasks: 'id, clientId, owner, status, createdAt, dueDate, source, *linkedTo',
      compileSuggestions: 'id, clientId, &fingerprint, status, entityId, propertyKey, evidenceEntryId, createdAt, updatedAt',
      ingestJobs: 'id, clientId, status, contentHash, createdAt, updatedAt',
      ingestCache: '&contentHash, clientId, updatedAt, *entryIds',
      graphInsightDismissals: 'id, clientId, type, dismissedAt',
      rawAssets: 'id, clientId, status, kind, contentHash, filename, createdAt, updatedAt',
      queryCache: '&key, clientId, updatedAt, dataUpdatedAt',
      wikiBatchJobs: 'id, clientId, owner, status, createdAt, updatedAt',
      wikiReviewItems: 'id, clientId, &fingerprint, status, type, entityId, createdAt, updatedAt',
    });
  }
}

export const db = new MyWikiDatabase();

export async function resetDatabase() {
  await db.delete();
  await db.open();
}
