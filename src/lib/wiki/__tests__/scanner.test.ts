import { describe, expect, it } from 'vitest';
import { scanWikiPages, type WikiFileAdapter } from '@/lib/wiki/scanner';

function memoryAdapter(files: Record<string, string>): WikiFileAdapter {
  return {
    async listMarkdownFiles(root) {
      const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
      return Object.keys(files)
        .filter((path) => path.startsWith(`${normalizedRoot}/`) && path.endsWith('.md'))
        .sort();
    },
    async readTextFile(path) {
      const content = files[path.replace(/\\/g, '/')];
      if (content === undefined) throw new Error(`Missing file: ${path}`);
      return content;
    },
  };
}

describe('wiki scanner', () => {
  it('indexes markdown pages from a workspace wiki folder', async () => {
    const adapter = memoryAdapter({
      'D:/Workspace/wiki/index.md': '# Wiki Index',
      'D:/Workspace/wiki/log.md': '# Wiki Log',
      'D:/Workspace/wiki/schema.md': '# Legacy Schema',
      'D:/Workspace/wiki/entities/furui.md': [
        '---',
        'type: entity',
        'title: 福瑞健康科技园三期项目',
        'tags: [产业园区, 智算中心]',
        'related: [zhisuan-center]',
        'sources: ["source-plan"]',
        'updated: 2026-05-08',
        '---',
        '# 福瑞健康科技园三期项目',
        '',
        '## 摘要',
        '',
        '项目位于乌兰察布，包含医疗、康养、文旅和智算中心。',
        '',
        '关联 [[zhisuan-center|智算中心]]。',
      ].join('\n'),
      'D:/Workspace/wiki/concepts/zhisuan-center.md': [
        '---',
        'type: concept',
        'title: 智算中心',
        'tags: [算力]',
        '---',
        '# 智算中心',
      ].join('\n'),
    });

    const pages = await scanWikiPages(adapter, 'D:/Workspace');

    expect(pages.map((page) => page.slug)).toEqual(['furui', 'zhisuan-center']);
    expect(pages.find((page) => page.slug === 'furui')).toMatchObject({
      path: 'wiki/entities/furui.md',
      type: 'entity',
      title: '福瑞健康科技园三期项目',
      tags: ['产业园区', '智算中心'],
      related: ['zhisuan-center'],
      sources: ['source-plan'],
      summary: '项目位于乌兰察布，包含医疗、康养、文旅和智算中心。',
      wikilinks: ['zhisuan-center'],
    });
  });

  it('falls back to heading and slug when frontmatter is incomplete', async () => {
    const adapter = memoryAdapter({
      'D:/Workspace/wiki/projects/no-meta.md': ['# 无元数据页面', '', '第一段摘要。'].join('\n'),
    });

    await expect(scanWikiPages(adapter, 'D:/Workspace')).resolves.toEqual([
      expect.objectContaining({
        slug: 'no-meta',
        type: 'project',
        title: '无元数据页面',
        summary: '第一段摘要。',
      }),
    ]);
  });
  it('does not index model thinking accidentally saved in markdown files', async () => {
    const adapter = memoryAdapter({
      'D:/Workspace/wiki/entities/clean.md': [
        '<think>draft reasoning should stay hidden</think>',
        '---',
        'type: entity',
        'title: Clean Page',
        '---',
        '# Clean Page',
        '',
        'Visible summary.',
      ].join('\n'),
    });

    const pages = await scanWikiPages(adapter, 'D:/Workspace');

    expect(pages[0]).toMatchObject({
      title: 'Clean Page',
      summary: 'Visible summary.',
    });
    expect(pages[0].summary).not.toContain('draft reasoning');
  });
});
