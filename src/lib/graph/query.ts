import {
  candidateResult,
  dedupeSources,
  emptyResult,
  entitySource,
  entrySource,
  formatOwnerTasksAnswer,
  formatProjectStatusAnswer,
  formatProjectTasksAnswer,
  formatRelatedEntitiesAnswer,
  taskSource,
} from './answer';
import {
  findEntityCandidates,
  getEntriesByIds,
  getPendingTasksByOwner,
  getPendingTasksForProject,
  getRelatedEntities,
  getRelationshipsWithEntity,
} from './filter';
import { parseQueryIntent } from './queryIntent';
import { getSubgraph } from './traverse';
import type { QuerySource, QueryTraceStep, StructuredQueryResult } from './types';
import type { Entity, Entry, Relationship, Task } from '@/types';
import { db } from '@/lib/db';

export type { QuerySource, StructuredQueryResult } from './types';

export async function runStructuredQuery(question: string): Promise<StructuredQueryResult> {
  const trimmed = question.trim();
  if (!trimmed) {
    return emptyResult('请输入一个问题。');
  }

  const intent = parseQueryIntent(trimmed);

  if (intent.type === 'my_pending_tasks') {
    return answerOwnerTasks(intent.entityName ?? '我', true);
  }

  if (intent.type === 'person_pending_tasks') {
    return answerOwnerTasks(intent.entityName, false);
  }

  if (intent.type === 'project_tasks') {
    return answerProjectTasks(intent.entityName, 'tasks');
  }

  if (intent.type === 'project_improvements') {
    return answerProjectTasks(intent.entityName, 'improvements');
  }

  if (intent.type === 'project_status') {
    return answerProjectStatus(intent.entityName);
  }

  if (intent.type === 'project_related_entities') {
    return answerProjectRelatedEntities(intent.entityName);
  }

  if (intent.type === 'entity_profile') {
    return answerWikiRead(trimmed, intent.entityName);
  }

  return answerWikiRead(trimmed, intent.entityName);
}

async function answerOwnerTasks(personName: string | undefined, isSelf: boolean): Promise<StructuredQueryResult> {
  if (!personName) {
    return emptyResult('我还不能确定你问的是谁的任务。可以把人名写得更明确一点。');
  }

  const candidates = await findEntityCandidates(personName, ['person']);
  if (candidates.length === 0) {
    const name = isSelf ? '我' : personName;
    return emptyResult(`没有找到名为「${name}」的人员记录。`, ['先捕获一条包含任务负责人的记录', '查看知识库现有人员']);
  }

  if (candidates.length > 1) {
    return candidateResult('人员', candidates.map((candidate) => candidate.entity));
  }

  const owner = candidates[0].entity;
  const tasks = await getPendingTasksByOwner(owner.id);
  const entries = await getEntriesByIds(tasks.map((task) => task.source));

  return {
    answer: formatOwnerTasksAnswer(owner, tasks),
    sources: dedupeSources([entitySource(owner), ...tasks.map(taskSource), ...entries.map(entrySource)]),
    suggestions: [`查看${owner.title}的人员页`, `继续问${owner.title}参与了哪些事项`],
  };
}

async function answerProjectTasks(
  projectName: string | undefined,
  mode: 'tasks' | 'improvements',
): Promise<StructuredQueryResult> {
  const project = await resolveSingleProject(projectName);
  if ('result' in project) return project.result;

  const tasks = await getPendingTasksForProject(project.entity.id);
  const entries = await getEntriesByIds(tasks.map((task) => task.source));

  return {
    answer: formatProjectTasksAnswer(project.entity, tasks, mode),
    sources: dedupeSources([entitySource(project.entity), ...tasks.map(taskSource), ...entries.map(entrySource)]),
    suggestions: [`查看${project.entity.title}相关工具`, `查看${project.entity.title}当前状态`],
  };
}

async function answerProjectStatus(projectName: string | undefined): Promise<StructuredQueryResult> {
  const project = await resolveSingleProject(projectName);
  if ('result' in project) return project.result;

  const tasks = await getPendingTasksForProject(project.entity.id);
  const entries = await getEntriesByIds([
    ...project.entity.sourceEntries,
    ...tasks.map((task) => task.source),
  ]);

  return {
    answer: formatProjectStatusAnswer(project.entity, tasks),
    sources: dedupeSources([entitySource(project.entity), ...tasks.map(taskSource), ...entries.map(entrySource)]),
    suggestions: [`查看${project.entity.title}下一阶段优化项`, `查看${project.entity.title}关联实体`],
  };
}

async function answerProjectRelatedEntities(projectName: string | undefined): Promise<StructuredQueryResult> {
  const project = await resolveSingleProject(projectName);
  if ('result' in project) return project.result;

  const relationships = await getRelationshipsWithEntity(project.entity.id);
  const relatedEntities = await getRelatedEntities(project.entity.id, relationships);
  const evidenceEntryIds = relationships.flatMap((relationship) => relationship.evidence);
  const entries = await getEntriesByIds(evidenceEntryIds);

  return {
    answer: formatRelatedEntitiesAnswer(project.entity, relationships, relatedEntities),
    sources: dedupeSources([entitySource(project.entity), ...relatedEntities.map(entitySource), ...entries.map(entrySource)]),
    suggestions: [`查看${project.entity.title}下一阶段优化项`, `查看${project.entity.title}未完成任务`],
  };
}

async function answerWikiRead(question: string, entityName: string | undefined): Promise<StructuredQueryResult> {
  const terms = buildSearchTerms(question, entityName);
  const trace: QueryTraceStep[] = [
    {
      layer: 'intent',
      label: '问题解析',
      detail: `抽取关键词：${terms.join('、') || '未抽取到明确关键词'}`,
    },
  ];

  const candidates = await findWikiEntityCandidates(terms);
  trace.push({
    layer: 'directory',
    label: '知识目录',
    detail:
      candidates.length > 0
        ? `命中 ${candidates.length} 个候选实体：${candidates.map((candidate) => candidate.entity.title).join('、')}`
        : '没有在实体目录中命中候选。',
  });

  if (candidates.length === 0) {
    return answerEvidenceFallback(question, terms, trace);
  }

  if (isAmbiguous(candidates)) {
    const entities = candidates.map((candidate) => candidate.entity);
    return {
      ...candidateResult('实体', entities),
      trace,
    };
  }

  const entity = candidates[0].entity;
  const document = await readEntityDocument(entity);
  trace.push(
    {
      layer: 'entity',
      label: '实体文档',
      detail: `读取摘要、属性、${document.tasks.length} 条任务、${document.entries.length} 条来源。`,
    },
    {
      layer: 'graph',
      label: '关系子图',
      detail: `展开 1 跳关系，读取 ${document.relationships.length} 条关系、${document.relatedEntities.length} 个相邻实体。`,
    },
    {
      layer: 'evidence',
      label: '来源证据',
      detail:
        document.entries.length > 0
          ? `已读取 ${document.entries.length} 条原始捕获作为证据。`
          : '当前实体还没有可回读的原始捕获。',
    },
  );

  return {
    answer: formatWikiReadAnswer(question, document),
    candidates: [entity],
    sources: buildWikiReadSources(document),
    suggestions: buildEntitySuggestions(entity),
    trace,
  };
}

type WikiEntityCandidate = {
  entity: Entity;
  score: number;
};

type EntityDocument = {
  entity: Entity;
  tasks: Task[];
  relationships: Relationship[];
  relatedEntities: Entity[];
  entries: Entry[];
};

async function findWikiEntityCandidates(terms: string[]): Promise<WikiEntityCandidate[]> {
  if (terms.length === 0) return [];

  const [entities, relationships] = await Promise.all([db.entities.toArray(), db.relationships.toArray()]);
  const relationshipCountByEntity = new Map<string, number>();
  for (const relationship of relationships) {
    relationshipCountByEntity.set(relationship.from, (relationshipCountByEntity.get(relationship.from) ?? 0) + 1);
    relationshipCountByEntity.set(relationship.to, (relationshipCountByEntity.get(relationship.to) ?? 0) + 1);
  }

  return entities
    .map((entity) => {
      const baseScore = Math.max(...terms.map((term) => scoreEntityForTerm(entity, term)));
      const sourceBoost = Math.min(entity.sourceEntries.length * 2, 6);
      const relationshipBoost = Math.min(relationshipCountByEntity.get(entity.id) ?? 0, 5);
      return { entity, score: baseScore + sourceBoost + relationshipBoost };
    })
    .filter((candidate) => candidate.score >= 30)
    .sort((a, b) => b.score - a.score || b.entity.updatedAt - a.entity.updatedAt)
    .slice(0, 5);
}

async function readEntityDocument(entity: Entity): Promise<EntityDocument> {
  const [tasks, subgraph] = await Promise.all([
    db.tasks
      .filter((task) => task.owner === entity.id || task.linkedTo.includes(entity.id))
      .toArray(),
    getSubgraph(entity.id, 1),
  ]);

  const relationships = subgraph.edges;
  const relatedEntities = subgraph.nodes.filter((node) => node.id !== entity.id);
  const entryIds = [
    ...entity.sourceEntries,
    ...tasks.map((task) => task.source),
    ...relationships.flatMap((relationship) => relationship.evidence),
  ];
  const entries = await getEntriesByIds(entryIds);

  return { entity, tasks, relationships, relatedEntities, entries };
}

async function answerEvidenceFallback(
  question: string,
  terms: string[],
  trace: QueryTraceStep[],
): Promise<StructuredQueryResult> {
  const [entries, tasks] = await Promise.all([findEntryEvidence(terms), findTaskEvidence(terms)]);
  trace.push({
    layer: 'evidence',
    label: '来源证据',
    detail:
      entries.length > 0 || tasks.length > 0
        ? `目录未命中后回扫原始证据，找到 ${entries.length} 条捕获、${tasks.length} 条任务。`
        : '目录和原始证据都没有命中。',
  });

  if (entries.length === 0 && tasks.length === 0) {
    return {
      ...emptyResult('没有找到相关记录。可以换一个更具体的人名、事项名或主题词。'),
      trace,
    };
  }

  const entryLines = entries.slice(0, 3).map((entry, index) => `${index + 1}. ${snippet(entry.content)}`);
  const taskLines = tasks.slice(0, 3).map((task, index) => `${index + 1}. ${task.description}`);
  const answer = [
    '没有先命中明确实体，但在原始证据层找到可能相关内容：',
    entryLines.length > 0 ? `\n原始捕获：\n${entryLines.join('\n')}` : '',
    taskLines.length > 0 ? `\n任务：\n${taskLines.join('\n')}` : '',
    '\n建议先打开来源确认，或补充更明确的实体名称继续查询。',
  ]
    .filter(Boolean)
    .join('');

  return {
    answer,
    sources: dedupeSources([...entries.map(entrySource), ...tasks.map(taskSource)]),
    suggestions: ['查看来源记录', '换一个更明确的实体名再问'],
    trace,
  };
}

function formatWikiReadAnswer(question: string, document: EntityDocument) {
  const { entity, tasks, relationships, relatedEntities, entries } = document;
  const lines: string[] = [];

  if (isNameQuestion(question)) {
    lines.push(`它在知识库里的正式名称是「${entity.title}」。`);
    const roleName = extractRoleName(entries);
    if (roleName) {
      lines.push(`来源中还提到当前角色名为「${roleName}」。`);
    }
    if (entity.summary) {
      lines.push(`摘要：${entity.summary}`);
    }
    return lines.join('\n');
  }

  lines.push(`${entity.title}（${entityTypeLabel(entity.type)}）`);

  if (entity.summary) {
    lines.push(`摘要：${entity.summary}`);
  }

  const status = getEntityStatus(entity);
  if (status) {
    lines.push(`当前状态：${status}`);
  }

  const openTasks = tasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled');
  if (openTasks.length > 0) {
    lines.push(`未完成任务：\n${openTasks.slice(0, 5).map((task, index) => `${index + 1}. ${task.description}`).join('\n')}`);
  }

  if (relatedEntities.length > 0) {
    lines.push(
      `直接关联：${relatedEntities
        .slice(0, 8)
        .map((related) => related.title)
        .join('、')}`,
    );
  }

  if (relationships.length > 0) {
    lines.push(`关系证据：已读取 ${relationships.length} 条一跳关系。`);
  }

  if (entries.length > 0) {
    lines.push(`来源：${entries.length} 条原始捕获可追溯。`);
  }

  return lines.join('\n\n');
}

function buildWikiReadSources(document: EntityDocument): QuerySource[] {
  return dedupeSources([
    entitySource(document.entity),
    ...document.tasks.slice(0, 6).map(taskSource),
    ...document.relatedEntities.slice(0, 8).map(entitySource),
    ...document.entries.slice(0, 6).map(entrySource),
  ]);
}

function buildEntitySuggestions(entity: Entity) {
  return [`查看${entity.title}当前状态`, `查看${entity.title}关联实体`, `查看${entity.title}未完成任务`];
}

function buildSearchTerms(question: string, entityName: string | undefined) {
  const cleanedQuestion = cleanupSearchText(question);
  const cleanedEntityName = cleanupSearchText(entityName ?? '');
  return Array.from(new Set([cleanedEntityName, cleanedQuestion].filter((term) => term.length >= 2)));
}

function cleanupSearchText(value: string) {
  return value
    .replace(/[？?。！!，,、：:；;]/g, '')
    .replace(/^(请问|帮我|帮忙|查一下|看一下|看看|关于)/, '')
    .replace(
      /(下一阶段|当前|短期优先级|优先级|推荐后续|后续|需要|有哪些|有什么|用了哪些|使用哪些|用了|使用|关联|相关|状态|进展|进度|任务|待办|未完成|没完成|重点问题|问题|叫什么|叫啥|名字|名称|是谁|是什么|介绍|讲讲|档案|信息|概况|总结|吗|呢|的)/g,
      '',
    )
    .replace(/\s+/g, '')
    .trim();
}

function scoreEntityForTerm(entity: Entity, term: string) {
  const normalizedTerm = normalize(term);
  if (!normalizedTerm) return 0;

  const title = normalize(entity.title);
  const summary = normalize(entity.summary);
  const tags = normalize(entity.tags.join(''));
  const scenes = normalize(entity.scenes.join(''));

  if (title === normalizedTerm) return 100;
  if (title.includes(normalizedTerm) || normalizedTerm.includes(title)) return 88;
  if (isSubsequence(normalizedTerm, title)) return 72;
  if (isSubsequence(title, normalizedTerm)) return 58;
  if (summary.includes(normalizedTerm) || tags.includes(normalizedTerm) || scenes.includes(normalizedTerm)) return 42;

  const overlap = overlapRatio(normalizedTerm, title);
  if (overlap >= 0.75) return 56;
  if (overlap >= 0.5) return 34;
  return 0;
}

async function findEntryEvidence(terms: string[]) {
  const entries = await db.entries.orderBy('capturedAt').reverse().toArray();
  return entries.filter((entry) => terms.some((term) => evidenceTextMatches(entry.content, term))).slice(0, 5);
}

async function findTaskEvidence(terms: string[]) {
  const tasks = await db.tasks.orderBy('createdAt').reverse().toArray();
  return tasks.filter((task) => terms.some((term) => evidenceTextMatches(task.description, term))).slice(0, 5);
}

function evidenceTextMatches(text: string, term: string) {
  const normalizedText = normalize(text);
  const normalizedTerm = normalize(term);
  if (!normalizedText || !normalizedTerm) return false;
  return normalizedText.includes(normalizedTerm) || isSubsequence(normalizedTerm, normalizedText);
}

function isAmbiguous(candidates: WikiEntityCandidate[]) {
  if (candidates.length < 2) return false;
  const [first, second] = candidates;
  return first.score < 70 && first.score - second.score < 10;
}

function isNameQuestion(question: string) {
  return /(叫什么|叫啥|名字|名称)/.test(question);
}

function extractRoleName(entries: Entry[]) {
  for (const entry of entries) {
    const match =
      entry.content.match(/(?:当前)?角色名(?:为|是|叫)?[：:\s]*([^。\n；;，,]+)/) ??
      entry.content.match(/名为[：:\s]*([^。\n；;，,]+)/);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function getEntityStatus(entity: Entity) {
  if (entity.type === 'project') return entity.properties.status;
  return undefined;
}

function entityTypeLabel(type: Entity['type']) {
  const labels: Record<Entity['type'], string> = {
    person: '人员',
    project: '事项',
    event: '互动',
    topic: '主题',
  };
  return labels[type];
}

function snippet(value: string) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 80 ? `${compact.slice(0, 80)}...` : compact;
}

function normalize(value: string) {
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

type ProjectResolution = { entity: Entity } | { result: StructuredQueryResult };

async function resolveSingleProject(projectName: string | undefined): Promise<ProjectResolution> {
  if (!projectName) {
    return {
      result: emptyResult('我还不能确定你问的是哪个事项。可以把事项名称写得更明确一点。', [
        '查看知识库现有事项',
        '换一个更完整的事项名再问',
      ]),
    };
  }

  const candidates = await findEntityCandidates(projectName, ['project']);
  if (candidates.length === 0) {
    return {
      result: emptyResult(`没有找到名为「${projectName}」的事项记录。`, [
        '先捕获一条包含该事项的记录',
        '查看知识库现有事项',
      ]),
    };
  }

  if (candidates.length > 1) {
    return {
      result: candidateResult('事项', candidates.map((candidate) => candidate.entity)),
    };
  }

  return { entity: candidates[0].entity };
}
