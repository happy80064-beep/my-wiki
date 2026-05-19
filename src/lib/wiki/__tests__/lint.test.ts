import { describe, expect, it } from 'vitest';
import {
  buildSemanticWikiLintPrompt,
  normalizeSemanticWikiLintResponse,
  runStructuralWikiLint,
  type WikiLintPage,
} from '../lint';

describe('wiki lint core', () => {
  it('detects broken links, orphan pages, no outbound links, and frontmatter gaps', () => {
    const pages: WikiLintPage[] = [
      page('wiki/entities/project-a.md', 'Project A', [
        '---',
        'type: entity',
        'title: Project A',
        'updated: 2026-05-10',
        'related: ["Concept A"]',
        '---',
        '',
        '# Project A',
        '',
        'See [[Missing Page]].',
      ]),
      page('wiki/concepts/concept-a.md', 'Concept A', [
        '---',
        'type: concept',
        'title: Concept A',
        'updated: 2026-05-10',
        '---',
        '',
        '# Concept A',
      ]),
      page('wiki/sources/source-a.md', 'Source A', ['# Source A', '', 'No frontmatter here.']),
    ];

    const results = runStructuralWikiLint(pages);

    expect(results).toContainEqual(expect.objectContaining({ type: 'broken-link', page: 'wiki/entities/project-a.md' }));
    expect(results).toContainEqual(expect.objectContaining({ type: 'no-outlinks', page: 'wiki/concepts/concept-a.md' }));
    expect(results).toContainEqual(expect.objectContaining({ type: 'orphan', page: 'wiki/sources/source-a.md' }));
    expect(results).toContainEqual(expect.objectContaining({ type: 'frontmatter', page: 'wiki/sources/source-a.md' }));
  });

  it('matches wikilinks by basename, slug path, and title case-insensitively', () => {
    const pages: WikiLintPage[] = [
      page('wiki/entities/project-a.md', 'Project A', [
        '---',
        'type: entity',
        'title: Project A',
        'updated: 2026-05-10',
        '---',
        '',
        '[[concepts/Concept-A]] [[CONCEPT A]] [[concept-a.md]]',
      ]),
      page('wiki/concepts/concept-a.md', 'Concept A', [
        '---',
        'type: concept',
        'title: Concept A',
        'updated: 2026-05-10',
        '---',
        '',
        'Body',
      ]),
    ];

    const results = runStructuralWikiLint(pages);

    expect(results.some((result) => result.type === 'broken-link')).toBe(false);
  });

  it('matches wikilinks by explicit page aliases and index aliases', () => {
    const pages: WikiLintPage[] = [
      page('wiki/concepts/个体化巨噬细胞疗法.md', '个体化巨噬细胞疗法', [
        '---',
        'type: concept',
        'title: 个体化巨噬细胞疗法',
        'updated: 2026-05-10',
        'aliases: ["macrophage-cell-therapy"]',
        '---',
        '',
        '[[furuai-health-tech-park-phase-3]]',
      ]),
      page('wiki/projects/福瑞健康科技园三期项目.md', '福瑞健康科技园三期项目', [
        '---',
        'type: project',
        'title: 福瑞健康科技园三期项目',
        'updated: 2026-05-10',
        '---',
        '',
        '[[macrophage-cell-therapy]]',
      ]),
    ];

    const results = runStructuralWikiLint(pages, {
      index: '- [[projects/福瑞健康科技园三期项目|furuai-health-tech-park-phase-3]]',
    });

    expect(results.some((result) => result.type === 'broken-link')).toBe(false);
  });

  it('matches Chinese wiki links with folder prefixes, spacing, and punctuation variants', () => {
    const pages: WikiLintPage[] = [
      page('wiki/projects/乌兰察布集宁区康养项目.md', '乌兰察布集宁区康养项目', [
        '---',
        'type: project',
        'title: 乌兰察布集宁区康养项目',
        'updated: 2026-05-10',
        '---',
        '',
        '相关技术包括 [[concepts/CUNDE® DC疗法]] 和 [[concepts/FMT (粪菌移植) 疗法]]。',
      ]),
      page('wiki/concepts/CUNDE® DC疗法.md', 'CUNDE® DC疗法', [
        '---',
        'type: concept',
        'title: CUNDE® DC疗法',
        'updated: 2026-05-10',
        '---',
        '',
        'Body',
      ]),
      page('wiki/concepts/FMT（粪菌移植）疗法.md', 'FMT（粪菌移植）疗法', [
        '---',
        'type: concept',
        'title: FMT（粪菌移植）疗法',
        'updated: 2026-05-10',
        '---',
        '',
        'Body',
      ]),
    ];

    const results = runStructuralWikiLint(pages);

    expect(results.some((result) => result.type === 'broken-link')).toBe(false);
  });

  it('matches slug-style wikilinks to spaced page titles without dropping meaningful punctuation', () => {
    const pages: WikiLintPage[] = [
      page('wiki/sources/runtime-source.md', 'Runtime Source', [
        '---',
        'type: source',
        'title: Runtime Source',
        'updated: 2026-05-18',
        '---',
        '',
        'See [[concepts/agent-记忆运行时(调度层)]].',
      ]),
      page('wiki/concepts/Agent 记忆运行时（调度层）.md', 'Agent 记忆运行时（调度层）', [
        '---',
        'type: concept',
        'title: Agent 记忆运行时（调度层）',
        'updated: 2026-05-18',
        '---',
        '',
        'Body',
      ]),
    ];

    const results = runStructuralWikiLint(pages);

    expect(results.some((result) => result.type === 'broken-link')).toBe(false);
  });

  it('matches Chinese titles when a wikilink adds an English parenthetical alias', () => {
    const pages: WikiLintPage[] = [
      page('wiki/sources/runtime-source.md', 'Runtime Source', [
        '---',
        'type: source',
        'title: Runtime Source',
        'updated: 2026-05-18',
        '---',
        '',
        'See [[concepts/上下文压缩(context-compaction)]] and [[concepts/有损压缩(lossy-compression)]].',
      ]),
      page('wiki/concepts/上下文压缩.md', '上下文压缩', [
        '---',
        'type: concept',
        'title: 上下文压缩',
        'updated: 2026-05-18',
        '---',
        '',
        'Body',
      ]),
      page('wiki/concepts/有损压缩.md', '有损压缩', [
        '---',
        'type: concept',
        'title: 有损压缩',
        'updated: 2026-05-18',
        '---',
        '',
        'Body',
      ]),
    ];

    const results = runStructuralWikiLint(pages);

    expect(results.some((result) => result.type === 'broken-link')).toBe(false);
  });

  it('keeps parenthetical alias links broken when simplification would be ambiguous', () => {
    const pages: WikiLintPage[] = [
      page('wiki/sources/runtime-source.md', 'Runtime Source', [
        '---',
        'type: source',
        'title: Runtime Source',
        'updated: 2026-05-18',
        '---',
        '',
        'See [[concepts/上下文压缩(context-compaction)]].',
      ]),
      page('wiki/concepts/上下文压缩.md', '上下文压缩', [
        '---',
        'type: concept',
        'title: 上下文压缩',
        'updated: 2026-05-18',
        '---',
        '',
        'Body',
      ]),
      page('wiki/concepts/上下文压缩(other-alias).md', '上下文压缩(other-alias)', [
        '---',
        'type: concept',
        'title: 上下文压缩(other-alias)',
        'updated: 2026-05-18',
        '---',
        '',
        'Body',
      ]),
    ];

    const results = runStructuralWikiLint(pages);

    expect(results).toContainEqual(
      expect.objectContaining({
        type: 'broken-link',
        detail: expect.stringContaining('[[concepts/上下文压缩(context-compaction)]]'),
      }),
    );
  });

  it('resolves escaped table wikilinks and source-file aliases without reporting broken links', () => {
    const pages: WikiLintPage[] = [
      page('wiki/projects/project-a.md', 'Project A', [
        '---',
        'type: project',
        'title: Project A',
        'updated: 2026-05-18',
        'related: ["sources/report.pdf"]',
        '---',
        '',
        '| Source | Owner |',
        '| --- | --- |',
        '| [[sources/report.pdf|Report]] | [[entities/Owner\\|Owner]] |',
        'Raw provenance: [[raw/entries/entry_1|entry_1]]',
      ]),
      {
        ...page('wiki/sources/report-summary.md', 'Report Summary', [
          '---',
          'type: source',
          'title: Report Summary',
          'updated: 2026-05-18',
          'sources: ["report.pdf"]',
          '---',
          '',
          'Body',
        ]),
        type: 'source',
        sources: ['report.pdf'],
      },
      page('wiki/entities/owner.md', 'Owner', [
        '---',
        'type: entity',
        'title: Owner',
        'updated: 2026-05-18',
        '---',
        '',
        'Body',
      ]),
    ];

    const results = runStructuralWikiLint(pages);

    expect(results.some((result) => result.type === 'broken-link')).toBe(false);
  });

  it('resolves related frontmatter entries that are written as wikilinks', () => {
    const pages: WikiLintPage[] = [
      page('wiki/entities/李俊杰.md', '李俊杰', [
        '---',
        'type: entity',
        'title: 李俊杰',
        'updated: 2026-05-15',
        'related: ["[[concepts/运营经理]]", "[[[concepts/2026年5月1日]]]", "[[entities/内蒙古福瑞医疗科技股份有限公司|内蒙古福瑞医疗科技股份有限公司]]"]',
        '---',
        '',
        '# 李俊杰',
      ]),
      page('wiki/concepts/运营经理.md', '运营经理', ['---', 'type: concept', 'title: 运营经理', 'updated: 2026-05-15', '---', '', 'Body']),
      page('wiki/concepts/2026年5月1日.md', '2026年5月1日', [
        '---',
        'type: concept',
        'title: 2026年5月1日',
        'updated: 2026-05-15',
        '---',
        '',
        'Body',
      ]),
      page('wiki/entities/内蒙古福瑞医疗科技股份有限公司.md', '内蒙古福瑞医疗科技股份有限公司', [
        '---',
        'type: entity',
        'title: 内蒙古福瑞医疗科技股份有限公司',
        'updated: 2026-05-15',
        '---',
        '',
        'Body',
      ]),
    ];

    const results = runStructuralWikiLint(pages);

    expect(results.some((result) => result.type === 'broken-link')).toBe(false);
  });

  it('does not silently merge distinct pages by overly loose punctuation matching', () => {
    const pages: WikiLintPage[] = [
      page('wiki/projects/project-a.md', 'Project A', [
        '---',
        'type: project',
        'title: Project A',
        'updated: 2026-05-10',
        '---',
        '',
        '[[concepts/CUNDE DC疗法]]',
      ]),
      page('wiki/concepts/CUNDE® DC疗法.md', 'CUNDE® DC疗法', [
        '---',
        'type: concept',
        'title: CUNDE® DC疗法',
        'updated: 2026-05-10',
        '---',
        '',
        'Body',
      ]),
    ];

    const results = runStructuralWikiLint(pages);

    expect(results).toContainEqual(
      expect.objectContaining({
        type: 'broken-link',
        detail: expect.stringContaining('[[concepts/CUNDE DC疗法]]'),
      }),
    );
  });

  it('builds and parses semantic lint blocks', () => {
    const prompt = buildSemanticWikiLintPrompt({
      pages: [page('wiki/entities/project-a.md', 'Project A', '# Project A\n\nA preview')],
      outputLanguage: 'zh-CN',
    });

    expect(prompt).toContain('---LINT: type | severity | Short title---');
    expect(prompt).toContain('wiki/entities/project-a.md');

    const results = normalizeSemanticWikiLintResponse(`
---LINT: contradiction | warning | 指标口径冲突---
Project A and Source A use different revenue values.
PAGES: wiki/entities/project-a.md, wiki/sources/source-a.md
---END LINT---
`);

    expect(results).toEqual([
      expect.objectContaining({
        type: 'semantic',
        severity: 'warning',
        title: '指标口径冲突',
        affectedPages: ['wiki/entities/project-a.md', 'wiki/sources/source-a.md'],
      }),
    ]);
  });
});

function page(path: string, title: string, markdown: string | string[]): WikiLintPage {
  return {
    id: path,
    title,
    type: 'entity',
    path,
    markdown: Array.isArray(markdown) ? markdown.join('\n') : markdown,
  };
}
