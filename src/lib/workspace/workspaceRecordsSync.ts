import { buildMarkdownExportFiles } from '@/lib/export/markdown';
import { parseMarkdownExportFileRecords } from '@/lib/export/importMarkdown';
import {
  createWorkspaceRecordState,
  clearWorkspaceRecordRuntimeCache,
  db,
  readWorkspaceRecordStateWithRecovery,
  replaceWorkspaceRecordState,
  type WorkspaceRecordState,
} from '@/lib/db/schema';
import { buildWorkspaceLayout, joinWorkspacePath, normalizeWorkspacePath } from './paths';
import { getPersistedWorkspaceRoot } from './activeWorkspace';
import { canUseWorkspaceStorage, createWorkspaceStorage, getWorkspaceDefaultRoot } from './storage';
import { initializeAndScanWorkspace, type WorkspaceSnapshot } from './service';
import type { TauriWorkspaceStorage } from './tauriStorage';
import { initializeWorkspace } from './workspace';

export type WorkspaceSyncResult = {
  root: string;
  writtenFiles: number;
  snapshotPath?: string;
};

export type WorkspaceRestoreMode = 'records' | 'markdown' | 'empty';

export type WorkspaceRestoreResult = {
  root: string;
  mode: WorkspaceRestoreMode;
  counts: {
    entries: number;
    entities: number;
    relationships: number;
    tasks: number;
    compileSuggestions?: number;
    ingestJobs?: number;
    rawAssets?: number;
    wikiBatchJobs?: number;
  };
};

export type WorkspaceSwitchResult = {
  previousRoot: string;
  root: string;
  workspace: WorkspaceSnapshot;
  restore: WorkspaceRestoreResult;
};

type MigrationState = {
  version: 1;
  status: 'migrated' | 'failed';
  source: 'workspace-records' | 'workspace-markdown';
  migratedAt?: number;
  failedAt?: number;
  error?: string;
  counts?: WorkspaceRestoreResult['counts'];
};

export async function syncWorkspaceRecordsToDefaultWorkspace(rootOverride?: string): Promise<WorkspaceSyncResult | undefined> {
  if (!canUseWorkspaceStorage()) return undefined;

  const storage = createWorkspaceStorage();
  const root = rootOverride ?? getPersistedWorkspaceRoot() ?? (await getWorkspaceDefaultRoot());
  const initialized = await initializeWorkspace(storage, root, { outputLanguage: 'zh-CN' });
  const files = await buildMarkdownExportFiles();
  let writtenFiles = 0;

  for (const file of files) {
    await storage.writeTextFile(joinWorkspacePath(initialized.layout.root, file.path), file.content);
    writtenFiles += 1;
  }

  if (storage.writeBinaryFile) {
    for (const asset of await db.rawAssets.toArray()) {
      const dataBase64 = asset.dataBase64 || (asset.blob ? await blobToBase64(asset.blob) : '');
      if (!dataBase64) continue;
      await storage.writeBinaryFile(joinWorkspacePath(initialized.layout.rawSources, sanitizeWorkspaceRawAssetPath(asset.filename)), dataBase64);
      writtenFiles += 1;
    }
  }

  const counts = await currentRecordCounts();
  await writeMigrationState(storage, initialized.layout.root, {
    version: 1,
    status: 'migrated',
    source: 'workspace-records',
    migratedAt: Date.now(),
    counts,
  });

  return { root: initialized.layout.root, writtenFiles, snapshotPath: initialized.layout.recordsState };
}

export async function restoreWorkspaceRecordsFromWorkspace(rootOverride?: string): Promise<WorkspaceRestoreResult | undefined> {
  if (!canUseWorkspaceStorage()) return undefined;

  const storage = createWorkspaceStorage();
  const root = rootOverride ?? getPersistedWorkspaceRoot() ?? (await getWorkspaceDefaultRoot());
  return loadWorkspaceRecordsAsRuntime(storage, root);
}

export async function switchWorkspaceRecordsRoot(targetRoot: string): Promise<WorkspaceSwitchResult> {
  if (!canUseWorkspaceStorage()) {
    throw new Error('切换知识库需要桌面壳，或通过 localhost:5173 开发服务运行。');
  }

  const storage = createWorkspaceStorage();
  const target = normalizeWorkspacePath(targetRoot);
  const previousRoot = normalizeWorkspacePath(getPersistedWorkspaceRoot() ?? (await getWorkspaceDefaultRoot()));
  const restore = await loadWorkspaceRecordsAsRuntime(storage, target);
  const workspace = await initializeAndScanWorkspace(storage, target, { outputLanguage: 'zh-CN' });
  return { previousRoot, root: workspace.layout.root, workspace, restore };
}

async function loadWorkspaceRecordsAsRuntime(storage: TauriWorkspaceStorage, root: string): Promise<WorkspaceRestoreResult> {
  const initialized = await initializeWorkspace(storage, root, { outputLanguage: 'zh-CN' });
  const layout = buildWorkspaceLayout(initialized.layout.root);

  try {
    if (await storage.exists(layout.recordsState)) {
      const state = await repairDegradedRecordStateFromMarkdownIfRicher(
        storage,
        layout.root,
        await readWorkspaceRecordStateWithRecovery(storage, layout.recordsState),
      );
      clearWorkspaceRecordRuntimeCache();
      await replaceWorkspaceRecordState(state);
      const counts = countWorkspaceRecords(state);
      await writeMigrationState(storage, layout.root, {
        version: 1,
        status: 'migrated',
        source: 'workspace-records',
        migratedAt: Date.now(),
        counts,
      });
      return { root: layout.root, mode: 'records', counts };
    }

    if (await hasFailedRecordsMigration(storage, layout.migrationState)) {
      throw new Error('Lossless workspace switch stopped: records.json is missing after a previous records migration failure. A valid records.json or .mywiki/snapshots backup is required before using Markdown recovery.');
    }

    const records = parseMarkdownExportFileRecords(await readWorkspaceMarkdownFileRecords(storage, layout.root));
    const state = createWorkspaceRecordState(records);
    await storage.writeTextFile(layout.recordsState, `${JSON.stringify(state, null, 2)}\n`);
    await replaceWorkspaceRecordState(state);
    const counts = countWorkspaceRecords(state);
    await writeMigrationState(storage, layout.root, {
      version: 1,
      status: 'migrated',
      source: records.entries.length || records.entities.length || records.relationships.length || records.tasks.length ? 'workspace-markdown' : 'workspace-records',
      migratedAt: Date.now(),
      counts,
    });
    return {
      root: layout.root,
      mode: records.entries.length || records.entities.length || records.relationships.length || records.tasks.length ? 'markdown' : 'empty',
      counts,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeMigrationState(storage, layout.root, {
      version: 1,
      status: 'failed',
      source: 'workspace-records',
      failedAt: Date.now(),
      error: message,
    });
    throw new Error(`工作区数据迁移失败，已停止切换以避免静默降级：${message}`);
  }
}

async function repairDegradedRecordStateFromMarkdownIfRicher(
  storage: TauriWorkspaceStorage,
  root: string,
  current: WorkspaceRecordState,
) {
  if (!looksLikeDegradedMarkdownRestore(current)) return current;
  const records = parseMarkdownExportFileRecords(await readWorkspaceMarkdownFileRecords(storage, root));
  const repaired = createWorkspaceRecordState(records);
  if (recordRichnessScore(repaired) <= recordRichnessScore(current)) return current;

  const layout = buildWorkspaceLayout(root);
  await storage.writeTextFile(layout.recordsState, `${JSON.stringify(repaired, null, 2)}\n`);
  return repaired;
}

function looksLikeDegradedMarkdownRestore(state: WorkspaceRecordState) {
  const entityCount = state.records.entities.length;
  if (entityCount === 0) return false;
  const wikiReady = state.records.entities.filter((entity) => entity.wikiMarkdown?.trim()).length;
  const sourceBacked = state.records.entities.filter((entity) => entity.sourceEntries.length > 0).length;
  return wikiReady <= Math.max(1, Math.floor(entityCount * 0.1)) && sourceBacked <= Math.max(1, Math.floor(entityCount * 0.1)) && state.records.relationships.length === 0;
}

function recordRichnessScore(state: WorkspaceRecordState) {
  return (
    state.records.entities.filter((entity) => entity.wikiMarkdown?.trim()).length * 10
    + state.records.entities.filter((entity) => entity.sourceEntries.length > 0).length * 5
    + state.records.relationships.length
  );
}

async function hasFailedRecordsMigration(storage: TauriWorkspaceStorage, migrationStatePath: string) {
  if (!(await storage.exists(migrationStatePath))) return false;
  try {
    const raw = await storage.readTextFile(migrationStatePath);
    const state = JSON.parse(raw) as Partial<MigrationState>;
    return state.status === 'failed' && state.source === 'workspace-records';
  } catch {
    return false;
  }
}

async function readWorkspaceMarkdownFileRecords(storage: TauriWorkspaceStorage, root: string) {
  const layout = buildWorkspaceLayout(root);
  const files = await storage.listFiles(layout.root);
  const markdownFiles = files
    .map(normalizeWorkspacePath)
    .filter((path) => path.toLowerCase().endsWith('.md'))
    .filter((path) => path.startsWith(`${layout.root}/`));

  return Promise.all(
    markdownFiles.map(async (path) => ({
      path: path.slice(layout.root.length + 1),
      content: await storage.readTextFile(path),
    })),
  );
}

async function writeMigrationState(storage: TauriWorkspaceStorage, root: string, state: MigrationState) {
  const layout = buildWorkspaceLayout(root);
  await storage.writeTextFile(layout.migrationState, `${JSON.stringify(state, null, 2)}\n`);
}

async function currentRecordCounts() {
  const [entries, entities, relationships, tasks, compileSuggestions, ingestJobs, rawAssets, wikiBatchJobs] = await Promise.all([
    db.entries.count(),
    db.entities.count(),
    db.relationships.count(),
    db.tasks.count(),
    db.compileSuggestions.count(),
    db.ingestJobs.count(),
    db.rawAssets.count(),
    db.wikiBatchJobs.count(),
  ]);
  return { entries, entities, relationships, tasks, compileSuggestions, ingestJobs, rawAssets, wikiBatchJobs };
}

function countWorkspaceRecords(state: WorkspaceRecordState) {
  return {
    entries: state.records.entries.length,
    entities: state.records.entities.length,
    relationships: state.records.relationships.length,
    tasks: state.records.tasks.length,
    compileSuggestions: state.records.compileSuggestions.length,
    ingestJobs: state.records.ingestJobs.length,
    rawAssets: state.records.rawAssets.length,
    wikiBatchJobs: state.records.wikiBatchJobs.length,
  };
}

function sanitizeWorkspaceRawAssetPath(value: string) {
  return (
    value
      .replace(/\\/g, '/')
      .split('/')
      .map((part) =>
        part
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
          .replace(/\s+/g, ' ')
          .replace(/^\.+$/g, '')
          .replace(/\.+$/g, '')
          .trim()
          .slice(0, 120),
      )
      .filter(Boolean)
      .join('/') || 'unknown'
  );
}

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
