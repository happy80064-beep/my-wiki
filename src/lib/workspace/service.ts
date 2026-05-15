import { scanWikiPages, type WikiPageIndexEntry } from '@/lib/wiki/scanner';
import { initializeWorkspace, type InitializeWorkspaceOptions, type InitializeWorkspaceResult } from './workspace';
import type { TauriWorkspaceStorage } from './tauriStorage';

export type WorkspaceSnapshot = InitializeWorkspaceResult & {
  pages: WikiPageIndexEntry[];
};

export async function initializeAndScanWorkspace(
  storage: TauriWorkspaceStorage,
  root: string,
  options?: InitializeWorkspaceOptions,
): Promise<WorkspaceSnapshot> {
  const initialized = await initializeWorkspace(storage, root, options);
  const pages = await scanWikiPages(storage, initialized.layout.root);
  return { ...initialized, pages };
}
