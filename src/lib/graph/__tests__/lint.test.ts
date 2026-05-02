import { beforeEach, describe, expect, it } from 'vitest';
import { createEntity, createEntry, createTask, db, materializeCompileSuggestions, resetDatabase } from '@/lib/db';
import { buildWikiLintReport, runWikiLint } from '@/lib/graph/lint';
import type { Entity } from '@/types';

describe('wiki lint', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('detects orphan entities and missing sources', async () => {
    await createEntity({ type: 'topic', title: '孤立主题' });

    const report = await runWikiLint();

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        type: 'orphan-entity',
        title: '孤立实体',
      }),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        type: 'missing-source',
        title: '缺少来源',
      }),
    );
  });

  it('detects broken relationships, stale tasks, and pending compile suggestions', async () => {
    const entry = await createEntry({ content: 'OpenMaic 是开源项目。', source: 'text' });
    const entity = await createEntity({
      type: 'topic',
      title: 'OpenMaic',
      sourceEntries: [entry.id],
      createdAt: 1,
      updatedAt: 1,
    });
    await db.relationships.add({
      id: 'rel_broken',
      from: entity.id,
      to: 'missing_entity',
      type: 'related-to',
      evidence: [],
      createdAt: Date.now(),
    });
    await createTask({
      description: '长期任务',
      owner: entity.id,
      source: entry.id,
      createdAt: Date.now() - 1000 * 60 * 60 * 24 * 40,
    });
    await materializeCompileSuggestions([
      {
        entityId: entity.id,
        entityTitle: entity.title,
        propertyKey: 'openSourceStatus',
        propertyLabel: '开源状态',
        propertyValue: '开源项目',
        evidenceEntryId: entry.id,
        evidenceSnippet: 'OpenMaic 是开源项目。',
        evidenceScope: 'entity-source',
        confidence: 0.9,
      },
    ]);

    const report = await runWikiLint();

    expect(report.summary.errors).toBe(1);
    expect(report.issues.map((issue) => issue.type)).toEqual(
      expect.arrayContaining(['broken-relationship', 'stale-task', 'pending-compile-suggestion']),
    );
  });

  it('detects duplicate entities, contradictory properties, and compile backlog', () => {
    const now = Date.now();
    const duplicated: Entity[] = [
      createTestEntity('topic_1', 'topic', 'OpenMaic', now),
      createTestEntity('topic_2', 'topic', 'Open Maic', now),
      ({
        ...createTestEntity('topic_3', 'topic', '开源判断', now),
        properties: {
          isPersonal: false,
          autoCollectedSnippets: [],
          openSourceStatus: ['开源项目', '闭源项目'],
        } as unknown as Entity['properties'],
      } as unknown as Entity),
    ];
    const compileSuggestions = Array.from({ length: 5 }, (_, index) => ({
      id: `compile_${index}`,
      fingerprint: `topic_1:ownerNote:${index}`,
      entityId: 'topic_1',
      entityTitle: 'OpenMaic',
      propertyKey: 'ownerNote',
      propertyLabel: '备注',
      propertyValue: `建议 ${index}`,
      evidenceEntryId: 'entry_1',
      evidenceSnippet: '证据',
      evidenceScope: 'entity-source' as const,
      confidence: 0.7,
      status: 'pending' as const,
      createdAt: now,
      updatedAt: now,
    }));

    const report = buildWikiLintReport({
      entities: duplicated,
      relationships: [],
      tasks: [],
      compileSuggestions,
    });

    expect(report.issues.map((issue) => issue.type)).toEqual(
      expect.arrayContaining(['duplicate-entity', 'contradictory-property', 'compile-suggestion-backlog']),
    );
  });

  it('builds a report from in-memory records for pure tests', () => {
    const report = buildWikiLintReport({
      entities: [],
      relationships: [],
      tasks: [],
      compileSuggestions: [],
    });

    expect(report.summary).toEqual({ errors: 0, warnings: 0, info: 0 });
    expect(report.issues).toEqual([]);
  });
});

function createTestEntity(id: string, type: Entity['type'], title: string, now: number): Entity {
  return {
    id,
    type,
    title,
    summary: '',
    tags: [],
    scenes: ['work'],
    properties: type === 'topic' ? { isPersonal: false, autoCollectedSnippets: [] } : { status: 'active' },
    sourceEntries: ['entry_1'],
    createdAt: now,
    updatedAt: now,
  } as Entity;
}
