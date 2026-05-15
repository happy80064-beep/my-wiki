import { buildMarkdownExportFiles } from '@/lib/export/markdown';
import { parseMarkdownExportFileRecords, restoreMarkdownImportRecords } from '@/lib/export/importMarkdown';
import { db } from '@/lib/db';
import {
  buildIndexedDbSnapshot,
  countIndexedDbSnapshotRecords,
  parseWorkspaceIndexedDbSnapshotJson,
  restoreIndexedDbSnapshot,
  workspaceIndexedDbSnapshotFileName,
} from './indexedDbSnapshot';
import { assertSafeWorkspaceRelativePath, buildWorkspaceLayout, joinWorkspacePath, normalizeWorkspacePath } from './paths';
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

export type WorkspaceRestoreMode = 'snapshot' | 'markdown' | 'empty';

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

export async function syncIndexedDbKnowledgeToDefaultWorkspace(rootOverride?: string): Promise<WorkspaceSyncResult | undefined> {
  if (!canUseWorkspaceStorage()) return undefined;

  const storage = createWorkspaceStorage();
  const root = rootOverride ?? getPersistedWorkspaceRoot() ?? (await getWorkspaceDefaultRoot());
  const initialized = await initializeWorkspace(storage, root, { outputLanguage: 'zh-CN' });
  const files = await buildMarkdownExportFiles();
  let writtenFiles = 0;

  for (const file of files) {
    const relativePath = assertSafeWorkspaceRelativePath(file.path);
    await storage.writeTextFile(joinWorkspacePath(initialized.layout.root, relativePath), file.content);
    writtenFiles += 1;
  }

  const snapshotPath = joinWorkspacePath(initialized.layout.state, workspaceIndexedDbSnapshotFileName);
  await storage.writeTextFile(snapshotPath, `${JSON.stringify(await buildIndexedDbSnapshot(), null, 2)}\n`);

  return { root: initialized.layout.root, writtenFiles, snapshotPath };
}

export async function restoreIndexedDbKnowledgeFromWorkspace(rootOverride?: string): Promise<WorkspaceRestoreResult | undefined> {
  if (!canUseWorkspaceStorage()) return undefined;

  const storage = createWorkspaceStorage();
  const root = rootOverride ?? getPersistedWorkspaceRoot() ?? (await getWorkspaceDefaultRoot());
  return restoreIndexedDbKnowledgeFromWorkspaceStorage(storage, root);
}

export async function switchIndexedDbKnowledgeWorkspace(targetRoot: string): Promise<WorkspaceSwitchResult> {
  if (!canUseWorkspaceStorage()) {
    throw new Error('切换知识库需要桌面壳，或通过 localhost:5173 开发服务运行。');
  }

  const storage = createWorkspaceStorage();
  const target = normalizeWorkspacePath(targetRoot);
  const previousRoot = normalizeWorkspacePath(getPersistedWorkspaceRoot() ?? (await getWorkspaceDefaultRoot()));

  if (previousRoot.toLowerCase() !== target.toLowerCase()) {
    await syncIndexedDbKnowledgeToDefaultWorkspace(previousRoot);
  }

  const restore = await restoreIndexedDbKnowledgeFromWorkspaceStorage(storage, target);
  const workspace = await initializeAndScanWorkspace(storage, target, { outputLanguage: 'zh-CN' });
  return { previousRoot, root: workspace.layout.root, workspace, restore };
}

async function restoreIndexedDbKnowledgeFromWorkspaceStorage(
  storage: TauriWorkspaceStorage,
  root: string,
): Promise<WorkspaceRestoreResult> {
  const initialized = await initializeWorkspace(storage, root, { outputLanguage: 'zh-CN' });
  const snapshotPath = joinWorkspacePath(initialized.layout.state, workspaceIndexedDbSnapshotFileName);

  if (await storage.exists(snapshotPath)) {
    const snapshot = parseWorkspaceIndexedDbSnapshotJson(await storage.readTextFile(snapshotPath));
    await restoreIndexedDbSnapshot(snapshot);
    return {
      root: initialized.layout.root,
      mode: 'snapshot',
      counts: countIndexedDbSnapshotRecords(snapshot),
    };
  }

  const records = parseMarkdownExportFileRecords(await readWorkspaceMarkdownFileRecords(storage, initialized.layout.root));
  await restoreMarkdownImportRecords(records);

  return {
    root: initialized.layout.root,
    mode: records.entries.length || records.entities.length || records.relationships.length || records.tasks.length ? 'markdown' : 'empty',
    counts: {
      entries: records.entries.length,
      entities: records.entities.length,
      relationships: records.relationships.length,
      tasks: records.tasks.length,
    },
  };
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
