import { beforeEach, describe, expect, it } from 'vitest';
import { createEntity, createEntry, db, resetDatabase, updateEntity } from '@/lib/db';
import type { StructuredQueryResult } from '@/lib/graph/types';
import type { Entity, Relationship } from '@/types';
import { detectQueryChatIntent } from '../chatIntent';
import {
  applyWikiRagPageAnswer,
  buildWikiRagBaseResult,
} from '../queryPipeline';
import { buildLookupRetrievalText, understandQuery } from '../queryUnderstanding';
import { retrieveQueryContextFromEntities, type RetrievedQueryContext } from '../wikiRetrieval';

const runRealExamples = process.env.RUN_QUERY_REAL_EXAMPLES === '1';
const realApiBase = process.env.REAL_QUERY_API_BASE || 'http://127.0.0.1:5173';

type RealExampleResult = {
  question: string;
  mode: string;
  elapsedMs: number;
  provider?: string;
  model?: string;
  answer: string;
  evidence: string[];
  fallback: boolean;
};

describe.skipIf(!runRealExamples)('real query examples', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it(
    'answers five representative query cases without fallback',
    async () => {
      await seedQueryExampleKnowledge();
      const results: RealExampleResult[] = [];
      for (const question of [
        '你好',
        '福瑞科技园三期什么时候完工？',
        '福瑞健康科技园三期医疗业态都有哪些项目？',
        '桌面生命体的终止词是什么？',
        '福瑞健康科技园三期项目的商业模式和关键风险是什么？',
      ]) {
        results.push(await runExample(question));
      }

      console.log(
        JSON.stringify(
          results.map((item) => ({
            ...item,
            elapsed: formatDuration(item.elapsedMs),
            answer: excerpt(item.answer, 560),
            evidence: item.evidence.map((line) => excerpt(line, 320)),
          })),
          null,
          2,
        ),
      );

      expect(results).toHaveLength(5);
      for (const result of results) {
        expect(result.answer.trim().length).toBeGreaterThan(8);
        expect(result.fallback).toBe(false);
      }
      const defaultLookupResult = results.find((item) => item.question.includes('什么时候完工'));
      expect(defaultLookupResult?.mode).toBe('Wiki RAG + LLM');
      const complexResult = results.find((item) => item.question.includes('商业模式和关键风险'));
      expect(complexResult?.mode).toBe('Wiki RAG + LLM');
      expect(complexResult?.answer).toContain('商业模式');
      expect(complexResult?.answer).toContain('风险');
    },
    240_000,
  );
});

async function runExample(question: string): Promise<RealExampleResult> {
  const startedAt = Date.now();
  const chatIntent = detectQueryChatIntent(question);
  if (chatIntent.isChat) {
    const answered = await callQueryChat(question, chatIntent.label);
    return {
      question,
      mode: '闲聊直达 LLM',
      elapsedMs: Date.now() - startedAt,
      provider: answered.provider,
      model: answered.model,
      answer: answered.answer,
      evidence: [`闲聊意图：${chatIntent.label}；跳过 Wiki 检索和结构化查询。`],
      fallback: false,
    };
  }

  const understanding = understandQuery(question);
  const retrievalQuestion = buildLookupRetrievalText(question, understanding);
  const [entities, relationships] = await Promise.all([db.entities.toArray(), db.relationships.toArray()]);
  const retrievalStartedAt = Date.now();
  const retrieved = retrieveQueryContextFromEntities(
    retrievalQuestion,
    entities,
    relationships,
    buildExampleIndex(entities, relationships),
    { limit: 10, maxContextChars: 50_000 },
  );
  const retrievalMs = Date.now() - retrievalStartedAt;
  const initial = buildWikiRagBaseResult({
    retrievedPages: retrieved.pages,
    queryUnderstanding: understanding,
    retrievalTrace: retrieved.trace,
    retrievalUsedConversation: false,
    timing: { retrievalMs },
    formatDuration,
  });

  const answered = await callQueryAnswer(question, retrieved);
  const applied = applyWikiRagPageAnswer({
    result: initial.result,
    retrievedPages: retrieved.pages,
    answered,
    answerMs: answered.elapsedMs,
    formatDuration,
    formatProviderTimingDetail: () => '',
  });

  return {
    question,
    mode: 'Wiki RAG + LLM',
    elapsedMs: Date.now() - startedAt,
    provider: applied.result.llm?.provider,
    model: applied.result.llm?.model,
    answer: applied.result.answer,
    evidence: selectEvidenceTrace(applied.result),
    fallback: hasFallback(applied.result),
  };
}

async function seedQueryExampleKnowledge() {
  const now = Date.now();
  const projectEntry = await createEntry({
    content:
      '福瑞科技园三期计划 2026 年开工，预计 2029 年投入运营。当前材料没有明确写出完工或竣工日期。医疗业态的用地面积为 248 亩，布局社区门诊、中蒙特色康复理疗、慢病管理和康复护理。住宅业态的建筑面积在当前材料中未披露。',
    source: 'text',
  });
  const businessEntry = await createEntry({
    content:
      '福瑞健康科技园三期项目以医康旅一体化为主线，包含医疗服务、康养住宅、文旅配套、研发办公与智算中心。收入来源包括医疗康复服务、适老住宅销售或运营、文旅消费、研发办公租赁以及智算服务。关键风险包括医疗资质审批、招商去化、运营团队能力和现金流节奏。',
    source: 'text',
  });
  const projectWikiMarkdown = [
    '---',
    'type: project',
    'title: 福瑞健康科技园三期项目',
    'tags: [福瑞科技园三期, 医康旅, 园区]',
    'sources: [可研报告]',
    'related: [医疗业态, 康养住宅]',
    '---',
    '',
    '# 福瑞健康科技园三期项目',
    '',
    '## 摘要',
    '福瑞健康科技园三期项目是医康旅一体化园区项目。',
    '',
    '## 商业模式',
    '项目以医康旅一体化为主线，包含医疗服务、康养住宅、文旅配套、研发办公与智算中心。收入来源包括医疗康复服务、适老住宅销售或运营、文旅消费、研发办公租赁以及智算服务。',
    '',
    '## 时间节点',
    '计划 2026 年开工，预计 2029 年投入运营。当前材料没有明确写出完工或竣工日期。',
    '',
    '## 风险',
    '医疗资质审批、招商去化、运营团队能力和现金流节奏需要重点关注。',
  ].join('\n');
  const project = await createEntity({
    type: 'project',
    title: '福瑞健康科技园三期项目',
    summary: '医康旅一体化园区项目，包含医疗、康养、住宅、研发、文旅和智算等业态。',
    tags: ['福瑞科技园三期', '福瑞三期', '健康科技园三期'],
    sourceEntries: [projectEntry.id, businessEntry.id],
    categories: [
      {
        name: '医疗业态',
        aliases: ['医疗', '医疗板块'],
        items: [
          { title: '社区门诊', kind: 'service' },
          { title: '中蒙特色康复理疗', kind: 'service' },
          { title: '慢病管理', kind: 'service' },
          { title: '康复护理', kind: 'service' },
        ],
        evidence: '医疗业态布局社区门诊、中蒙特色康复理疗、慢病管理和康复护理。',
        updatedAt: now,
      },
    ],
    indicators: [
      {
        id: 'medical_land_area',
        name: '医疗板块用地面积',
        value: 248,
        rawValue: '248 亩',
        unit: '亩',
        businessLine: '医疗',
        categoryName: '医疗业态',
        source: { entryId: projectEntry.id, excerpt: '医疗业态的用地面积为 248 亩。' },
        confidence: 'high',
        extractedAt: now,
        updatedAt: now,
      },
    ],
  });
  await updateEntity(project.id, { wikiMarkdown: projectWikiMarkdown });
  const voiceEntry = await createEntry({
    content:
      '桌面数字生命体运行在 Windows 桌面，主唤醒词是“小李”，终止词使用 miki / mi ki / 米基 / 米奇 近音组。',
    source: 'text',
  });
  const voice = await createEntity({
    type: 'project',
    title: '桌面数字生命体',
    summary: '运行在 Windows 桌面的 AI 生命体原型。',
    tags: ['桌面生命体', '数字生命体'],
    sourceEntries: [voiceEntry.id],
  });
  await updateEntity(voice.id, {
    wikiMarkdown: '# 桌面数字生命体\n\n运行在 Windows 桌面，主唤醒词是“小李”，终止词使用 miki / mi ki / 米基 / 米奇 近音组。',
  });
  expect(project.id).toBeTruthy();
}

function buildExampleIndex(entities: Entity[], relationships: Relationship[]) {
  return entities.map((entity) => ({
    entityId: entity.id,
    type: entity.type,
    title: entity.title,
    aliases: [entity.title, ...(entity.tags ?? [])],
    shortSummary: entity.summary,
    importance: 10,
    sourceCount: entity.sourceEntries.length,
    relationshipCount: relationships.filter((relationship) => relationship.from === entity.id || relationship.to === entity.id).length,
    updatedAt: entity.updatedAt,
  }));
}

async function callQueryChat(question: string, intentLabel: string) {
  const startedAt = Date.now();
  const response = await fetch(`${realApiBase}/api/query/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ question, intentLabel, reasoningMode: 'disabled' }),
  });
  const body = (await response.json()) as { answer?: string; provider?: string; model?: string; error?: string };
  if (!response.ok || !body.answer) throw new Error(body.error ?? `Query chat failed with HTTP ${response.status}.`);
  return {
    answer: body.answer,
    provider: body.provider,
    model: body.model,
    elapsedMs: Date.now() - startedAt,
  };
}

async function callQueryAnswer(
  question: string,
  retrieved: RetrievedQueryContext,
) {
  const startedAt = Date.now();
  const response = await fetch(`${realApiBase}/api/query/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      question,
      indexSummary: retrieved.indexSummary,
      pages: retrieved.pages.map((page) => ({
        index: page.index,
        entityId: page.entityId,
        type: page.type,
        title: page.title,
        href: page.href,
        path: page.path,
        summary: page.summary,
        content: page.content,
        score: page.score,
        tags: page.tags,
        sources: page.sources,
        related: page.related,
        updated: page.updated,
      })),
      reasoningMode: 'disabled',
    }),
  });
  const body = (await response.json()) as {
    answer?: string;
    citedIndices?: number[];
    provider?: string;
    model?: string;
    error?: string;
  };
  if (!response.ok || !body.answer) throw new Error(body.error ?? `Query answer failed with HTTP ${response.status}.`);
  return {
    answer: body.answer,
    citedIndices: body.citedIndices ?? [],
    provider: body.provider ?? 'unknown',
    model: body.model ?? 'unknown',
    elapsedMs: Date.now() - startedAt,
  };
}

function selectEvidenceTrace(result: StructuredQueryResult) {
  return (result.trace ?? [])
    .filter((step) => ['Wiki 页面检索', '查询理解', '证据分层', '完整性判断', 'Query 回答'].includes(step.label))
    .map((step) => `${step.label}：${step.detail}`);
}

function hasFallback(result: StructuredQueryResult) {
  return /(回退|模型表达失败|页面级回答失败|fallback)/i.test(
    `${result.answer}\n${(result.trace ?? []).map((step) => step.detail).join('\n')}`,
  );
}

function formatDuration(ms: number) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function excerpt(value: string, maxLength: number) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
