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
