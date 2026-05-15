import { describe, expect, it } from 'vitest';
import { createWorkspaceProject } from '@/lib/workspace/projectCreator';
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

describe('createWorkspaceProject', () => {
  it('creates a new Chinese workspace from the selected template', async () => {
    const storage = memoryWorkspaceStorage();

    const project = await createWorkspaceProject(storage, {
      projectName: '福瑞项目知识库',
      parentDirectory: 'D:/Knowledge',
      templateId: 'business',
      outputLanguage: 'zh-CN',
    });

    expect(project.root).toBe('D:/Knowledge/福瑞项目知识库');
    expect(project.outputLanguage).toBe('zh-CN');
    expect(storage.dirs).toContain('D:/Knowledge/福瑞项目知识库/wiki/projects');
    expect(storage.dirs).toContain('D:/Knowledge/福瑞项目知识库/wiki/meetings');
    expect(storage.files.get('D:/Knowledge/福瑞项目知识库/purpose.md')).toContain('业务上下文');
    expect(storage.files.get('D:/Knowledge/福瑞项目知识库/.mywiki/settings.json')).toContain('"template": "business"');
    expect(project.pages.map((page) => page.title)).toContain('MyWiki 总览');
  });

  it('protects an existing workspace from accidental overwrite', async () => {
    const storage = memoryWorkspaceStorage({
      'D:/Knowledge/existing/.mywiki/settings.json': '{}',
    });

    await expect(
      createWorkspaceProject(storage, {
        projectName: 'existing',
        parentDirectory: 'D:/Knowledge',
        templateId: 'general',
      }),
    ).rejects.toThrow('已经是 MyWiki 工作区');
  });

  it('requires a project name and parent directory', async () => {
    const storage = memoryWorkspaceStorage();

    await expect(
      createWorkspaceProject(storage, {
        projectName: ' ',
        parentDirectory: 'D:/Knowledge',
        templateId: 'general',
      }),
    ).rejects.toThrow('请输入项目名称');

    await expect(
      createWorkspaceProject(storage, {
        projectName: 'demo',
        parentDirectory: ' ',
        templateId: 'general',
      }),
    ).rejects.toThrow('请输入父目录');
  });
});
