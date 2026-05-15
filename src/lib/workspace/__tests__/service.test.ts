import { describe, expect, it } from 'vitest';
import { initializeAndScanWorkspace } from '@/lib/workspace/service';
import type { TauriWorkspaceStorage } from '@/lib/workspace/tauriStorage';

function memoryWorkspaceStorage(files: Record<string, string> = {}): TauriWorkspaceStorage & {
  dirs: Set<string>;
  files: Map<string, string>;
} {
  const dirs = new Set<string>();
  const fileMap = new Map(Object.entries(files));
  return {
    dirs,
    files: fileMap,
    async ensureDir(path) {
      dirs.add(path);
    },
    async exists(path) {
      return dirs.has(path) || fileMap.has(path);
    },
    async writeTextFile(path, content) {
      fileMap.set(path, content);
    },
    async listMarkdownFiles(root) {
      return [...fileMap.keys()].filter((path) => path.startsWith(`${root}/`) && path.endsWith('.md'));
    },
    async listFiles(root) {
      return [...fileMap.keys()].filter((path) => path.startsWith(`${root}/`));
    },
    async readTextFile(path) {
      const content = fileMap.get(path);
      if (content === undefined) throw new Error(`Missing file: ${path}`);
      return content;
    },
  };
}

describe('workspace service', () => {
  it('initializes a workspace and returns scanned pages', async () => {
    const storage = memoryWorkspaceStorage({
      'D:/Workspace/wiki/entities/furui.md': [
        '---',
        'type: entity',
        'title: 福瑞项目',
        'tags: [项目]',
        '---',
        '# 福瑞项目',
        '',
        '## 摘要',
        '',
        '一个项目页面。',
      ].join('\n'),
    });

    const result = await initializeAndScanWorkspace(storage, 'D:/Workspace');

    expect(result.layout.root).toBe('D:/Workspace');
    expect(result.pages.map((page) => page.title)).toEqual(['MyWiki 总览', '福瑞项目']);
    expect(result.createdFiles).toContain('D:/Workspace/wiki/index.md');
  });
});
