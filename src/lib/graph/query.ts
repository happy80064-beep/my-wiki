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
import type { CompileSuggestionDraft, Entity, EntityIndicator, Entry, Relationship, Task } from '@/types';
import { composeQueryAnswer } from '@/lib/ai/queryComposerClient';
import type { QueryComposePayload } from '@/lib/ai/queryComposer';
import { planQueryWithAgent } from '@/lib/ai/queryPlannerClient';
import type { QueryIndexEntity, QueryPlan } from '@/lib/ai/queryPlanner';
import { db, materializeCompileSuggestions } from '@/lib/db';
import {
  buildWikiIndex,
  findCachedInsight,
  getFreshQueryCache,
  putQueryCache,
  queryCacheKey,
  refreshCompiledProfile,
} from '@/lib/wikiIndex';

export type { QuerySource, StructuredQueryResult } from './types';

export type RunStructuredQueryOptions = {
  composeWithLlm?: boolean;
  planWithAgent?: boolean;
  maxContextChars?: number;
  useCache?: boolean;
};

export async function runStructuredQuery(
  question: string,
  options: RunStructuredQueryOptions = {},
): Promise<StructuredQueryResult> {
  const trimmed = question.trim();
  if (!trimmed) {
    return emptyResult('请输入一个问题。');
  }

  if (options.useCache !== false) {
    const cacheKey = queryCacheKey(trimmed);
    const cached = cacheKey ? await getFreshQueryCache<StructuredQueryResult>(cacheKey) : undefined;
    if (cached) {
      return {
        ...cached,
        trace: [
          ...(cached.trace ?? []),
          {
            layer: 'cache',
            label: '查询缓存',
            detail: '命中同一问题的已缓存答案，跳过本次重新检索和模型表达。',
          },
        ],
      };
    }

    const cachedInsight = await findCachedInsight(trimmed);
    if (cachedInsight) {
      const insightAnswer = getEntityPropertyDisplayValue(cachedInsight, 'myView') || cachedInsight.summary;
      const result: StructuredQueryResult = {
        answer: insightAnswer,
        candidates: [cachedInsight],
        sources: [entitySource(cachedInsight)],
        suggestions: [`查看${cachedInsight.title}`, '继续追问相关实体'],
        trace: [
          {
            layer: 'cache',
            label: '查询洞察',
            detail: '命中此前保存到 Wiki 的查询洞察页面，直接返回预编译答案。',
          },
        ],
      };
      if (cacheKey) await putQueryCache({ key: cacheKey, question: trimmed, result });
      return result;
    }
  }

  const intent = parseQueryIntent(trimmed);

  if (intent.type === 'my_pending_tasks') {
    return cacheQueryResult(trimmed, await answerOwnerTasks(intent.entityName ?? '我', true), options);
  }

  if (intent.type === 'person_pending_tasks') {
    return cacheQueryResult(trimmed, await answerOwnerTasks(intent.entityName, false), options);
  }

  if (intent.type === 'project_tasks') {
    return cacheQueryResult(trimmed, await answerProjectTasks(intent.entityName, 'tasks'), options);
  }

  if (intent.type === 'project_improvements') {
    return cacheQueryResult(trimmed, await answerProjectTasks(intent.entityName, 'improvements'), options);
  }

  if (intent.type === 'project_status') {
    return cacheQueryResult(trimmed, await answerProjectStatus(intent.entityName), options);
  }

  if (intent.type === 'project_related_entities') {
    return cacheQueryResult(trimmed, await answerProjectRelatedEntities(intent.entityName), options);
  }

  if (intent.type === 'entity_relationship_path') {
    return cacheQueryResult(trimmed, await answerEntityRelationshipPath(intent.entityName, intent.targetEntityName, trimmed, options), options);
  }

  if (intent.type === 'entity_profile') {
    return cacheQueryResult(trimmed, await answerWikiRead(trimmed, intent.entityName, options), options);
  }

  return cacheQueryResult(trimmed, await answerWikiRead(trimmed, intent.entityName, options), options);
}

async function cacheQueryResult(
  question: string,
  result: StructuredQueryResult,
  options: RunStructuredQueryOptions,
) {
  if (options.useCache === false) return result;

  const key = queryCacheKey(question);
  if (!key) return result;

  await putQueryCache({ key, question, result });
  return result;
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
    sources: buildWikiReadSources(document, draftAnswer, question),
    suggestions: buildEntitySuggestions(entity),
    trace,
    compileSuggestions: await materializeCompileSuggestions(buildCompileSuggestions(document, plan, question), question),
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

type MetricAnswer = {
  label: string;
  value: string;
  confidence: 'high' | 'medium';
  reason: string;
  hit: EvidenceHit;
  evidenceSnippet: string;
};

type IndicatorLookupAnswer = {
  indicator: EntityIndicator;
  label: string;
  valueText?: string;
  missing: boolean;
};

type IndicatorGroupAnswer = {
  mode: 'comparison' | 'overview';
  answers: IndicatorLookupAnswer[];
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
  const index = await buildWikiIndex(120);
  return index.map((item) => ({
    id: item.entityId,
    type: item.type,
    title: item.title,
    aliases: item.aliases,
    summary: item.shortSummary,
    tags: [],
    scenes: [],
    sourceCount: item.sourceCount,
    relationshipCount: item.relationshipCount,
    updatedAt: item.updatedAt,
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
    .filter((entity) => !isQueryInsightEntity(entity) || selectedIds.has(entity.id))
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
  const compiledEntity = entity.compiledProfile ? entity : (await refreshCompiledProfile(entity.id)) ?? entity;
  const agentSelectedEntities = await getPlanSelectedEntities(plan, entity.id);
  const [tasks, subgraph] = await Promise.all([
    db.tasks
      .filter((task) => task.owner === entity.id || task.linkedTo.includes(entity.id))
      .toArray(),
    getSubgraph(entity.id, 2),
  ]);

  const queryInsightIds = new Set(subgraph.nodes.filter(isQueryInsightEntity).map((node) => node.id));
  const relationships = subgraph.edges.filter(
    (relationship) => !queryInsightIds.has(relationship.from) && !queryInsightIds.has(relationship.to),
  );
  const graphRelatedEntities = rankRelatedEntities(
    entity,
    subgraph.nodes.filter((node) => node.id !== entity.id && !isQueryInsightEntity(node)),
    relationships,
  )
    .slice(0, 12)
    .map((ranked) => ranked.entity);
  const normalizedRetrievalEntities = mergeUniqueEntities(
    retrievalEntities.filter((candidate) => candidate.id !== entity.id && !isQueryInsightEntity(candidate)),
  );
  const relatedEntities = mergeUniqueEntities([
    ...agentSelectedEntities.filter((candidate) => !isQueryInsightEntity(candidate)),
    ...normalizedRetrievalEntities,
    ...graphRelatedEntities,
  ]).slice(0, 12);
  const entryIds = [
    ...compiledEntity.sourceEntries,
    ...agentSelectedEntities.flatMap((selectedEntity) => selectedEntity.sourceEntries),
    ...normalizedRetrievalEntities.flatMap((retrievalEntity) => retrievalEntity.sourceEntries),
    ...tasks.map((task) => task.source),
    ...relationships.flatMap((relationship) => relationship.evidence),
  ];
  const entries = await getEntriesByIds(entryIds);
  const evidenceHits = await findRawEvidenceHits(question, entity, entries, plan);

  return {
    entity: compiledEntity,
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
  const profile = entity.compiledProfile;

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
      lines.push(formatEvidenceHitLines(evidenceHits, { includeSnippet: true }));
    }
    return lines.join('\n');
  }

  const queriedPropertyKey = normalizePropertyKey(inferAttribute(question));
  const compiledPropertyValue = queriedPropertyKey ? getEntityPropertyDisplayValue(entity, queriedPropertyKey) : undefined;
  const evidencePropertyValue = queriedPropertyKey ? extractEvidencePropertyValue(queriedPropertyKey, evidenceHits) : undefined;
  const propertyValue = compiledPropertyValue ?? evidencePropertyValue;
  const unknownMetricDimension = !propertyValue ? findUnknownMetricDimension(question, document) : undefined;
  if (unknownMetricDimension) {
    return formatUnknownMetricDimensionFastAnswer(entity, question, unknownMetricDimension);
  }
  const indicatorGroupAnswer = !propertyValue ? findIndicatorGroupAnswer(question, entity) : undefined;
  if (indicatorGroupAnswer) {
    return formatIndicatorGroupFastAnswer(entity, indicatorGroupAnswer);
  }
  const indicatorAnswer = !propertyValue ? findIndicatorAnswer(question, entity) : undefined;
  if (indicatorAnswer) {
    return formatIndicatorFastAnswer(entity, indicatorAnswer);
  }
  const metricAnswer = !propertyValue ? extractMetricAnswer(question, evidenceHits) : undefined;
  if (metricAnswer) {
    return formatMetricFastAnswer(entity, metricAnswer);
  }
  if (!propertyValue && isMetricQuestion(question)) {
    return formatMissingMetricFastAnswer(entity, expectedMetricLabel(question), evidenceHits.length);
  }
  if (queriedPropertyKey && propertyValue) {
    return formatAttributeFastAnswer(entity, queriedPropertyKey, propertyValue, Boolean(compiledPropertyValue));
  }
  if (isListDetailQuestion(question)) {
    const drillDown = drillDownEntityCategory(entity, question);
    if (drillDown) {
      return formatCategoryDrillDownAnswer(entity, drillDown);
    }
    if (evidenceHits.length > 0) {
      return formatListDetailFastAnswer(question, document);
    }
  }

  lines.push(`${entity.title}（${entityTypeLabel(entity.type)}）`);

  const overview = profile?.overview && profile.overview !== `${entity.title} 相关记录。` ? profile.overview : entity.summary;
  if (overview) {
    lines.push(`摘要：${overview}`);
  }

  if (profile) {
    const keyFacts = rankReadableFacts(profile.keyFacts, question, queriedPropertyKey).slice(0, 6);
    if (keyFacts.length > 0) {
      lines.push(`关键信息：\n${keyFacts.map((fact, index) => `${index + 1}. ${fact}`).join('\n')}`);
    }
    if (profile.openTasks.length > 0 && /(任务|待办|优化|推进|下一阶段|后续|优先级)/.test(question)) {
      lines.push(`待推进事项：\n${profile.openTasks.slice(0, 5).map((task, index) => `${index + 1}. ${task}`).join('\n')}`);
    }
    if (profile.relationshipSummary.length > 0 && relatedEntities.length === 0 && isRelationshipOrToolQuestion(question)) {
      lines.push(`关系摘要：${profile.relationshipSummary.slice(0, 6).join('；')}`);
    }
  }

  const status = getEntityStatus(entity);
  if (status) {
    lines.push(`当前状态：${status}`);
  }

  const openTasks = tasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled');
  if (openTasks.length > 0 && /(任务|待办|优化|推进|下一阶段|后续|优先级)/.test(question)) {
    lines.push(`未完成任务：\n${openTasks.slice(0, 5).map((task, index) => `${index + 1}. ${task.description}`).join('\n')}`);
  }

  const relatedTitles = readableRelatedTitles(relatedEntities);
  if (relatedTitles.length > 0) {
    lines.push(`${isRelationshipOrToolQuestion(question) ? '直接关联' : '相关实体'}：${relatedTitles.slice(0, 8).join('、')}`);
  }

  return lines.join('\n\n');
}

function buildWikiReadSources(document: EntityDocument, answer: string, question: string): QuerySource[] {
  const adoptedEntryIds = new Set<string>();
  const adoptedEvidenceHits = document.evidenceHits
    .filter((hit) => evidenceHitSupportsAnswer(hit, answer, question))
    .slice(0, 4);
  for (const hit of adoptedEvidenceHits) adoptedEntryIds.add(hit.entry.id);

  const adoptedContextEntries = document.entries
    .filter((entry) => !adoptedEntryIds.has(entry.id) && sourceTextSupportsAnswer(entry.content, answer, question))
    .slice(0, Math.max(0, 4 - adoptedEvidenceHits.length));

  return dedupeSources([
    entitySource(document.entity),
    ...document.tasks
      .filter((task) => sourceTextSupportsAnswer(task.description, answer, question))
      .slice(0, 4)
      .map(taskSource),
    ...document.relatedEntities
      .filter((entity) => sourceTitleMentioned(entity.title, answer))
      .slice(0, 6)
      .map(entitySource),
    ...adoptedEvidenceHits.map((hit) => entrySource(hit.entry)),
    ...adoptedContextEntries.map(entrySource),
  ]);
}

function isQueryInsightEntity(entity: Entity) {
  return entity.type === 'topic' && entity.tags.includes('query-insight');
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
      summary: entity.compiledProfile?.overview
        ? [
            entity.compiledProfile.overview,
            entity.compiledProfile.keyFacts.slice(0, 5).join('\n'),
            formatEntityIndicatorsForComposer(entity),
          ].filter(Boolean).join('\n')
        : [entity.summary, formatEntityIndicatorsForComposer(entity)].filter(Boolean).join('\n'),
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

function formatEntityIndicatorsForComposer(entity: Entity) {
  const indicators = entity.indicators ?? [];
  if (indicators.length === 0) return '';

  return [
    '已编译指标：',
    ...indicators.slice(0, 12).map((indicator) => {
      const value = indicator.value === null
        ? '未提供明确数值'
        : indicator.rawValue || `${indicator.value}${indicator.unit ? ` ${indicator.unit}` : ''}`;
      const scope = [indicator.businessLine, indicator.categoryName].filter(Boolean).join('/');
      return `- ${scope ? `${scope} · ` : ''}${indicator.name}: ${value}${indicator.note ? `（${indicator.note}）` : ''}`;
    }),
  ].join('\n');
}

function buildCompileSuggestions(document: EntityDocument, plan: QueryPlan, question?: string): CompileSuggestionDraft[] {
  const propertyKey = normalizePropertyKey(plan.attribute ?? inferAttribute(plan.evidenceTerms.join(' ')));
  if (question && findUnknownMetricDimension(question, document)) return [];
  if (question && (findIndicatorGroupAnswer(question, document.entity) || findIndicatorAnswer(question, document.entity))) return [];
  const metricSuggestions = question ? buildMetricCompileSuggestions(document, question) : [];
  if ((!propertyKey || document.evidenceHits.length === 0) && metricSuggestions.length === 0) return [];

  const suggestions = document.evidenceHits
    .map((hit) => {
      if (!propertyKey) return undefined;
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

  return dedupeCompileSuggestions([...metricSuggestions, ...suggestions]).slice(0, 3);
}

function buildMetricCompileSuggestions(document: EntityDocument, question: string): CompileSuggestionDraft[] {
  if (findUnknownMetricDimension(question, document)) return [];
  const metricAnswer = extractMetricAnswer(question, document.evidenceHits);
  if (!metricAnswer) return [];

  const propertyLabel = metricAnswer.label;
  const propertyValue = metricAnswer.confidence === 'high'
    ? metricAnswer.value
    : `${metricAnswer.value}（疑似，需核对原文）`;
  const suggestion = {
    entityId: document.entity.id,
    entityTitle: document.entity.title,
    propertyKey: metricPropertyKey(propertyLabel),
    propertyLabel,
    propertyValue,
    evidenceEntryId: metricAnswer.hit.entry.id,
    evidenceSnippet: metricAnswer.evidenceSnippet,
    evidenceScope: metricAnswer.hit.scope,
    confidence: metricAnswer.confidence === 'high' ? 0.82 : 0.62,
  } satisfies CompileSuggestionDraft;

  return validateCompileSuggestionByRule(suggestion) ? [suggestion] : [];
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

function metricPropertyKey(label: string) {
  const encoded = Array.from(normalize(label) || 'metric')
    .map((char) => char.codePointAt(0)?.toString(36) ?? '')
    .filter(Boolean)
    .join('_')
    .slice(0, 72);
  return `metric_${encoded || 'value'}`;
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
  const noteFree = base.replace(/[（(][^）)]*[）)]/g, '').trim();
  const descriptorFree = base
    .replace(/开源项目|项目|平台|方案|路线|方向|近音组/g, '')
    .trim();
  const splitValues = base.split(/[、/，,；;\s]+/).map((item) => item.trim());
  const semanticAliases = [
    /开源/.test(base) ? '开源' : '',
    /非开源|闭源/.test(base) ? '闭源' : '',
  ];
  return uniqueStrings([base, noteFree, descriptorFree, ...splitValues, ...semanticAliases].filter(Boolean));
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
    const correction = isExplicitFastAnswerCorrection(composed.answer);
    if (!correction && composedContradictsConcreteDraft(payload.draftAnswer, composed.answer)) {
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
    if (!correction && composedDriftsFromFastAnswer(payload.draftAnswer, composed.answer)) {
      return {
        ...result,
        trace: [
          ...(result.trace ?? []),
          {
            layer: 'answer',
            label: 'LLM 表达',
            detail: '模型表达偏离快速答案骨架，已保留快速答案，避免两段答案事实不一致。',
          },
        ],
      };
    }
    return {
      ...result,
      answer: composed.answer.trim() || result.answer,
      sources: filterSourcesForComposedAnswer(result.sources, composed.answer.trim() || result.answer, payload, result.candidates?.[0]?.id),
      llm: {
        provider: composed.provider,
        model: composed.model,
        fallbackFrom: composed.fallbackFrom,
      },
      trace: [
        ...(result.trace ?? []),
        {
          layer: 'answer',
          label: correction ? 'LLM 修正' : 'LLM 表达',
          detail: correction
            ? `${providerLabel(composed.provider)} · ${composed.model} 明确修正了快速答案，并已在正文标注。`
            : `${providerLabel(composed.provider)} · ${composed.model} 已基于结构化召回材料优化回答。`,
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

function isExplicitFastAnswerCorrection(answer: string) {
  return /^已修正快速答案[:：]/.test(answer.trim());
}

function composedDriftsFromFastAnswer(draftAnswer: string, composedAnswer: string) {
  const anchors = extractFastAnswerAnchors(draftAnswer);
  if (anchors.length === 0) return false;

  const normalizedAnswer = normalize(composedAnswer);
  const missingRequired = anchors.filter((anchor) => anchor.required && !normalizedAnswer.includes(anchor.normalized));
  if (missingRequired.length > 0) return true;

  const flexibleAnchors = anchors.filter((anchor) => !anchor.required);
  if (flexibleAnchors.length < 2) return false;
  const matched = flexibleAnchors.filter((anchor) => normalizedAnswer.includes(anchor.normalized)).length;
  return matched / flexibleAnchors.length < 0.45;
}

function extractFastAnswerAnchors(answer: string) {
  const anchors: Array<{ text: string; normalized: string; required: boolean }> = [];
  const add = (text: string, required = false) => {
    const cleaned = text.replace(/[（）()，。；;：:、]/g, ' ').replace(/\s+/g, ' ').trim();
    const normalized = normalize(cleaned);
    if (normalized.length < 2) return;
    if (anchors.some((anchor) => anchor.normalized === normalized)) return;
    anchors.push({ text: cleaned, normalized, required });
  };

  for (const match of answer.matchAll(/的[^。\n]{1,12}是([^。\n]+)。/g)) {
    add(match[1] ?? '', true);
  }
  for (const match of answer.matchAll(/的[^。\n]{1,24}为\s*([^。\n]+)。/g)) {
    add(match[1] ?? '', true);
  }
  for (const match of answer.matchAll(/已编译指标显示：([^。\n]+没有明确数值)/g)) {
    add(match[1] ?? '', true);
  }
  for (const match of answer.matchAll(/(?:运行环境|唤醒词|终止词|本地路径|相关模型|负责人说明|来源\/基于项目|开源状态)：([^（。\n]+)/g)) {
    add(match[1] ?? '', true);
  }
  for (const match of answer.matchAll(/^\d+\.\s*([^。\n]+)/gm)) {
    add(match[1] ?? '', false);
  }
  for (const match of answer.matchAll(/「([^」]{2,40})」|“([^”]{2,40})”|([A-Za-z][A-Za-z0-9._/-]{2,})/g)) {
    add(match[1] ?? match[2] ?? match[3] ?? '', false);
  }

  return anchors.slice(0, 16);
}

function hasConcretePropertyLine(answer: string) {
  return /(运行环境|唤醒词|终止词|本地路径|相关模型|负责人说明|来源\/基于项目|开源状态)：[^。\n]+|已编译指标显示：|的[^。\n]{1,24}为\s*[^。\n]+。/.test(answer);
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
    .replace(/都/g, '')
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
    {
      test: /(收入|营收|金额|费用|成本|投资|利润|价格|总额|面积|规模|人数|数量|年均|合计|多少)/,
      terms: buildMetricTerms(question),
    },
  ];

  return Array.from(
    new Set(groups.flatMap((group) => (group.test.test(question) ? group.terms : []))),
  );
}

function buildMetricTerms(question: string) {
  if (!isMetricQuestion(question)) return [];

  const compactQuestion = question.replace(/[？?。！!，,、：:；;]/g, '').replace(/\s+/g, '');
  const terms: string[] = [];
  const afterDe = compactQuestion.match(/的([^的]{2,28}?)(?:是多少|多少|为多少|是几|几|$)/);
  if (afterDe?.[1]) terms.push(afterDe[1]);

  for (const match of compactQuestion.matchAll(/([\u4e00-\u9fa5A-Za-z0-9/-]{0,16}(?:收入|营收|金额|费用|成本|投资|利润|价格|总额|面积|规模|人数|数量))/g)) {
    if (match[1]) terms.push(match[1]);
  }

  if (/年均/.test(question)) terms.push('年均');
  if (/稳定运营期/.test(question)) terms.push('稳定运营期');
  if (/项目总收入/.test(question)) terms.push('项目总收入');
  if (/总收入/.test(question)) terms.push('总收入');
  if (/收入|营收/.test(question)) terms.push('收入', '营收');
  if (/住宅/.test(question)) terms.push('住宅', '住宅业态');
  if (/医疗/.test(question)) terms.push('医疗', '医疗业态', '医疗板块');
  if (/康养|养老|养生/.test(question)) terms.push('康养', '康养业态');
  if (/研发|科研/.test(question)) terms.push('研发', '研发业态');
  if (/文旅|旅游|旅居/.test(question)) terms.push('文旅', '文旅业态');
  if (/土地|用地|占地|面积|建筑面积/.test(question)) terms.push('土地面积', '面积', '用地', '占地');
  if (/多少/.test(question)) terms.push(...compactQuestion.split(/的/).filter((term) => term.length >= 2).slice(-2));

  return uniqueStrings(terms).slice(0, 12);
}

function isMetricQuestion(question: string) {
  return /(指标|收入|营收|金额|费用|成本|投资|利润|价格|总额|面积|规模|人数|数量|年均|合计|多少|几多|多少钱)/.test(question);
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
  const compiledProfile = normalize([
    entity.compiledProfile?.overview,
    ...(entity.compiledProfile?.keyFacts ?? []),
    ...(entity.compiledProfile?.relationshipSummary ?? []),
  ].filter(Boolean).join(' '));
  const categories = normalize(
    (entity.categories ?? [])
      .flatMap((category) => [
        category.name,
        ...(category.aliases ?? []),
        ...category.items.map((item) => `${item.title} ${item.summary ?? ''}`),
      ])
      .join(' '),
  );
  const indicators = normalize(
    (entity.indicators ?? [])
      .map((indicator) => [
        indicator.name,
        indicator.rawValue,
        indicator.unit,
        indicator.businessLine,
        indicator.categoryName,
        indicator.note,
      ].filter(Boolean).join(' '))
      .join(' '),
  );
  const tags = normalize(entity.tags.join(''));
  const scenes = normalize(entity.scenes.join(''));

  if (title === normalizedTerm) return 100;
  if (title.includes(normalizedTerm) || normalizedTerm.includes(title)) return 88;
  if (isSubsequence(normalizedTerm, title)) return 72;
  if (isSubsequence(title, normalizedTerm)) return 58;
  if (summary.includes(normalizedTerm) || tags.includes(normalizedTerm) || scenes.includes(normalizedTerm)) return 42;
  if (compiledProfile.includes(normalizedTerm)) return 48;
  if (categories.includes(normalizedTerm)) return 52;
  if (indicators.includes(normalizedTerm)) return 60;

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

function rankReadableFacts(facts: string[], question: string, propertyKey: string | undefined) {
  const terms = uniqueStrings([
    propertyKey ? propertyLabel(propertyKey) : '',
    ...buildAttributeTerms(question),
    ...cjkBigrams(question),
  ].filter(Boolean));

  return [...facts].sort((a, b) => factScore(b, terms) - factScore(a, terms));
}

function factScore(fact: string, terms: string[]) {
  const normalizedFact = normalize(fact);
  return terms.reduce((score, term) => score + (normalizedFact.includes(normalize(term)) ? 1 : 0), 0);
}

function isRelationshipOrToolQuestion(question: string) {
  return /(关系|关联|相关|依赖|基于|来源|源自|工具|模型|组件|用了哪些|使用哪些|和.+什么关系)/.test(question);
}

function formatAttributeFastAnswer(entity: Entity, propertyKey: string, value: string, isCompiled: boolean) {
  return [
    `${entity.title}的${propertyLabel(propertyKey)}是${value}。`,
    isCompiled
      ? '提示：该信息已经写入 Wiki。'
      : '提示：该信息来自来源材料命中，建议确认后编译回 Wiki。',
  ].join('\n\n');
}

function findIndicatorGroupAnswer(question: string, entity: Entity): IndicatorGroupAnswer | undefined {
  const indicators = entity.indicators ?? [];
  if (indicators.length === 0) return undefined;

  if (isIndicatorOverviewQuestion(question)) {
    return {
      mode: 'overview',
      answers: indicators
        .slice()
        .sort((left, right) => indicatorGroupLabel(left).localeCompare(indicatorGroupLabel(right), 'zh-Hans') ||
          indicatorConfidenceRank(right.confidence) - indicatorConfidenceRank(left.confidence))
        .map((indicator) => toIndicatorLookupAnswer(indicator, indicator.name)),
    };
  }

  if (!isMetricQuestion(question)) return undefined;
  const scopes = inferMetricScopes(question);
  if (scopes.length < 2 || !isMetricComparisonQuestion(question)) return undefined;

  const answers = scopes
    .map((scope) => rankIndicatorsForQuestion(question, entity, scope)[0])
    .filter((answer): answer is IndicatorLookupAnswer => Boolean(answer));

  return answers.length >= 2 ? { mode: 'comparison', answers } : undefined;
}

function findIndicatorAnswer(question: string, entity: Entity): IndicatorLookupAnswer | undefined {
  if (!isMetricQuestion(question)) return undefined;
  return rankIndicatorsForQuestion(question, entity)[0];
}

function findUnknownMetricDimension(question: string, document: EntityDocument) {
  if (!isMetricQuestion(question) || isIndicatorOverviewQuestion(question)) return undefined;
  const dimension = extractMetricDimensionCandidate(question, document.entity);
  if (!dimension) return undefined;
  if (isKnownMetricDimension(dimension, document)) return undefined;
  return dimension;
}

function extractMetricDimensionCandidate(question: string, entity: Entity) {
  let compact = question.replace(/[？?。！!，,、：:；;\s]/g, '');
  for (const alias of buildEntityAliasesForMetricDimensionStrip(entity).sort((left, right) => right.length - left.length)) {
    const compactAlias = alias.replace(/[？?。！!，,、：:；;\s]/g, '');
    if (compactAlias.length >= 2) compact = compact.replace(new RegExp(escapeRegExp(compactAlias), 'gi'), '');
  }

  const metricPattern = '(?:建筑面积|土地面积|用地面积|占地面积|面积|收入|营收|投资额|投资|人数|数量|床位|机构数|项目数)';
  const match = compact.match(new RegExp(`(?:项目中|项目里|其中|中|里)?([\\u4e00-\\u9fa5A-Za-z0-9]{2,24}?)(?:的)?${metricPattern}`));
  const candidate = cleanupMetricDimensionCandidate(match?.[1] ?? '');
  return isGenericMetricDimension(candidate) ? undefined : candidate;
}

function buildEntityAliasesForMetricDimensionStrip(entity: Entity) {
  return buildEntityAliases(entity).filter((alias) => !isMetricDimensionAlias(alias));
}

function isMetricDimensionAlias(alias: string) {
  const normalizedAlias = normalize(alias);
  if (normalizedAlias.length < 2) return false;
  return Object.values(metricScopeTerms).flat().some((term) => {
    const normalizedTerm = normalize(term);
    return normalizedTerm.length >= 2 &&
      (normalizedAlias.includes(normalizedTerm) || normalizedTerm.includes(normalizedAlias));
  });
}

function cleanupMetricDimensionCandidate(value: string) {
  return value
    .replace(/^(?:项目中|项目里|其中|中|里|的)+/g, '')
    .replace(/(?:稳定运营期|运营期|年均|平均|预计|估算|测算|总计|合计|总体|整体|全部|当前|目前|大概|大约|约|项目|相关|对应|的)/g, '')
    .replace(/(?:是多少|多少|为多少|是几|几)$/g, '')
    .trim();
}

function isGenericMetricDimension(value: string) {
  const normalized = normalize(value);
  if (normalized.length < 2) return true;
  return /^(面积|土地面积|用地面积|占地面积|建筑面积|收入|营收|投资|投资额|人数|数量|指标|数值|数据|规模)$/.test(normalized);
}

function isKnownMetricDimension(dimension: string, document: EntityDocument) {
  const normalizedDimension = normalize(dimension);
  if (normalizedDimension.length < 2) return true;

  const entity = document.entity;
  const categoryTerms = (entity.categories ?? []).flatMap((category) => [
    category.name,
    ...(category.aliases ?? []),
    ...category.items.flatMap((item) => [item.title, item.summary ?? '']),
    category.evidence ?? '',
  ]);
  const indicatorTerms = (entity.indicators ?? []).flatMap((indicator) => [
    indicator.name,
    indicator.businessLine ?? '',
    indicator.categoryName ?? '',
    indicator.note ?? '',
    indicator.source?.excerpt ?? '',
  ]);
  const knownTerms = uniqueStrings([
    ...Object.values(metricScopeTerms).flat(),
    ...categoryTerms,
    ...indicatorTerms,
    entity.title,
    entity.summary,
    ...entity.tags,
  ].filter(Boolean));

  if (knownTerms.some((term) => {
    const normalizedTerm = normalize(term);
    return normalizedTerm.length >= 2 &&
      (normalizedTerm.includes(normalizedDimension) || normalizedDimension.includes(normalizedTerm));
  })) {
    return true;
  }

  const sourceText = normalize([
    ...document.evidenceHits
      .filter((hit) => !isQueryInsightEntry(hit.entry))
      .flatMap((hit) => [hit.snippet, hit.entry.content]),
    ...document.entries.filter((entry) => !isQueryInsightEntry(entry)).map((entry) => entry.content),
  ].join('\n'));
  return sourceText.includes(normalizedDimension);
}

function isQueryInsightEntry(entry: Entry) {
  const head = entry.content.slice(0, 120);
  return /查询洞察/.test(head) && /(问题|答案)[:：]/.test(entry.content.slice(0, 300));
}

function rankIndicatorsForQuestion(
  question: string,
  entity: Entity,
  forcedScope?: MetricScope,
): IndicatorLookupAnswer[] {
  const indicators = entity.indicators ?? [];
  if (indicators.length === 0) return [];

  const terms = buildMetricTerms(question);
  const label = expectedMetricLabel(question);
  const scope = forcedScope ?? inferMetricScope(question) ?? inferMetricScope(terms.join(''));
  return indicators
    .map((indicator) => ({
      indicator,
      score: scoreIndicatorForQuestion(indicator, question, terms, label, scope),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || indicatorConfidenceRank(right.indicator.confidence) - indicatorConfidenceRank(left.indicator.confidence))
    .map((item) => toIndicatorLookupAnswer(item.indicator, item.indicator.name || label));
}

function toIndicatorLookupAnswer(indicator: EntityIndicator, label: string): IndicatorLookupAnswer {
  const valueText =
    indicator.value === null
      ? undefined
      : indicator.rawValue?.trim() || `${indicator.value}${indicator.unit ? ` ${indicator.unit}` : ''}`;

  return {
    indicator,
    label,
    valueText,
    missing: indicator.value === null,
  };
}

function scoreIndicatorForQuestion(
  indicator: EntityIndicator,
  question: string,
  terms: string[],
  label: string,
  scope: MetricScope | undefined,
) {
  if (scope && !indicatorMatchesScope(indicator, scope)) return 0;
  if (!indicatorMetricNameMatches(indicator, question, terms, label)) return 0;

  const indicatorText = indicatorSearchText(indicator);
  const normalizedIndicator = normalize(indicatorText);
  let score = 20 + indicatorConfidenceRank(indicator.confidence) * 4;

  if (scope) score += 24;
  const normalizedLabel = normalize(label);
  if (normalizedLabel && normalizedIndicator.includes(normalizedLabel)) score += 24;

  for (const term of terms) {
    const normalizedTerm = normalize(term);
    if (normalizedTerm.length >= 2 && normalizedIndicator.includes(normalizedTerm)) score += 8;
  }

  if (indicator.value === null) score += 4;
  if (indicator.source?.excerpt) score += 3;
  return score;
}

function indicatorMetricNameMatches(indicator: EntityIndicator, question: string, terms: string[], label: string) {
  const normalizedQuestion = normalize(question);
  const normalizedName = normalize(`${indicator.name} ${indicator.unit ?? ''}`);

  const requiresBuildingArea = normalizedQuestion.includes(normalize('建筑面积'));
  if (requiresBuildingArea) return normalizedName.includes(normalize('建筑面积'));

  const requiresLandArea = /(土地|用地|占地)/.test(question);
  if (requiresLandArea) return /(土地|用地|占地)/.test(indicator.name);

  const requiresRevenue = /(收入|营收|年均|年收入|总收入|项目总收入)/.test(question);
  if (requiresRevenue) return /(收入|营收)/.test(indicator.name);

  const requiresInvestment = /(投资|总投资)/.test(question);
  if (requiresInvestment) return /投资/.test(indicator.name);

  const requiresCount = /(人数|数量|床位|机构数|项目数|家数|多少个|多少家|多少人)/.test(question);
  if (requiresCount) return /(人数|数量|床位|机构数|项目数|家数)/.test(indicator.name);

  const normalizedLabel = normalize(label);
  if (normalizedLabel && normalizedName.includes(normalizedLabel)) return true;
  return terms.some((term) => {
    const normalizedTerm = normalize(term);
    return normalizedTerm.length >= 2 && normalizedName.includes(normalizedTerm);
  });
}

function indicatorMatchesScope(indicator: EntityIndicator, scope: MetricScope) {
  const normalizedText = normalize(indicatorSearchText(indicator));
  return metricScopeTerms[scope].some((term) => normalizedText.includes(normalize(term)));
}

function indicatorSearchText(indicator: EntityIndicator) {
  return [
    indicator.name,
    indicator.rawValue,
    indicator.unit,
    indicator.businessLine,
    indicator.categoryName,
    indicator.note,
    indicator.source?.excerpt,
  ].filter(Boolean).join(' ');
}

function indicatorConfidenceRank(confidence: EntityIndicator['confidence']) {
  const rank = { low: 1, medium: 2, high: 3 } as const;
  return rank[confidence];
}

function isIndicatorOverviewQuestion(question: string) {
  return /(指标|关键数据|主要数据|核心数据|主要指标|指标列表)/.test(question) &&
    /(有哪些|有什么|列出|列表|汇总|总览|主要|核心|分别)/.test(question);
}

function isMetricComparisonQuestion(question: string) {
  return /(分别|各自|对比|比较|和|与|及|以及)/.test(question);
}

function indicatorGroupLabel(indicator: EntityIndicator) {
  return indicator.categoryName?.trim() ||
    (indicator.businessLine ? `${indicator.businessLine.replace(/(业态|版块|板块)$/g, '')}业态` : '未分组指标');
}

function formatIndicatorGroupFastAnswer(entity: Entity, group: IndicatorGroupAnswer) {
  if (group.mode === 'overview') {
    const grouped = groupIndicatorsByLabel(group.answers);
    const lines = [`${entity.title}当前已编译的主要指标包括：`];
    for (const [label, answers] of grouped) {
      lines.push(`\n${label}`);
      lines.push(answers.map((answer, index) => `${index + 1}. ${formatIndicatorItem(answer)}`).join('\n'));
    }
    lines.push('\n以上来自 Wiki 已编译的指标层；没有明确数值的指标会标为“未提供明确数值”。');
    return lines.join('\n');
  }

  return [
    `${entity.title}中与该问题相关的指标如下：`,
    group.answers.map((answer, index) => `${index + 1}. ${indicatorGroupLabel(answer.indicator)}：${formatIndicatorItem(answer)}`).join('\n'),
    '',
    '以上来自 Wiki 已编译的指标层，并按业态/板块层级对齐后返回；未提供明确数值的项不会再从原文临时猜数字。',
  ].join('\n');
}

function groupIndicatorsByLabel(answers: IndicatorLookupAnswer[]) {
  const groups = new Map<string, IndicatorLookupAnswer[]>();
  for (const answer of answers) {
    const label = indicatorGroupLabel(answer.indicator);
    groups.set(label, [...(groups.get(label) ?? []), answer]);
  }
  return [...groups.entries()];
}

function formatIndicatorItem(answer: IndicatorLookupAnswer) {
  if (answer.missing) {
    return `${answer.label}：未提供明确数值${answer.indicator.note ? `（${answer.indicator.note}）` : ''}`;
  }
  const confidenceHint = answer.indicator.confidence === 'high' ? '' : '（需核对来源）';
  return `${answer.label}：${answer.valueText}${confidenceHint}`;
}

function formatIndicatorFastAnswer(entity: Entity, answer: IndicatorLookupAnswer) {
  const { indicator } = answer;
  const evidenceLine = indicator.source?.excerpt
    ? `依据：${cleanEvidenceSnippet(indicator.source.excerpt)}`
    : undefined;

  if (answer.missing) {
    return [
      `已编译指标显示：${entity.title}的${answer.label}在当前资料中没有明确数值。`,
      indicator.note ? `说明：${indicator.note}` : '说明：该指标已进入 Wiki 指标层，但来源没有提供可确认的数值。',
      evidenceLine,
      '这类问题不再从目录编号、OCR 碎片或其他板块数字里临时推断。',
    ].filter(Boolean).join('\n\n');
  }

  return [
    `${entity.title}的${answer.label}为 ${answer.valueText}。`,
    indicator.confidence === 'high'
      ? '该数字来自 Wiki 已编译指标层。'
      : '该数字来自 Wiki 已编译指标层，但置信度不是高，建议打开来源核对。',
    evidenceLine,
  ].filter(Boolean).join('\n\n');
}

function formatUnknownMetricDimensionFastAnswer(entity: Entity, question: string, dimension: string) {
  const label = expectedMetricLabel(question);
  return [
    `我没有在${entity.title}的已编译业态、指标或关联来源中找到「${dimension}」这个维度。`,
    `因此不能把住宅、医疗、康养、文旅等其他板块的${label}套用为答案。`,
    `建议先补充包含「${dimension}」的材料，或确认它属于哪个已有业态后再编译回 Wiki。`,
  ].join('\n\n');
}

function formatMetricFastAnswer(entity: Entity, answer: MetricAnswer) {
  const evidenceLine = `证据摘录：${cleanEvidenceSnippet(answer.evidenceSnippet)}`;
  if (answer.confidence === 'high') {
    return [
      `${entity.title}的${answer.label}约为 ${answer.value}。`,
      evidenceLine,
      '提示：该数字来自来源材料命中，建议打开来源核对原文。后续确认后可以编译回 Wiki，避免下次再从原文临时抽取。',
    ].join('\n\n');
  }

  return [
    `我没有找到能直接确认${entity.title}的${answer.label}的高置信数字。`,
    `待确认线索：来源材料里出现了 ${answer.value}，但它和“${answer.label}”的对应关系还不够明确，暂不建议直接作为结论。`,
    evidenceLine,
  ].join('\n\n');
}

function formatMissingMetricFastAnswer(entity: Entity, label: string, evidenceHitCount: number) {
  const lines = [`我没有找到能直接确认${entity.title}的${label}的可靠数值。`];
  if (evidenceHitCount > 0) {
    lines.push('当前命中材料里没有出现与该指标对应的可靠单位或完整上下文，暂不建议把目录编号、页码或零散数字当作结论。');
  } else {
    lines.push('当前知识库和关联来源里没有命中可用于确认该指标的材料。');
  }
  lines.push('建议打开来源核对原文表格或章节；确认后再编译回 Wiki。');
  return lines.join('\n\n');
}

function drillDownEntityCategory(entity: Entity, question: string) {
  const categories = entity.categories ?? [];
  if (categories.length === 0) return undefined;

  const focus = extractListQuestionFocus(question, entity);
  const normalizedQuestion = normalize(question);
  const normalizedFocus = normalize(focus);
  const category = categories.find((item) => {
    const aliases = [item.name, ...(item.aliases ?? []), item.name.replace(/(业态|版块|板块|业务线|子分类|子类)$/g, '')];
    return aliases.some((alias) => {
      const normalizedAlias = normalize(alias);
      return normalizedAlias.length >= 2 &&
        (normalizedQuestion.includes(normalizedAlias) ||
          normalizedFocus.includes(normalizedAlias) ||
          normalizedAlias.includes(normalizedFocus));
    });
  });

  if (!category || category.items.length === 0) return undefined;
  return {
    category,
    focus: category.name,
    items: category.items.filter((item) => !isTocOrOcrNoise(item.title)).slice(0, 12),
  };
}

function formatCategoryDrillDownAnswer(
  entity: Entity,
  drillDown: NonNullable<ReturnType<typeof drillDownEntityCategory>>,
) {
  if (drillDown.items.length === 0) {
    return `我找到了「${drillDown.focus}」这个层级，但其中还没有可用项目清单。建议补充或重新编译该业态下的项目。`;
  }

  return [
    `${entity.title}的「${drillDown.focus}」下已结构化的项目包括：`,
    drillDown.items.map((item, index) => {
      const suffix = item.summary ? `：${item.summary}` : '';
      return `${index + 1}. ${item.title}${suffix}`;
    }).join('\n'),
    '',
    '提示：该结果来自 Wiki 已编译的层级结构。后续如果某个业态被频繁深入查询，可以再把它升级为独立实体页。',
  ].join('\n');
}

function isListDetailQuestion(question: string) {
  const hasDimension = /(业态|版块|板块|业务线|子分类|子类)/.test(question);
  const asksItemList = /(有哪些|都有哪些|包含哪些|包括哪些|列出|清单)/.test(question) &&
    /(项目|服务|产品|机构|科室|门诊|中心|疗法)/.test(question);
  return hasDimension && asksItemList;
}

function formatListDetailFastAnswer(question: string, document: EntityDocument) {
  const focus = extractListQuestionFocus(question, document.entity);
  const items = extractListItemsFromEvidence(question, document.evidenceHits);
  if (items.length > 0) {
    return [
      `${document.entity.title}中与「${focus}」相关的项目包括：`,
      items.slice(0, 8).map((item, index) => `${index + 1}. ${item}`).join('\n'),
      '',
      '提示：以上来自命中的来源材料片段，建议打开来源核对原文表格或章节，确认后可编译回 Wiki。',
    ].join('\n');
  }

  const overview = document.entity.compiledProfile?.overview || document.entity.summary;
  return [
    `我没有找到能直接展开「${focus}」的明确项目清单。`,
    overview ? `当前只能确认：${overview}` : '',
    document.evidenceHits.length > 0 ? '命中的来源材料更像目录、章节摘要或上一级业态说明，暂不适合直接当作项目清单。' : '',
    '建议继续打开来源报告中对应的业态/版块章节，确认后再编译回 Wiki，避免把上一级业态列表误当作具体项目清单。',
  ].filter(Boolean).join('\n\n');
}

function extractListQuestionFocus(question: string, entity: Entity) {
  let focus = question;
  for (const alias of buildEntityAliases(entity)) {
    focus = focus.replace(new RegExp(escapeRegExp(alias), 'gi'), '');
  }
  focus = focus
    .replace(/(都有哪些|有哪些|包含哪些|包括哪些|列出|清单|是什么|多少|的|？|\?)/g, '')
    .replace(/\s+/g, '')
    .trim();
  return focus || '相关项目';
}

function extractListItemsFromEvidence(question: string, hits: EvidenceHit[]) {
  const focusTerms = buildListFocusTerms(question);
  const items: string[] = [];
  for (const hit of hits) {
    const text = normalizeEvidenceForMetric(`${hit.snippet}\n${hit.entry.content}`);
    const sentences = text
      .split(/[。\n；;]/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0);
    for (const sentence of sentences) {
      if (isLikelyTocOrNavigationSentence(sentence)) continue;
      if (!sentenceMatchesListFocus(sentence, focusTerms)) continue;
      if (!hasFocusedListAnswerSignal(sentence, focusTerms)) continue;
      if (!hasListItemTrigger(sentence)) continue;
      items.push(...extractItemsFromSentence(sentence, focusTerms));
    }
  }

  return uniqueStrings(items)
    .filter((item) => isUsefulListItem(item, focusTerms) && itemMatchesFocus(item, focusTerms))
    .slice(0, 12);
}

function buildListFocusTerms(question: string) {
  const dimensionTerms = [...question.matchAll(/([\u4e00-\u9fa5A-Za-z0-9]{1,12}(?:业态|版块|板块|业务线|子分类|子类))/g)]
    .map((match) => match[1] ?? '');
  const commonDimensionBases = ['医疗', '康养', '研发', '文旅', '住宅', '医养', '养老', '商业', '教育']
    .filter((base) => question.includes(base));
  const dimensionBases = uniqueStrings([
    ...dimensionTerms.map((term) => term.replace(/(业态|版块|板块|业务线|子分类|子类)$/g, '')),
    ...dimensionTerms.map((term) => term.replace(/(业态|版块|板块|业务线|子分类|子类)$/g, '').slice(-2)),
    ...commonDimensionBases,
  ]).filter((term) => term.length >= 2);
  const targetTerms = dimensionBases.flatMap((base) => [
    `${base}业态`,
    base,
    `${base}项目`,
    `${base}服务`,
    `${base}机构`,
    `${base}中心`,
  ]);
  const terms = uniqueStrings([...dimensionTerms, ...targetTerms].filter((term) => term.trim().length >= 2));
  return terms.length > 0 ? terms : [question];
}

function extractItemsFromSentence(sentence: string, focusTerms: string[]) {
  const specificTargetMatch = sentence.match(/(?:项目|服务|机构|方法|疗法|中心|门诊)(?:包括|包含|有|为|如下)[：:\s]*([^。；;]+)/);
  if (specificTargetMatch?.[1]) {
    return splitListItems(specificTargetMatch[1], focusTerms);
  }

  const afterTrigger =
    sentence.match(/(?:包括|包含|涵盖|细分为|分为|设有|设置|建设|配置|规划|项目有|项目包括)[：:\s]*([^。；;]+)/)?.[1] ??
    sentence.match(/(?:医疗项目|项目|业态|版块|板块)[^。；;：:]{0,12}[：:]\s*([^。；;]+)/)?.[1];
  if (!afterTrigger) return [];
  return splitListItems(afterTrigger, focusTerms);
}

function splitListItems(value: string, focusTerms: string[]) {
  return value
    .replace(/^(?:的)?(?:项目|服务|机构|方法|疗法|中心|门诊)(?:包括|包含|有|为|如下)?[：:\s]*/, '')
    .split(/[、，,；;\/]/)
    .map((item) => cleanupListItem(item, focusTerms))
    .filter(Boolean);
}

function sentenceMatchesListFocus(sentence: string, focusTerms: string[]) {
  const normalizedSentence = normalize(sentence);
  return focusTerms.some((term) => {
    const normalizedTerm = normalize(term);
    if (normalizedTerm.length < 2) return false;
    if (normalizedSentence.includes(normalizedTerm)) return true;
    const base = normalizedTerm.replace(/(业态|版块|板块|业务线|子分类|子类|项目|服务|机构|中心)$/g, '');
    if (base.length < 2) return false;
    return new RegExp(`${escapeRegExp(base)}.{0,10}(业态|版块|板块|业务线|项目|服务|机构|中心|疗法|门诊)`).test(sentence);
  });
}

function cleanupListItem(item: string, focusTerms: string[]) {
  let cleaned = item
    .replace(/^[\d一二三四五六七八九十]+[.、\s-]*/, '')
    .replace(/^(医疗业态|医疗项目|项目|业态|版块|板块|包括|包含|涵盖|以及|和|与)/, '')
    .replace(/[。；;：:]+$/g, '')
    .trim();
  for (const term of focusTerms) {
    if (normalize(cleaned) === normalize(term)) cleaned = '';
  }
  return cleaned;
}

function isUsefulListItem(item: string, focusTerms: string[]) {
  const normalized = normalize(item);
  if (normalized.length < 2 || normalized.length > 36) return false;
  if (focusTerms.some((term) => normalize(term) === normalized)) return false;
  if (/^(项目|业态|版块|板块|类型|服务|包括|包含|相关|具体|如下|其中|以及|和|与|都)$/.test(item)) return false;
  if (isTocOrOcrNoise(item)) return false;
  if (isLikelyNarrativeOrHeadingItem(item)) return false;
  return /[\u4e00-\u9fa5A-Za-z]/.test(item);
}

function hasFocusedListAnswerSignal(sentence: string, focusTerms: string[]) {
  const hasListSeparator = /[、,，；;]/.test(sentence);
  const hasExplicitTarget =
    /(项目|服务|产品|机构|科室|门诊|中心|疗法|方法).{0,12}(包括|包含|有|设有|设置|建设|配置|规划|清单|如下|为)/.test(sentence) ||
    /(包括|包含|设有|设置|建设|配置|规划).{0,18}(项目|服务|产品|机构|科室|门诊|中心|疗法|方法)/.test(sentence);
  const hasDimensionList =
    /(业态|版块|板块|业务线|子分类|子类).{0,24}(包括|包含|有|设有|设置|建设|配置|规划|清单|如下|[:：])/.test(sentence) &&
    hasListSeparator;
  const focus = focusTerms.join('');
  const isMedicalFocus = /(医疗|医养|诊疗|医院|门诊|疗法|科室)/.test(focus);
  const hasMedicalItemSignal = isMedicalFocus && /(医院|门诊|科室|中心|疗法|治疗|康复|抗衰|细胞|中医|医养|诊疗)/.test(sentence);

  return hasExplicitTarget || hasDimensionList || (hasMedicalItemSignal && hasListSeparator);
}

function hasListItemTrigger(sentence: string) {
  return /(包括|包含|涵盖|细分为|分为|设有|设置|建设|配置|规划|项目有|项目包括|清单|如下|：|:)/.test(sentence);
}

function itemMatchesFocus(item: string, focusTerms: string[]) {
  const focus = focusTerms.join('');
  if (/医疗|医养|诊疗|医院|门诊/.test(focus)) {
    return /(医|医疗|医养|诊疗|医院|门诊|疗法|细胞|康复|抗衰|科室|中心|护理|体检|健康|中蒙|中医|专病)/.test(item);
  }
  if (/康养|养老|养生/.test(focus)) {
    return /(康养|养老|养生|康复|护理|健康|中心|社区|公寓|照护)/.test(item);
  }
  return true;
}

function isTocOrOcrNoise(item: string) {
  const compact = item.replace(/\s+/g, ' ').trim();
  if (/(\.{3,}|…{2,}|-{2,}|_{2,})/.test(compact)) return true;
  if (/\bof\s+\d+\b/i.test(compact)) return true;
  if (/^\s*(?:[IVX]+|\d+)(?:[.．]\d+){1,}/i.test(compact)) return true;
  if (/第\s*\d+\s*页|页码|目录|附录/.test(compact)) return true;
  const digitCount = (compact.match(/\d/g) ?? []).length;
  const hasMetricContext = /(收入|营收|金额|费用|成本|投资|利润|价格|总额|合计|面积|土地|用地|占地|建筑面积|万元|亿元|平方米|平米|㎡|亩|公顷|元)/.test(compact);
  if (digitCount >= 3 && digitCount / Math.max(compact.length, 1) > 0.2 && !hasMetricContext) return true;
  return false;
}

function isLikelyTocOrNavigationSentence(sentence: string) {
  const compact = sentence.replace(/\s+/g, ' ').trim();
  if (isTocOrOcrNoise(compact)) return true;
  if (/[.·•]{3,}\s*\d/.test(compact)) return true;
  if (/--\s*\d+\s+of\s+\d+\s*--/i.test(compact)) return true;
  if (/(目录|页码|章节|附录|图目录|表目录)/.test(compact)) return true;

  const headingWords = /(业务协同|增长极|创新商业模式|资产价值|项目愿景|项目定位|温暖永生|为特色|为核心|养生息|消费场景|待.*建成后)/;
  const hasConcreteList =
    /(包括|包含|设有|设置|建设|配置|规划).{0,24}(项目|服务|机构|科室|门诊|中心|疗法|方法)/.test(compact) ||
    /(项目|服务|机构|科室|门诊|中心|疗法|方法).{0,12}(包括|包含|有|设有|设置|建设|配置|规划)/.test(compact);

  return headingWords.test(compact) && !hasConcreteList;
}

function isLikelyNarrativeOrHeadingItem(item: string) {
  return /(业务协同|增长极|创新商业模式|资产价值|项目愿景|项目定位|温暖永生|为特色|为核心|养生息|消费场景|待.*建成后|第\s*\d+\s*页|页码|目录)/.test(item);
}

function evidenceHitSupportsAnswer(hit: EvidenceHit, answer: string, question: string) {
  return sourceTextSupportsAnswer(`${hit.snippet}\n${hit.entry.content}`, answer, question);
}

function filterSourcesForComposedAnswer(
  sources: QuerySource[],
  answer: string,
  payload: QueryComposePayload,
  primaryEntityId?: string,
) {
  const entryContentById = new Map(payload.entries.map((entry) => [entry.id, entry.content]));
  const filtered = sources.filter((source) => {
    if (source.type === 'entity') {
      return source.id === primaryEntityId || sourceTitleMentioned(source.title, answer);
    }
    if (source.type === 'task') {
      return sourceTextSupportsAnswer(source.title, answer, payload.question);
    }
    const entryContent = entryContentById.get(source.id);
    return entryContent ? sourceTextSupportsAnswer(entryContent, answer, payload.question) : false;
  });

  return filtered.length > 0 ? filtered : sources.filter((source) => source.type === 'entity').slice(0, 1);
}

function sourceTitleMentioned(title: string, answer: string) {
  const normalizedTitle = normalize(title);
  if (normalizedTitle.length < 2) return false;
  const normalizedAnswer = normalize(answer);
  return normalizedAnswer.includes(normalizedTitle) || titleAliases(title).some((alias) => normalize(alias).length >= 2 && normalizedAnswer.includes(normalize(alias)));
}

function titleAliases(title: string) {
  return uniqueStrings([
    title,
    title.replace(/项目|主题|事项|公司|有限公司|股份/g, ''),
    ...title.split(/[、/，,；;\s-]+/),
  ].filter((alias) => alias.trim().length >= 2));
}

function sourceTextSupportsAnswer(text: string, answer: string, question: string) {
  const normalizedText = normalize(text);
  if (!normalizedText) return false;

  const metricValues = extractComparableMetricValues(answer);
  if (metricValues.length > 0) {
    return metricValues.some((value) => normalizedText.includes(normalize(normalizeMetricComparable(value))));
  }

  const directValues = extractDirectAnswerValues(answer);
  if (directValues.some((value) => normalizedText.includes(normalize(value)))) {
    return true;
  }

  const anchors = extractAnswerSourceAnchors(answer, question);
  if (anchors.length === 0) return false;

  const matched = anchors.filter((anchor) => normalizedText.includes(normalize(anchor)));
  if (matched.some((anchor) => normalize(anchor).length >= 6)) return true;
  const hasStrongMatch = matched.some((anchor) => normalize(anchor).length >= 4);
  return hasStrongMatch && matched.length >= Math.min(2, anchors.length);
}

function extractComparableMetricValues(answer: string) {
  const values = [
    ...answer.matchAll(/[0-9][0-9,，]*(?:\.[0-9]+)?\s*(?:亿元|万元|元|%|平方米|㎡|人|家|个)/g),
    ...answer.matchAll(/[0-9][0-9,，]*(?:\.[0-9]+)?\s*(?:亿|万)(?![\u4e00-\u9fa5A-Za-z0-9])/g),
  ].map((match) => match[0]);
  return uniqueStrings(values);
}

function normalizeMetricComparable(value: string) {
  return value.replace(/，/g, ',').replace(/\s+/g, '');
}

function extractDirectAnswerValues(answer: string) {
  const values: string[] = [];
  for (const match of answer.matchAll(/(?:是|为|叫|设定为|设置为)\s*([^。\n；;]+)/g)) {
    values.push(...(match[1] ?? '').split(/[、/，,；;\s]+/));
  }
  for (const match of answer.matchAll(/「([^」]{1,40})」|“([^”]{1,40})”|\*\*([^*]{1,40})\*\*/g)) {
    values.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return uniqueStrings(
    values
      .map((value) => value.replace(/^(约|大约|预计|当前|目前)/, '').trim())
      .filter((value) => normalize(value).length >= 2 && !/^(提示|建议|来源材料|知识库)$/.test(value)),
  ).slice(0, 12);
}

function extractAnswerSourceAnchors(answer: string, question: string) {
  const questionTerms = new Set([
    ...buildMetricTerms(question),
    ...buildAttributeTerms(question),
    ...cjkBigrams(question),
  ].map(normalize));
  const ignored = new Set([
    '主要依据',
    '提示',
    '建议',
    '目前',
    '知识库',
    '来源材料',
    '可以确认',
    '无法确认',
    '相关信息',
    '直接作为结论',
  ].map(normalize));

  const quoted = [...answer.matchAll(/[「“]([^」”]{2,40})[」”]/g)].map((match) => match[1] ?? '');
  const phraseCandidates = answer
    .split(/[。\n；;：:，,、（）()\[\]【】\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3 && item.length <= 24);

  return uniqueStrings([...quoted, ...phraseCandidates])
    .filter((term) => {
      const normalized = normalize(term);
      if (normalized.length < 3 || ignored.has(normalized) || questionTerms.has(normalized)) return false;
      return !/^(第?[一二三四五六七八九十0-9]+|这些|其中|包括|分别|相关|具体|如下)$/.test(term);
    })
    .slice(0, 16);
}

function extractMetricAnswer(question: string, hits: EvidenceHit[]) {
  if (!isMetricQuestion(question)) return undefined;
  const terms = buildMetricTerms(question);
  if (terms.length === 0) return undefined;

  let mediumCandidate: MetricAnswer | undefined;
  for (const hit of hits) {
    const evidenceText = hit.entry.content || hit.snippet;
    const extraction = extractMetricValueFromText(evidenceText, terms);
    if (!extraction) continue;
    const evidenceSnippet = buildMetricEvidenceSnippet(evidenceText, extraction.value, terms, hit);
    const answer = {
      label: normalizeMetricLabel(terms[0] ?? '相关数值'),
      value: extraction.value,
      confidence: extraction.confidence,
      reason: extraction.reason,
      hit,
      evidenceSnippet,
    } satisfies MetricAnswer;
    if (answer.confidence === 'high') {
      return answer;
    }
    mediumCandidate ??= answer;
  }

  return mediumCandidate;
}

function buildMetricEvidenceSnippet(text: string, value: string, terms: string[], hit: EvidenceHit) {
  const sentence = findSentenceContaining(text, metricValueCandidates(value));
  if (sentence) return snippet(sentence, 180);

  const valueIndex = findFirstTermIndex(text, metricValueCandidates(value));
  if (valueIndex >= 0) return snippetAround(text, valueIndex, 180);

  const termIndex = findFirstTermIndex(text, terms);
  if (termIndex >= 0) return snippetAround(text, termIndex, 180);

  return hit.snippet;
}

function findSentenceContaining(text: string, terms: string[]) {
  const sentences = text
    .split(/[。；;\n]/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.find((sentence) => terms.some((term) => evidenceTextMatches(sentence, term)));
}

function extractMetricValueFromText(text: string, terms: string[]) {
  const cleaned = normalizeEvidenceForMetric(text);
  const sentences = cleaned
    .split(/[。\n；;]/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const matchedSentences = sentences.filter((sentence) =>
    !isLikelyTocOrNavigationSentence(sentence) &&
    metricSentenceMatchesScope(sentence, terms) &&
    terms.some((term) => evidenceTextMatches(sentence, term)),
  );

  for (const sentence of matchedSentences) {
    const value = extractMetricValueFromSentence(sentence, terms);
    if (value) {
      const confidence = adjustMetricConfidence(metricSentenceConfidence(sentence, terms), value, sentence, terms);
      return {
        value,
        confidence,
        reason: confidence === 'high'
          ? '来源句同时包含指标词和金额单位'
          : metricMediumReason(value, sentence, terms),
      } satisfies Pick<MetricAnswer, 'value' | 'confidence' | 'reason'>;
    }
  }

  if (matchedSentences.length > 0) {
    for (const sentence of sentences) {
      if (isLikelyTocOrNavigationSentence(sentence)) continue;
      if (!metricSentenceMatchesScope(sentence, terms)) continue;
      const value = extractMetricValueFromSentence(sentence, terms);
      if (value) {
        return {
          value,
          confidence: 'medium',
          reason: '同一来源中找到问题指标词和金额，但金额不在同一句中',
        } satisfies Pick<MetricAnswer, 'value' | 'confidence' | 'reason'>;
      }
    }
  }

  return undefined;
}

type MetricKind = 'money' | 'area' | 'count' | 'ratio' | 'generic';

function inferMetricKind(terms: string[], sentence = ''): MetricKind {
  const text = `${terms.join('')} ${sentence}`;
  if (/(面积|土地|用地|占地|建筑面积|住宅业态)/.test(text)) return 'area';
  if (/(收入|营收|金额|费用|成本|投资|利润|价格|总额|年均|年收入|总收入)/.test(text)) return 'money';
  if (/(比例|收益率|利润率|率|百分比|%)/.test(text)) return 'ratio';
  if (/(人数|数量|家数|机构数|项目数|个数|多少个|多少家|多少人)/.test(text)) return 'count';
  return 'generic';
}

function extractMetricValueFromSentence(sentence: string, terms: string[]) {
  if (isLikelyTocOrNavigationSentence(sentence)) return undefined;
  if (!metricSentenceMatchesScope(sentence, terms)) return undefined;

  const kind = inferMetricKind(terms, sentence);
  if (kind === 'area') return extractScopedAreaLikeValue(sentence, terms) ?? extractAreaLikeValue(sentence);
  if (kind === 'money') return extractMoneyLikeValue(sentence);
  if (kind === 'ratio') return extractRatioLikeValue(sentence);
  if (kind === 'count') return extractCountLikeValue(sentence);

  return (
    extractMoneyLikeValue(sentence) ??
    extractAreaLikeValue(sentence) ??
    extractRatioLikeValue(sentence) ??
    extractCountLikeValue(sentence) ??
    extractLooseMagnitudeValue(sentence)
  );
}

type MetricScope = 'residential' | 'medical' | 'eldercare' | 'research' | 'cultureTourism';

function metricSentenceMatchesScope(sentence: string, terms: string[]) {
  const scope = inferMetricScope(terms.join(''));
  if (!scope) return true;

  const normalizedSentence = normalize(sentence);
  const ownTerms = metricScopeTerms[scope];
  if (ownTerms.some((term) => normalizedSentence.includes(normalize(term)))) return true;

  return false;
}

const metricScopeTerms: Record<MetricScope, string[]> = {
  residential: ['住宅', '住宅业态', '住宅项目', '宅地', '居住', '住区', '适老住宅'],
  medical: ['医疗', '医疗业态', '医疗板块', '医养', '诊疗', '医院', '门诊', '疗法', '细胞治疗'],
  eldercare: ['康养', '养老', '养生', '康复', '护理', '照护'],
  research: ['研发', '科研', '实验室', '创新中心'],
  cultureTourism: ['文旅', '旅游', '旅居', '消费场景'],
};

function inferMetricScopes(text: string): MetricScope[] {
  const normalized = normalize(text);
  return (Object.entries(metricScopeTerms) as Array<[MetricScope, string[]]>)
    .map(([scope, terms]) => {
      const indexes = terms
        .map((term) => normalized.indexOf(normalize(term)))
        .filter((index) => index >= 0);
      return indexes.length > 0 ? { scope, index: Math.min(...indexes) } : undefined;
    })
    .filter((item): item is { scope: MetricScope; index: number } => Boolean(item))
    .sort((left, right) => left.index - right.index)
    .map((item) => item.scope);
}

function inferMetricScope(text: string): MetricScope | undefined {
  return inferMetricScopes(text)[0];
}

function metricSentenceConfidence(sentence: string, terms: string[]): MetricAnswer['confidence'] {
  const normalizedSentence = normalize(sentence);
  const strongTermHit = terms.some((term) => {
    const normalizedTerm = normalize(term);
    return normalizedTerm.length >= 4 && normalizedSentence.includes(normalizedTerm);
  });
  const equivalentTermHit = metricSentenceHasEquivalentSignal(sentence, terms);
  const metricVerbHit = /(为|约|达到|合计|总计|预计|测算|收入|营收|[:：])/.test(sentence);
  return (strongTermHit || equivalentTermHit) && metricVerbHit ? 'high' : 'medium';
}

function metricSentenceHasEquivalentSignal(sentence: string, terms: string[]) {
  const termText = terms.join('');
  const kind = inferMetricKind(terms, sentence);
  if (kind === 'area') {
    const wantsBuildingArea = /建筑面积/.test(termText);
    if (wantsBuildingArea) return /建筑面积/.test(sentence);
    const wantsLandArea = /(土地|用地|占地|土地面积|用地面积|占地面积)/.test(termText);
    return wantsLandArea && /(土地面积|用地面积|占地面积|土地|用地|占地)/.test(sentence);
  }
  return false;
}

function adjustMetricConfidence(
  confidence: MetricAnswer['confidence'],
  value: string,
  sentence: string,
  terms: string[],
): MetricAnswer['confidence'] {
  if (confidence !== 'high') return confidence;
  if (isYuanOnlyRevenueValue(value, sentence, terms)) return 'medium';
  if (isLooseWanMetricValue(value, sentence, terms)) return 'medium';
  return confidence;
}

function metricMediumReason(value: string, sentence: string, terms: string[]) {
  if (isYuanOnlyRevenueValue(value, sentence, terms)) {
    return '金额单位为元，且问题是收入/营收类指标，可能存在表格单位或 OCR 单位丢失';
  }
  if (isLooseWanMetricValue(value, sentence, terms)) {
    return '数值只出现“万”这类量级词，缺少平方米、亩、万元等明确单位，上下文仍需确认';
  }
  return '来源句包含部分指标词和金额单位，但上下文仍需确认';
}

function isYuanOnlyRevenueValue(value: string, sentence: string, terms: string[]) {
  const normalizedValue = value.replace(/\s+/g, '');
  if (!/元$/.test(normalizedValue) || /(万元|亿元)$/.test(normalizedValue)) return false;
  const normalizedTerms = terms.join('');
  const revenueLike = /(收入|营收|年均|年收入|总收入|合计)/.test(`${normalizedTerms}${sentence}`);
  const explicitSmallUnit = /(单价|价格|费用|成本|每次|每人|每平|元\/|元每)/.test(sentence);
  return revenueLike && !explicitSmallUnit;
}

function isLooseWanMetricValue(value: string, sentence: string, terms: string[]) {
  const normalizedValue = value.replace(/\s+/g, '');
  if (!/^[0-9][0-9,]*(?:\.[0-9]+)?万$/.test(normalizedValue)) return false;
  const metricLike = /(面积|土地|规模|收入|营收|总额|合计|数量|人数)/.test(`${terms.join('')}${sentence}`);
  return metricLike;
}

function extractCurrencyLikeValue(text: string) {
  return extractMetricValueFromSentence(text, []);
}

function extractMoneyLikeValue(text: string) {
  const currencyMatch = text.match(/(?:人民币|RMB)?\s*([0-9][0-9,，]*(?:\.[0-9]+)?\s*(?:亿元|万元|元))/i);
  if (currencyMatch?.[1]) return normalizeMetricValue(currencyMatch[1]);

  if (/(收入|营收|金额|费用|成本|投资|利润|价格|总额|合计|年均)/.test(text)) {
    const looseMatch = text.match(/([0-9][0-9,，]*(?:\.[0-9]+)?\s*(?:亿|万))(?!平方米|平米|㎡|亩|公顷|人|家|个|套|间|床|户)/);
    if (looseMatch?.[1]) return normalizeMetricValue(looseMatch[1]);
  }

  return undefined;
}

function extractAreaLikeValue(text: string) {
  const areaMatch = findAreaLikeValueMatches(text)[0];
  if (areaMatch) return areaMatch.value;

  if (/(面积|土地|用地|占地|建筑面积|住宅|宅地)/.test(text)) {
    const looseWanMatch = text.match(/([0-9][0-9,，]*(?:\.[0-9]+)?\s*万)(?!元|人|家|个|套|间|床|户)/);
    if (looseWanMatch?.[1]) return normalizeMetricValue(looseWanMatch[1]);
  }

  return undefined;
}

function extractScopedAreaLikeValue(text: string, terms: string[]) {
  const matches = findAreaLikeValueMatches(text);
  if (matches.length <= 1) return matches[0]?.value;

  const scope = inferMetricScope(terms.join(''));
  if (!scope) return undefined;

  const scopeIndexes = findAllTermIndexes(text, metricScopeTerms[scope]);
  if (scopeIndexes.length === 0) return undefined;

  return matches
    .slice()
    .sort((left, right) =>
      distanceToNearestIndex(left.index, scopeIndexes) - distanceToNearestIndex(right.index, scopeIndexes) ||
      afterScopePenalty(left.index, scopeIndexes) - afterScopePenalty(right.index, scopeIndexes))
    [0]?.value;
}

function findAreaLikeValueMatches(text: string) {
  const matches = [...text.matchAll(/([0-9][0-9,，]*(?:\.[0-9]+)?\s*(?:万平方米|平方米|平米|㎡|亩|公顷))/g)]
    .map((match) => ({
      value: normalizeMetricValue(match[1] ?? ''),
      index: match.index ?? 0,
    }))
    .filter((match) => match.value.length > 0);

  if (/(面积|土地|用地|占地|建筑面积|住宅|宅地)/.test(text)) {
    matches.push(...[...text.matchAll(/([0-9][0-9,，]*(?:\.[0-9]+)?\s*万)(?!元|人|家|个|套|间|床|户)/g)]
      .map((match) => ({
        value: normalizeMetricValue(match[1] ?? ''),
        index: match.index ?? 0,
      }))
      .filter((match) => match.value.length > 0));
  }

  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${match.value}:${match.index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findAllTermIndexes(text: string, terms: string[]) {
  const lowerText = text.toLowerCase();
  const indexes: number[] = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (!needle) continue;
    let fromIndex = 0;
    while (fromIndex < lowerText.length) {
      const index = lowerText.indexOf(needle, fromIndex);
      if (index < 0) break;
      indexes.push(index);
      fromIndex = index + Math.max(needle.length, 1);
    }
  }
  return indexes;
}

function distanceToNearestIndex(index: number, targets: number[]) {
  return Math.min(...targets.map((target) => Math.abs(index - target)));
}

function afterScopePenalty(index: number, targets: number[]) {
  const nearest = targets.slice().sort((left, right) => Math.abs(index - left) - Math.abs(index - right))[0] ?? 0;
  return index >= nearest ? 0 : 1;
}

function extractRatioLikeValue(text: string) {
  const ratioMatch = text.match(/([0-9][0-9,，]*(?:\.[0-9]+)?\s*%)/);
  if (ratioMatch?.[1]) return normalizeMetricValue(ratioMatch[1]);

  return undefined;
}

function extractCountLikeValue(text: string) {
  const genericUnitMatch = text.match(/([0-9][0-9,，]*(?:\.[0-9]+)?\s*(?:人|家|个|套|间|床|户))/);
  if (genericUnitMatch?.[1]) return normalizeMetricValue(genericUnitMatch[1]);

  return undefined;
}

function extractLooseMagnitudeValue(text: string) {
  const looseMatch = text.match(/([0-9][0-9,，]*(?:\.[0-9]+)?\s*(?:亿|万))/);
  if (looseMatch?.[1]) return normalizeMetricValue(looseMatch[1]);

  return undefined;
}

function normalizeMetricLabel(label: string) {
  return label
    .replace(/^(这个|该|其)/, '')
    .replace(/是多少|多少|为多少|是几|几/g, '')
    .trim() || '相关数值';
}

function expectedMetricLabel(question: string) {
  return normalizeMetricLabel(buildMetricTerms(question)[0] ?? '相关数值');
}

function normalizeMetricValue(value: string) {
  return value.replace(/，/g, ',').replace(/\s+/g, '');
}

function metricValueCandidates(value: string) {
  const normalized = normalizeMetricValue(value);
  const spacedWan = normalized.replace(/(万)(元|平方米)?$/, ' $1$2');
  const compactUnit = normalized
    .replace(/平方米$/, '㎡')
    .replace(/平米$/, '㎡');
  return uniqueStrings([normalized, spacedWan, compactUnit, normalized.replace(/㎡$/, '平方米')]);
}

function normalizeEvidenceForMetric(value: string) {
  return value
    .replace(/[`>#*_]+/g, ' ')
    .replace(/万\s+元/g, '万元')
    .replace(/亿\s+元/g, '亿元')
    .replace(/([一-龥])\s+(?=[一-龥])/g, '$1')
    .replace(/([0-9])\s+(?=[0-9])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function readableRelatedTitles(entities: Entity[]) {
  return uniqueStrings(
    entities
      .map((entity) => entity.title.trim())
      .filter((title) => title.length > 0 && title !== 'undefined' && title !== 'null'),
  );
}

function formatEvidenceHitLines(
  hits: EvidenceHit[],
  options: { includeSnippet?: boolean; maxSnippets?: number } = {},
) {
  const scopeLabels = Array.from(
    new Set(hits.map((hit) => (hit.scope === 'global-fallback' ? '全库原始材料兜底' : '关联原始材料'))),
  );
  const matchedTerms = uniqueStrings(hits.flatMap((hit) => hit.matchedTerms)).slice(0, 6);
  const summary = `原始材料命中：已找到 ${hits.length} 条证据（${scopeLabels.join('、')}），命中词：${matchedTerms.join('、') || '未标注'}。`;

  if (!options.includeSnippet) {
    return `${summary}\n这些原文已放在来源区，避免把未编译的长文本直接混入快速答案。`;
  }

  const lines = hits.slice(0, options.maxSnippets ?? 2).map((hit, index) => {
    const scopeLabel = hit.scope === 'global-fallback' ? '全库原始材料兜底' : '关联原始材料';
    return `${index + 1}. ${cleanEvidenceSnippet(hit.snippet)}（${scopeLabel}）`;
  });

  return `${summary}\n证据摘录：\n${lines.join('\n')}\n建议：这些信息应后续编译回实体档案，下次就能直接从 Wiki 回答。`;
}

function cleanEvidenceSnippet(value: string) {
  return snippet(
    value
      .replace(/[`>#*_]+/g, ' ')
      .replace(/([一-龥])\s+(?=[一-龥])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim(),
    120,
  );
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
