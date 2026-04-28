import type { Entry } from '@/types';
import { db } from './schema';
import { createId } from './ids';

export type CreateEntryInput = {
  content: string;
  source: Entry['source'];
  fileMetadata?: Entry['fileMetadata'];
  capturedAt?: number;
  processed?: boolean;
  derivedEntities?: string[];
  derivedTasks?: string[];
  derivedRelationships?: string[];
};

export async function createEntry(input: CreateEntryInput) {
  const entry: Entry = {
    id: createId('entry'),
    content: input.content,
    source: input.source,
    fileMetadata: input.fileMetadata,
    capturedAt: input.capturedAt ?? Date.now(),
    processed: input.processed ?? false,
    derivedEntities: input.derivedEntities ?? [],
    derivedTasks: input.derivedTasks ?? [],
    derivedRelationships: input.derivedRelationships ?? [],
  };

  await db.entries.add(entry);
  return entry;
}

export function getEntry(id: string) {
  return db.entries.get(id);
}

export function listEntries() {
  return db.entries.orderBy('capturedAt').reverse().toArray();
}

export async function updateEntry(id: string, patch: Partial<Omit<Entry, 'id'>>) {
  await db.entries.update(id, patch);
  return db.entries.get(id);
}

export function deleteEntry(id: string) {
  return db.entries.delete(id);
}
