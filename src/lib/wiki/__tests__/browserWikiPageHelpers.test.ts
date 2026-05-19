import { describe, expect, it } from 'vitest';
import {
  activateProvider,
  assignModelRole,
  createDefaultProviderSettings,
  updateProviderConfig,
} from '@/lib/llm/providerSettings';
import { createEntity } from '@/lib/db';
import {
  buildBrowserEntityMarkdownPatch,
  buildBrowserEntityWikiRepairPatch,
  buildInitialBrowserEntityMarkdown,
  getWikiCompileProviderSummary,
} from '../browserWikiPageHelpers';

describe('browser wiki page helpers', () => {
  it('reports the role-selected wiki compile provider like llm-wiki style settings expect', async () => {
    let settings = createDefaultProviderSettings();
    settings = updateProviderConfig(settings, 'minimax-cn', { apiKey: 'sk-mini', model: 'MiniMax-M2.7' });
    settings = updateProviderConfig(settings, 'openai', { apiKey: 'sk-openai', model: 'gpt-5.5' });
    settings = activateProvider(settings, 'openai');
    settings = assignModelRole(settings, 'wiki-compile', 'minimax-cn');

    expect(getWikiCompileProviderSummary(settings)).toEqual({
      providerId: 'minimax-cn',
      label: 'MiniMax 中国',
      model: 'MiniMax-M2.7',
    });
  });

  it('derives title, tags, summary and markdown from a full wiki page edit', async () => {
    const entity = await createEntity({
      type: 'project',
      title: '旧标题',
      summary: '旧摘要',
      tags: ['旧标签'],
      sourceEntries: [],
    });

    const patch = buildBrowserEntityMarkdownPatch(
      entity,
      [
        '---',
        'type: project',
        'title: "福瑞健康科技园三期项目"',
        'tags: [产业园区, 智算中心]',
        'sources: ["report.pdf"]',
        'related: [集宁区中蒙医院]',
        '---',
        '',
        '# 福瑞健康科技园三期项目',
        '',
        '## 摘要',
        '这是新的页面摘要。',
      ].join('\n'),
      123456,
    );

    expect(patch).toMatchObject({
      title: '福瑞健康科技园三期项目',
      summary: '这是新的页面摘要。',
      tags: ['产业园区', '智算中心'],
      updatedAt: 123456,
    });
    expect((patch.wikiMarkdown ?? '').startsWith('---')).toBe(true);
    expect(patch.wikiMarkdown ?? '').not.toContain('<think>');
  });

  it('updates the entity type when edited frontmatter moves a page between wiki groups', async () => {
    const entity = await createEntity({
      type: 'project',
      title: 'Flexible staffing model',
      summary: 'Old summary.',
      tags: ['project'],
      sourceEntries: [],
    });

    const patch = buildBrowserEntityMarkdownPatch(
      entity,
      [
        '---',
        'type: concept',
        'title: "Flexible staffing model"',
        'tags: [concept]',
        'sources: []',
        'related: []',
        '---',
        '',
        '# Flexible staffing model',
        '',
        '## Summary',
        'A concept page after manual editing.',
      ].join('\n'),
    );

    expect(patch).toMatchObject({
      type: 'topic',
      tags: ['concept'],
    });
  });

  it('accepts Chinese page type names when manually editing wiki frontmatter', async () => {
    const entity = await createEntity({
      type: 'project',
      title: '目标市场界定',
      summary: 'Old summary.',
      tags: ['project', '项目'],
      sourceEntries: [],
    });

    const patch = buildBrowserEntityMarkdownPatch(
      entity,
      [
        '---',
        'type: 概念',
        'title: "目标市场界定"',
        'tags: [概念]',
        'sources: []',
        'related: []',
        '---',
        '',
        '# 目标市场界定',
        '',
        '## 摘要',
        '目标市场界定应作为概念页维护。',
      ].join('\n'),
    );

    expect(patch).toMatchObject({
      type: 'topic',
      tags: ['概念'],
    });
    expect(patch.wikiMarkdown).toContain('type: concept');
  });

  it('lets edited type frontmatter override stale type tags and cleans those tags', async () => {
    const entity = await createEntity({
      type: 'project',
      title: '出版业',
      summary: 'Old summary.',
      tags: ['项目', '产业链', '出版'],
      sourceEntries: [],
    });

    const patch = buildBrowserEntityMarkdownPatch(
      entity,
      [
        '---',
        'type: concept',
        'title: "出版业"',
        'tags: ["项目","产业链","出版"]',
        'sources: []',
        'related: []',
        '---',
        '',
        '# 出版业',
        '',
        '## 摘要',
        '出版业应作为概念页维护。',
      ].join('\n'),
    );

    expect(patch).toMatchObject({
      type: 'topic',
      tags: ['概念', '产业链', '出版'],
    });
    expect(patch.wikiMarkdown).toContain('type: concept');
    expect(patch.wikiMarkdown).toContain('tags: ["概念","产业链","出版"]');
  });

  it('moves a page when the visible type tags are edited from project to concept', async () => {
    const entity = await createEntity({
      type: 'project',
      title: '项目目标市场界定',
      summary: 'Old summary.',
      tags: ['project', '项目'],
      sourceEntries: [],
    });

    const patch = buildBrowserEntityMarkdownPatch(
      entity,
      [
        '---',
        'type: project',
        'title: "项目目标市场界定"',
        'tags: [concept, 概念]',
        'sources: []',
        'related: []',
        '---',
        '',
        '# 项目目标市场界定',
        '',
        '## 摘要',
        '用户将类型标签从项目改成概念后，知识树应同步移动。',
      ].join('\n'),
    );

    expect(patch).toMatchObject({
      type: 'topic',
      tags: ['concept'],
    });
    expect(patch.wikiMarkdown).toContain('type: concept');
  });

  it('builds an initial markdown scaffold for entities that do not yet have wikiMarkdown', async () => {
    const entity = await createEntity({
      type: 'project',
      title: '福瑞健康科技园三期项目',
      summary: '一个需要继续完善的项目页。',
      tags: ['产业园区', '大健康'],
      indicators: [
        {
          id: 'indicator_1',
          name: '预计年均营收',
          value: 4.22,
          unit: '亿元',
          confidence: 'high',
          extractedAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const markdown = buildInitialBrowserEntityMarkdown(entity);
    expect(markdown).toContain('title: "福瑞健康科技园三期项目"');
    expect(markdown).toContain('tags: ["产业园区", "大健康"]');
    expect(markdown).toContain('# 福瑞健康科技园三期项目');
    expect(markdown).toContain('## 摘要');
    expect(markdown).toContain('## 指标');
    expect(markdown).toContain('**预计年均营收**：4.22亿元');
  });

  it('builds a repair patch for polluted wiki descriptions', async () => {
    const entity = await createEntity({
      type: 'topic',
      title: '查询洞察：卡兹克是谁？',
      summary: '旧摘要',
      tags: ['query-insight'],
      sourceEntries: [],
    });

    const patch = buildBrowserEntityWikiRepairPatch({
        ...entity,
        wikiMarkdown: [
          '---',
          'type: topic',
          'title: "查询洞察：卡兹克是谁？"',
          'description: "MiniMax failed: fetch failed ??? ??? Wiki ?? ###### 3279 / OpenAI / ???? / ????"',
          'tags: [query-insight]',
          'sources: []',
          'related: []',
          '---',
          '',
          '# 查询洞察：卡兹克是谁？',
          '',
          '## 摘要',
          '卡兹克是一个公众号内容数据分析运营 AI 热点写作方法。',
        ].join('\n'),
      });

    expect(patch).not.toBeNull();
    expect(patch?.summary).toBe('卡兹克是一个公众号内容数据分析运营 AI 热点写作方法。');
    expect(patch?.wikiMarkdown).not.toContain('MiniMax failed');
  });

  it('repairs recently saved query insight pages back to the summary-first layout', async () => {
    const entity = await createEntity({
      type: 'topic',
      title: '查询洞察：中海广场是一个什么样的写字楼？',
      summary: '旧摘要',
      tags: ['query-insight'],
      sourceEntries: [],
    });

    const patch = buildBrowserEntityWikiRepairPatch({
      ...entity,
      wikiMarkdown: [
        '---',
        'type: query',
        'title: "查询洞察：中海广场是一个什么样的写字楼？"',
        'tags: [query-insight]',
        'sources: []',
        'related: []',
        '---',
        '',
        '# 查询洞察：中海广场是一个什么样的写字楼？',
        '',
        '## 问题',
        '中海广场是一个什么样的写字楼？楼下有配图商业吗？',
        '',
        '## 结论',
        '中海广场是朝阳 CBD 的甲级写字楼，底部配有商业配套。',
        '',
        '## 参考来源',
        '- source-a',
      ].join('\n'),
    });

    expect(patch).not.toBeNull();
    expect(patch?.wikiMarkdown).toContain('## 摘要');
    expect(patch?.wikiMarkdown).toContain('中海广场是朝阳 CBD 的甲级写字楼');
    expect(patch?.wikiMarkdown).not.toContain('## 问题');
    expect(patch?.wikiMarkdown).not.toContain('## 结论');
  });
});
