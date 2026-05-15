import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceFileEntries,
  filterRawSourceEntries,
  findMatchingSourcePage,
  findWikiPageByReference,
  findWorkspaceSourceEntryByLabel,
} from '../workbench';
import type { WikiPageIndexEntry } from '../scanner';

describe('wiki workbench helpers', () => {
  it('normalizes workspace files into typed areas', () => {
    const entries = buildWorkspaceFileEntries('D:/Knowledge/MyWiki', [
      'D:/Knowledge/MyWiki/wiki/entities/serina.md',
      'D:/Knowledge/MyWiki/raw/sources/report.pdf',
      'D:/Knowledge/MyWiki/.mywiki/settings.json',
      'D:/Knowledge/MyWiki/notes/todo.txt',
    ]);

    expect(entries.map((entry) => [entry.relativePath, entry.area])).toEqual([
      ['.mywiki/settings.json', 'state'],
      ['notes/todo.txt', 'other'],
      ['raw/sources/report.pdf', 'raw'],
      ['wiki/entities/serina.md', 'wiki'],
    ]);
    expect(entries.find((entry) => entry.name === 'serina.md')?.isMarkdown).toBe(true);
    expect(entries.find((entry) => entry.name === 'settings.json')?.isTextLike).toBe(true);
  });

  it('keeps raw source files while hiding cache files', () => {
    const entries = buildWorkspaceFileEntries('D:/Knowledge/MyWiki', [
      'D:/Knowledge/MyWiki/raw/sources/report.pdf',
      'D:/Knowledge/MyWiki/raw/sources/.cache/report.pdf.txt',
      'D:/Knowledge/MyWiki/wiki/sources/report.md',
    ]);

    expect(filterRawSourceEntries(entries).map((entry) => entry.relativePath)).toEqual(['raw/sources/report.pdf']);
  });

  it('finds a wiki source page related to a raw source file', () => {
    const source = buildWorkspaceFileEntries('D:/Knowledge/MyWiki', [
      'D:/Knowledge/MyWiki/raw/sources/Foo Report.pdf',
    ])[0];
    const pages: WikiPageIndexEntry[] = [
      {
        id: 'foo-report',
        slug: 'foo-report',
        absolutePath: 'D:/Knowledge/MyWiki/wiki/sources/foo-report.md',
        path: 'wiki/sources/foo-report.md',
        type: 'source',
        title: 'Foo Report',
        summary: '',
        tags: [],
        sources: ['raw/sources/Foo Report.pdf'],
        related: [],
        wikilinks: [],
        frontmatter: {},
      },
    ];

    expect(findMatchingSourcePage(source, pages)?.title).toBe('Foo Report');
  });

  it('resolves source labels back to raw source entries', () => {
    const entries = buildWorkspaceFileEntries('D:/Knowledge/MyWiki', [
      'D:/Knowledge/MyWiki/raw/sources/Foo Report.pdf',
      'D:/Knowledge/MyWiki/raw/sources/bar-notes.md',
    ]);

    expect(findWorkspaceSourceEntryByLabel('Foo Report.pdf', entries)?.relativePath).toBe('raw/sources/Foo Report.pdf');
    expect(findWorkspaceSourceEntryByLabel('raw/sources/bar-notes.md', entries)?.name).toBe('bar-notes.md');
  });

  it('resolves related references by title, slug and path', () => {
    const pages: WikiPageIndexEntry[] = [
      {
        id: 'ji-ning-qu-zhong-meng-yi-yuan',
        slug: 'ji-ning-qu-zhong-meng-yi-yuan',
        absolutePath: 'D:/Knowledge/MyWiki/wiki/entities/ji-ning-qu-zhong-meng-yi-yuan.md',
        path: 'wiki/entities/ji-ning-qu-zhong-meng-yi-yuan.md',
        type: 'entity',
        title: '集宁区中蒙医院',
        summary: '',
        tags: [],
        sources: [],
        related: [],
        wikilinks: [],
        frontmatter: {},
      },
    ];

    expect(findWikiPageByReference('集宁区中蒙医院', pages)?.slug).toBe('ji-ning-qu-zhong-meng-yi-yuan');
    expect(findWikiPageByReference('ji-ning-qu-zhong-meng-yi-yuan', pages)?.title).toBe('集宁区中蒙医院');
    expect(findWikiPageByReference('wiki/entities/ji-ning-qu-zhong-meng-yi-yuan.md', pages)?.title).toBe('集宁区中蒙医院');
  });
});
