import { describe, expect, it } from 'vitest';
import type { Entity, Relationship } from '@/types';
import type { WikiIndexEntry } from '@/lib/wikiIndex';
import { retrieveQueryContextFromEntities } from '../wikiRetrieval';

function makeEntity(input: Partial<Entity> & Pick<Entity, 'id' | 'type' | 'title' | 'summary'>): Entity {
  const now = Date.now();
  return {
    clientId: 'test',
    tags: [],
    scenes: ['work'],
    properties:
      input.type === 'project'
        ? { status: 'active' }
        : input.type === 'person'
          ? {}
          : input.type === 'event'
            ? { occurredAt: now }
            : { isPersonal: false, autoCollectedSnippets: [] },
    sourceEntries: [],
    createdAt: now,
    updatedAt: now,
    ...input,
  } as Entity;
}

describe('wiki retrieval', () => {
  it('prefers wiki pages whose content matches the business question', () => {
    const project = makeEntity({
      id: 'project_1',
      type: 'project',
      title: '福瑞健康科技园三期项目',
      summary: '围绕算力、医疗、康养、住宅、文旅形成医康旅一体化商业模式。',
      wikiMarkdown: [
        '---',
        'type: project',
        'title: 福瑞健康科技园三期项目',
        '---',
        '',
        '# 福瑞健康科技园三期项目',
        '',
        '## 商业模式',
        '项目采用“算力+医疗+康养”协同发展的商业模式。',
      ].join('\n'),
    });
    const topic = makeEntity({
      id: 'topic_1',
      type: 'topic',
      title: '提示词技巧',
      summary: 'AI 提示词方法论。',
      wikiMarkdown: '# 提示词技巧\n\n与项目商业模式无关。',
    });

    const wikiIndex: WikiIndexEntry[] = [
      {
        entityId: project.id,
        type: project.type,
        title: project.title,
        aliases: [project.title],
        shortSummary: project.summary,
        importance: 20,
        sourceCount: 2,
        relationshipCount: 3,
        updatedAt: project.updatedAt,
      },
      {
        entityId: topic.id,
        type: topic.type,
        title: topic.title,
        aliases: [topic.title],
        shortSummary: topic.summary,
        importance: 8,
        sourceCount: 1,
        relationshipCount: 0,
        updatedAt: topic.updatedAt,
      },
    ];

    const context = retrieveQueryContextFromEntities(
      '健康科技园三期的商业模式是什么？',
      [project, topic],
      [],
      wikiIndex,
    );

    expect(context.pages[0]?.title).toBe('福瑞健康科技园三期项目');
    expect(context.pages[0]?.content).toContain('商业模式');
    expect(context.trace[1]).toContain('选入上下文');
  });

  it('does not include unrelated pages just because they have tags, sources, or long content', () => {
    const project = makeEntity({
      id: 'project_1',
      type: 'project',
      title: '福瑞健康科技园三期项目',
      summary: '围绕医疗、康养、文旅形成商业模式。',
      sourceEntries: ['entry_1', 'entry_2'],
      tags: ['福瑞科技园三期', '医康旅'],
      wikiMarkdown: '# 福瑞健康科技园三期项目\n\n## 商业模式\n项目采用医康旅一体化商业模式。',
    });
    const unrelated = makeEntity({
      id: 'project_2',
      type: 'project',
      title: '桌面数字生命体',
      summary: '运行在 Windows 桌面的 AI 生命体原型。',
      sourceEntries: ['entry_3'],
      tags: ['桌面生命体', '数字生命体'],
      wikiMarkdown: `# 桌面数字生命体\n\n${'这是一段较长但无关的桌面助手说明。'.repeat(80)}`,
    });
    const wikiIndex: WikiIndexEntry[] = [project, unrelated].map((entity) => ({
      entityId: entity.id,
      type: entity.type,
      title: entity.title,
      aliases: [entity.title, ...(entity.tags ?? [])],
      shortSummary: entity.summary,
      importance: 10,
      sourceCount: entity.sourceEntries.length,
      relationshipCount: 0,
      updatedAt: entity.updatedAt,
    }));

    const context = retrieveQueryContextFromEntities(
      '福瑞健康科技园三期项目的商业模式和关键风险是什么？',
      [project, unrelated],
      [],
      wikiIndex,
    );

    expect(context.pages.map((page) => page.title)).toEqual(['福瑞健康科技园三期项目']);
    expect(context.trace.join('\n')).not.toContain('桌面数字生命体');
  });

  it('adds one-hop related pages as secondary context', () => {
    const project = makeEntity({
      id: 'project_1',
      type: 'project',
      title: '福瑞健康科技园三期项目',
      summary: '主项目',
      wikiMarkdown: '# 福瑞健康科技园三期项目\n\n项目总体规划。',
    });
    const hospital = makeEntity({
      id: 'person_1',
      type: 'person',
      title: '集宁区中蒙医院',
      summary: '合作医院',
      wikiMarkdown: '# 集宁区中蒙医院\n\n承担医疗合作服务。',
    });

    const relationships: Relationship[] = [
      {
        id: 'rel_1',
        clientId: 'test',
        from: project.id,
        to: hospital.id,
        type: 'participant',
        evidence: [],
        createdAt: Date.now(),
      },
    ];

    const wikiIndex: WikiIndexEntry[] = [project, hospital].map((entity) => ({
      entityId: entity.id,
      type: entity.type,
      title: entity.title,
      aliases: [entity.title],
      shortSummary: entity.summary,
      importance: 10,
      sourceCount: 1,
      relationshipCount: 1,
      updatedAt: entity.updatedAt,
    }));

    const context = retrieveQueryContextFromEntities(
      '这个项目的合作医院是谁？',
      [project, hospital],
      relationships,
      wikiIndex,
      { limit: 3 },
    );

    expect(context.pages.map((page) => page.title)).toContain('集宁区中蒙医院');
  });

  it('adds secondary graph expansion by shared sources and wiki link affinity', () => {
    const project = makeEntity({
      id: 'project_1',
      type: 'project',
      title: '福瑞健康科技园三期项目',
      summary: '福瑞健康科技园三期医康旅项目。',
      wikiMarkdown: [
        '---',
        'type: project',
        'title: 福瑞健康科技园三期项目',
        'sources: [可研报告]',
        'related: [集宁区中蒙医院]',
        '---',
        '# 福瑞健康科技园三期项目',
        '福瑞健康科技园三期包含医疗和康养板块。',
      ].join('\n'),
    });
    const sourceSibling = makeEntity({
      id: 'project_2',
      type: 'project',
      title: '前序园区',
      summary: '前序项目。',
      wikiMarkdown: [
        '---',
        'type: project',
        'title: 前序园区',
        'sources: [可研报告]',
        '---',
        '# 前序园区',
        '一二期项目是前序基础。',
      ].join('\n'),
    });
    const hospital = makeEntity({
      id: 'entity_1',
      type: 'person',
      title: '集宁区中蒙医院',
      summary: '合作医院。',
      wikiMarkdown: '# 集宁区中蒙医院\n\n参与合作服务。',
    });
    const wikiIndex: WikiIndexEntry[] = [project, sourceSibling, hospital].map((entity) => ({
      entityId: entity.id,
      type: entity.type,
      title: entity.title,
      aliases: [entity.title],
      shortSummary: entity.summary,
      importance: 10,
      sourceCount: 1,
      relationshipCount: 0,
      updatedAt: entity.updatedAt,
    }));

    const context = retrieveQueryContextFromEntities('福瑞健康科技园三期医疗业态', [project, sourceSibling, hospital], [], wikiIndex, {
      limit: 3,
      enableGraphExpansion: true,
    });

    expect(context.pages.map((page) => page.title)).toContain('前序园区');
    expect(context.pages.map((page) => page.title)).toContain('集宁区中蒙医院');
    expect(context.pages.flatMap((page) => page.matchedTerms)).toEqual(
      expect.arrayContaining(['图谱扩展:来源重叠', '图谱扩展:Wiki链接']),
    );
  });
  it('ignores superseded wiki content when retrieving query context', () => {
    const project = makeEntity({
      id: 'project_superseded',
      type: 'project',
      title: '福瑞三期',
      summary: '项目最新住宅建筑面积为 14.2 万平方米。',
      wikiMarkdown: [
        '# 福瑞三期',
        '',
        '## 住宅建筑面积',
        '福瑞三期住宅建筑面积为 14.2 万平方米。',
        '',
        '<!-- mywiki:superseded reason="reviewed" supersededAt="2026-05-18T00:00:00.000Z" -->',
        '~~福瑞三期住宅建筑面积为 12 万平方米。~~',
        '<!-- /mywiki:superseded -->',
      ].join('\n'),
    });
    const wikiIndex: WikiIndexEntry[] = [
      {
        entityId: project.id,
        type: project.type,
        title: project.title,
        aliases: [project.title],
        shortSummary: project.summary,
        importance: 10,
        sourceCount: 1,
        relationshipCount: 0,
        updatedAt: project.updatedAt,
      },
    ];

    const oldContext = retrieveQueryContextFromEntities('12 万平方米', [project], [], wikiIndex);
    const newContext = retrieveQueryContextFromEntities('14.2 万平方米', [project], [], wikiIndex);

    expect(oldContext.pages[0]?.content ?? '').not.toContain('12 万平方米');
    expect(newContext.pages[0]?.content).toContain('14.2 万平方米');
    expect(newContext.pages[0]?.content).not.toContain('12 万平方米');
  });

  it('does not revive a fully superseded page through structured facts', () => {
    const noisy = makeEntity({
      id: 'topic_old_vision_noise',
      type: 'topic',
      title: '多模态模型视觉描述',
      summary: '模型限流导致待重试。',
      tags: ['多模态', '模型限流'],
      wikiMarkdown: [
        '<!-- mywiki:superseded reason="invalid-vision-compile" supersededAt="2026-05-21T00:00:00.000Z" -->',
        '# 多模态模型视觉描述',
        '~~模型限流导致待重试。~~',
        '<!-- /mywiki:superseded -->',
      ].join('\n'),
      compiledProfile: {
        overview: '模型限流导致待重试。',
        keyFacts: ['图片 OCR 碎片化。'],
        openTasks: [],
        relationshipSummary: [],
        sourceSummary: '旧版错误图片编译结果。',
        updatedAt: Date.now(),
      },
    });
    const wikiIndex: WikiIndexEntry[] = [
      {
        entityId: noisy.id,
        type: noisy.type,
        title: noisy.title,
        aliases: [noisy.title],
        shortSummary: noisy.summary,
        importance: 10,
        sourceCount: 1,
        relationshipCount: 0,
        updatedAt: noisy.updatedAt,
      },
    ];

    const context = retrieveQueryContextFromEntities('模型限流 OCR 碎片化', [noisy], [], wikiIndex);

    expect(context.pages).toHaveLength(0);
  });
});
