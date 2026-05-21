import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyQueryMode } from '../queryMode';
import { loadQueryWorkspaceContext } from '../workspaceContext';

const files = new Map<string, string>();

vi.mock('@/lib/workspace', () => ({
  buildWorkspaceLayout: (root: string) => ({
    root,
    wiki: `${root}/wiki`,
    wikiIndex: `${root}/wiki/index.md`,
    rawSources: `${root}/raw/sources`,
    purpose: `${root}/purpose.md`,
  }),
  createWorkspaceStorage: () => ({
    exists: async (path: string) =>
      files.has(path) || [...files.keys()].some((filePath) => filePath.startsWith(`${path.replace(/\/$/, '')}/`)),
    readTextFile: async (path: string) => files.get(path) ?? '',
    listMarkdownFiles: async (root: string) =>
      [...files.keys()].filter((filePath) => filePath.startsWith(`${root.replace(/\/$/, '')}/`) && filePath.endsWith('.md')),
  }),
}));

describe('query workspace context', () => {
  beforeEach(() => {
    files.clear();
  });

  it('loads purpose, trims index, and strips superseded markdown candidates', async () => {
    files.set('D:/wiki/purpose.md', '关注福瑞三期项目运营、招商和医疗业态。');
    files.set(
      'D:/wiki/wiki/index.md',
      ['- 福瑞三期：医康旅一体化。', '- 无关项目：桌面工具。'].join('\n'),
    );
    files.set(
      'D:/wiki/wiki/project/furui.md',
      [
        '# 福瑞三期',
        '',
        '医疗资质和招商节奏是未来运营风险。',
        '',
        '<!-- mywiki:superseded reason="reviewed" supersededAt="2026-05-18T00:00:00.000Z" -->',
        '~~旧风险：住宅面积 12 万平方米。~~',
        '<!-- /mywiki:superseded -->',
      ].join('\n'),
    );
    files.set('D:/wiki/raw/sources/report.md', '# 可研报告\n\n福瑞三期包含医疗和康养业态。');

    const context = await loadQueryWorkspaceContext({
      workspaceRoot: 'D:/wiki',
      question: '福瑞三期未来运营风险怎么优化',
      queryMode: classifyQueryMode('福瑞三期未来运营风险怎么优化'),
    });

    expect(context?.purpose).toContain('福瑞三期');
    expect(context?.index).toContain('福瑞三期');
    expect(context?.index).not.toContain('无关项目');
    expect(context?.files?.map((file) => file.path)).toContain('wiki/project/furui.md');
    expect(context?.files?.map((file) => file.path)).toContain('raw/sources/report.md');
    expect(context?.files?.map((file) => file.excerpt).join('\n')).not.toContain('12 万平方米');
    expect(context?.trace?.join('\n')).toContain('词法召回');
    expect(context?.trace?.join('\n')).toContain('未把词法召回冒充为语义向量召回');
  });
});
