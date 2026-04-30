import { beforeEach, describe, expect, it } from 'vitest';
import { createEntity, createRelationship, db, resetDatabase } from '@/lib/db';
import { createLocalCaptureDraft, persistCaptureDraft } from '@/lib/capture';

describe('capture flow', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('creates an editable draft from text and persists all derived records', async () => {
    const content = '今天和虾总约了股票监控项目的进度同步会，他确认这周内调通飞书推送';
    const draft = createLocalCaptureDraft(content);

    draft.primaryEntity.title = '股票监控进度同步';

    const result = await persistCaptureDraft(content, draft);

    expect(result.entry.processed).toBe(true);
    expect(result.entities.some((entity) => entity.title === '股票监控进度同步')).toBe(true);
    expect(result.relationships.length).toBeGreaterThan(0);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.owner).toBeTruthy();
    expect(result.compilation.createdEntities).toBe(result.entities.length);
    expect(result.compilation.createdTasks).toBe(1);

    const savedEntry = await db.entries.get(result.entry.id);
    expect(savedEntry?.derivedEntities).toHaveLength(result.entities.length);
    expect(savedEntry?.derivedTasks).toHaveLength(result.tasks.length);
  });

  it('reuses existing entities and compiles capture impact into them', async () => {
    const person = await createEntity({ type: 'person', title: '虾总', tags: ['客户'], scenes: ['work'] });
    const project = await createEntity({ type: 'project', title: '股票监控', tags: ['旧项目'], scenes: ['work'] });
    const topic = await createEntity({ type: 'topic', title: '语音交互', tags: ['旧主题'], scenes: ['personal'] });
    const previousEntry = await db.entries.add({
      id: 'entry_previous',
      content: '旧证据',
      source: 'text',
      capturedAt: 1,
      processed: true,
      derivedEntities: [person.id, project.id],
      derivedTasks: [],
      derivedRelationships: [],
    });

    await createRelationship({
      from: person.id,
      to: project.id,
      type: 'participant',
      evidence: [previousEntry],
    });

    const draft = createLocalCaptureDraft('今天和虾总同步股票监控项目，需要完善语音交互');
    draft.relatedEntities.push({
      clientId: 'topic_voice',
      type: 'topic',
      title: '语音交互',
      summary: '语音交互相关主题。',
      tags: ['新主题'],
      scenes: ['work'],
    });
    draft.relationships.push({
      clientId: 'rel_topic',
      fromClientId: draft.primaryEntity.clientId,
      toClientId: 'topic_voice',
      type: 'relevant-to',
    });

    const result = await persistCaptureDraft('今天和虾总同步股票监控项目，需要完善语音交互', draft);

    const allPeople = await db.entities.where('type').equals('person').toArray();
    const allProjects = await db.entities.where('type').equals('project').toArray();
    const updatedPerson = await db.entities.get(person.id);
    const updatedProject = await db.entities.get(project.id);
    const updatedTopic = await db.entities.get(topic.id);
    const participantRelationships = await db.relationships
      .where('from')
      .equals(person.id)
      .filter((relationship) => relationship.to === project.id && relationship.type === 'participant')
      .toArray();

    expect(allPeople).toHaveLength(1);
    expect(allProjects.map((entity) => entity.title)).toContain('股票监控');
    expect(updatedPerson?.sourceEntries).toContain(result.entry.id);
    expect(updatedPerson?.properties && 'lastContactAt' in updatedPerson.properties).toBe(true);
    expect(updatedProject?.sourceEntries).toContain(result.entry.id);
    expect(updatedTopic?.sourceEntries).toContain(result.entry.id);
    expect(updatedTopic?.properties && 'autoCollectedSnippets' in updatedTopic.properties).toBe(true);
    expect(
      updatedTopic?.properties && 'autoCollectedSnippets' in updatedTopic.properties
        ? updatedTopic.properties.autoCollectedSnippets
        : [],
    ).toContain(result.entry.id);
    expect(participantRelationships).toHaveLength(1);
    expect(participantRelationships[0].evidence).toContain(result.entry.id);
    expect(result.compilation.reusedEntities).toBeGreaterThanOrEqual(3);
    expect(result.compilation.updatedPeople).toBeGreaterThanOrEqual(1);
    expect(result.compilation.updatedTopics).toBeGreaterThanOrEqual(1);
    expect(result.compilation.updatedRelationships).toBeGreaterThanOrEqual(1);
  });

  it('persists capture compile suggestions into the review queue', async () => {
    const draft = createLocalCaptureDraft('OpenMaic 是开源项目。');
    draft.primaryEntity.type = 'topic';
    draft.primaryEntity.title = 'OpenMaic';
    draft.compileSuggestions = [
      {
        clientId: 'compile_open_source',
        entityClientId: draft.primaryEntity.clientId,
        entityTitle: 'OpenMaic',
        propertyKey: 'openSourceStatus',
        propertyLabel: '开源状态',
        propertyValue: '开源项目',
        evidenceSnippet: 'OpenMaic 是开源项目。',
        confidence: 0.9,
      },
    ];

    const result = await persistCaptureDraft('OpenMaic 是开源项目。', draft);
    const suggestions = await db.compileSuggestions.where('status').equals('pending').toArray();

    expect(result.compilation.queuedCompileSuggestions).toBe(1);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toEqual(
      expect.objectContaining({
        entityTitle: 'OpenMaic',
        propertyKey: 'openSourceStatus',
        propertyValue: '开源项目',
      }),
    );
  });
});
