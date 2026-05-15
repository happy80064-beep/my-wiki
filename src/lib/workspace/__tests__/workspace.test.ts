import { describe, expect, it } from 'vitest';
import { initializeWorkspace, type WorkspaceStorageAdapter } from '@/lib/workspace/workspace';

function memoryStorage(existingFiles: Record<string, string> = {}): WorkspaceStorageAdapter & {
  dirs: Set<string>;
  files: Map<string, string>;
} {
  const dirs = new Set<string>();
  const files = new Map(Object.entries(existingFiles).map(([path, content]) => [path.replace(/\\/g, '/'), content]));
  return {
    dirs,
    files,
    async ensureDir(path) {
      dirs.add(path.replace(/\\/g, '/'));
    },
    async exists(path) {
      const normalized = path.replace(/\\/g, '/');
      return dirs.has(normalized) || files.has(normalized);
    },
    async writeTextFile(path, content) {
      files.set(path.replace(/\\/g, '/'), content);
    },
  };
}

describe('workspace initialization', () => {
  it('creates the v2 workspace directory skeleton and default markdown files', async () => {
    const storage = memoryStorage();
    const result = await initializeWorkspace(storage, 'D:\\Knowledge\\MyWiki');

    expect(result.createdDirectories).toEqual([
      'D:/Knowledge/MyWiki/raw',
      'D:/Knowledge/MyWiki/raw/sources',
      'D:/Knowledge/MyWiki/raw/assets',
      'D:/Knowledge/MyWiki/wiki',
      'D:/Knowledge/MyWiki/wiki/entities',
      'D:/Knowledge/MyWiki/wiki/concepts',
      'D:/Knowledge/MyWiki/wiki/projects',
      'D:/Knowledge/MyWiki/wiki/sources',
      'D:/Knowledge/MyWiki/wiki/queries',
      'D:/Knowledge/MyWiki/wiki/comparisons',
      'D:/Knowledge/MyWiki/wiki/synthesis',
      'D:/Knowledge/MyWiki/wiki/decisions',
      'D:/Knowledge/MyWiki/wiki/meetings',
      'D:/Knowledge/MyWiki/wiki/stakeholders',
      'D:/Knowledge/MyWiki/.mywiki',
      'D:/Knowledge/MyWiki/.mywiki/locks',
    ]);
    expect([...storage.files.keys()].sort()).toEqual([
      'D:/Knowledge/MyWiki/.mywiki/ingest-cache.json',
      'D:/Knowledge/MyWiki/.mywiki/ingest-queue.json',
      'D:/Knowledge/MyWiki/.mywiki/review.json',
      'D:/Knowledge/MyWiki/.mywiki/settings.json',
      'D:/Knowledge/MyWiki/purpose.md',
      'D:/Knowledge/MyWiki/schema.md',
      'D:/Knowledge/MyWiki/wiki/index.md',
      'D:/Knowledge/MyWiki/wiki/log.md',
      'D:/Knowledge/MyWiki/wiki/overview.md',
    ]);
    expect(storage.files.get(result.layout.wikiIndex)).toContain('# Wiki 目录');
    expect(storage.files.get(result.layout.wikiOverview)).toContain('type: overview');
    expect(storage.files.get(result.layout.settings)).toContain('"outputLanguage": "zh-CN"');
  });

  it('adds template directories and Chinese template files for business projects', async () => {
    const storage = memoryStorage();

    await initializeWorkspace(storage, 'D:/Knowledge/BusinessWiki', {
      templateId: 'business',
      outputLanguage: 'zh-CN',
    });

    expect(storage.dirs).toContain('D:/Knowledge/BusinessWiki/wiki/stakeholders');
    expect(storage.dirs).toContain('D:/Knowledge/BusinessWiki/wiki/decisions');
    expect(storage.files.get('D:/Knowledge/BusinessWiki/purpose.md')).toContain('业务上下文');
    expect(storage.files.get('D:/Knowledge/BusinessWiki/schema.md')).toContain('负责人');
    expect(storage.files.get('D:/Knowledge/BusinessWiki/.mywiki/settings.json')).toContain('"template": "business"');
  });

  it('does not overwrite existing workspace files by default', async () => {
    const storage = memoryStorage({
      'D:/Knowledge/MyWiki/wiki/index.md': '# Existing Index',
    });

    await initializeWorkspace(storage, 'D:/Knowledge/MyWiki');

    expect(storage.files.get('D:/Knowledge/MyWiki/wiki/index.md')).toBe('# Existing Index');
  });
});
