import { describe, expect, it } from 'vitest';
import { groupWikiPagesByType, typeLabel } from '@/lib/wiki/pageTree';
import type { WikiPageIndexEntry } from '@/lib/wiki/scanner';

function page(type: WikiPageIndexEntry['type'], title: string): WikiPageIndexEntry {
  return {
    id: title,
    slug: title,
    path: `wiki/${title}.md`,
    absolutePath: `D:/Workspace/wiki/${title}.md`,
    type,
    title,
    summary: '',
    tags: [],
    related: [],
    sources: [],
    frontmatter: {},
    wikilinks: [],
  };
}

describe('wiki page tree helpers', () => {
  it('groups pages by Chinese type labels in product order', () => {
    const groups = groupWikiPagesByType([
      page('concept', '模型'),
      page('overview', '总览'),
      page('entity', 'OpenAI'),
      page('project', '福瑞项目'),
    ]);

    expect(groups.map((group) => group.label)).toEqual(['总览', '项目', '实体', '概念']);
    expect(groups[2].pages.map((item) => item.title)).toEqual(['OpenAI']);
  });

  it('returns Chinese labels for known page types', () => {
    expect(typeLabel('source')).toBe('来源');
    expect(typeLabel('query')).toBe('查询');
  });
});
