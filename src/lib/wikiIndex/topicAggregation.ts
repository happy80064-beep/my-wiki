import { createEntity, createRelationship, db, updateEntity, updateRelationship } from '@/lib/db';
import type { Entity, Relationship } from '@/types';

export type TopicAutoAggregationResult = {
  topicIds: string[];
  createdTopics: number;
  updatedTopics: number;
  linkedRelationships: string[];
};

type TopicCandidate = {
  title: string;
  score: number;
  sourceEntityId: string;
};

const GENERIC_TOPIC_TERMS = new Set([
  'ai',
  'pdf',
  'ocr',
  'work',
  'life',
  'social',
  'personal',
  '项目',
  '事项',
  '人物',
  '主题',
  '互动',
  '任务',
  '会议',
  '待办',
  '文件',
  '原文',
  '材料',
  '记录',
  '相关',
  '总结',
  '导入',
  '标签',
  '类别',
  '类型',
  '来源',
  '本地',
  '未命名',
]);

export async function runTopicAutoAggregation(
  seedEntityIds: string[],
  entryId: string,
): Promise<TopicAutoAggregationResult> {
  const uniqueSeedIds = Array.from(new Set(seedEntityIds.filter(Boolean)));
  if (uniqueSeedIds.length === 0 || !entryId) {
    return { topicIds: [], createdTopics: 0, updatedTopics: 0, linkedRelationships: [] };
  }

  const [seedEntities, allEntities, allRelationships] = await Promise.all([
    db.entities.bulkGet(uniqueSeedIds),
    db.entities.toArray(),
    db.relationships.toArray(),
  ]);
  const seeds = seedEntities.filter((entity): entity is Entity => Boolean(entity));
  if (seeds.length === 0) {
    return { topicIds: [], createdTopics: 0, updatedTopics: 0, linkedRelationships: [] };
  }

  const candidates = rankTopicCandidates(seeds);
  const topics: Entity[] = allEntities.filter((entity) => entity.type === 'topic');
  const relationships = [...allRelationships];
  const result: TopicAutoAggregationResult = {
    topicIds: [],
    createdTopics: 0,
    updatedTopics: 0,
    linkedRelationships: [],
  };

  for (const candidate of candidates.slice(0, 4)) {
    const topic = await upsertAutoTopic(candidate, topics, entryId);
    const existingTopicIndex = topics.findIndex((item) => item.id === topic.id);
    if (existingTopicIndex >= 0) {
      topics[existingTopicIndex] = topic;
      result.updatedTopics += 1;
    } else {
      topics.push(topic);
      result.createdTopics += 1;
    }
    result.topicIds.push(topic.id);

    const sourceEntity = seeds.find((entity) => entity.id === candidate.sourceEntityId);
    if (!sourceEntity || sourceEntity.id === topic.id) continue;
    const relationship = await upsertTopicRelationship(topic.id, sourceEntity.id, entryId, relationships);
    relationships.push(relationship);
    result.linkedRelationships.push(relationship.id);
  }

  result.topicIds = unique(result.topicIds);
  result.linkedRelationships = unique(result.linkedRelationships);
  return result;
}

function rankTopicCandidates(entities: Entity[]) {
  const byTitle = new Map<string, TopicCandidate>();
  const seedTitleKeys = new Set(entities.map((entity) => normalizeTopicTerm(entity.title)));

  for (const entity of entities) {
    const terms: TopicCandidate[] = [
      ...entity.tags.map((tag) => ({ title: tag, score: 2, sourceEntityId: entity.id })),
      ...(entity.categories ?? []).flatMap((category) => [
        { title: category.name, score: 4, sourceEntityId: entity.id },
        ...(category.aliases ?? []).map((alias) => ({ title: alias, score: 2, sourceEntityId: entity.id })),
      ]),
    ];

    if (entity.type === 'topic') {
      terms.push({ title: entity.title, score: 5, sourceEntityId: entity.id });
    }

    for (const term of terms) {
      const title = cleanTopicTitle(term.title);
      const key = normalizeTopicTerm(title);
      if (!isUsefulTopicTerm(title, key) || seedTitleKeys.has(key)) continue;
      const current = byTitle.get(key);
      byTitle.set(key, {
        title,
        score: (current?.score ?? 0) + term.score,
        sourceEntityId: current?.sourceEntityId ?? term.sourceEntityId,
      });
    }
  }

  return Array.from(byTitle.values()).sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
}

async function upsertAutoTopic(candidate: TopicCandidate, topics: Entity[], entryId: string) {
  const normalizedTitle = normalizeTopicTerm(candidate.title);
  const existing = topics.find((topic) => {
    const aliases = [topic.title, ...topic.tags, ...(topic.categories ?? []).flatMap((category) => [category.name, ...(category.aliases ?? [])])];
    return aliases.some((alias) => normalizeTopicTerm(alias) === normalizedTitle);
  });

  if (!existing) {
    return createEntity({
      type: 'topic',
      title: candidate.title,
      summary: `${candidate.title} 是由捕获材料自动汇集的主题，可在知识库中继续整理。`,
      tags: ['auto-topic'],
      scenes: ['work'],
      properties: { isPersonal: false, autoCollectedSnippets: [entryId] },
      sourceEntries: [entryId],
    });
  }

  const properties = existing.properties;
  const autoCollectedSnippets =
    existing.type === 'topic' && 'autoCollectedSnippets' in properties
      ? unique([...properties.autoCollectedSnippets, entryId])
      : [entryId];
  const updated = await updateEntity(existing.id, {
    tags: unique([...existing.tags, 'auto-topic']),
    properties: existing.type === 'topic'
      ? {
          ...properties,
          autoCollectedSnippets,
        }
      : properties,
    sourceEntries: unique([...existing.sourceEntries, entryId]),
  });
  return updated ?? existing;
}

async function upsertTopicRelationship(
  topicId: string,
  entityId: string,
  entryId: string,
  relationships: Relationship[],
) {
  const existing = relationships.find((relationship) =>
    relationship.from === topicId && relationship.to === entityId && relationship.type === 'about',
  );
  if (!existing) {
    return createRelationship({
      from: topicId,
      to: entityId,
      type: 'about',
      evidence: [entryId],
    });
  }

  const updated = await updateRelationship(existing.id, {
    evidence: unique([...existing.evidence, entryId]),
  });
  return updated ?? existing;
}

function cleanTopicTitle(value: string) {
  return value
    .replace(/^#+\s*/, '')
    .replace(/[:：]\s*$/, '')
    .trim();
}

function isUsefulTopicTerm(title: string, key: string) {
  if (key.length < 2 || key.length > 32) return false;
  if (GENERIC_TOPIC_TERMS.has(key) || GENERIC_TOPIC_TERMS.has(title.toLowerCase())) return false;
  if (/^\d+$/.test(key)) return false;
  if (/^[a-z]$/.test(key)) return false;
  return true;
}

function normalizeTopicTerm(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
    .trim();
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}
