import { beforeEach, describe, expect, it } from 'vitest';
import { loadWorkspaceRegistry, upsertWorkspaceRegistryItem, workspaceRegistryStorageKey } from '@/lib/workspace/registry';

describe('workspace registry', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('deduplicates workspace roots and keeps the most recently opened first', () => {
    upsertWorkspaceRegistryItem({
      root: 'D:\\Wiki\\Business',
      name: '业务知识库',
      templateId: 'business',
      pageCount: 3,
      lastOpenedAt: 10,
    });
    upsertWorkspaceRegistryItem({
      root: 'D:/Wiki/Research',
      name: '研究知识库',
      templateId: 'research',
      pageCount: 8,
      lastOpenedAt: 20,
    });
    upsertWorkspaceRegistryItem({
      root: 'D:/Wiki/Business',
      pageCount: 4,
      lastOpenedAt: 30,
    });

    expect(loadWorkspaceRegistry().map((item) => [item.name, item.root, item.pageCount])).toEqual([
      ['业务知识库', 'D:/Wiki/Business', 4],
      ['研究知识库', 'D:/Wiki/Research', 8],
    ]);
    expect(window.localStorage.getItem(workspaceRegistryStorageKey)).toContain('业务知识库');
  });
});
