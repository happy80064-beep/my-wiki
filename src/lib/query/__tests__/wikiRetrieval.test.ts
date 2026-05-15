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
});
