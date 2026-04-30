import Dexie, { type Table } from 'dexie';
import type { CompileSuggestionRecord, Entity, Entry, Relationship, Task } from '@/types';

export class MyWikiDatabase extends Dexie {
  entries!: Table<Entry, string>;
  entities!: Table<Entity, string>;
  relationships!: Table<Relationship, string>;
  tasks!: Table<Task, string>;
  compileSuggestions!: Table<CompileSuggestionRecord, string>;

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
  }
}

export const db = new MyWikiDatabase();

export async function resetDatabase() {
  await db.delete();
  await db.open();
}
