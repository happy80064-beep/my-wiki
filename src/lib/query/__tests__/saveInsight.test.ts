import { beforeEach, describe, expect, it } from 'vitest';
import { createEntity, resetDatabase } from '@/lib/db';
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
  });
});
