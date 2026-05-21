import { describe, expect, it } from 'vitest';
import {
  assertSafeWorkspaceRelativePath,
  buildWorkspaceLayout,
  isPathInsideWorkspace,
  joinWorkspacePath,
  normalizeWorkspacePath,
  resolveWorkspacePath,
} from '@/lib/workspace/paths';

describe('workspace paths', () => {
  it('normalizes Windows separators and repeated slashes', () => {
    expect(normalizeWorkspacePath('raw\\sources//file.md')).toBe('raw/sources/file.md');
    expect(normalizeWorkspacePath('./wiki\\entities\\person.md')).toBe('wiki/entities/person.md');
  });

  it('rejects unsafe relative paths before writing into workspace', () => {
    expect(() => assertSafeWorkspaceRelativePath('../secrets.md')).toThrow(/unsafe/i);
    expect(() => assertSafeWorkspaceRelativePath('wiki/../secrets.md')).toThrow(/unsafe/i);
    expect(() => assertSafeWorkspaceRelativePath('C:/Users/me/file.md')).toThrow(/unsafe/i);
    expect(() => assertSafeWorkspaceRelativePath('/tmp/file.md')).toThrow(/unsafe/i);
    expect(() => assertSafeWorkspaceRelativePath('wiki/\0bad.md')).toThrow(/unsafe/i);
  });

  it('requires an allowed root when provided', () => {
    expect(assertSafeWorkspaceRelativePath('wiki/entities/a.md', ['wiki'])).toBe('wiki/entities/a.md');
    expect(() => assertSafeWorkspaceRelativePath('raw/sources/a.md', ['wiki'])).toThrow(/allowed root/i);
  });

  it('builds the v2 workspace layout', () => {
    expect(buildWorkspaceLayout('D:\\MyWiki Workspace')).toEqual({
      root: 'D:/MyWiki Workspace',
      raw: 'D:/MyWiki Workspace/raw',
      rawSources: 'D:/MyWiki Workspace/raw/sources',
      rawAssets: 'D:/MyWiki Workspace/raw/assets',
      purpose: 'D:/MyWiki Workspace/purpose.md',
      schema: 'D:/MyWiki Workspace/schema.md',
      wiki: 'D:/MyWiki Workspace/wiki',
      wikiIndex: 'D:/MyWiki Workspace/wiki/index.md',
      wikiOverview: 'D:/MyWiki Workspace/wiki/overview.md',
      wikiLog: 'D:/MyWiki Workspace/wiki/log.md',
      state: 'D:/MyWiki Workspace/.mywiki',
      recordsState: 'D:/MyWiki Workspace/.mywiki/records.json',
      migrationState: 'D:/MyWiki Workspace/.mywiki/migration-state.json',
      vectorIndex: 'D:/MyWiki Workspace/.mywiki/lancedb',
      ingestQueue: 'D:/MyWiki Workspace/.mywiki/ingest-queue.json',
      ingestCache: 'D:/MyWiki Workspace/.mywiki/ingest-cache.json',
      reviewState: 'D:/MyWiki Workspace/.mywiki/review.json',
      settings: 'D:/MyWiki Workspace/.mywiki/settings.json',
    });
  });

  it('resolves safe relative paths and checks containment', () => {
    expect(resolveWorkspacePath('D:\\Workspace', 'wiki/entities/a.md')).toBe('D:/Workspace/wiki/entities/a.md');
    expect(joinWorkspacePath('D:\\Workspace', 'wiki', 'entities', 'a.md')).toBe('D:/Workspace/wiki/entities/a.md');
    expect(isPathInsideWorkspace('D:\\Workspace', 'D:\\Workspace\\wiki\\entities\\a.md')).toBe(true);
    expect(isPathInsideWorkspace('D:\\Workspace', 'D:\\Other\\wiki\\entities\\a.md')).toBe(false);
  });
});
