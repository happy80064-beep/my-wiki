import { db } from '@/lib/db';
import { getClientId } from '@/lib/db/clientId';
import { createId } from '@/lib/db/ids';
import type { StructuredQueryResult } from '@/lib/graph';
import { createIngestJob } from '@/lib/ingest';
import { refreshCompiledProfiles } from '@/lib/wikiIndex';
import type { Entity, Entry, Relationship } from '@/types';

export type SavedQueryInsight = {
  entry: Entry;
  entity: Entity;
  relationships: Relationship[];
  reused: boolean;
  recompileJobId?: string;
};

export async function saveQueryInsight(question: string, result: StructuredQueryResult): Promise<SavedQueryInsight> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    throw new Error('question is required.');
  }
  if (!result.answer.trim()) {
    throw new Error('answer is required.');
  }

  const saved = await db.transaction('rw', [db.entries, db.entities, db.relationships], async () => {
    const now = Date.now();
    const relatedEntityIds = getRelatedEntityIds(result);
    const title = buildInsightTitle(trimmedQuestion);
    const questionTag = `question:${normalizeQuestion(trimmedQuestion)}`;
    const existing = await findExistingInsightEntity(trimmedQuestion);
    const entry: Entry = {
      id: createId('entry'),
      clientId: getClientId(),
      content: buildInsightEntryContent(trimmedQuestion, result),
      source: 'text',
      capturedAt: now,
      processed: true,
      derivedEntities: [],
      derivedTasks: [],
      derivedRelationships: [],
    };
    await db.entries.add(entry);

    const entity =
      existing ??
      ({
        id: createId('topic'),
        clientId: getClientId(),
        type: 'topic',
        title,
        summary: summarizeAnswer(result.answer),
        tags: ['query-insight', questionTag],
        scenes: ['work'],
        properties: {
          isPersonal: true,
          myView: result.answer,
          viewHistory: [],
          autoCollectedSnippets: [entry.id],
        },
        sourceEntries: [entry.id],
        createdAt: now,
        updatedAt: now,
      } satisfies Entity);
    const sourceEntries = existing ? uniqueStrings([...existing.sourceEntries, entry.id]) : [entry.id];
    const tags = existing ? uniqueStrings([...existing.tags, 'query-insight', questionTag]) : entity.tags;
    const wikiMarkdown = buildInsightWikiMarkdown({
      title,
      question: trimmedQuestion,
      result,
      entryId: entry.id,
      sourceEntries,
      tags,
      createdAt: entity.createdAt,
      updatedAt: now,
    });
    const wikiCompileModel = result.llm ? `${result.llm.provider}/${result.llm.model}` : 'query-save';
    let nextExistingProperties: Entity['properties'] | undefined;

    if (existing) {
      const properties = existing.properties as Entity['properties'] & {
        autoCollectedSnippets?: string[];
        myView?: string;
        viewHistory?: { view: string; updatedAt: number }[];
      };
      nextExistingProperties = {
        ...properties,
        myView: result.answer,
        viewHistory: properties.myView
          ? [...(properties.viewHistory ?? []), { view: properties.myView, updatedAt: now }]
          : properties.viewHistory ?? [],
        autoCollectedSnippets: uniqueStrings([...(properties.autoCollectedSnippets ?? []), entry.id]),
      };
      await db.entities.update(existing.id, {
        title,
        summary: summarizeAnswer(result.answer),
        tags,
        sourceEntries,
        wikiMarkdown,
        wikiCompiledAt: now,
        wikiCompileModel,
        properties: nextExistingProperties,
        updatedAt: now,
      });
    } else {
      await db.entities.add({
        ...entity,
        wikiMarkdown,
        wikiCompiledAt: now,
        wikiCompileModel,
      });
    }

    const relationships: Relationship[] = [];
    for (const targetId of relatedEntityIds.filter((id) => id !== entity.id)) {
      const existingRelationship = await db.relationships
        .filter((relationship) => relationship.from === entity.id && relationship.to === targetId && relationship.type === 'about')
        .first();
      if (existingRelationship) {
        await db.relationships.update(existingRelationship.id, {
          evidence: uniqueStrings([...existingRelationship.evidence, entry.id]),
        });
        relationships.push({ ...existingRelationship, evidence: uniqueStrings([...existingRelationship.evidence, entry.id]) });
        continue;
      }

      const relationship: Relationship = {
        id: createId('rel'),
        clientId: getClientId(),
        from: entity.id,
        to: targetId,
        type: 'about',
        evidence: [entry.id],
        createdAt: now,
      };
      await db.relationships.add(relationship);
      relationships.push(relationship);
    }

    await db.entries.update(entry.id, {
      derivedEntities: uniqueStrings([entity.id, ...relatedEntityIds]),
      derivedRelationships: relationships.map((relationship) => relationship.id),
    });
    const savedEntity = (await db.entities.get(entity.id)) ?? entity;

    return {
      entry: {
        ...entry,
        derivedEntities: uniqueStrings([entity.id, ...relatedEntityIds]),
        derivedRelationships: relationships.map((relationship) => relationship.id),
      },
      entity: savedEntity,
      relationships,
      reused: Boolean(existing),
    };
  });
  await refreshCompiledProfiles([saved.entity.id, ...getRelatedEntityIds(result)]);

  try {
    const job = await createIngestJob({
      content: saved.entry.content,
      source: 'text',
      filename: `query-insight-${saved.entry.id}.md`,
    });
    return { ...saved, recompileJobId: job.id };
  } catch {
    return saved;
  }
}

function getRelatedEntityIds(result: StructuredQueryResult) {
  return uniqueStrings([
    ...(result.candidates ?? []).map((entity) => entity.id),
    ...result.sources.filter((source) => source.type === 'entity').map((source) => source.id),
  ]);
}

function buildInsightTitle(question: string) {
  return `查询洞察：${question.length > 24 ? `${question.slice(0, 23)}...` : question}`;
}

function buildInsightEntryContent(question: string, result: StructuredQueryResult) {
  const sourceLines = result.sources
    .slice(0, 12)
    .map((source) => `- ${source.type}: ${source.href ? `[${source.title}](${source.href})` : source.title}`)
    .join('\n');

  return [
    '# 查询洞察',
    '',
    `问题：${question}`,
    '',
    '答案：',
    result.answer.trim(),
    '',
    sourceLines ? `来源：\n${sourceLines}` : '来源：暂无结构化来源。',
  ].join('\n');
}

function buildInsightWikiMarkdown(input: {
  title: string;
  question: string;
  result: StructuredQueryResult;
  entryId: string;
  sourceEntries: string[];
  tags: string[];
  createdAt: number;
  updatedAt: number;
}) {
  const { title, question, result, entryId, sourceEntries, tags, createdAt, updatedAt } = input;
  const sourceIds = uniqueStrings([entryId, ...sourceEntries, ...result.sources.map((source) => source.id)]);
  const related = uniqueStrings([
    ...(result.candidates ?? []).map((entity) => entity.title),
    ...result.sources.filter((source) => source.type === 'entity').map((source) => source.title),
  ]);
  const sourceLines = result.sources.slice(0, 12).map((source, index) => {
    const label = `${index + 1}. ${source.title}`;
    return source.href ? `- [${escapeMarkdownLinkLabel(label)}](${source.href})` : `- ${label}`;
  });
  const llmLine = result.llm ? `- 模型：${result.llm.provider}/${result.llm.model}` : undefined;
  const frontmatter = [
    '---',
    'type: query',
    `title: ${JSON.stringify(title)}`,
    `created: ${dateOnly(createdAt)}`,
    `updated: ${dateOnly(updatedAt)}`,
    `tags: ${JSON.stringify(tags)}`,
    `sources: ${JSON.stringify(sourceIds)}`,
    `related: ${JSON.stringify(related)}`,
    '---',
  ];

  return [
    ...frontmatter,
    '',
    `# ${title}`,
    '',
    '## 摘要',
    result.answer.trim(),
    '',
    '## 参考来源',
    ...(sourceLines.length ? sourceLines : ['- 暂无结构化来源。']),
    ...(llmLine ? ['', '## 生成信息', llmLine] : []),
  ].join('\n').trim();
}

async function findExistingInsightEntity(question: string) {
  const tag = `question:${normalizeQuestion(question)}`;
  return db.entities
    .where('tags')
    .equals(tag)
    .first();
}

function summarizeAnswer(answer: string) {
  const compact = answer.replace(/\s+/g, ' ').trim();
  return compact.length > 120 ? `${compact.slice(0, 119)}...` : compact;
}

function normalizeQuestion(question: string) {
  return question
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
    .slice(0, 80);
}

function dateOnly(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function escapeMarkdownLinkLabel(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
