import {
  canUseWorkspaceStorage,
  createWorkspaceStorage,
  getPersistedWorkspaceRoot,
  getWorkspaceDefaultRoot,
  initializeWorkspace,
  joinWorkspacePath,
  type WorkspaceFileStorageAdapter,
} from '@/lib/workspace';
import type { RawAsset } from '@/types';

export type RawAssetWorkspaceQueueTaskStatus = 'pending' | 'processing' | 'done' | 'failed' | 'cancelled';
export type RawAssetWorkspaceQueueTaskStage = 'queued' | 'extracting' | 'structuring' | 'wiki';

export type RawAssetWorkspaceQueueTask = {
  id: string;
  rawAssetId: string;
  owner: string;
  sourcePath: string;
  filename: string;
  contentHash: string;
  status: RawAssetWorkspaceQueueTaskStatus;
  stage: RawAssetWorkspaceQueueTaskStage;
  compileWiki: boolean;
  retryCount: number;
  addedAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
};

export type RawAssetWorkspaceQueueFile = {
  version: 1;
  updatedAt: number;
  tasks: RawAssetWorkspaceQueueTask[];
};

export type RawAssetWorkspaceQueueSnapshot = RawAssetWorkspaceQueueFile & {
  root: string;
  path: string;
};

export async function loadRawAssetWorkspaceQueue(): Promise<RawAssetWorkspaceQueueSnapshot | null> {
  const target = await resolveQueueTarget();
  if (!target) return null;
  const queue = await readQueueFile(target.storage, target.path);
  return {
    ...queue,
    root: target.root,
    path: target.path,
  };
}

export async function prepareRawAssetWorkspaceQueue(
  assets: RawAsset[],
  input: { owner: string; compileWiki: boolean },
): Promise<Map<string, RawAssetWorkspaceQueueTask>> {
  const target = await resolveQueueTarget();
  if (!target) return new Map();

  const queue = await readQueueFile(target.storage, target.path);
  const now = Date.now();
  const taskByRawAssetId = new Map(queue.tasks.map((task) => [task.rawAssetId, task]));

  for (const asset of assets) {
    const existing = taskByRawAssetId.get(asset.id);
    const task: RawAssetWorkspaceQueueTask = {
      id: existing?.id ?? createQueueTaskId(asset.id),
      rawAssetId: asset.id,
      owner: input.owner,
      sourcePath: joinWorkspacePath('raw/sources', asset.filename),
      filename: asset.filename,
      contentHash: asset.contentHash,
      status: 'pending',
      stage: 'queued',
      compileWiki: input.compileWiki,
      retryCount: existing?.retryCount ?? 0,
      addedAt: existing?.addedAt ?? now,
      updatedAt: now,
      startedAt: existing?.startedAt,
      completedAt: undefined,
      error: undefined,
    };
    taskByRawAssetId.set(asset.id, task);
  }

  queue.tasks = pruneQueueTasks(Array.from(taskByRawAssetId.values()));
  queue.updatedAt = now;
  await writeQueueFile(target.storage, target.path, queue);
  return new Map(queue.tasks.map((task) => [task.rawAssetId, task]));
}

export async function updateRawAssetWorkspaceQueueTask(
  rawAssetId: string,
  updater: (task: RawAssetWorkspaceQueueTask) => RawAssetWorkspaceQueueTask,
): Promise<RawAssetWorkspaceQueueTask | null> {
  const target = await resolveQueueTarget();
  if (!target) return null;

  const queue = await readQueueFile(target.storage, target.path);
  const taskIndex = queue.tasks.findIndex((task) => task.rawAssetId === rawAssetId);
  if (taskIndex < 0) return null;

  const updated = updater(queue.tasks[taskIndex]);
  queue.tasks[taskIndex] = {
    ...updated,
    updatedAt: Date.now(),
  };
  queue.tasks = pruneQueueTasks(queue.tasks);
  queue.updatedAt = Date.now();
  await writeQueueFile(target.storage, target.path, queue);
  return queue.tasks.find((task) => task.rawAssetId === rawAssetId) ?? null;
}

export async function updateRawAssetWorkspaceQueueTaskById(
  taskId: string,
  updater: (task: RawAssetWorkspaceQueueTask) => RawAssetWorkspaceQueueTask,
): Promise<RawAssetWorkspaceQueueTask | null> {
  const target = await resolveQueueTarget();
  if (!target) return null;

  const queue = await readQueueFile(target.storage, target.path);
  const taskIndex = queue.tasks.findIndex((task) => task.id === taskId);
  if (taskIndex < 0) return null;

  const updated = updater(queue.tasks[taskIndex]);
  queue.tasks[taskIndex] = {
    ...updated,
    updatedAt: Date.now(),
  };
  queue.tasks = pruneQueueTasks(queue.tasks);
  queue.updatedAt = Date.now();
  await writeQueueFile(target.storage, target.path, queue);
  return queue.tasks.find((task) => task.id === taskId) ?? null;
}

export async function getRawAssetWorkspaceQueueTask(taskId: string): Promise<RawAssetWorkspaceQueueTask | null> {
  const queue = await loadRawAssetWorkspaceQueue();
  return queue?.tasks.find((task) => task.id === taskId) ?? null;
}

export async function clearRawAssetWorkspaceQueueTasks(statuses: RawAssetWorkspaceQueueTaskStatus[]): Promise<number> {
  const target = await resolveQueueTarget();
  if (!target) return 0;

  const queue = await readQueueFile(target.storage, target.path);
  const removable = new Set(statuses);
  const before = queue.tasks.length;
  queue.tasks = queue.tasks.filter((task) => !removable.has(task.status));
  const removed = before - queue.tasks.length;
  if (removed > 0) {
    queue.updatedAt = Date.now();
    await writeQueueFile(target.storage, target.path, queue);
  }
  return removed;
}

export async function resetInterruptedRawAssetWorkspaceQueueTasks(): Promise<number> {
  const target = await resolveQueueTarget();
  if (!target) return 0;

  const queue = await readQueueFile(target.storage, target.path);
  let recovered = 0;
  const now = Date.now();
  queue.tasks = queue.tasks.map((task) => {
    if (task.status !== 'processing') return task;
    recovered += 1;
    return {
      ...task,
      status: 'pending',
      stage: 'queued',
      error: 'Previous run was interrupted before completion.',
      updatedAt: now,
    };
  });
  if (recovered > 0) {
    queue.updatedAt = now;
    await writeQueueFile(target.storage, target.path, queue);
  }
  return recovered;
}

export function summarizeRawAssetWorkspaceQueue(tasks: RawAssetWorkspaceQueueTask[]) {
  return {
    pending: tasks.filter((task) => task.status === 'pending').length,
    processing: tasks.filter((task) => task.status === 'processing').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    cancelled: tasks.filter((task) => task.status === 'cancelled').length,
    done: tasks.filter((task) => task.status === 'done').length,
    total: tasks.length,
  };
}

function createQueueTaskId(rawAssetId: string) {
  return `rawq-${rawAssetId}`;
}

async function resolveQueueTarget(): Promise<{ storage: WorkspaceFileStorageAdapter; root: string; path: string } | null> {
  if (!canUseWorkspaceStorage()) return null;
  const storage = createWorkspaceStorage();
  const root = getPersistedWorkspaceRoot() ?? (await getWorkspaceDefaultRoot());
  const initialized = await initializeWorkspace(storage, root, { outputLanguage: 'zh-CN' });
  return {
    storage,
    root: initialized.layout.root,
    path: initialized.layout.ingestQueue,
  };
}

async function readQueueFile(storage: WorkspaceFileStorageAdapter, path: string): Promise<RawAssetWorkspaceQueueFile> {
  try {
    if (!(await storage.exists(path))) return createEmptyQueue();
    const raw = await storage.readTextFile(path);
    return normalizeQueueFile(JSON.parse(raw));
  } catch {
    return createEmptyQueue();
  }
}

async function writeQueueFile(storage: WorkspaceFileStorageAdapter, path: string, queue: RawAssetWorkspaceQueueFile) {
  await storage.writeTextFile(path, `${JSON.stringify(normalizeQueueFile(queue), null, 2)}\n`);
}

function createEmptyQueue(): RawAssetWorkspaceQueueFile {
  return {
    version: 1,
    updatedAt: Date.now(),
    tasks: [],
  };
}

function normalizeQueueFile(value: unknown): RawAssetWorkspaceQueueFile {
  const now = Date.now();
  const rawTasks = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { tasks?: unknown }).tasks)
      ? (value as { tasks: unknown[] }).tasks
      : [];
  return {
    version: 1,
    updatedAt:
      value && typeof value === 'object' && Number.isFinite((value as { updatedAt?: unknown }).updatedAt)
        ? Number((value as { updatedAt: number }).updatedAt)
        : now,
    tasks: pruneQueueTasks(rawTasks.map(normalizeTask).filter((task): task is RawAssetWorkspaceQueueTask => Boolean(task))),
  };
}

function normalizeTask(value: unknown): RawAssetWorkspaceQueueTask | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<RawAssetWorkspaceQueueTask>;
  if (!raw.rawAssetId || typeof raw.rawAssetId !== 'string') return null;
  if (!raw.filename || typeof raw.filename !== 'string') return null;

  const now = Date.now();
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createQueueTaskId(raw.rawAssetId),
    rawAssetId: raw.rawAssetId,
    owner: typeof raw.owner === 'string' && raw.owner ? raw.owner : 'wiki',
    sourcePath: typeof raw.sourcePath === 'string' && raw.sourcePath ? raw.sourcePath : joinWorkspacePath('raw/sources', raw.filename),
    filename: raw.filename,
    contentHash: typeof raw.contentHash === 'string' ? raw.contentHash : '',
    status: normalizeTaskStatus(raw.status),
    stage: normalizeTaskStage(raw.stage),
    compileWiki: Boolean(raw.compileWiki),
    retryCount: Math.max(0, Math.round(Number(raw.retryCount) || 0)),
    addedAt: Number.isFinite(raw.addedAt) ? Number(raw.addedAt) : now,
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : now,
    startedAt: Number.isFinite(raw.startedAt) ? Number(raw.startedAt) : undefined,
    completedAt: Number.isFinite(raw.completedAt) ? Number(raw.completedAt) : undefined,
    error: typeof raw.error === 'string' && raw.error ? raw.error : undefined,
  };
}

function normalizeTaskStatus(value: unknown): RawAssetWorkspaceQueueTaskStatus {
  return value === 'processing' || value === 'done' || value === 'failed' || value === 'cancelled' ? value : 'pending';
}

function normalizeTaskStage(value: unknown): RawAssetWorkspaceQueueTaskStage {
  return value === 'extracting' || value === 'structuring' || value === 'wiki' ? value : 'queued';
}

function pruneQueueTasks(tasks: RawAssetWorkspaceQueueTask[]) {
  const sorted = [...tasks].sort((left, right) => left.addedAt - right.addedAt);
  return sorted.filter((task) => task.status !== 'done');
}
