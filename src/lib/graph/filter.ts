import { db } from '@/lib/db';
import type { Entity, EntityType, Entry, Relationship, Task } from '@/types';

export type EntityCandidate = {
  entity: Entity;
  score: number;
};

export async function findEntityCandidates(name: string | undefined, types?: EntityType[]) {
  const entities = await db.entities.toArray();
  const pool = types ? entities.filter((entity) => types.includes(entity.type)) : entities;
  const searchTerms = buildEntitySearchTerms(name ?? '');

  if (searchTerms.length === 0) {
    return [];
  }

  return pool
    .map((entity) => ({
      entity,
      score: Math.max(...searchTerms.map((term) => scoreEntity(entity, term.normalized, term.derived))),
    }))
    .filter((candidate) => candidate.score >= 45)
    .sort((a, b) => b.score - a.score || b.entity.updatedAt - a.entity.updatedAt)
    .slice(0, 5);
}

export async function getPendingTasksByOwner(ownerId: string) {
  return db.tasks
    .where('owner')
    .equals(ownerId)
    .filter(isOpenTask)
    .toArray();
}

export async function getPendingTasksForProject(projectId: string) {
  return db.tasks
    .filter((task) => task.linkedTo.includes(projectId) && isOpenTask(task))
    .toArray();
}

export async function getRelationshipsWithEntity(entityId: string) {
  const [outgoing, incoming] = await Promise.all([
    db.relationships.where('from').equals(entityId).toArray(),
    db.relationships.where('to').equals(entityId).toArray(),
  ]);

  return [...outgoing, ...incoming].sort((a, b) => b.createdAt - a.createdAt);
}

export async function getRelatedEntities(entityId: string, relationships: Relationship[]) {
  const relatedIds = Array.from(
    new Set(
      relationships
        .map((relationship) => (relationship.from === entityId ? relationship.to : relationship.from))
        .filter((id) => id !== entityId),
    ),
  );

  const entities = await db.entities.bulkGet(relatedIds);
  const entityById = new Map(entities.filter((entity): entity is Entity => Boolean(entity)).map((entity) => [entity.id, entity]));

  return relatedIds
    .map((id) => entityById.get(id))
    .filter((entity): entity is Entity => Boolean(entity));
}

export async function getEntriesByIds(ids: string[]) {
  const uniqueIds = Array.from(new Set(ids));
  const entries = await db.entries.bulkGet(uniqueIds);
  return entries.filter((entry): entry is Entry => Boolean(entry));
}

export async function fuzzyFindEntities(question: string) {
  const searchTerms = buildEntitySearchTerms(question);
  const entities = await db.entities.toArray();

  if (searchTerms.length === 0) return [];

  return entities
    .map((entity) => ({
      entity,
      score: Math.max(...searchTerms.map((term) => scoreEntity(entity, term.normalized, term.derived))),
    }))
    .filter((candidate) => candidate.score >= 30)
    .sort((a, b) => b.score - a.score || b.entity.updatedAt - a.entity.updatedAt)
    .slice(0, 5);
}

function isOpenTask(task: Task) {
  return task.status !== 'done' && task.status !== 'cancelled';
}

type EntitySearchTerm = {
  normalized: string;
  derived: boolean;
};

function buildEntitySearchTerms(value: string): EntitySearchTerm[] {
  const phrase = value.trim();
  const baseTerms = uniqueStrings([
    phrase,
    stripEntityDescriptors(phrase),
    ...domainEntityAliases(phrase),
  ]);

  const expanded = baseTerms.flatMap((term) => [
    { value: term, derived: term !== phrase },
    ...cjkBigrams(term).map((gram) => ({ value: gram, derived: true })),
  ]);

  const seen = new Set<string>();
  return expanded
    .map((term) => ({ normalized: normalizeName(term.value), derived: term.derived }))
    .filter((term) => (term.normalized.length >= 2 || isAllowedSingleCharEntityTerm(term)) && !isWeakEntityTerm(term.normalized))
    .filter((term) => {
      if (seen.has(term.normalized)) return false;
      seen.add(term.normalized);
      return true;
    });
}

function isAllowedSingleCharEntityTerm(term: EntitySearchTerm) {
  return !term.derived && term.normalized === '我';
}

function scoreEntity(entity: Entity, normalizedName: string, derivedTerm = false) {
  const title = normalizeName(entity.title);
  const summary = normalizeName(entity.summary);
  const tags = normalizeName(entity.tags.join(''));

  if (title === normalizedName) return 100;
  if (title.includes(normalizedName) || normalizedName.includes(title)) return derivedTerm ? 78 : 85;
  if (isSubsequence(normalizedName, title)) return derivedTerm ? 62 : 70;
  if (isSubsequence(title, normalizedName)) return derivedTerm ? 52 : 58;
  if (summary.includes(normalizedName) || tags.includes(normalizedName)) return derivedTerm ? 45 : 48;

  const overlap = overlapRatio(normalizedName, title);
  if (overlap >= 0.75) return derivedTerm ? 50 : 55;
  if (overlap >= 0.55) return derivedTerm ? 34 : 38;
  return 0;
}

function stripEntityDescriptors(value: string) {
  return value.replace(/(方案|机制|路线|链路|能力|模块|系统|平台|项目|事项|问题)$/g, '').trim();
}

function domainEntityAliases(value: string) {
  const aliases: string[] = [];

  if (/(唤醒|叫醒|KWS|wake)/i.test(value)) {
    aliases.push('唤醒词', '主唤醒词', '本地唤醒', 'KWS', '小林');
  }

  if (/(终止|停止|结束|打断|miki|mi ki|米基|米奇)/i.test(value)) {
    aliases.push('终止词', '停止词', '结束词', '打断词', 'miki', 'mi ki', '米基', '米奇');
  }

  if (/(语音|听写|ASR|TTS|voice|speech)/i.test(value)) {
    aliases.push('语音交互', '语音链路', '语音输入', '语音输出', 'ASR', 'TTS');
  }

  if (/(运行环境|桌面环境|Windows|操作系统|平台)/i.test(value)) {
    aliases.push('Windows', 'Windows 桌面', '运行环境', '桌面环境');
  }

  return aliases;
}

function cjkBigrams(value: string) {
  const cjkText = value.replace(/[^\u4e00-\u9fa5]/g, '');
  if (cjkText.length < 4) return [];

  const grams: string[] = [];
  for (let index = 0; index < cjkText.length - 1; index += 1) {
    grams.push(cjkText.slice(index, index + 2));
  }
  return grams;
}

function isWeakEntityTerm(term: string) {
  return new Set([
    '什么',
    '哪些',
    '是否',
    '能否',
    '可以',
    '关系',
    '关联',
    '相关',
    '方案',
    '机制',
    '路线',
    '链路',
    '能力',
    '模块',
    '系统',
    '平台',
    '项目',
    '事项',
    '问题',
    '任务',
    '状态',
    '进展',
    '优化',
  ]).has(term);
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const trimmed = value.trim();
    const key = normalizeName(trimmed);
    if (!trimmed || !key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
    .trim();
}

function isSubsequence(needle: string, haystack: string) {
  if (!needle || !haystack) return false;
  let cursor = 0;
  for (const char of haystack) {
    if (char === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return true;
  }
  return false;
}

function overlapRatio(a: string, b: string) {
  if (!a || !b) return 0;
  const bChars = new Set([...b]);
  const matched = [...new Set([...a])].filter((char) => bChars.has(char)).length;
  return matched / new Set([...a]).size;
}
