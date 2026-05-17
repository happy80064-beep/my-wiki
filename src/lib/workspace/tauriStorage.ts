import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { WikiFileAdapter } from '@/lib/wiki/scanner';
import type { WorkspaceFileStorageAdapter } from './workspace';

export type TauriInvoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;

export type TauriWorkspaceStorage = WorkspaceFileStorageAdapter & WikiFileAdapter;

export function createTauriWorkspaceStorage(invoke: TauriInvoke = tauriInvoke): TauriWorkspaceStorage {
  return {
    ensureDir(path) {
      return invoke<void>('workspace_ensure_dir', { path });
    },
    exists(path) {
      return invoke<boolean>('workspace_exists', { path });
    },
    writeTextFile(path, content) {
      return invoke<void>('workspace_write_text_file', { path, content });
    },
    writeBinaryFile(path, dataBase64) {
      return invoke<void>('workspace_write_binary_file', { path, dataBase64 });
    },
    listMarkdownFiles(wikiRoot) {
      return invoke<string[]>('workspace_list_markdown_files', { root: wikiRoot });
    },
    listFiles(root) {
      return invoke<string[]>('workspace_list_files', { root });
    },
    readTextFile(path) {
      return invoke<string>('workspace_read_text_file', { path });
    },
    deletePath(root, path) {
      return invoke<void>('workspace_delete_path', { root, path });
    },
  };
}

export function getDefaultWorkspaceRoot(invoke: TauriInvoke = tauriInvoke) {
  return invoke<string>('workspace_default_root');
}
