import { beforeEach, describe, expect, it } from 'vitest';
import { createEntity, db, resetDatabase } from '@/lib/db';
import { saveQueryInsight } from '@/lib/query/saveInsight';
import type { StructuredQueryResult } from '@/lib/graph';

describe('save query insight', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('saves an answer as a topic and links it to source entities', async () => {
    const entity = await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      sourceEntries: ['entry_source'],
    });
    const result: StructuredQueryResult = {
      answer: '桌面数字生命体的唤醒词是小林。',
      candidates: [entity],
      sources: [{ type: 'entity', id: entity.id, title: entity.title, href: `/wiki/${entity.type}/${entity.id}` }],
      suggestions: [],
    };

    const saved = await saveQueryInsight('桌面生命体的唤醒词是什么', result);

    expect(saved.reused).toBe(false);
    expect(saved.entity.type).toBe('topic');
    expect(saved.relationships).toHaveLength(1);
    expect(saved.relationships[0]).toMatchObject({
      from: saved.entity.id,
      to: entity.id,
      type: 'about',
    });
    expect(saved.entry.derivedEntities).toEqual(expect.arrayContaining([saved.entity.id, entity.id]));
    expect(saved.entity.wikiMarkdown).toContain('桌面数字生命体的唤醒词是小林。');
    expect(saved.recompileJobId).toBeTruthy();
    expect(await db.ingestJobs.count()).toBe(1);
  });

  it('reuses the same query insight topic for the same question', async () => {
    const result: StructuredQueryResult = {
      answer: 'OpenMaic 是开源项目。',
      sources: [],
      suggestions: [],
    };

    const first = await saveQueryInsight('openmaic 是开源的吗？', result);
    const second = await saveQueryInsight('openmaic 是开源的吗？', result);

    expect(second.reused).toBe(true);
    expect(second.entity.id).toBe(first.entity.id);
    expect(await db.ingestJobs.count()).toBe(1);
  });

  it('writes the query answer into wiki markdown immediately', async () => {
    const entity = await createEntity({
      type: 'project',
      title: '福瑞新职场',
      summary: '福瑞新职场搬迁项目。',
    });
    const result: StructuredQueryResult = {
      answer: '根据现有材料，福瑞新职场是在中海广场。',
      candidates: [entity],
      sources: [{ type: 'entity', id: entity.id, title: entity.title, href: `/wiki/${entity.type}/${entity.id}` }],
      suggestions: [],
      llm: { provider: 'zhipu', model: 'glm-4.6v' },
    };

    const saved = await saveQueryInsight('福瑞新职场是在哪里？', result);
    const stored = await db.entities.get(saved.entity.id);

    expect(stored?.wikiMarkdown).toContain('福瑞新职场是在中海广场');
    expect(stored?.wikiMarkdown).toContain('## 摘要');
    expect(stored?.wikiMarkdown).not.toContain('## 问题');
    expect(stored?.wikiCompileModel).toBe('zhipu/glm-4.6v');
  });

  it('refreshes stale wiki markdown when the same query insight is saved again', async () => {
    const staleResult: StructuredQueryResult = {
      answer: '当前材料暂未确认福瑞新职场的位置。',
      sources: [],
      suggestions: [],
    };
    const freshResult: StructuredQueryResult = {
      answer: '后续材料已确认：福瑞新职场是在中海广场。',
      sources: [],
      suggestions: [],
    };

    const first = await saveQueryInsight('福瑞新职场是在哪里？', staleResult);
    const second = await saveQueryInsight('福瑞新职场是在哪里？', freshResult);
    const stored = await db.entities.get(first.entity.id);

    expect(second.reused).toBe(true);
    expect(second.entity.id).toBe(first.entity.id);
    expect(stored?.wikiMarkdown).toContain('福瑞新职场是在中海广场');
    expect(stored?.wikiMarkdown).not.toContain('当前材料暂未确认福瑞新职场的位置。');
  });
});
