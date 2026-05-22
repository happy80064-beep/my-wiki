import {
  buildWorkspaceLayout,
  joinWorkspacePath,
} from '@/lib/workspace/paths';
import { getPersistedWorkspaceRoot } from '@/lib/workspace/activeWorkspace';
import {
  canUseWorkspaceStorage,
  createWorkspaceStorage,
  getWorkspaceDefaultRoot,
} from '@/lib/workspace/storage';
import { initializeWorkspace } from '@/lib/workspace/workspace';
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
  WikiBatchJob,
  WikiReviewRecord,
} from '@/types';
import { notifyWorkspaceDbChanged } from './liveQuery';

type TableName = keyof WorkspaceRecordState['records'];
type RecordOf<TName extends TableName> = WorkspaceRecordState['records'][TName][number];
type Predicate<TRecord> = (record: TRecord) => boolean;
type Mutator<TRecord> = (record: TRecord) => void | false | Promise<void | false>;

export type WorkspaceRecordState = {
  version: 1;
  createdAt: number;
  updatedAt: number;
  records: {
    entries: Entry[];
    entities: Entity[];
    relationships: Relationship[];
    tasks: Task[];
    compileSuggestions: CompileSuggestionRecord[];
    ingestJobs: IngestJob[];
    ingestCache: IngestCacheRecord[];
    graphInsightDismissals: GraphInsightDismissal[];
    rawAssets: RawAsset[];
    queryCache: QueryCacheRecord[];
    wikiBatchJobs: WikiBatchJob[];
    wikiReviewItems: WikiReviewRecord[];
  };
};

const tableNames = [
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
  'wikiBatchJobs',
  'wikiReviewItems',
] as const satisfies readonly TableName[];

const rawAssetBlobStore = new Map<string, Blob>();
const inMemoryWorkspaceRoot = 'memory://mywiki-test-workspace';

let activeRecordsPath: string | null = null;
let activeState: WorkspaceRecordState | null = null;
let useInMemoryStore = false;
let operationQueue: Promise<unknown> = Promise.resolve();
let transactionState: WorkspaceRecordState | null = null;

export class MyWikiDatabase {
  entries = new WorkspaceTable<'entries'>('entries');
  entities = new WorkspaceTable<'entities'>('entities');
  relationships = new WorkspaceTable<'relationships'>('relationships');
  tasks = new WorkspaceTable<'tasks'>('tasks');
  compileSuggestions = new WorkspaceTable<'compileSuggestions'>('compileSuggestions');
  ingestJobs = new WorkspaceTable<'ingestJobs'>('ingestJobs');
  ingestCache = new WorkspaceTable<'ingestCache'>('ingestCache');
  graphInsightDismissals = new WorkspaceTable<'graphInsightDismissals'>('graphInsightDismissals');
  rawAssets = new WorkspaceTable<'rawAssets'>('rawAssets');
  queryCache = new WorkspaceTable<'queryCache'>('queryCache');
  wikiBatchJobs = new WorkspaceTable<'wikiBatchJobs'>('wikiBatchJobs');
  wikiReviewItems = new WorkspaceTable<'wikiReviewItems'>('wikiReviewItems');

  constructor(public readonly name = 'mywiki') {}

  async open() {
    await loadState();
    return this;
  }

  async delete() {
    await resetDatabase();
  }

  table<TName extends TableName>(name: TName) {
    return this[name] as unknown as WorkspaceTable<TName>;
  }

  async transaction<T = unknown>(
    _mode: string,
    tablesOrFirst: unknown,
    maybeCallback?: unknown,
    ...rest: unknown[]
  ): Promise<T> {
    const callback = [tablesOrFirst, maybeCallback, ...rest].find((item) => typeof item === 'function') as
      | (() => Promise<T> | T)
      | undefined;
    if (!callback) throw new Error('Workspace transaction requires a callback.');
    return enqueueWrite(async (state) => {
      if (transactionState) return callback() as T | Promise<T>;
      transactionState = state;
      try {
        return await callback();
      } finally {
        transactionState = null;
      }
    });
  }
}

class WorkspaceTable<TName extends TableName> {
  constructor(readonly name: TName) {}

  async add(record: RecordOf<TName>) {
    await enqueueWrite(async (state) => {
      const records = getTableRecords(state, this.name);
      if (records.some((item) => getRecordKey(this.name, item) === getRecordKey(this.name, record))) {
        throw new Error(`Duplicate record in ${this.name}: ${getRecordKey(this.name, record)}`);
      }
      records.push(cloneForStorage(this.name, record));
    });
    return getRecordKey(this.name, record);
  }

  async put(record: RecordOf<TName>) {
    await enqueueWrite(async (state) => {
      upsertRecord(getTableRecords(state, this.name), this.name, record);
    });
    return getRecordKey(this.name, record);
  }

  async bulkPut(records: RecordOf<TName>[]) {
    await enqueueWrite(async (state) => {
      const table = getTableRecords(state, this.name);
      records.forEach((record) => upsertRecord(table, this.name, record));
    });
  }

  async bulkDelete(keys: string[]) {
    await enqueueWrite(async (state) => {
      const keySet = new Set(keys);
      replaceTableRecords(
        state,
        this.name,
        getTableRecords(state, this.name).filter((record) => !keySet.has(getRecordKey(this.name, record))),
      );
    });
  }

  async get(key: string) {
    const records = await this.toArray();
    return records.find((record) => getRecordKey(this.name, record) === key);
  }

  async bulkGet(keys: string[]) {
    const records = await this.toArray();
    const byKey = new Map(records.map((record) => [getRecordKey(this.name, record), record]));
    return keys.map((key) => byKey.get(key));
  }

  async update(key: string, patch: Partial<Record<string, unknown>>) {
    let updated = 0;
    await enqueueWrite(async (state) => {
      const records = getTableRecords(state, this.name);
      const index = records.findIndex((record) => getRecordKey(this.name, record) === key);
      if (index < 0) return;
      records[index] = cloneForStorage(this.name, { ...records[index], ...patch } as RecordOf<TName>);
      updated = 1;
    });
    return updated;
  }

  async delete(key: string) {
    await enqueueWrite(async (state) => {
      replaceTableRecords(
        state,
        this.name,
        getTableRecords(state, this.name).filter((record) => getRecordKey(this.name, record) !== key),
      );
    });
  }

  async clear() {
    await enqueueWrite(async (state) => {
      replaceTableRecords(state, this.name, []);
    });
  }

  async count() {
    return (await this.toArray()).length;
  }

  async toArray() {
    const state = await loadState();
    return cloneFromStorage(this.name, getTableRecords(state, this.name));
  }

  orderBy(field: string) {
    return new WorkspaceCollection(this, [(left, right) => compareValues(getFieldValue(left, field), getFieldValue(right, field))]);
  }

  where(field: string) {
    return new WorkspaceWhereClause(this, field);
  }

  filter(predicate: Predicate<RecordOf<TName>>) {
    return new WorkspaceCollection(this, [], [predicate]);
  }

  toCollection() {
    return new WorkspaceCollection(this);
  }
}

class WorkspaceWhereClause<TName extends TableName> {
  constructor(
    private readonly table: WorkspaceTable<TName>,
    private readonly field: string,
    private readonly predicates: Predicate<RecordOf<TName>>[] = [],
  ) {}

  equals(value: unknown) {
    return new WorkspaceCollection(this.table, [], [
      ...this.predicates,
      (record) => fieldMatches(getFieldValue(record, this.field), value),
    ]);
  }

  anyOf(values: unknown[]) {
    return new WorkspaceCollection(this.table, [], [
      ...this.predicates,
      (record) => values.some((value) => fieldMatches(getFieldValue(record, this.field), value)),
    ]);
  }
}

class WorkspaceCollection<TName extends TableName> {
  constructor(
    private readonly table: WorkspaceTable<TName>,
    private readonly sorters: Array<(left: RecordOf<TName>, right: RecordOf<TName>) => number> = [],
    private readonly predicates: Predicate<RecordOf<TName>>[] = [],
    private readonly limitCount?: number,
  ) {}

  reverse() {
    return new WorkspaceCollection(
      this.table,
      this.sorters.map((sorter) => (left, right) => -sorter(left, right)),
      this.predicates,
      this.limitCount,
    );
  }

  filter(predicate: Predicate<RecordOf<TName>>) {
    return new WorkspaceCollection(this.table, this.sorters, [...this.predicates, predicate], this.limitCount);
  }

  limit(count: number) {
    return new WorkspaceCollection(this.table, this.sorters, this.predicates, count);
  }

  or(field: string) {
    return new WorkspaceOrClause(this, this.table, field);
  }

  async sortBy(field: string) {
    return (await this.toArray()).sort((left, right) => compareValues(getFieldValue(left, field), getFieldValue(right, field)));
  }

  async first() {
    return (await this.toArray())[0];
  }

  async last() {
    const records = await this.toArray();
    return records[records.length - 1];
  }

  async count() {
    return (await this.toArray()).length;
  }

  async delete() {
    const doomed = new Set((await this.toArray()).map((record) => getRecordKey(this.table.name, record)));
    await enqueueWrite(async (state) => {
      replaceTableRecords(
        state,
        this.table.name,
        getTableRecords(state, this.table.name).filter((record) => !doomed.has(getRecordKey(this.table.name, record))),
      );
    });
  }

  async modify(mutator: Mutator<RecordOf<TName>>) {
    await enqueueWrite(async (state) => {
      const records = getTableRecords(state, this.table.name);
      const selected = await this.selectedKeys();
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (!selected.has(getRecordKey(this.table.name, record))) continue;
        const draft = cloneFromStorage(this.table.name, record);
        const result = await mutator(draft);
        if (result !== false) {
          records[index] = cloneForStorage(this.table.name, draft);
        }
      }
    });
  }

  async toArray() {
    let records = await this.table.toArray();
    records = records.filter((record) => this.predicates.every((predicate) => predicate(record)));
    for (const sorter of this.sorters) records = records.sort(sorter);
    if (typeof this.limitCount === 'number') records = records.slice(0, Math.max(0, this.limitCount));
    return records;
  }

  private async selectedKeys() {
    return new Set((await this.toArray()).map((record) => getRecordKey(this.table.name, record)));
  }
}

class WorkspaceOrClause<TName extends TableName> {
  constructor(
    private readonly base: WorkspaceCollection<TName>,
    private readonly table: WorkspaceTable<TName>,
    private readonly field: string,
  ) {}

  equals(value: unknown) {
    const branch = new WorkspaceCollection(this.table, [], [(record) => fieldMatches(getFieldValue(record, this.field), value)]);
    return new WorkspaceUnionCollection(this.table, [this.base, branch]);
  }
}

class WorkspaceUnionCollection<TName extends TableName> {
  constructor(
    private readonly table: WorkspaceTable<TName>,
    private readonly branches: WorkspaceCollection<TName>[],
  ) {}

  filter(predicate: Predicate<RecordOf<TName>>) {
    return new WorkspaceUnionCollection(
      this.table,
      this.branches.map((branch) => branch.filter(predicate)),
    );
  }

  async toArray() {
    const byKey = new Map<string, RecordOf<TName>>();
    for (const branch of this.branches) {
      for (const record of await branch.toArray()) {
        byKey.set(getRecordKey(this.table.name, record), record);
      }
    }
    return [...byKey.values()];
  }

  async first() {
    return (await this.toArray())[0];
  }

  async count() {
    return (await this.toArray()).length;
  }

  async delete() {
    const doomed = new Set((await this.toArray()).map((record) => getRecordKey(this.table.name, record)));
    await enqueueWrite(async (state) => {
      replaceTableRecords(
        state,
        this.table.name,
        getTableRecords(state, this.table.name).filter((record) => !doomed.has(getRecordKey(this.table.name, record))),
      );
    });
  }
}

export const db = new MyWikiDatabase();

export async function resetDatabase() {
  rawAssetBlobStore.clear();
  useInMemoryStore = !canUseWorkspaceStorage();
  activeRecordsPath = useInMemoryStore ? inMemoryWorkspaceRoot : null;
  activeState = emptyWorkspaceRecordState();
  if (!useInMemoryStore) {
    await persistState(activeState);
  }
}

export async function getWorkspaceRecordStatePath() {
  return resolveRecordsPath();
}

export function createWorkspaceRecordState(records?: Partial<WorkspaceRecordState['records']>): WorkspaceRecordState {
  return normalizeState({
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    records: {
      ...emptyWorkspaceRecordState().records,
      ...records,
    },
  });
}

export async function replaceWorkspaceRecordState(state: WorkspaceRecordState) {
  const normalized = normalizeState(state);
  await enqueueWrite((current) => {
    current.version = normalized.version;
    current.createdAt = normalized.createdAt;
    current.updatedAt = normalized.updatedAt;
    current.records = normalized.records;
  });
}

export async function reloadWorkspaceRecordStateFromDisk() {
  activeRecordsPath = null;
  activeState = null;
  await loadState();
  notifyWorkspaceDbChanged();
}

export function clearWorkspaceRecordRuntimeCache() {
  activeRecordsPath = null;
  activeState = null;
}

async function enqueueWrite<T>(operation: (state: WorkspaceRecordState) => Promise<T> | T): Promise<T> {
  if (transactionState) {
    const result = await operation(transactionState);
    transactionState.updatedAt = Date.now();
    return result;
  }

  const run = operationQueue.then(async () => {
    const state = await loadState();
    const result = await operation(state);
    state.updatedAt = Date.now();
    await persistState(state);
    notifyWorkspaceDbChanged();
    return result;
  });
  operationQueue = run.catch(() => undefined);
  return run;
}

async function loadState(): Promise<WorkspaceRecordState> {
  const recordsPath = await resolveRecordsPath();
  if (activeState && activeRecordsPath === recordsPath) return activeState;

  if (useInMemoryStore) {
    activeRecordsPath = recordsPath;
    activeState = activeState ?? emptyWorkspaceRecordState();
    return activeState;
  }

  const storage = createWorkspaceStorage();
  if (!(await storage.exists(recordsPath))) {
    activeRecordsPath = recordsPath;
    activeState = emptyWorkspaceRecordState();
    await storage.writeTextFile(recordsPath, `${JSON.stringify(serializeState(activeState), null, 2)}\n`);
    return activeState;
  }

  const raw = await storage.readTextFile(recordsPath);
  activeRecordsPath = recordsPath;
  activeState = parseState(raw);
  return activeState;
}

async function persistState(state: WorkspaceRecordState) {
  if (useInMemoryStore) {
    activeState = state;
    return;
  }
  const recordsPath = await resolveRecordsPath();
  const storage = createWorkspaceStorage();
  await storage.writeTextFile(recordsPath, `${JSON.stringify(serializeState(state), null, 2)}\n`);
  activeRecordsPath = recordsPath;
  activeState = state;
}

async function resolveRecordsPath() {
  if (!canUseWorkspaceStorage()) {
    useInMemoryStore = true;
    return inMemoryWorkspaceRoot;
  }
  useInMemoryStore = false;
  const storage = createWorkspaceStorage();
  const root = getPersistedWorkspaceRoot() ?? (await getWorkspaceDefaultRoot());
  const initialized = await initializeWorkspace(storage, root, { outputLanguage: 'zh-CN' });
  return buildWorkspaceLayout(initialized.layout.root).recordsState;
}

function emptyWorkspaceRecordState(): WorkspaceRecordState {
  const now = Date.now();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    records: {
      entries: [],
      entities: [],
      relationships: [],
      tasks: [],
      compileSuggestions: [],
      ingestJobs: [],
      ingestCache: [],
      graphInsightDismissals: [],
      rawAssets: [],
      queryCache: [],
      wikiBatchJobs: [],
      wikiReviewItems: [],
    },
  };
}

function parseState(raw: string) {
  try {
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Workspace records file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeState(value: unknown): WorkspaceRecordState {
  if (!value || typeof value !== 'object') {
    throw new Error('Workspace records state is invalid.');
  }
  const state = value as Partial<WorkspaceRecordState>;
  const empty = emptyWorkspaceRecordState();
  const records =
    state.records && typeof state.records === 'object'
      ? (state.records as Partial<WorkspaceRecordState['records']>)
      : ({} as Partial<WorkspaceRecordState['records']>);
  return {
    version: 1,
    createdAt: typeof state.createdAt === 'number' ? state.createdAt : empty.createdAt,
    updatedAt: typeof state.updatedAt === 'number' ? state.updatedAt : empty.updatedAt,
    records: Object.fromEntries(
      tableNames.map((name) => [name, Array.isArray(records[name]) ? cloneFromStorage(name, records[name]) : []]),
    ) as WorkspaceRecordState['records'],
  };
}

function serializeState(state: WorkspaceRecordState) {
  return {
    ...state,
    records: {
      ...state.records,
      rawAssets: state.records.rawAssets.map(serializeRawAssetRecord),
    },
  };
}

function getTableRecords<TName extends TableName>(state: WorkspaceRecordState, name: TName): RecordOf<TName>[] {
  return state.records[name] as RecordOf<TName>[];
}

function replaceTableRecords<TName extends TableName>(state: WorkspaceRecordState, name: TName, records: RecordOf<TName>[]) {
  (state.records[name] as RecordOf<TName>[]) = records.map((record) => cloneForStorage(name, record));
}

function upsertRecord<TName extends TableName>(records: RecordOf<TName>[], tableName: TName, record: RecordOf<TName>) {
  const key = getRecordKey(tableName, record);
  const index = records.findIndex((item) => getRecordKey(tableName, item) === key);
  const stored = cloneForStorage(tableName, record);
  if (index >= 0) records[index] = stored;
  else records.push(stored);
}

function getRecordKey<TName extends TableName>(tableName: TName, record: RecordOf<TName>) {
  if (tableName === 'ingestCache') return String((record as IngestCacheRecord).contentHash);
  if (tableName === 'queryCache') return String((record as QueryCacheRecord).key);
  return String((record as { id?: string }).id ?? '');
}

function getFieldValue(record: unknown, field: string): unknown {
  return (record as Record<string, unknown>)[field];
}

function fieldMatches(fieldValue: unknown, expected: unknown) {
  if (Array.isArray(fieldValue)) return fieldValue.includes(expected);
  return fieldValue === expected;
}

function compareValues(left: unknown, right: unknown) {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left ?? '').localeCompare(String(right ?? ''), 'zh-Hans-CN');
}

function cloneForStorage<TName extends TableName>(tableName: TName, value: RecordOf<TName>): RecordOf<TName> {
  if (tableName === 'rawAssets') return serializeRawAssetRecord(value as RawAsset) as RecordOf<TName>;
  return structuredCloneSafe(value);
}

function cloneFromStorage<TName extends TableName>(tableName: TName, value: RecordOf<TName>): RecordOf<TName>;
function cloneFromStorage<TName extends TableName>(tableName: TName, value: RecordOf<TName>[]): RecordOf<TName>[];
function cloneFromStorage<TName extends TableName>(tableName: TName, value: RecordOf<TName> | RecordOf<TName>[]) {
  if (Array.isArray(value)) return value.map((item) => cloneFromStorage(tableName, item));
  if (tableName === 'rawAssets') return deserializeRawAssetRecord(value as RawAsset);
  return structuredCloneSafe(value);
}

function serializeRawAssetRecord(asset: RawAsset): RawAsset {
  const { blob: _blob, ...rest } = asset;
  if (asset.blob && asset.blob.size > 0) rawAssetBlobStore.set(asset.id, asset.blob);
  else rawAssetBlobStore.delete(asset.id);
  return {
    ...structuredCloneSafe(rest),
    dataBase64: asset.dataBase64,
    blob: new Blob([], { type: asset.mimeType || 'application/octet-stream' }),
  };
}

function deserializeRawAssetRecord(asset: RawAsset): RawAsset {
  const cloned = structuredCloneSafe(asset);
  const runtimeBlob = rawAssetBlobStore.get(asset.id);
  const blob =
    runtimeBlob && runtimeBlob.size > 0
      ? runtimeBlob
      : base64ToBlob(asset.dataBase64 ?? '', asset.mimeType || 'application/octet-stream');
  return {
    ...cloned,
    blob,
  };
}

function base64ToBlob(base64: string, mimeType: string) {
  if (!base64) return new Blob([], { type: mimeType });
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
