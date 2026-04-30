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
  relationshipTypeLabel,
  taskSource,
} from './answer';
import {
  type EntityCandidate,
  findEntityCandidates,
  getEntriesByIds,
  getPendingTasksByOwner,
  getPendingTasksForProject,
  getRelatedEntities,
  getRelationshipsWithEntity,
} from './filter';
import { parseQueryIntent } from './queryIntent';
import { rankRelatedEntities } from './relevance';
import { findPaths, getSubgraph } from './traverse';
import type { QuerySource, QueryTraceStep, StructuredQueryResult, WikiCompileSuggestion } from './types';
import type { CompileSuggestionDraft, Entity, Entry, Relationship, Task } from '@/types';
import { composeQueryAnswer } from '@/lib/ai/queryComposerClient';
import type { QueryComposePayload } from '@/lib/ai/queryComposer';
import { planQueryWithAgent } from '@/lib/ai/queryPlannerClient';
import type { QueryIndexEntity, QueryPlan } from '@/lib/ai/queryPlanner';
import { db, materializeCompileSuggestions } from '@/lib/db';

export type { QuerySource, StructuredQueryResult } from './types';

export type RunStructuredQueryOptions = {
  composeWithLlm?: boolean;
  planWithAgent?: boolean;
  maxContextChars?: number;
};

export async function runStructuredQuery(
  question: string,
  options: RunStructuredQueryOptions = {},
): Promise<StructuredQueryResult> {
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

  if (intent.type === 'entity_relationship_path') {
    return answerEntityRelationshipPath(intent.entityName, intent.targetEntityName, trimmed, options);
  }

  if (intent.type === 'entity_profile') {
    return answerWikiRead(trimmed, intent.entityName, options);
  }

  return answerWikiRead(trimmed, intent.entityName, options);
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

async function answerEntityRelationshipPath(
  fromName: string | undefined,
  toName: string | undefined,
  question: string,
  options: RunStructuredQueryOptions,
): Promise<StructuredQueryResult> {
  if (!fromName || !toName) {
    return emptyResult('我还不能确定你问的是哪两个实体之间的关系。');
  }

  const relationshipPlan = await resolveRelationshipQueryPlan(question, fromName, toName, options);
  const selectedEntities = relationshipPlan.plan ? await getPlanSelectedEntities(relationshipPlan.plan) : [];
  const [baseFromCandidates, baseToCandidates] = await Promise.all([
    findEntityCandidates(fromName),
    findEntityCandidates(toName),
  ]);
  const fromCandidates = mergeSelectedEntityCandidates(baseFromCandidates, selectedEntities, fromName);
  const rawToCandidates = mergeSelectedEntityCandidates(baseToCandidates, selectedEntities, toName);
  const resolvedFrom = fromCandidates[0]?.entity;
  const toCandidates = resolvedFrom
    ? rawToCandidates.filter((candidate) => candidate.entity.id !== resolvedFrom.id)
    : rawToCandidates;

  if (fromCandidates.length === 0 || toCandidates.length === 0) {
    if (fromCandidates.length > 0 && toCandidates.length === 0 && toName) {
      const fallback = await answerRelationshipEvidenceFallback(
        fromCandidates[0].entity,
        toName,
        question,
        options,
        relationshipPlan.plan,
        relationshipPlan.trace,
      );
      if (fallback) return fallback;
    }

    const missing = [
      fromCandidates.length === 0 ? `「${fromName}」` : '',
      toCandidates.length === 0 ? `「${toName}」` : '',
    ].filter(Boolean);

    return {
      ...emptyResult(`没有找到 ${missing.join('、')} 对应的实体。可以先捕获包含它的材料，或换一个知识库里已有的实体名。`),
      trace: [
        ...optionalTrace(relationshipPlan.trace),
        {
          layer: 'intent',
          label: '关系问题解析',
          detail: `已识别为实体关系查询：${fromName} ↔ ${toName}。`,
        },
        {
          layer: 'directory',
          label: '知识目录',
          detail: `未命中实体：${missing.join('、')}。`,
        },
      ],
    };
  }

  const from = fromCandidates[0].entity;
  const to = toCandidates[0].entity;
  const paths = await findPaths(from.id, to.id, 3);
  const pathRelationships = paths.slice(0, 3).flat();
  const entries = await getEntriesByIds(pathRelationships.flatMap((relationship) => relationship.evidence));
  const pathEntityIds = Array.from(new Set(pathRelationships.flatMap((relationship) => [relationship.from, relationship.to])));
  const pathEntities = (await db.entities.bulkGet(pathEntityIds)).filter((entity): entity is Entity => Boolean(entity));

  const trace: QueryTraceStep[] = [
    ...optionalTrace(relationshipPlan.trace),
    {
      layer: 'intent',
      label: '关系问题解析',
      detail: `已识别为实体关系查询：${from.title} ↔ ${to.title}。`,
    },
    {
      layer: 'graph',
      label: '路径搜索',
      detail: paths.length > 0 ? `在 3 跳内找到 ${paths.length} 条关系路径。` : '3 跳内没有显式关系路径。',
    },
  ];

  const draftAnswer =
    paths.length > 0
      ? formatRelationshipPathAnswer(from, to, paths.slice(0, 3), pathEntities)
      : formatNoRelationshipPathAnswer(from, to);

  const result: StructuredQueryResult = {
    answer: draftAnswer,
    candidates: [from, to],
    sources: dedupeSources([
      entitySource(from),
      entitySource(to),
      ...pathEntities.map(entitySource),
      ...entries.map(entrySource),
    ]),
    suggestions: [`查看${from.title}的关系图谱`, `查看${to.title}的实体页`],
    trace,
  };

  return composeResultIfRequested(
    result,
    {
      question,
      draftAnswer,
      entities: [from, to, ...pathEntities].slice(0, 10).map((entity) => ({
        id: entity.id,
        type: entity.type,
        title: entity.title,
        summary: entity.summary,
      })),
      tasks: [],
      relationships: pathRelationships.slice(0, 10).map((relationship) => ({
        id: relationship.id,
        type: relationship.type,
        fromTitle: pathEntities.find((entity) => entity.id === relationship.from)?.title ?? relationship.from,
        toTitle: pathEntities.find((entity) => entity.id === relationship.to)?.title ?? relationship.to,
      })),
      entries: entries.slice(0, 5).map((entry) => ({
        id: entry.id,
        content: snippet(entry.content, 240),
        scope: 'entity-source',
        matchedTerms: [],
      })),
    },
    options,
  );
}

async function answerRelationshipEvidenceFallback(
  from: Entity,
  missingName: string,
  question: string,
  options: RunStructuredQueryOptions,
  agentPlan?: QueryPlan,
  agentTrace?: QueryTraceStep,
): Promise<StructuredQueryResult | undefined> {
  const linkedEntries = await getEntriesByIds(from.sourceEntries);
  const plan: QueryPlan = {
    ...mergeQueryPlans(agentPlan ?? buildFallbackQueryPlan(question, from.title), buildFallbackQueryPlan(question, from.title)),
    evidenceTerms: uniqueStrings([
      missingName,
      ...(agentPlan?.evidenceTerms ?? []),
      ...buildAttributeTerms(`${question} ${missingName}`),
      ...cjkBigrams(missingName),
    ]).slice(0, 16),
    needsRawEvidence: true,
    needsGlobalSearch: true,
  };
  const evidenceHits = await findRawEvidenceHits(question, from, linkedEntries, plan);
  if (evidenceHits.length === 0) return undefined;
  const compileSuggestions = await materializeCompileSuggestions(
    buildCompileSuggestions(
      {
        entity: from,
        tasks: [],
        relationships: [],
        relatedEntities: [],
        agentSelectedEntities: [],
        retrievalEntities: [],
        entries: linkedEntries,
        evidenceHits,
      },
      plan,
    ),
    question,
  );

  const answer = [
    `没有找到独立实体「${missingName}」，但在「${from.title}」的来源材料里找到了相关线索：`,
    formatEvidenceHitLines(evidenceHits),
  ].join('\n\n');
  const result: StructuredQueryResult = {
    answer,
    candidates: [from],
    sources: dedupeSources([entitySource(from), ...evidenceHits.map((hit) => entrySource(hit.entry))]),
    suggestions: [`把「${missingName}」编译成独立实体或属性`, `查看${from.title}的实体页`],
    trace: [
      ...optionalTrace(agentTrace),
      {
        layer: 'intent',
        label: '关系问题解析',
        detail: `已识别为实体关系查询：${from.title} ↔ ${missingName}。`,
      },
      {
        layer: 'directory',
        label: '知识目录',
        detail: `没有找到独立实体「${missingName}」，改为扫描「${from.title}」的来源材料。`,
      },
      {
        layer: 'evidence',
        label: '原始材料兜底扫描',
        detail: `定位到 ${evidenceHits.length} 个可能说明二者关系的片段。`,
      },
    ],
    compileSuggestions,
  };

  return composeResultIfRequested(
    result,
    {
      question,
      draftAnswer: answer,
      entities: [
        {
          id: from.id,
          type: from.type,
          title: from.title,
          summary: from.summary,
        },
      ],
      tasks: [],
      relationships: [],
      entries: evidenceHits.slice(0, 5).map((hit) => ({
        id: hit.entry.id,
        content: hit.snippet,
        scope: hit.scope,
        matchedTerms: hit.matchedTerms,
      })),
    },
    options,
  );
}

async function answerWikiRead(
  question: string,
  entityName: string | undefined,
  options: RunStructuredQueryOptions,
): Promise<StructuredQueryResult> {
  const index = await buildEntityIndex();
  const { plan, trace: planTrace } = await resolveQueryPlan(question, entityName, index, options);
  const terms = buildSearchTerms(question, entityName, plan);
  const trace: QueryTraceStep[] = [
    {
      layer: options.planWithAgent ? 'agent' : 'intent',
      label: options.planWithAgent ? 'Query Agent' : '问题解析',
      detail: planTrace,
    },
  ];

  const candidates = await findWikiEntityCandidates(terms, plan.selectedEntityIds);
  trace.push({
    layer: 'directory',
    label: '知识目录',
    detail:
      candidates.length > 0
        ? `命中 ${candidates.length} 个候选实体：${candidates.map((candidate) => candidate.entity.title).join('、')}`
        : '没有在实体目录中命中候选。',
  });

  if (candidates.length === 0) {
    return answerEvidenceFallback(question, terms, trace, options);
  }

  if (isAmbiguous(candidates)) {
    const entities = candidates.map((candidate) => candidate.entity);
    return {
      ...candidateResult('实体', entities),
      trace,
    };
  }

  const entity = candidates[0].entity;
  const expandedCandidates = await expandWikiEntityCandidates(candidates);
  trace.push({
    layer: 'graph',
    label: '多种子图谱扩展',
    detail: `以 ${Math.min(candidates.length, SEED_LIMIT)} 个候选为种子，按 1 跳 0.5、2 跳 0.25 衰减扩展，得到 ${expandedCandidates.length} 个候选页面。`,
  });

  const document = await readEntityDocument(
    entity,
    question,
    plan,
    expandedCandidates.map((candidate) => candidate.entity),
  );
  trace.push(
    {
      layer: 'entity',
      label: '实体文档',
      detail: `读取摘要、属性、${document.tasks.length} 条任务、${document.entries.length} 条来源。`,
    },
    {
      layer: 'graph',
      label: '关系子图',
      detail: `展开 2 跳关系，并按直接关系、共同来源、共同邻居和类型亲和度排序；读取 ${document.relationships.length} 条关系、${document.relatedEntities.length} 个相关实体，其中多种子扩展页面 ${document.retrievalEntities.length} 个。`,
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
  if (document.agentSelectedEntities.length > 0) {
    trace.push({
      layer: 'agent',
      label: 'Agent 证据范围',
      detail: `额外读取 Query Agent 选中的页面来源：${document.agentSelectedEntities
        .map((entity) => entity.title)
        .join('、')}。`,
    });
  }
  if (document.evidenceHits.length > 0) {
    const linkedCount = document.evidenceHits.filter((hit) => hit.scope === 'entity-source').length;
    const globalCount = document.evidenceHits.filter((hit) => hit.scope === 'global-fallback').length;
    trace.push({
      layer: 'evidence',
      label: '原始材料兜底扫描',
      detail: `围绕问题关键词定位到 ${document.evidenceHits.length} 个片段：相关来源 ${linkedCount} 个，全库兜底 ${globalCount} 个。`,
    });
  }

  const draftAnswer = formatWikiReadAnswer(question, document);
  const result: StructuredQueryResult = {
    answer: draftAnswer,
    candidates: [entity],
    sources: buildWikiReadSources(document),
    suggestions: buildEntitySuggestions(entity),
    trace,
    compileSuggestions: await materializeCompileSuggestions(buildCompileSuggestions(document, plan), question),
  };

  return composeResultIfRequested(
    result,
    buildQueryComposePayload(question, draftAnswer, document, computeContextBudget(options.maxContextChars)),
    options,
  );
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
  agentSelectedEntities: Entity[];
  retrievalEntities: Entity[];
  entries: Entry[];
  evidenceHits: EvidenceHit[];
};

type EvidenceHit = {
  entry: Entry;
  snippet: string;
  matchedTerms: string[];
  scope: 'entity-source' | 'global-fallback';
  score: number;
};

type QueryContextBudget = {
  maxContextChars: number;
  responseReserve: number;
  indexBudget: number;
  pageBudget: number;
  maxPageSize: number;
};

const SEED_LIMIT = 10;
const HOP1_PER_SEED = 5;
const HOP2_PER_HOP1 = 3;
const DECAY_HOP1 = 0.5;
const DECAY_HOP2 = 0.25;
const DEFAULT_QUERY_CONTEXT_CHARS = 24000;

async function buildEntityIndex(): Promise<QueryIndexEntity[]> {
  const [entities, relationships] = await Promise.all([db.entities.toArray(), db.relationships.toArray()]);
  const relationshipCountByEntity = new Map<string, number>();
  for (const relationship of relationships) {
    relationshipCountByEntity.set(relationship.from, (relationshipCountByEntity.get(relationship.from) ?? 0) + 1);
    relationshipCountByEntity.set(relationship.to, (relationshipCountByEntity.get(relationship.to) ?? 0) + 1);
  }

  return entities
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 120)
    .map((entity) => ({
      id: entity.id,
      type: entity.type,
      title: entity.title,
      aliases: buildEntityAliases(entity),
      summary: entity.summary,
      tags: entity.tags,
      scenes: entity.scenes,
      sourceCount: entity.sourceEntries.length,
      relationshipCount: relationshipCountByEntity.get(entity.id) ?? 0,
      updatedAt: entity.updatedAt,
    }));
}

async function resolveQueryPlan(
  question: string,
  entityName: string | undefined,
  index: QueryIndexEntity[],
  options: RunStructuredQueryOptions,
): Promise<{ plan: QueryPlan; trace: string }> {
  const fallback = buildFallbackQueryPlan(question, entityName);
  if (!options.planWithAgent) {
    return {
      plan: fallback,
      trace: `规则解析关键词：${[...fallback.entityCandidates, ...fallback.evidenceTerms].join('、') || '无'}`,
    };
  }

  try {
    const plan = await planQueryWithAgent(question, index);
    const mergedPlan = correctQueryPlanAttribute(question, mergeQueryPlans(plan, fallback));
    return {
      plan: mergedPlan,
      trace: `读取 ${index.length} 个目录项，选择实体：${
        mergedPlan.selectedEntityIds.length > 0
          ? mergedPlan.selectedEntityIds.join('、')
          : mergedPlan.entityCandidates.join('、') || '未确定'
      }；属性：${mergedPlan.attribute || '未指定'}；证据词：${mergedPlan.evidenceTerms.join('、') || '无'}。`,
    };
  } catch (error) {
    return {
      plan: fallback,
      trace: `Query Agent 规划失败，回退规则解析：${error instanceof Error ? error.message : '未知错误'}`,
    };
  }
}

async function resolveRelationshipQueryPlan(
  question: string,
  fromName: string,
  toName: string,
  options: RunStructuredQueryOptions,
): Promise<{ plan: QueryPlan; trace?: QueryTraceStep }> {
  if (!options.planWithAgent) {
    return { plan: buildFallbackQueryPlan(question, `${fromName} ${toName}`) };
  }

  const index = await buildEntityIndex();
  const { plan, trace } = await resolveQueryPlan(question, `${fromName} ${toName}`, index, options);
  return {
    plan,
    trace: {
      layer: 'agent',
      label: 'Query Agent',
      detail: trace,
    },
  };
}

function buildFallbackQueryPlan(question: string, entityName: string | undefined): QueryPlan {
  const attributeTerms = buildAttributeTerms(question);
  const cleanedQuestion = cleanupSearchText(question);
  const cleanedEntityName = cleanupSearchText(entityName ?? '');
  return {
    intent: attributeTerms.length > 0 ? 'attribute_lookup' : 'evidence_search',
    selectedEntityIds: [],
    entityCandidates: [cleanedEntityName, cleanedQuestion].filter((term) => term.length >= 2),
    attribute: inferAttribute(question),
    evidenceTerms: attributeTerms,
    needsRawEvidence: attributeTerms.length > 0,
    needsGlobalSearch: true,
    answerType: /(能否|是否|能不能|可不可以|可以吗)/.test(question) ? 'yes_no_with_evidence' : 'unknown',
    confidence: 0.45,
  };
}

function mergeQueryPlans(plan: QueryPlan, fallback: QueryPlan): QueryPlan {
  return {
    ...plan,
    entityCandidates: uniqueStrings([...plan.entityCandidates, ...fallback.entityCandidates]).slice(0, 8),
    evidenceTerms: uniqueStrings([...plan.evidenceTerms, ...fallback.evidenceTerms]).slice(0, 12),
    needsRawEvidence: plan.needsRawEvidence || fallback.needsRawEvidence,
    needsGlobalSearch: plan.needsGlobalSearch || fallback.needsGlobalSearch,
    attribute: plan.attribute || fallback.attribute,
  };
}

function correctQueryPlanAttribute(question: string, plan: QueryPlan): QueryPlan {
  const inferredAttribute = inferAttribute(question);
  if (inferredAttribute === 'openSourceStatus' && plan.attribute === 'derivedFrom') {
    return {
      ...plan,
      attribute: 'openSourceStatus',
      evidenceTerms: uniqueStrings([...plan.evidenceTerms, ...buildAttributeTerms(question)]).slice(0, 12),
    };
  }

  return plan;
}

async function getPlanSelectedEntities(plan: QueryPlan, excludeEntityId?: string) {
  const selectedIds = plan.selectedEntityIds.filter((id) => id !== excludeEntityId);
  if (selectedIds.length === 0) return [];

  const entities = await db.entities.bulkGet(selectedIds);
  const byId = new Map(entities.filter((entity): entity is Entity => Boolean(entity)).map((entity) => [entity.id, entity]));

  return selectedIds
    .map((id) => byId.get(id))
    .filter((entity): entity is Entity => Boolean(entity));
}

function mergeSelectedEntityCandidates(
  candidates: EntityCandidate[],
  selectedEntities: Entity[],
  name: string | undefined,
): EntityCandidate[] {
  const byId = new Map(candidates.map((candidate) => [candidate.entity.id, candidate]));
  const terms = expandQuerySearchTerms([name ?? '', ...buildAttributeTerms(name ?? '')]);

  for (const entity of selectedEntities) {
    const score = terms.length > 0 ? Math.max(...terms.map((term) => scoreEntityForTerm(entity, term))) : 0;
    if (score < 30) continue;

    const current = byId.get(entity.id);
    const boostedScore = Math.max(score + 40, current?.score ?? 0);
    byId.set(entity.id, { entity, score: boostedScore });
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score || b.entity.updatedAt - a.entity.updatedAt)
    .slice(0, 5);
}

function mergeUniqueEntities(entities: Entity[]) {
  const byId = new Map<string, Entity>();
  for (const entity of entities) {
    if (!byId.has(entity.id)) byId.set(entity.id, entity);
  }
  return [...byId.values()];
}

function optionalTrace(trace: QueryTraceStep | undefined) {
  return trace ? [trace] : [];
}

async function findWikiEntityCandidates(
  terms: string[],
  selectedEntityIds: string[] = [],
): Promise<WikiEntityCandidate[]> {
  if (terms.length === 0 && selectedEntityIds.length === 0) return [];

  const [entities, relationships] = await Promise.all([db.entities.toArray(), db.relationships.toArray()]);
  const selectedIds = new Set(selectedEntityIds);
  const relationshipCountByEntity = new Map<string, number>();
  for (const relationship of relationships) {
    relationshipCountByEntity.set(relationship.from, (relationshipCountByEntity.get(relationship.from) ?? 0) + 1);
    relationshipCountByEntity.set(relationship.to, (relationshipCountByEntity.get(relationship.to) ?? 0) + 1);
  }

  return entities
    .map((entity) => {
      const baseScore = terms.length > 0 ? Math.max(...terms.map((term) => scoreEntityForTerm(entity, term))) : 0;
      const agentBoost = selectedIds.has(entity.id) ? 120 : 0;
      const sourceBoost = Math.min(entity.sourceEntries.length * 2, 6);
      const relationshipBoost = Math.min(relationshipCountByEntity.get(entity.id) ?? 0, 5);
      return { entity, score: agentBoost + baseScore + sourceBoost + relationshipBoost };
    })
    .filter((candidate) => candidate.score >= 30)
    .sort((a, b) => b.score - a.score || b.entity.updatedAt - a.entity.updatedAt)
    .slice(0, SEED_LIMIT);
}

async function expandWikiEntityCandidates(seedCandidates: WikiEntityCandidate[]): Promise<WikiEntityCandidate[]> {
  if (seedCandidates.length === 0) return [];

  const scoreById = new Map<string, number>();
  const entityById = new Map<string, Entity>();

  const addCandidate = (entity: Entity, score: number) => {
    entityById.set(entity.id, entity);
    scoreById.set(entity.id, (scoreById.get(entity.id) ?? 0) + score);
  };

  for (const seed of seedCandidates.slice(0, SEED_LIMIT)) {
    addCandidate(seed.entity, seed.score);

    const oneHop = await getSubgraph(seed.entity.id, 1);
    const hop1 = rankRelatedEntities(
      seed.entity,
      oneHop.nodes.filter((node) => node.id !== seed.entity.id),
      oneHop.edges,
    ).slice(0, HOP1_PER_SEED);

    for (const rankedHop1 of hop1) {
      addCandidate(rankedHop1.entity, rankedHop1.score * DECAY_HOP1);

      const twoHop = await getSubgraph(rankedHop1.entity.id, 1);
      const hop2 = rankRelatedEntities(
        rankedHop1.entity,
        twoHop.nodes.filter((node) => node.id !== rankedHop1.entity.id && node.id !== seed.entity.id),
        twoHop.edges,
      ).slice(0, HOP2_PER_HOP1);

      for (const rankedHop2 of hop2) {
        addCandidate(rankedHop2.entity, rankedHop2.score * DECAY_HOP2);
      }
    }
  }

  return [...scoreById.entries()]
    .map(([id, score]) => ({ entity: entityById.get(id), score }))
    .filter((candidate): candidate is WikiEntityCandidate => Boolean(candidate.entity))
    .sort((a, b) => b.score - a.score || b.entity.updatedAt - a.entity.updatedAt)
    .slice(0, 16);
}

async function readEntityDocument(
  entity: Entity,
  question: string,
  plan: QueryPlan,
  retrievalEntities: Entity[] = [],
): Promise<EntityDocument> {
  const agentSelectedEntities = await getPlanSelectedEntities(plan, entity.id);
  const [tasks, subgraph] = await Promise.all([
    db.tasks
      .filter((task) => task.owner === entity.id || task.linkedTo.includes(entity.id))
      .toArray(),
    getSubgraph(entity.id, 2),
  ]);

  const relationships = subgraph.edges;
  const graphRelatedEntities = rankRelatedEntities(
    entity,
    subgraph.nodes.filter((node) => node.id !== entity.id),
    relationships,
  )
    .slice(0, 12)
    .map((ranked) => ranked.entity);
  const normalizedRetrievalEntities = mergeUniqueEntities(retrievalEntities.filter((candidate) => candidate.id !== entity.id));
  const relatedEntities = mergeUniqueEntities([
    ...agentSelectedEntities,
    ...normalizedRetrievalEntities,
    ...graphRelatedEntities,
  ]).slice(0, 12);
  const entryIds = [
    ...entity.sourceEntries,
    ...agentSelectedEntities.flatMap((selectedEntity) => selectedEntity.sourceEntries),
    ...normalizedRetrievalEntities.flatMap((retrievalEntity) => retrievalEntity.sourceEntries),
    ...tasks.map((task) => task.source),
    ...relationships.flatMap((relationship) => relationship.evidence),
  ];
  const entries = await getEntriesByIds(entryIds);
  const evidenceHits = await findRawEvidenceHits(question, entity, entries, plan);

  return {
    entity,
    tasks,
    relationships,
    relatedEntities,
    agentSelectedEntities,
    retrievalEntities: normalizedRetrievalEntities,
    entries,
    evidenceHits,
  };
}

async function answerEvidenceFallback(
  question: string,
  terms: string[],
  trace: QueryTraceStep[],
  options: RunStructuredQueryOptions,
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

  const result: StructuredQueryResult = {
    answer,
    sources: dedupeSources([...entries.map(entrySource), ...tasks.map(taskSource)]),
    suggestions: ['查看来源记录', '换一个更明确的实体名再问'],
    trace,
  };

  return composeResultIfRequested(
    result,
    {
      question,
      draftAnswer: answer,
      entities: [],
      tasks: tasks.slice(0, 6).map((task) => ({
        id: task.id,
        description: task.description,
        status: task.status,
        dueDate: task.dueDate,
      })),
      relationships: [],
      entries: entries.slice(0, 5).map((entry) => ({
        id: entry.id,
        content: snippet(entry.content, 240),
      })),
    },
    options,
  );
}

async function findRawEvidenceHits(question: string, entity: Entity, linkedEntries: Entry[], plan: QueryPlan) {
  const terms = buildEvidenceTerms(question, entity, plan);
  if (terms.length === 0) return [];

  const linkedHits = findEvidenceHitsInEntries(linkedEntries, terms, 'entity-source');
  if (linkedHits.length > 0 && !plan.needsGlobalSearch) {
    return linkedHits.slice(0, 5);
  }

  const linkedEntryIds = new Set(linkedEntries.map((entry) => entry.id));
  const entries = await db.entries.orderBy('capturedAt').reverse().toArray();
  const globalHits = findEvidenceHitsInEntries(
    entries.filter((entry) => !linkedEntryIds.has(entry.id)),
    terms,
    'global-fallback',
  );

  return [...linkedHits, ...globalHits].sort((a, b) => b.score - a.score).slice(0, 5);
}

function findEvidenceHitsInEntries(
  entries: Entry[],
  terms: string[],
  scope: EvidenceHit['scope'],
): EvidenceHit[] {
  return entries
    .map((entry) => {
      const matchedTerms = terms.filter((term) => evidenceTextMatches(entry.content, term));
      if (matchedTerms.length === 0) return undefined;

      const firstIndex = findFirstTermIndex(entry.content, matchedTerms);
      return {
        entry,
        snippet: snippetAround(entry.content, firstIndex, 150),
        matchedTerms,
        scope,
        score: matchedTerms.length * 100 + Math.max(0, 5000 - Math.max(firstIndex, 0)),
      };
    })
    .filter((hit): hit is EvidenceHit => Boolean(hit))
    .sort((a, b) => b.score - a.score || b.entry.capturedAt - a.entry.capturedAt);
}

function formatWikiReadAnswer(question: string, document: EntityDocument) {
  const { entity, tasks, relationships, relatedEntities, entries, evidenceHits } = document;
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
    if (evidenceHits.length > 0) {
      lines.push(formatEvidenceHitLines(evidenceHits));
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

  const queriedPropertyKey = normalizePropertyKey(inferAttribute(question));
  const compiledPropertyValue = queriedPropertyKey ? getEntityPropertyDisplayValue(entity, queriedPropertyKey) : undefined;
  if (queriedPropertyKey && compiledPropertyValue) {
    lines.push(`${propertyLabel(queriedPropertyKey)}：${compiledPropertyValue}`);
  } else if (queriedPropertyKey) {
    const evidencePropertyValue = extractEvidencePropertyValue(queriedPropertyKey, evidenceHits);
    if (evidencePropertyValue) {
      lines.push(`${propertyLabel(queriedPropertyKey)}：${evidencePropertyValue}（来源材料命中，待编译回 Wiki）`);
    }
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

  if (evidenceHits.length > 0) {
    lines.push(formatEvidenceHitLines(evidenceHits));
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
    ...document.evidenceHits.map((hit) => entrySource(hit.entry)),
    ...document.entries.slice(0, 6).map(entrySource),
  ]);
}

function formatRelationshipPathAnswer(from: Entity, to: Entity, paths: Relationship[][], pathEntities: Entity[]) {
  const entityById = new Map([from, to, ...pathEntities].map((entity) => [entity.id, entity]));
  const pathLines = paths.map((path, index) => {
    const parts: string[] = [];
    for (const relationship of path) {
      const fromTitle = entityById.get(relationship.from)?.title ?? relationship.from;
      const toTitle = entityById.get(relationship.to)?.title ?? relationship.to;
      if (parts.length === 0) parts.push(fromTitle);
      parts.push(`--${relationshipTypeLabel(relationship.type)}--> ${toTitle}`);
    }
    return `${index + 1}. ${parts.join(' ')}`;
  });

  return [
    `${from.title} 和 ${to.title} 在知识图谱中存在关系路径：`,
    pathLines.join('\n'),
  ].join('\n\n');
}

function formatNoRelationshipPathAnswer(from: Entity, to: Entity) {
  const sharedSourceCount = from.sourceEntries.filter((entryId) => to.sourceEntries.includes(entryId)).length;
  if (sharedSourceCount > 0) {
    return `${from.title} 和 ${to.title} 目前没有显式关系边，但它们共享 ${sharedSourceCount} 条原始来源。建议把这类来源中的关系编译成正式关系。`;
  }

  return `${from.title} 和 ${to.title} 都存在于知识库中，但目前 3 跳内没有找到显式关系路径。`;
}

function computeContextBudget(maxContextChars = DEFAULT_QUERY_CONTEXT_CHARS): QueryContextBudget {
  const maxContext = Math.max(4000, Math.min(maxContextChars, 1_000_000));
  const responseReserve = Math.floor(maxContext * 0.15);
  const indexBudget = Math.floor(maxContext * 0.05);
  const pageBudget = Math.floor(maxContext * 0.5);
  const maxPageSize = Math.min(pageBudget, Math.max(5000, Math.floor(pageBudget * 0.3)));

  return {
    maxContextChars: maxContext,
    responseReserve,
    indexBudget,
    pageBudget,
    maxPageSize,
  };
}

function buildQueryComposePayload(
  question: string,
  draftAnswer: string,
  document: EntityDocument,
  budget = computeContextBudget(),
): QueryComposePayload {
  const entityById = new Map(
    [document.entity, ...document.relatedEntities].map((entity) => [entity.id, entity]),
  );

  return {
    question,
    draftAnswer,
    entities: [document.entity, ...document.relatedEntities].slice(0, 10).map((entity) => ({
      id: entity.id,
      type: entity.type,
      title: entity.title,
      summary: entity.summary,
    })),
    tasks: document.tasks.slice(0, 8).map((task) => ({
      id: task.id,
      description: task.description,
      status: task.status,
      dueDate: task.dueDate,
    })),
    relationships: document.relationships.slice(0, 10).map((relationship) => ({
      id: relationship.id,
      type: relationship.type,
      fromTitle: entityById.get(relationship.from)?.title ?? relationship.from,
      toTitle: entityById.get(relationship.to)?.title ?? relationship.to,
    })),
    entries: buildComposeEntries(document, budget),
  };
}

function extractEvidencePropertyValue(propertyKey: string, evidenceHits: EvidenceHit[]) {
  for (const hit of evidenceHits) {
    const evidenceText = hit.entry.content || hit.snippet;
    const value = extractPropertyValue(propertyKey, evidenceText, hit.matchedTerms);
    if (value && validateCompileSuggestionByRule({
      entityId: 'preview',
      entityTitle: '',
      propertyKey,
      propertyLabel: propertyLabel(propertyKey),
      propertyValue: value,
      evidenceEntryId: hit.entry.id,
      evidenceSnippet: evidenceText,
      evidenceScope: hit.scope,
      confidence: 1,
    })) {
      return value;
    }
  }

  return undefined;
}

function buildComposeEntries(document: EntityDocument, budget: QueryContextBudget): QueryComposePayload['entries'] {
  const used = new Set<string>();
  let usedChars = 0;
  const remainingBudget = () => Math.max(0, budget.pageBudget - usedChars);
  const budgetedContent = (value: string) => {
    const maxLength = Math.min(budget.maxPageSize, remainingBudget());
    if (maxLength <= 0) return '';
    const compact = value.replace(/\s+/g, ' ').trim();
    const content = compact.length > maxLength ? compact.slice(0, maxLength) : compact;
    usedChars += content.length;
    return content;
  };

  const evidenceEntries = document.evidenceHits.map((hit) => {
    used.add(hit.entry.id);
    const content = budgetedContent(hit.snippet);
    if (!content) return undefined;
    return {
      id: hit.entry.id,
      content,
      scope: hit.scope,
      matchedTerms: hit.matchedTerms,
    };
  }).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  const contextEntries = document.entries
    .filter((entry) => !used.has(entry.id))
    .map((entry) => {
      const content = budgetedContent(entry.content);
      if (!content) return undefined;
      return {
        id: entry.id,
        content,
        scope: 'entity-source' as const,
        matchedTerms: [],
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  return [...evidenceEntries, ...contextEntries];
}

function buildCompileSuggestions(document: EntityDocument, plan: QueryPlan): CompileSuggestionDraft[] {
  const propertyKey = normalizePropertyKey(plan.attribute ?? inferAttribute(plan.evidenceTerms.join(' ')));
  if (!propertyKey || document.evidenceHits.length === 0) return [];

  const suggestions = document.evidenceHits
    .map((hit, index) => {
      const evidenceText = hit.entry.content || hit.snippet;
      const propertyValue = extractPropertyValue(propertyKey, evidenceText, hit.matchedTerms);
      if (!propertyValue) return undefined;
      const evidenceSnippet = buildPropertyEvidenceSnippet(evidenceText, propertyValue, hit);
      const suggestion = {
        entityId: document.entity.id,
        entityTitle: document.entity.title,
        propertyKey,
        propertyLabel: propertyLabel(propertyKey),
        propertyValue,
        evidenceEntryId: hit.entry.id,
        evidenceSnippet,
        evidenceScope: hit.scope,
        confidence: scoreCompileSuggestion(propertyKey, propertyValue, hit),
      } satisfies CompileSuggestionDraft;
      return validateCompileSuggestionByRule(suggestion) ? suggestion : undefined;
    })
    .filter((suggestion): suggestion is CompileSuggestionDraft => Boolean(suggestion));

  return dedupeCompileSuggestions(suggestions).slice(0, 3);
}

function buildPropertyEvidenceSnippet(evidenceText: string, propertyValue: string, hit: EvidenceHit) {
  const valueIndex = findFirstTermIndex(evidenceText, compileValueCandidates(propertyValue));
  if (valueIndex >= 0) return snippetAround(evidenceText, valueIndex, 150);
  return hit.snippet;
}

function normalizePropertyKey(attribute: string | undefined) {
  if (!attribute) return undefined;
  const normalized = attribute.toLowerCase();
  if (/(runtime|environment|windows|平台|运行)/i.test(normalized)) return 'runtimeEnvironment';
  if (/(opensourcestatus|open\s*source|开源状态|是否开源|是不是开源|开源吗|开源)/i.test(normalized)) {
    return 'openSourceStatus';
  }
  if (/(derived|source|from|基于|来源|源自|衍生|二次开发|fork)/i.test(normalized)) return 'derivedFrom';
  if (/(wake|唤醒|kws)/i.test(normalized)) return 'wakeWord';
  if (/(stop|终止|停止|打断)/i.test(normalized)) return 'stopWord';
  if (/(path|路径|目录)/i.test(normalized)) return 'localPath';
  if (/(model|模型|llm|asr|tts)/i.test(normalized)) return 'models';
  if (/(owner|负责人)/i.test(normalized)) return 'ownerNote';
  return attribute.replace(/[^A-Za-z0-9_]/g, '') || undefined;
}

function propertyLabel(propertyKey: string) {
  const labels: Record<string, string> = {
    runtimeEnvironment: '运行环境',
    wakeWord: '唤醒词',
    stopWord: '终止词',
    localPath: '本地路径',
    models: '相关模型',
    ownerNote: '负责人说明',
    derivedFrom: '来源/基于项目',
    openSourceStatus: '开源状态',
  };
  return labels[propertyKey] ?? propertyKey;
}

function extractPropertyValue(propertyKey: string, text: string, matchedTerms: string[]) {
  if (propertyKey === 'runtimeEnvironment') {
    if (/Windows/i.test(text)) return 'Windows';
    if (/macOS/i.test(text)) return 'macOS';
    if (/Linux/i.test(text)) return 'Linux';
  }

  if (propertyKey === 'wakeWord') {
    const patterns = [
      /主唤醒词(?:目前)?(?:是|为|叫|使用)?[：:\s“"]*([^”"。；;，,]+)/,
      /(?:唤醒词|叫醒词)(?:目前)?(?:是|为|叫|使用)[：:\s“"]*([^”"。；;，,]+)/,
    ];
    for (const pattern of patterns) {
      const value = cleanExtractedValue(text.match(pattern)?.[1]);
      if (value && isLikelyWakeWordValue(value)) return value;
    }
  }

  if (propertyKey === 'stopWord') {
    const match = text.match(/(?:终止词|停止词|打断词).*?(?:是|为|使用)?[：:\s“"]*([^。；;\n]+)/);
    return cleanExtractedValue(match?.[1]);
  }

  if (propertyKey === 'localPath') {
    const match = text.match(/[A-Z]:\\[^\s。；;，,]+/i);
    return cleanExtractedValue(match?.[0]);
  }

  if (propertyKey === 'derivedFrom') {
    const sourcePatterns = [
      /基于\s*([A-Za-z0-9_.\- /]+?开源项目)(?:二次开发|开发|构建|。|，|,|；|;|\s)/i,
      /基于\s*([A-Za-z0-9_.\- /]+?)(?:二次开发|开源项目|项目)/i,
      /(?:来源于|源自|衍生自|fork\s*自)\s*([A-Za-z0-9_.\- /]+?)(?:开源项目|项目|。|，|,|；|;|\s)/i,
    ];
    for (const pattern of sourcePatterns) {
      const match = text.match(pattern);
      const value = cleanExtractedValue(match?.[1]);
      if (value) {
        return /开源项目/.test(value) ? value : `${value} 开源项目`;
      }
    }
  }

  if (propertyKey === 'openSourceStatus') {
    if (/(不开源|非开源|闭源|closed\s*source|not\s+open\s+source)/i.test(text)) return '非开源';
    if (/(开源项目|开源|open\s*source)/i.test(text)) return '开源项目';
  }

  if (propertyKey === 'models') {
    const models = matchedTerms.filter((term) => /[A-Za-z0-9]/.test(term));
    return models.length > 0 ? uniqueStrings(models).join('、') : undefined;
  }

  return cleanExtractedValue(matchedTerms[0]);
}

function cleanExtractedValue(value: string | undefined) {
  return value
    ?.replace(/^[“"'\s]+|[”"'\s]+$/g, '')
    .replace(/^(：|:|是|为|使用|目前)/, '')
    .trim();
}

function isLikelyWakeWordValue(value: string) {
  return !/(方案|路线|架构|PowerShell|System\.Speech|KWS|关键词检测|本地|云端|识别器)/i.test(value);
}

function scoreCompileSuggestion(propertyKey: string, propertyValue: string, hit: EvidenceHit) {
  let score = hit.scope === 'entity-source' ? 0.55 : 0.45;

  if (compileEvidenceContainsValue(hit.snippet, propertyValue)) score += 0.2;
  if (compileEvidenceHasTrigger(propertyKey, hit.snippet)) score += 0.15;
  score += Math.min(hit.matchedTerms.length * 0.03, 0.1);

  return Math.round(Math.min(score, 0.95) * 100) / 100;
}

function validateCompileSuggestionByRule(suggestion: CompileSuggestionDraft) {
  if (!suggestion.propertyValue.trim() || !suggestion.evidenceSnippet.trim()) return false;

  const hasValue = compileEvidenceContainsValue(suggestion.evidenceSnippet, suggestion.propertyValue);
  if (!hasValue) return false;

  if (suggestion.propertyKey === 'derivedFrom') {
    return (
      compileEvidenceHasTrigger(suggestion.propertyKey, suggestion.evidenceSnippet) &&
      compileEvidenceMentionsEntity(suggestion.evidenceSnippet, suggestion.entityTitle)
    );
  }

  if (suggestion.propertyKey === 'runtimeEnvironment') {
    return /(Windows|macOS|Linux)/i.test(suggestion.evidenceSnippet);
  }

  if (suggestion.propertyKey === 'openSourceStatus') {
    return (
      compileEvidenceHasTrigger(suggestion.propertyKey, suggestion.evidenceSnippet) &&
      compileEvidenceMentionsEntity(suggestion.evidenceSnippet, suggestion.entityTitle)
    );
  }

  if (['wakeWord', 'stopWord', 'localPath'].includes(suggestion.propertyKey)) {
    return compileEvidenceHasTrigger(suggestion.propertyKey, suggestion.evidenceSnippet);
  }

  return true;
}

function dedupeCompileSuggestions(suggestions: CompileSuggestionDraft[]) {
  const byKey = new Map<string, CompileSuggestionDraft>();

  for (const suggestion of suggestions) {
    const key = [
      suggestion.entityId,
      suggestion.propertyKey,
      normalizeCompileKey(suggestion.propertyValue),
    ].join(':');
    const current = byKey.get(key);

    if (!current || compileSuggestionRank(suggestion) > compileSuggestionRank(current)) {
      byKey.set(key, suggestion);
    }
  }

  return Array.from(byKey.values()).sort((a, b) => compileSuggestionRank(b) - compileSuggestionRank(a));
}

function compileSuggestionRank(suggestion: CompileSuggestionDraft) {
  return suggestion.confidence + (suggestion.evidenceScope === 'entity-source' ? 0.05 : 0);
}

function compileEvidenceContainsValue(text: string, value: string) {
  const normalizedText = normalizeCompileKey(text);
  return compileValueCandidates(value).some((candidate) => {
    const normalizedCandidate = normalizeCompileKey(candidate);
    return normalizedCandidate.length >= 2 && normalizedText.includes(normalizedCandidate);
  });
}

function compileEvidenceMentionsEntity(text: string, entityTitle: string) {
  const normalizedText = normalizeCompileKey(text);
  const normalizedEntity = normalizeCompileKey(entityTitle);
  return normalizedEntity.length >= 2 && normalizedText.includes(normalizedEntity);
}

function compileEvidenceHasTrigger(propertyKey: string, text: string) {
  const triggerPatterns: Record<string, RegExp> = {
    derivedFrom: /(基于|来源于|源自|衍生自|二次开发|fork\s*自|derived\s+from)/i,
    openSourceStatus: /(开源项目|开源|open\s*source|闭源|closed\s*source)/i,
    wakeWord: /(唤醒词|叫醒|KWS|wake)/i,
    stopWord: /(终止词|停止词|打断词|终止|停止|打断|stop)/i,
    localPath: /[A-Z]:\\/i,
  };
  return triggerPatterns[propertyKey]?.test(text) ?? true;
}

function compileValueCandidates(value: string) {
  const base = value.trim();
  const descriptorFree = base
    .replace(/开源项目|项目|平台|方案|路线|方向|近音组/g, '')
    .trim();
  const splitValues = base.split(/[、/，,；;\s]+/).map((item) => item.trim());
  const semanticAliases = [
    /开源/.test(base) ? '开源' : '',
    /非开源|闭源/.test(base) ? '闭源' : '',
  ];
  return uniqueStrings([base, descriptorFree, ...splitValues, ...semanticAliases].filter(Boolean));
}

function normalizeCompileKey(value: string) {
  return normalize(value);
}

async function composeResultIfRequested(
  result: StructuredQueryResult,
  payload: QueryComposePayload,
  options: RunStructuredQueryOptions,
): Promise<StructuredQueryResult> {
  if (!options.composeWithLlm) return result;

  try {
    const composed = await composeQueryAnswer(payload);
    if (composedContradictsConcreteDraft(payload.draftAnswer, composed.answer)) {
      return {
        ...result,
        trace: [
          ...(result.trace ?? []),
          {
            layer: 'answer',
            label: 'LLM 表达',
            detail: '模型表达与结构化属性结论冲突，已保留结构化答案。',
          },
        ],
      };
    }
    return {
      ...result,
      answer: composed.answer.trim() || result.answer,
      llm: {
        provider: composed.provider,
        model: composed.model,
        fallbackFrom: composed.fallbackFrom,
      },
      trace: [
        ...(result.trace ?? []),
        {
          layer: 'answer',
          label: 'LLM 表达',
          detail: `${providerLabel(composed.provider)} · ${composed.model} 已基于结构化召回材料优化回答。`,
        },
      ],
    };
  } catch (error) {
    return {
      ...result,
      trace: [
        ...(result.trace ?? []),
        {
          layer: 'answer',
          label: 'LLM 表达',
          detail: `模型表达失败，已回退到结构化模板答案：${error instanceof Error ? error.message : '未知错误'}`,
        },
      ],
    };
  }
}

function composedContradictsConcreteDraft(draftAnswer: string, composedAnswer: string) {
  if (!hasConcretePropertyLine(draftAnswer)) return false;
  return (
    /(没有|未|暂未|尚未).{0,18}(找到|记录|明确|确认|披露|解析|提取|编译)|无法确认|不能确认|不确定/.test(composedAnswer) ||
    /未被完整披露|未完整披露|未能解析|未解析出来|没有完整披露/.test(composedAnswer)
  );
}

function hasConcretePropertyLine(answer: string) {
  return /(运行环境|唤醒词|终止词|本地路径|相关模型|负责人说明|来源\/基于项目|开源状态)：[^。\n]+/.test(answer);
}

function providerLabel(provider: 'minimax' | 'deepseek') {
  return provider === 'minimax' ? 'MiniMax' : 'DeepSeek';
}

function buildEntitySuggestions(entity: Entity) {
  return [`查看${entity.title}当前状态`, `查看${entity.title}关联实体`, `将命中信息编译回${entity.title}`];
}

function buildSearchTerms(question: string, entityName: string | undefined, plan?: QueryPlan) {
  const cleanedQuestion = cleanupSearchText(question);
  const cleanedEntityName = cleanupSearchText(entityName ?? '');
  const attributeTerms = uniqueStrings([...(plan?.evidenceTerms ?? []), ...buildAttributeTerms(question)]);
  let entityOnlyQuestion = cleanedQuestion;
  for (const term of attributeTerms) {
    entityOnlyQuestion = entityOnlyQuestion.replace(cleanupSearchText(term), '');
  }
  const baseTerms = Array.from(
    new Set([
      ...(plan?.entityCandidates ?? []),
      cleanedEntityName,
      entityOnlyQuestion,
      cleanedQuestion,
      ...(plan?.evidenceTerms ?? []),
    ].filter((term) => term.length >= 2)),
  );

  return expandQuerySearchTerms(baseTerms).slice(0, 32);
}

function expandQuerySearchTerms(terms: string[]) {
  return uniqueStrings(
    terms.flatMap((term) => [
      term,
      stripQueryDescriptors(term),
      ...cjkBigrams(term),
    ]),
  ).filter((term) => {
    const normalized = normalize(term);
    return normalized.length >= 2 && !isWeakQueryTerm(normalized);
  });
}

function stripQueryDescriptors(value: string) {
  return value.replace(/(方案|机制|路线|链路|能力|模块|系统|平台|项目|事项|问题)$/g, '').trim();
}

function cleanupSearchText(value: string) {
  return value
    .replace(/[？?。！!，,、：:；;]/g, '')
    .replace(/^(请问|帮我|帮忙|查一下|看一下|看看|关于)/, '')
    .replace(
      /(下一阶段|当前|短期优先级|优先级|推荐后续|后续|需要|有哪些|有什么|用了哪些|使用哪些|用了|使用|关联|相关|状态|进展|进度|任务|待办|未完成|没完成|重点问题|问题|叫什么|叫啥|名字|名称|是谁|是什么|介绍|讲讲|档案|信息|概况|总结|吗|呢|的)/g,
      '',
    )
    .replace(/(能否|是否|能不能|可不可以|可以不|可以吗|在|环境|运行|平台|支持|windows|Windows)/g, '')
    .replace(/(是不是|是否|是|不是|开源项目|开源|opensource|open source)/gi, '')
    .replace(/\s+/g, '')
    .trim();
}

function buildEvidenceTerms(question: string, entity: Entity, plan?: QueryPlan) {
  const terms = new Set([...(plan?.evidenceTerms ?? []), ...buildAttributeTerms(question)]);
  const entityAliases = buildEntityAliases(entity);
  let stripped = question;

  for (const alias of entityAliases) {
    stripped = stripped.replace(new RegExp(escapeRegExp(alias), 'gi'), '');
  }

  const cleaned = cleanupSearchText(stripped);
  if (cleaned.length >= 2 && !entityAliases.some((alias) => normalize(alias) === normalize(cleaned))) {
    terms.add(cleaned);
  }

  return Array.from(terms)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .flatMap((term) => [term, ...cjkBigrams(term)])
    .filter((term, index, list) => list.findIndex((item) => normalize(item) === normalize(term)) === index)
    .slice(0, 24);
}

function buildAttributeTerms(question: string) {
  const groups: Array<{ test: RegExp; terms: string[] }> = [
    { test: /(唤醒词|叫醒词|唤醒|KWS)/i, terms: ['唤醒词', '主唤醒词', '叫醒词', '唤醒', 'KWS'] },
    { test: /(终止词|停止词|结束词|打断词|miki|mi ki|米基|米奇)/i, terms: ['终止词', '停止词', '结束词', '打断词', 'miki', 'mi ki', '米基', '米奇'] },
    { test: /(API\s*key|apikey|密钥|token)/i, terms: ['API key', 'apikey', '密钥', 'token'] },
    { test: /(模型|LLM|ASR|TTS)/i, terms: ['模型', 'LLM', 'ASR', 'TTS'] },
    { test: /(Windows|windows|运行环境|桌面环境|操作系统|平台|能否.*运行|是否.*运行|运行在)/i, terms: ['Windows', 'Windows 桌面', '运行在 Windows', '运行环境', '桌面', '平台'] },
    { test: /(基于|来源|源自|衍生|二次开发|derived|fork)/i, terms: ['基于', '二次开发', '来源', '源自'] },
    { test: /(开源项目|开源|open\s*source)/i, terms: ['开源', '开源项目', 'open source'] },
    { test: /(路径|目录|文件夹|本地项目)/, terms: ['路径', '目录', '文件夹', '本地项目路径'] },
    { test: /(负责人|owner|谁负责|归谁)/i, terms: ['负责人', 'owner', '负责'] },
    { test: /(角色名|名字|名称|叫什么|叫啥)/, terms: ['角色名', '名字', '名称'] },
  ];

  return Array.from(
    new Set(groups.flatMap((group) => (group.test.test(question) ? group.terms : []))),
  );
}

function inferAttribute(question: string) {
  if (/(Windows|windows|运行环境|桌面环境|操作系统|平台|能否.*运行|是否.*运行|运行在)/i.test(question)) {
    return 'runtimeEnvironment';
  }
  if (/(唤醒词|叫醒词|唤醒|KWS)/i.test(question)) return 'wakeWord';
  if (/(终止词|停止词|结束词|打断词|miki|mi ki|米基|米奇)/i.test(question)) return 'stopWord';
  if (/(API\s*key|apikey|密钥|token)/i.test(question)) return 'apiKey';
  if (/(路径|目录|文件夹|本地项目)/.test(question)) return 'localPath';
  if (/(基于|来源|源自|衍生|二次开发|derived|fork)/i.test(question)) return 'derivedFrom';
  if (/(开源项目|开源|open\s*source)/i.test(question)) return 'openSourceStatus';
  if (/(负责人|owner|谁负责|归谁)/i.test(question)) return 'owner';
  return undefined;
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const trimmed = value.trim();
    const key = normalize(trimmed);
    if (!trimmed || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildEntityAliases(entity: Entity) {
  return Array.from(
    new Set([
      entity.title,
      entity.title.replace(/数字/g, ''),
      entity.title.replace(/项目/g, ''),
      ...entity.tags,
    ].filter((alias) => alias.trim().length >= 2)),
  );
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

function cjkBigrams(value: string) {
  const cjkText = value.replace(/[^\u4e00-\u9fa5]/g, '');
  if (cjkText.length < 4) return [];

  const grams: string[] = [];
  for (let index = 0; index < cjkText.length - 1; index += 1) {
    grams.push(cjkText.slice(index, index + 2));
  }
  return grams;
}

function isWeakQueryTerm(term: string) {
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

function formatEvidenceHitLines(hits: EvidenceHit[]) {
  const lines = hits.slice(0, 3).map((hit, index) => {
    const scopeLabel = hit.scope === 'global-fallback' ? '全库原始材料兜底' : '关联原始材料';
    return `${index + 1}. ${hit.snippet}（${scopeLabel}，命中：${hit.matchedTerms.slice(0, 3).join('、')}）`;
  });

  return `原始材料命中：\n${lines.join('\n')}\n\n建议：这些信息应后续编译回实体档案，下次就能直接从 Wiki 回答。`;
}

function findFirstTermIndex(text: string, terms: string[]) {
  const lowerText = text.toLowerCase();
  const indexes = terms
    .flatMap((term) => [term, term.replace(/\s+/g, '')])
    .map((term) => lowerText.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0);

  return indexes.length > 0 ? Math.min(...indexes) : -1;
}

function snippetAround(value: string, index: number, radius = 150) {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (index < 0) return snippet(compact, radius * 2);

  const start = Math.max(0, index - radius);
  const end = Math.min(compact.length, index + radius);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < compact.length ? '...' : '';
  return `${prefix}${compact.slice(start, end)}${suffix}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function getEntityPropertyDisplayValue(entity: Entity, propertyKey: string) {
  const value = (entity.properties as Record<string, unknown>)[propertyKey];
  if (Array.isArray(value)) return value.filter(Boolean).join('、');
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
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

function snippet(value: string, maxLength = 80) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
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
