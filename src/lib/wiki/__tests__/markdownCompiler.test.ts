import { describe, expect, it } from 'vitest';
import type { Entity } from '@/types';
import {
  buildWikiMarkdownBatchCompilePrompt,
  buildWikiMarkdownCompilePrompt,
  extractFrontmatterTags,
  extractMarkdownSummary,
  inferWikiTargetSpec,
  isSafeWikiFilePath,
  normalizeWikiMarkdownBatchCompileResult,
  normalizeWikiMarkdownCompileResult,
  parseWikiFileBlocks,
  sanitizeWikiMarkdownOutput,
} from '../markdownCompiler';

const entity: Entity = {
  id: 'project_1',
  clientId: 'client',
  type: 'project',
  title: '福瑞健康科技园三期项目',
  summary: '综合性大健康项目。',
  tags: ['产业园区', '医康养融合'],
  scenes: ['work'],
  properties: { status: 'active' },
  sourceEntries: ['entry_1'],
  createdAt: 1,
  updatedAt: 1,
};

describe('wiki markdown compiler prompt', () => {
  it('asks the model to produce a frontmatter-based Chinese wiki page', () => {
    const prompt = buildWikiMarkdownCompilePrompt({
      entity,
      sourceEntries: [
        {
          id: 'entry_1',
          clientId: 'client',
          content: '项目总投资 12.03 亿元，预计年均营收 4.22 亿元。',
          source: 'file',
          capturedAt: 1,
          processed: true,
          derivedEntities: [],
          derivedTasks: [],
          derivedRelationships: [],
        },
      ],
      today: '2026-05-09',
    });

    expect(prompt).toContain('整个回复只能包含一个 FILE block');
    expect(prompt).toContain('---FILE: wiki/projects/');
    expect(prompt).toContain('## Wiki Context Map');
    expect(prompt).toContain('frontmatter.type 必须是：project');
    expect(prompt).toContain('严禁输出 `<think>`');
    expect(prompt).toContain('## 关键指标');
    expect(prompt).toContain('预计年均营收 4.22 亿元');
  });

  it('limits generated wikilinks to existing index targets', () => {
    const prompt = buildWikiMarkdownCompilePrompt({
      entity,
      sourceEntries: [],
      relatedEntities: [
        {
          id: 'topic_fmt',
          clientId: 'client',
          type: 'topic',
          title: 'FMT（粪菌移植）疗法',
          summary: '肠道微生态相关疗法。',
          tags: ['方法'],
          scenes: ['work'],
          properties: { isPersonal: false, autoCollectedSnippets: [] },
          sourceEntries: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      contextMap: {
        index: '- [[projects/福瑞健康科技园三期项目|福瑞健康科技园三期项目]]',
      },
      today: '2026-05-09',
    });

    expect(prompt).toContain('## Allowed Existing Wiki Links');
    expect(prompt).toContain('target: concepts/fmt(粪菌移植)疗法');
    expect(prompt).toContain('[[concepts/fmt(粪菌移植)疗法|FMT（粪菌移植）疗法]]');
    expect(prompt).toContain('禁止发明英文 slug、拼音 slug、翻译 slug');
  });
});

describe('wiki target classification', () => {
  it('routes query insight topics into query pages', () => {
    expect(
      inferWikiTargetSpec({
        id: 'topic_query',
        type: 'topic',
        title: '查询洞察：健康科技园三期的商业模式是什么？',
        tags: ['query-insight'],
      }),
    ).toMatchObject({
      type: 'query',
    });
  });

  it('routes method-like topics into concept pages', () => {
    expect(
      inferWikiTargetSpec({
        id: 'topic_concept',
        type: 'topic',
        title: '本地优先存储',
        tags: [],
      }),
    ).toMatchObject({
      type: 'concept',
    });
  });

  it('routes comparison topics into comparison pages', () => {
    expect(
      inferWikiTargetSpec({
        id: 'topic_comparison',
        type: 'topic',
        title: 'MiniMax 与 DeepSeek 对比',
        tags: [],
      }),
    ).toMatchObject({
      type: 'comparison',
    });
  });
});

describe('wiki markdown compiler normalization', () => {
  it('keeps valid frontmatter and extracts summary/tags', () => {
    const result = normalizeWikiMarkdownCompileResult(
      [
        '---FILE: wiki/entities/furui.md---',
        '---',
        'type: entity',
        'title: "福瑞健康科技园三期项目"',
        'created: 2026-05-09',
        'updated: 2026-05-09',
        'tags: [产业园区, 智算中心]',
        'sources: ["report.pdf"]',
        'related: [集宁区中蒙医院]',
        '---',
        '',
        '# 福瑞健康科技园三期项目',
        '',
        '## 摘要',
        '福瑞健康科技园三期项目是医康养融合园区。',
        '---END FILE---',
      ].join('\n'),
      entity,
      '2026-05-09',
    );

    expect(result.markdown.startsWith('---')).toBe(true);
    expect(result.path).toBe('wiki/entities/furui.md');
    expect(result.summary).toBe('福瑞健康科技园三期项目是医康养融合园区。');
    expect(result.tags).toEqual(['产业园区', '智算中心']);
  });

  it('wraps plain markdown with safe frontmatter', () => {
    const result = normalizeWikiMarkdownCompileResult('# 标题\n\n## 摘要\n补充内容。', entity, '2026-05-09');

    expect(result.markdown).toContain('type: project');
    expect(result.markdown).toContain('title: "福瑞健康科技园三期项目"');
    expect(result.summary).toBe('补充内容。');
  });

  it('rejects non-FILE output when strict FILE block mode is enabled', () => {
    expect(() =>
      normalizeWikiMarkdownCompileResult(
        '<think>internal notes</think>\n# Page\n\n## Summary\nThis should not be accepted by the v2 compiler endpoint.',
        entity,
        '2026-05-09',
        { requireFileBlock: true },
      ),
    ).toThrow(/valid FILE block/);
  });

  it('removes model thinking and preamble before storing wiki markdown', () => {
    const result = normalizeWikiMarkdownCompileResult(
      [
        '<think>让我分析这个任务。这里是模型内部思考，不应该进入 Wiki。</think>',
        '下面是 Wiki 页面：',
        '---FILE: wiki/entities/furui.md---',
        '---',
        'type: project',
        'title: "福瑞健康科技园三期项目"',
        'created: 2026-05-09',
        'updated: 2026-05-09',
        'tags: [产业园区]',
        'sources: []',
        'related: []',
        '---',
        '',
        '# 福瑞健康科技园三期项目',
        '',
        '## 摘要',
        '这是可保存的正文。',
        '---END FILE---',
      ].join('\n'),
      entity,
      '2026-05-09',
    );

    expect(result.markdown).not.toContain('<think>');
    expect(result.markdown).not.toContain('让我分析');
    expect(result.markdown.startsWith('---')).toBe(true);
    expect(result.summary).toBe('这是可保存的正文。');
  });
});

describe('wiki markdown output sanitizer', () => {
  it('can recover content after an unclosed think tag', () => {
    const cleaned = sanitizeWikiMarkdownOutput('<think>内部推理没有闭合\n\n# 页面标题\n\n## 摘要\n正文。');
    expect(cleaned).toBe('# 页面标题\n\n## 摘要\n正文。');
  });

  it('keeps existing page content before an unclosed think tag when no final page follows', () => {
    const cleaned = sanitizeWikiMarkdownOutput('# 页面标题\n\n<think>后面全是内部推理');
    expect(cleaned).toBe('# 页面标题');
  });
});

describe('llm-wiki style FILE block parser', () => {
  it('keeps only content inside safe FILE blocks', () => {
    const parsed = parseWikiFileBlocks(
      [
        '<think>outside thinking</think>',
        '---FILE: wiki/entities/page.md---',
        '---',
        'title: A',
        '---',
        '# A',
        '---END FILE---',
        'trailing commentary',
      ].join('\n'),
    );

    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0].content).toContain('# A');
    expect(parsed.blocks[0].content).not.toContain('outside thinking');
  });

  it('implicitly closes a file block at end-of-stream when the model forgot END FILE', () => {
    const parsed = parseWikiFileBlocks(
      [
        '---FILE: wiki/entities/page.md---',
        '---',
        'title: A',
        '---',
        '# A',
      ].join('\n'),
    );

    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0].content).toContain('# A');
    expect(parsed.warnings[0]).toMatch(/implicitly closed/);
  });

  it('does not close on END FILE text inside fenced code blocks', () => {
    const parsed = parseWikiFileBlocks(
      [
        '---FILE: wiki/entities/parser.md---',
        '---',
        'title: Parser',
        '---',
        '```',
        '---END FILE---',
        '```',
        '# Still inside page',
        '---END FILE---',
      ].join('\n'),
    );

    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0].content).toContain('# Still inside page');
  });

  it('rejects unsafe paths', () => {
    expect(isSafeWikiFilePath('wiki/entities/foo.md')).toBe(true);
    expect(isSafeWikiFilePath('../foo.md')).toBe(false);
    expect(isSafeWikiFilePath('C:/Windows/foo.md')).toBe(false);
    expect(isSafeWikiFilePath('raw/source.md')).toBe(false);
  });
});

describe('source-level batch wiki compiler helpers', () => {
  it('builds a multi-page FILE block prompt for one source entry', () => {
    const prompt = buildWikiMarkdownBatchCompilePrompt({
      sourceEntry: {
        id: 'entry_1',
        clientId: 'client',
        content: '福瑞新职场位于中海广场，包含办公空间和配套商业。',
        source: 'file',
        fileMetadata: { filename: 'report.pdf', mimeType: 'application/pdf', url: '' },
        capturedAt: 1,
        processed: true,
        derivedEntities: [],
        derivedTasks: [],
        derivedRelationships: [],
      },
      entities: [entity, { ...entity, id: 'entity_2', title: '中海广场', type: 'project' }],
      today: '2026-05-17',
    });

    expect(prompt).toContain('一次性生成或更新多篇');
    expect(prompt).toContain('report.pdf');
    expect(prompt).toContain('wiki/');
    expect(prompt).toContain('必须为“本次必须输出的目标页面”中的每一个 targetPath 输出');
    expect(prompt).toContain('证据不足的章节要明确写“当前来源未确认”');
  });

  it('normalizes multiple FILE blocks back to entity results and reports missing pages', () => {
    const second = { ...entity, id: 'entity_2', title: '中海广场', type: 'project' as const };
    const targetPath = inferWikiTargetSpec(entity).path;
    const result = normalizeWikiMarkdownBatchCompileResult(
      [
        `---FILE: ${targetPath}---`,
        '---',
        'type: project',
        `title: "${entity.title}"`,
        'tags: [AI]',
        'sources: [entry_1]',
        'related: []',
        '---',
        `# ${entity.title}`,
        '',
        '## 摘要',
        '这是一篇围绕来源生成的 Wiki 页面。',
        '---END FILE---',
      ].join('\n'),
      {
        sourceEntry: {
          id: 'entry_1',
          clientId: 'client',
          content: 'source',
          source: 'file',
          capturedAt: 1,
          processed: true,
          derivedEntities: [],
          derivedTasks: [],
          derivedRelationships: [],
        },
        entities: [entity, second],
        today: '2026-05-17',
      },
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ entityId: entity.id });
    expect(result.missingEntityIds).toEqual([second.id]);
  });
});

describe('markdown metadata helpers', () => {
  it('extracts a section summary', () => {
    expect(extractMarkdownSummary('# A\n\n## 摘要\n第一句。\n\n## 其他\n第二句。')).toBe('第一句。');
  });

  it('falls back tags when frontmatter has no tag line', () => {
    expect(extractFrontmatterTags('---\ntitle: A\n---\n# A', ['默认'])).toEqual(['默认']);
  });
});
