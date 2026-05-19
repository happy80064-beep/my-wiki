import { db } from '@/lib/db/schema';
import { getClientId } from '@/lib/db/clientId';
import { relationshipTypeLabel } from '@/lib/graph/answer';
import type { CompiledEntityProfile, Entity, QueryCacheRecord, Relationship, Task } from '@/types';

const QUERY_CACHE_ALGORITHM_VERSION = 'qa-v5-list-guard';

export type WikiIndexEntry = {
  entityId: string;
  type: Entity['type'];
  title: string;
  aliases: string[];
  shortSummary: string;
  importance: number;
  sourceCount: number;
  relationshipCount: number;
  updatedAt: number;
};

export async function buildWikiIndex(limit = 200): Promise<WikiIndexEntry[]> {
  const [entities, relationships] = await Promise.all([db.entities.toArray(), db.relationships.toArray()]);
  const relationshipCountByEntity = new Map<string, number>();

  for (const relationship of relationships) {
    relationshipCountByEntity.set(relationship.from, (relationshipCountByEntity.get(relationship.from) ?? 0) + 1);
    relationshipCountByEntity.set(relationship.to, (relationshipCountByEntity.get(relationship.to) ?? 0) + 1);
  }

  return entities
    .filter((entity) => !isQueryInsightEntity(entity))
    .map((entity) => {
      const relationshipCount = relationshipCountByEntity.get(entity.id) ?? 0;
      const sourceCount = entity.sourceEntries.length;
      return {
        entityId: entity.id,
        type: entity.type,
        title: entity.title,
        aliases: buildWikiIndexAliases(entity),
        shortSummary: compact([
          entity.compiledProfile?.overview || entity.summary,
          categorySummary(entity),
        ].filter(Boolean).join(' '), 120),
        importance: sourceCount * 2 + relationshipCount * 3 + Math.min(entity.tags.length, 5),
        sourceCount,
        relationshipCount,
        updatedAt: entity.updatedAt,
      };
    })
    .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

function isQueryInsightEntity(entity: Entity) {
  return entity.type === 'topic' && entity.tags.includes('query-insight');
}

export async function refreshCompiledProfile(entityId: string) {
  const entity = await db.entities.get(entityId);
  if (!entity) return undefined;

  const [tasks, relationships, entries, allEntities] = await Promise.all([
    db.tasks.filter((task) => task.owner === entityId || task.linkedTo.includes(entityId)).toArray(),
    db.relationships.filter((relationship) => relationship.from === entityId || relationship.to === entityId).toArray(),
    db.entries.bulkGet(entity.sourceEntries),
    db.entities.toArray(),
  ]);
  const entityById = new Map(allEntities.map((item) => [item.id, item]));
  const profile = buildCompiledProfile({
    entity,
    tasks,
    relationships,
    entries: entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    entityById,
  });

  await db.entities.update(entityId, {
    compiledProfile: profile,
    updatedAt: Date.now(),
  });

  return db.entities.get(entityId);
}

export async function refreshCompiledProfiles(entityIds: string[]) {
  const uniqueIds = Array.from(new Set(entityIds.filter(Boolean)));
  for (const entityId of uniqueIds) {
    await refreshCompiledProfile(entityId);
  }
}

export async function getFreshQueryCache<T>(key: string) {
  const cached = await db.queryCache.get(key);
  if (!cached) return undefined;

  const dataUpdatedAt = await getKnowledgeUpdatedAt();
  if (cached.dataUpdatedAt < dataUpdatedAt) {
    await db.queryCache.delete(key);
    return undefined;
  }

  return cached.result as T;
}

export async function putQueryCache(input: Pick<QueryCacheRecord, 'key' | 'question' | 'result'>) {
  const now = Date.now();
  const dataUpdatedAt = await getKnowledgeUpdatedAt();
  await db.queryCache.put({
    ...input,
    clientId: getClientId(),
    createdAt: now,
    updatedAt: now,
    dataUpdatedAt,
  });
}

export function queryCacheKey(question: string) {
  const normalized = normalizeQueryQuestion(question).slice(0, 120);
  return normalized ? `${QUERY_CACHE_ALGORITHM_VERSION}:${normalized}` : '';
}

function normalizeQueryQuestion(question: string) {
  return question
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
    .trim();
}

export async function findCachedInsight(question: string) {
  const normalized = normalizeQueryQuestion(question).slice(0, 80);
  if (!normalized) return undefined;

  const candidates = await db.entities
    .where('tags')
    .equals(`question:${normalized}`)
    .toArray();

  return candidates
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .find((entity) => entity.type === 'topic' && entity.tags.includes('query-insight'));
}

async function getKnowledgeUpdatedAt() {
  const [entities, entries, tasks, relationships, compileSuggestions, wikiReviewItems] = await Promise.all([
    db.entities.orderBy('updatedAt').last(),
    db.entries.orderBy('capturedAt').last(),
    db.tasks.orderBy('createdAt').last(),
    db.relationships.orderBy('createdAt').last(),
    db.compileSuggestions.orderBy('updatedAt').last(),
    db.wikiReviewItems.orderBy('updatedAt').last(),
  ]);

  return Math.max(
    entities?.updatedAt ?? 0,
    entries?.capturedAt ?? 0,
    tasks?.createdAt ?? 0,
    relationships?.createdAt ?? 0,
    compileSuggestions?.updatedAt ?? 0,
    wikiReviewItems?.updatedAt ?? 0,
  );
}

function buildCompiledProfile(input: {
  entity: Entity;
  tasks: Task[];
  relationships: Relationship[];
  entries: Array<{ content: string }>;
  entityById: Map<string, Entity>;
}): CompiledEntityProfile {
  const { entity, tasks, relationships, entries, entityById } = input;
  const openTasks = tasks
    .filter((task) => task.status !== 'done' && task.status !== 'cancelled')
    .slice(0, 8)
    .map((task) => task.dueDate ? `${task.description}（截止：${task.dueDate}）` : task.description);
  const relationshipSummary = relationships.slice(0, 10).map((relationship) => {
    const otherId = relationship.from === entity.id ? relationship.to : relationship.from;
    const other = entityById.get(otherId);
    return `${relationshipTypeLabel(relationship.type)}：${other?.title ?? otherId}`;
  });
  const keyFacts = buildKeyFacts(entity);
  const sourceSummary = entries.length > 0
    ? `${entries.length} 条来源：${entries.slice(0, 3).map((entry) => compact(entry.content, 42)).join('；')}`
    : '暂无来源原文。';

  return {
    overview: entity.summary || `${entity.title} 相关记录。`,
    keyFacts,
    openTasks,
    relationshipSummary,
    sourceSummary,
    updatedAt: Date.now(),
  };
}

function buildKeyFacts(entity: Entity) {
  const facts: string[] = [];
  const properties = entity.properties as Record<string, unknown>;
  for (const [key, label] of Object.entries(propertyLabels)) {
    const value = properties[key];
    const display = Array.isArray(value) ? value.join('、') : typeof value === 'string' ? value : undefined;
    if (display?.trim()) facts.push(`${label}：${display.trim()}`);
  }
  for (const category of entity.categories ?? []) {
    facts.push(`${category.name}：${category.items.slice(0, 6).map((item) => item.title).join('、')}`);
  }
  if (entity.tags.length > 0) facts.push(`标签：${entity.tags.join('、')}`);
  return facts.slice(0, 10);
}

function buildWikiIndexAliases(entity: Entity) {
  return Array.from(new Set([
    entity.title,
    entity.title.replace(/数字/g, ''),
    entity.title.replace(/项目/g, ''),
    ...(entity.categories ?? []).flatMap((category) => [
      category.name,
      ...(category.aliases ?? []),
      ...category.items.slice(0, 8).map((item) => item.title),
    ]),
    ...entity.tags,
  ].filter((alias) => alias.trim().length >= 2)));
}

function categorySummary(entity: Entity) {
  const categories = entity.categories ?? [];
  if (categories.length === 0) return '';
  return categories
    .slice(0, 4)
    .map((category) => `${category.name}：${category.items.slice(0, 4).map((item) => item.title).join('、')}`)
    .join('；');
}

function compact(value: string, maxLength: number) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

const propertyLabels: Record<string, string> = {
  runtimeEnvironment: '运行环境',
  wakeWord: '唤醒词',
  stopWord: '终止词',
  localPath: '本地路径',
  models: '相关模型',
  ownerNote: '负责人说明',
  derivedFrom: '来源/基于项目',
  openSourceStatus: '开源状态',
};
