import { describe, expect, it } from 'vitest';
import { createTauriWorkspaceStorage, getDefaultWorkspaceRoot, type TauriInvoke } from '@/lib/workspace/tauriStorage';

describe('tauri workspace storage adapter', () => {
  it('maps workspace storage calls to Tauri commands', async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const invoke: TauriInvoke = async <T = unknown>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === 'workspace_exists') return true as T;
      return undefined as T;
    };
    const storage = createTauriWorkspaceStorage(invoke);

    await storage.ensureDir('D:/Workspace/wiki');
    await storage.writeTextFile('D:/Workspace/wiki/index.md', '# Wiki');
    await expect(storage.exists('D:/Workspace/wiki/index.md')).resolves.toBe(true);
    await storage.deletePath?.('D:/Workspace', 'D:/Workspace/wiki/index.md');

    expect(calls).toEqual([
      { command: 'workspace_ensure_dir', args: { path: 'D:/Workspace/wiki' } },
      { command: 'workspace_write_text_file', args: { path: 'D:/Workspace/wiki/index.md', content: '# Wiki' } },
      { command: 'workspace_exists', args: { path: 'D:/Workspace/wiki/index.md' } },
      { command: 'workspace_delete_path', args: { root: 'D:/Workspace', path: 'D:/Workspace/wiki/index.md' } },
    ]);
  });

  it('maps wiki file adapter calls to Tauri commands', async () => {
    const invoke: TauriInvoke = async <T = unknown>(command: string) => {
      if (command === 'workspace_list_markdown_files') return ['D:/Workspace/wiki/index.md'] as T;
      if (command === 'workspace_list_files') return ['D:/Workspace/raw/sources/report.pdf'] as T;
      if (command === 'workspace_read_text_file') return '# Wiki Index' as T;
      return undefined as T;
    };
    const storage = createTauriWorkspaceStorage(invoke);

    await expect(storage.listMarkdownFiles('D:/Workspace/wiki')).resolves.toEqual(['D:/Workspace/wiki/index.md']);
    await expect(storage.listFiles('D:/Workspace')).resolves.toEqual(['D:/Workspace/raw/sources/report.pdf']);
    await expect(storage.readTextFile('D:/Workspace/wiki/index.md')).resolves.toBe('# Wiki Index');
  });

  it('reads the default workspace root from Tauri', async () => {
    const invoke: TauriInvoke = async <T = unknown>(command: string) => {
      expect(command).toBe('workspace_default_root');
      return 'D:/Users/AppData/MyWiki/workspace' as T;
    };

    await expect(getDefaultWorkspaceRoot(invoke)).resolves.toBe('D:/Users/AppData/MyWiki/workspace');
  });
});
