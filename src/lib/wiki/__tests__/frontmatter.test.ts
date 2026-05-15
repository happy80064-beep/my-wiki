import { describe, expect, it } from 'vitest';
import { parseMarkdownFrontmatter, stringifyMarkdownFrontmatter } from '@/lib/wiki/frontmatter';

describe('markdown frontmatter', () => {
  it('parses frontmatter and body from a wiki page', () => {
    const page = [
      '---',
      'type: entity',
      'title: 福瑞健康科技园三期项目',
      'tags: [产业园区, 智算中心]',
      'related: ["ji-ning-qu-zhong-meng-yi-yuan", "智算中心"]',
      'draft: false',
      'score: 12.5',
      '---',
      '',
      '# 福瑞健康科技园三期项目',
      '',
      '正文内容。',
    ].join('\n');

    const parsed = parseMarkdownFrontmatter(page);
    expect(parsed.data).toEqual({
      type: 'entity',
      title: '福瑞健康科技园三期项目',
      tags: ['产业园区', '智算中心'],
      related: ['ji-ning-qu-zhong-meng-yi-yuan', '智算中心'],
      draft: false,
      score: 12.5,
    });
    expect(parsed.body).toContain('# 福瑞健康科技园三期项目');
  });

  it('returns empty metadata when a page has no frontmatter', () => {
    expect(parseMarkdownFrontmatter('# Plain Page')).toEqual({
      data: {},
      body: '# Plain Page',
      raw: '',
    });
  });

  it('stringifies stable primitive and list metadata', () => {
    expect(
      stringifyMarkdownFrontmatter({
        type: 'entity',
        title: '测试页面',
        tags: ['A', 'B'],
        draft: false,
        order: 2,
      }),
    ).toBe(['---', 'type: entity', 'title: 测试页面', 'tags: ["A","B"]', 'draft: false', 'order: 2', '---'].join('\n'));
  });
});
